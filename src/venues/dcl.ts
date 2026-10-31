import { TGAS, applySlippage } from "../amount.js";
import { WRAP, type Ft } from "../near/ft.js";
import type { Rpc } from "../near/rpc.js";
import type { Tx } from "../near/signer.js";
import type { Quote } from "./types.js";

/** Rhea DCL, where JustHoot and Nearly launch every token into its own pool. */
export const DCL = "dclv2.ref-labs.near";

const DCL_DEPOSIT = 500_000_000_000_000_000_000_000n; // 0.5 NEAR attached...
const DCL_KEEP = 100_000_000_000_000_000_000_000n; // ...0.1 NEAR kept, the rest withdrawn (same as the Intear router)
const SWAP_GAS = 180n * TGAS;

/**
 * Direct swaps on a token's own pool: no router hop, one quote view, one swap transaction.
 * This is the same call nearly.trade documents and the Intear router builds for RheaDcl.
 */
export class DclVenue {
  constructor(private readonly rpc: Rpc, private readonly ft: Ft) {}

  async quoteOut(poolId: string, inToken: string, outToken: string, amountIn: bigint): Promise<bigint> {
    const r = await this.rpc.view<{ amount: string } | null>(DCL, "quote", {
      pool_ids: [poolId],
      input_token: inToken,
      output_token: outToken,
      input_amount: amountIn.toString(),
      tag: null,
    });
    const out = BigInt(r?.amount ?? "0");
    if (out <= 0n) throw new Error("The pool can't fill this size right now");
    return out;
  }

  /** One-time account registration on the exchange, so refunds and outputs always have somewhere to go. */
  private async registrationTx(): Promise<Tx | null> {
    if (await this.ft.isRegistered(DCL)) return null;
    return {
      receiverId: DCL,
      calls: [
        { method: "storage_deposit", args: { registration_only: true }, gas: 10n * TGAS, deposit: DCL_DEPOSIT },
        { method: "storage_withdraw", args: { amount: (DCL_DEPOSIT - DCL_KEEP).toString() }, gas: 10n * TGAS, deposit: 1n },
      ],
    };
  }

  private transferCall(poolId: string, outputToken: string, amountIn: bigint, minOut: bigint, unwrapNear: boolean) {
    return {
      method: "ft_transfer_call",
      args: {
        receiver_id: DCL,
        amount: amountIn.toString(),
        msg: JSON.stringify({
          Swap: { pool_ids: [poolId], output_token: outputToken, min_output_amount: minOut.toString(), skip_unwrap_near: !unwrapNear },
        }),
      },
      gas: SWAP_GAS,
      deposit: 1n,
    };
  }

  /** Registrations still needed (exchange plus each token) before a swap can pay out. */
  async prep(...tokens: string[]): Promise<Tx[]> {
    const txs = await Promise.all([this.registrationTx(), ...tokens.map((t) => this.ft.registrationTx(t))]);
    return txs.filter((t): t is Tx => !!t);
  }

  /** NEAR -> token on the token's own wNEAR pool. */
  async buy(poolId: string, token: string, amountIn: bigint, slippagePct: number): Promise<Quote> {
    // Quote and registration checks run in parallel; registrations are cached after the first trade.
    const [expectedOut, prep] = await Promise.all([this.quoteOut(poolId, WRAP, token, amountIn), this.prep(token, WRAP)]);
    const minOut = applySlippage(expectedOut, slippagePct);
    const swap: Tx = {
      receiverId: WRAP,
      calls: [{ method: "near_deposit", args: {}, gas: 5n * TGAS, deposit: amountIn }, this.transferCall(poolId, token, amountIn, minOut, false)],
    };
    return { expectedOut, minOut, txs: [...prep, swap], via: "Rhea DCL", refundCheck: true };
  }

  /** Token -> NEAR on the token's own wNEAR pool; paid out as native NEAR. */
  async sell(poolId: string, token: string, amountIn: bigint, slippagePct: number): Promise<Quote> {
    const [expectedOut, prep] = await Promise.all([this.quoteOut(poolId, token, WRAP, amountIn), this.prep(WRAP)]);
    const minOut = applySlippage(expectedOut, slippagePct);
    const swap: Tx = { receiverId: token, calls: [this.transferCall(poolId, WRAP, amountIn, minOut, true)] };
    return { expectedOut, minOut, txs: [...prep, swap], via: "Rhea DCL", refundCheck: true };
  }

  /** Any token -> any token on one pool (the token leg of a pair trade). */
  async swap(poolId: string, inToken: string, outToken: string, amountIn: bigint, slippagePct: number): Promise<Quote> {
    const [expectedOut, prep] = await Promise.all([this.quoteOut(poolId, inToken, outToken, amountIn), this.prep(outToken)]);
    const minOut = applySlippage(expectedOut, slippagePct);
    const swap: Tx = { receiverId: inToken, calls: [this.transferCall(poolId, outToken, amountIn, minOut, false)] };
    return { expectedOut, minOut, txs: [...prep, swap], via: "Rhea DCL", refundCheck: true };
  }
}
