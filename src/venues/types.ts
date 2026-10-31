import type { Tx } from "../near/signer.js";

/** Where a token really trades, and so how the bot must trade it. */
export type Route =
  /** Its own Rhea DCL pool against wNEAR; swapped directly on dclv2.ref-labs.near. */
  | { kind: "dcl"; poolId: string; label: string }
  /**
   * Its own Rhea DCL pool against another token (NEARLY, QTC, RHEA, USDC, BTC...). Routed on Rhea DCL
   * only, so the last hop is always the launch pool; if DCL has no NEAR leg, NEAR -> pair goes through
   * the router first (Nearly's own two-leg route).
   */
  | { kind: "dclPair"; poolId: string; pair: string; label: string }
  /** Through the Intear router, limited to the DEXes listed (all DEXes when undefined). */
  | { kind: "router"; dexes?: string[]; label: string }
  /** meme.cooking raise that is still open or awaiting launch. */
  | { kind: "memecooking"; memeId: number; label: string }
  /** Ondo tokenized stock, through NEAR Intents 1Click. */
  | { kind: "stock"; symbol: string; label: string };

export interface Quote {
  /** Expected output in raw units of the output asset. */
  expectedOut: bigint;
  /** Output guaranteed by the slippage limit. */
  minOut: bigint;
  txs: Tx[];
  /** Human-readable venue the trade goes through. */
  via: string;
  /** For swaps where the last tx returns the amount used: "0" means refunded. */
  refundCheck?: boolean;
}

export interface TradeResult {
  hashes: string[];
  via: string;
  /** Raw amounts actually swapped, when known. */
  nearAmount: bigint;
  tokenAmount: bigint;
  note?: string;
}
