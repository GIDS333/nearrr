import { findStock, type Stock } from "./stocks.js";

export type ParsedInput =
  | { kind: "token"; accountId: string }
  | { kind: "meme"; memeId: number }
  | { kind: "stock"; stock: Stock };

const ACCOUNT_RE = /(?:[a-z0-9_-]+\.)+(?:near|tg)\b|\b[0-9a-f]{64}\b|\b0x[0-9a-f]{40}\b/g;
const QUOTE_TOKENS = new Set(["wrap.near", "near"]);

/**
 * Turns a pasted contract address or a JustHoot / Nearly / meme.cooking / Intear / Rhea /
 * DexScreener link into what to open.
 */
export function parseInput(raw: string): ParsedInput | null {
  // DexScreener prefixes pools with the exchange: refv2-<token>:wrap.near:10000
  const text = safeDecode(raw.trim()).replace(/\/(?:refv\d|ref)-/gi, "/");

  const meme = /meme\.cooking\/meme\/(\d+)/i.exec(text);
  if (meme) return { kind: "meme", memeId: Number(meme[1]) };

  const stockPath = /nearly\.trade\/stocks?\/([a-z]+)/i.exec(text)?.[1];
  const stock = findStock(stockPath ?? text);
  if (stock) return { kind: "stock", stock };

  // Links carry the token account in the path (e.g. justhoot.fun/p/<token>, nearly.trade/<token>);
  // in a pool link the first non-NEAR side is the token.
  const candidates = (text.toLowerCase().match(ACCOUNT_RE) ?? []).filter((a) => !QUOTE_TOKENS.has(a));
  const first = candidates[0];
  if (!first) return null;
  const asStock = findStock(first);
  if (asStock) return { kind: "stock", stock: asStock };
  return { kind: "token", accountId: first };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The meme id inside a meme.cooking token account, e.g. omgy-1992.meme-cooking.near -> 1992. */
export function memeIdFromAccount(accountId: string): number | null {
  const m = /^[a-z0-9_]+-(\d+)\.meme-cooking\.near$/.exec(accountId);
  return m ? Number(m[1]) : null;
}

export type MainPool =
  | { dex: "dcl"; poolId: string; tokens: [string, string] }
  | { dex: "rhea"; poolId: number }
  | { dex: "other"; raw: string };

/** Parses Intear's main_pool field, e.g. "REFDCL-a.near|wrap.near|10000" or "REF-4276". */
export function parseMainPool(mainPool: string | null): MainPool | null {
  if (!mainPool) return null;
  const dcl = /^REFDCL-(([^|]+)\|([^|]+)\|\d+)$/.exec(mainPool);
  if (dcl) return { dex: "dcl", poolId: dcl[1]!, tokens: [dcl[2]!, dcl[3]!] };
  const ref = /^REF-(\d+)$/.exec(mainPool);
  if (ref) return { dex: "rhea", poolId: Number(ref[1]) };
  return { dex: "other", raw: mainPool };
}
