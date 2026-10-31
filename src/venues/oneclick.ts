import { TGAS } from "../amount.js";
import { WRAP, type Ft } from "../near/ft.js";
import type { Rpc } from "../near/rpc.js";
import type { Tx } from "../near/signer.js";
import type { Stock } from "./stocks.js";

/** NEAR Intents 1Click, the route nearly.trade uses for Ondo stocks. Stocks are held inside intents.near. */
const BASE = "https://1click.chaindefuser.com";
export const INTENTS = "intents.near";
const WNEAR_ASSET = `nep141:${WRAP}`;
export const stockAsset = (s: Stock) => `nep141:${s.token}`;

export interface OneClickQuote {
  depositAddress: string;
  amountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  minAmountOut?: string;
  timeEstimate?: number;
}

export type OneClickStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED";

export class OneClickVenue {
  constructor(private readonly rpc: Rpc, private readonly ft: Ft, private readonly accountId: string, private readonly jwt?: string) {}

  private async req<T>(path: string, body?: object, timeoutMs = 20_000): Promise<T> {
    const res = await fetch(BASE + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(this.jwt ? { authorization: `Bearer ${this.jwt}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as T & { message?: unknown };
    if (!res.ok) throw new Error(`1Click: ${String(json.message ?? res.status)}`);
    return json;
  }

  async quote(leg: "buy" | "sell", stock: Stock, amountRaw: bigint, slippagePct: number, dry = false, waitMs = 3000): Promise<OneClickQuote> {
    const sell = leg === "sell";
    const r = await this.req<{ quote: OneClickQuote }>("/v0/quote", {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: Math.round(slippagePct * 100),
      originAsset: sell ? stockAsset(stock) : WNEAR_ASSET,
      depositType: "INTENTS",
      destinationAsset: sell ? WNEAR_ASSET : stockAsset(stock),
      amount: amountRaw.toString(),
      recipient: this.accountId,
      recipientType: sell ? "DESTINATION_CHAIN" : "INTENTS",
      refundTo: this.accountId,
      refundType: "INTENTS",
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      quoteWaitingTimeMs: waitMs,
    });
    return r.quote;
  }

  /**
   * Price of one whole share in NEAR and USD, from a dry ~$30 buy quote (nothing is created;
   * solvers don't quote under ~$25, and often not at all outside market hours).
   */
  async price(stock: Stock): Promise<{ near: number; usd: number }> {
    const spend = 6n * 10n ** 24n;
    const q = await this.quote("buy", stock, spend, 1, true, 1500);
    const shares = Number(q.amountOutFormatted);
    if (!(shares > 0)) throw new Error("No quote");
    return { near: 6 / shares, usd: Number(q.amountInUsd ?? 0) / shares };
  }

  /** Shares held: inside intents.near and in the wallet. */
  async holdings(stock: Stock): Promise<{ intents: bigint; wallet: bigint }> {
    const [inIntents, inWallet] = await Promise.all([
      this.rpc
        .view<string[]>(INTENTS, "mt_batch_balance_of", { account_id: this.accountId, token_ids: [stockAsset(stock)] })
        .then((r) => BigInt(r?.[0] ?? "0"))
        .catch(() => 0n),
      this.ft.balance(stock.token),
    ]);
    return { intents: inIntents, wallet: inWallet };
  }

  async buyTxs(depositAddress: string, amount: bigint): Promise<Tx[]> {
    const regWrap = await this.ft.registrationTx(WRAP);
    const swap: Tx = {
      receiverId: WRAP,
      calls: [
        { method: "near_deposit", args: {}, gas: 10n * TGAS, deposit: amount },
        // Credits the wNEAR to the 1Click deposit address inside intents.near.
        { method: "ft_transfer_call", args: { receiver_id: INTENTS, amount: amount.toString(), msg: depositAddress }, gas: 100n * TGAS, deposit: 1n },
      ],
    };
    return regWrap ? [regWrap, swap] : [swap];
  }

  sellTxs(stock: Stock, depositAddress: string, fromIntents: bigint, fromWallet: bigint): Tx[] {
    const txs: Tx[] = [];
    if (fromIntents > 0n) {
      txs.push({
        receiverId: INTENTS,
        calls: [{ method: "mt_transfer", args: { receiver_id: depositAddress, token_id: stockAsset(stock), amount: fromIntents.toString() }, gas: 50n * TGAS, deposit: 1n }],
      });
    }
    if (fromWallet > 0n) {
      txs.push({
        receiverId: stock.token,
        calls: [{ method: "ft_transfer_call", args: { receiver_id: INTENTS, amount: fromWallet.toString(), msg: depositAddress }, gas: 100n * TGAS, deposit: 1n }],
      });
    }
    return txs;
  }

  submit(depositAddress: string, txHash: string): Promise<unknown> {
    return this.req("/v0/deposit/submit", { depositAddress, txHash }, 15_000);
  }

  async status(depositAddress: string): Promise<{ status: OneClickStatus; amountOut?: string }> {
    const r = await this.req<{ status: OneClickStatus; swapDetails?: { amountOut?: string } }>(
      `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
      undefined,
      15_000,
    );
    return { status: r.status, amountOut: r.swapDetails?.amountOut };
  }

  /** Polls until the swap settles (stocks take about a minute). */
  async waitForSettlement(depositAddress: string, timeoutMs = 10 * 60_000): Promise<{ status: OneClickStatus; amountOut?: string }> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const s = await this.status(depositAddress).catch(() => null);
      if (s && ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(s.status)) return s;
      await new Promise((r) => setTimeout(r, 4000));
    }
    return { status: "PROCESSING" };
  }
}
