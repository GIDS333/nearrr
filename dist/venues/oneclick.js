import { TGAS } from "../amount.js";
import { WRAP } from "../near/ft.js";
/** NEAR Intents 1Click, the route nearly.trade uses for Ondo stocks. Stocks are held inside intents.near. */
const BASE = "https://1click.chaindefuser.com";
export const INTENTS = "intents.near";
const WNEAR_ASSET = `nep141:${WRAP}`;
export const stockAsset = (s) => `nep141:${s.token}`;
export class OneClickVenue {
    rpc;
    ft;
    accountId;
    jwt;
    constructor(rpc, ft, accountId, jwt) {
        this.rpc = rpc;
        this.ft = ft;
        this.accountId = accountId;
        this.jwt = jwt;
    }
    async req(path, body, timeoutMs = 20_000) {
        const res = await fetch(BASE + path, {
            method: body ? "POST" : "GET",
            headers: { "content-type": "application/json", ...(this.jwt ? { authorization: `Bearer ${this.jwt}` } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const json = (await res.json().catch(() => ({})));
        if (!res.ok)
            throw new Error(`1Click: ${String(json.message ?? res.status)}`);
        return json;
    }
    async quote(leg, stock, amountRaw, slippagePct, dry = false, waitMs = 3000) {
        const sell = leg === "sell";
        const r = await this.req("/v0/quote", {
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
    async price(stock) {
        const spend = 6n * 10n ** 24n;
        const q = await this.quote("buy", stock, spend, 1, true, 1500);
        const shares = Number(q.amountOutFormatted);
        if (!(shares > 0))
            throw new Error("No quote");
        return { near: 6 / shares, usd: Number(q.amountInUsd ?? 0) / shares };
    }
    /** Shares held: inside intents.near and in the wallet. */
    async holdings(stock) {
        const [inIntents, inWallet] = await Promise.all([
            this.rpc
                .view(INTENTS, "mt_batch_balance_of", { account_id: this.accountId, token_ids: [stockAsset(stock)] })
                .then((r) => BigInt(r?.[0] ?? "0"))
                .catch(() => 0n),
            this.ft.balance(stock.token),
        ]);
        return { intents: inIntents, wallet: inWallet };
    }
    async buyTxs(depositAddress, amount) {
        const regWrap = await this.ft.registrationTx(WRAP);
        const swap = {
            receiverId: WRAP,
            calls: [
                { method: "near_deposit", args: {}, gas: 10n * TGAS, deposit: amount },
                // Credits the wNEAR to the 1Click deposit address inside intents.near.
                { method: "ft_transfer_call", args: { receiver_id: INTENTS, amount: amount.toString(), msg: depositAddress }, gas: 100n * TGAS, deposit: 1n },
            ],
        };
        return regWrap ? [regWrap, swap] : [swap];
    }
    sellTxs(stock, depositAddress, fromIntents, fromWallet) {
        const txs = [];
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
    submit(depositAddress, txHash) {
        return this.req("/v0/deposit/submit", { depositAddress, txHash }, 15_000);
    }
    async status(depositAddress) {
        const r = await this.req(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, undefined, 15_000);
        return { status: r.status, amountOut: r.swapDetails?.amountOut };
    }
    /** Polls until the swap settles (stocks take about a minute). */
    async waitForSettlement(depositAddress, timeoutMs = 10 * 60_000) {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
            const s = await this.status(depositAddress).catch(() => null);
            if (s && ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(s.status))
                return s;
            await new Promise((r) => setTimeout(r, 4000));
        }
        return { status: "PROCESSING" };
    }
}
//# sourceMappingURL=oneclick.js.map