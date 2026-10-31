import { findStock } from "./stocks.js";
const ACCOUNT_RE = /(?:[a-z0-9_-]+\.)+(?:near|tg)\b|\b[0-9a-f]{64}\b|\b0x[0-9a-f]{40}\b/g;
const QUOTE_TOKENS = new Set(["wrap.near", "near"]);
/**
 * Turns a pasted contract address or a JustHoot / Nearly / meme.cooking / Intear / Rhea /
 * DexScreener link into what to open.
 */
export function parseInput(raw) {
    // DexScreener prefixes pools with the exchange: refv2-<token>:wrap.near:10000
    const text = safeDecode(raw.trim()).replace(/\/(?:refv\d|ref)-/gi, "/");
    const meme = /meme\.cooking\/meme\/(\d+)/i.exec(text);
    if (meme)
        return { kind: "meme", memeId: Number(meme[1]) };
    const stockPath = /nearly\.trade\/stocks?\/([a-z]+)/i.exec(text)?.[1];
    const stock = findStock(stockPath ?? text);
    if (stock)
        return { kind: "stock", stock };
    // Links carry the token account in the path (e.g. justhoot.fun/p/<token>, nearly.trade/<token>);
    // in a pool link the first non-NEAR side is the token.
    const candidates = (text.toLowerCase().match(ACCOUNT_RE) ?? []).filter((a) => !QUOTE_TOKENS.has(a));
    const first = candidates[0];
    if (!first)
        return null;
    const asStock = findStock(first);
    if (asStock)
        return { kind: "stock", stock: asStock };
    return { kind: "token", accountId: first };
}
function safeDecode(s) {
    try {
        return decodeURIComponent(s);
    }
    catch {
        return s;
    }
}
/** The meme id inside a meme.cooking token account, e.g. omgy-1992.meme-cooking.near -> 1992. */
export function memeIdFromAccount(accountId) {
    const m = /^[a-z0-9_]+-(\d+)\.meme-cooking\.near$/.exec(accountId);
    return m ? Number(m[1]) : null;
}
/** Parses Intear's main_pool field, e.g. "REFDCL-a.near|wrap.near|10000" or "REF-4276". */
export function parseMainPool(mainPool) {
    if (!mainPool)
        return null;
    const dcl = /^REFDCL-(([^|]+)\|([^|]+)\|\d+)$/.exec(mainPool);
    if (dcl)
        return { dex: "dcl", poolId: dcl[1], tokens: [dcl[2], dcl[3]] };
    const ref = /^REF-(\d+)$/.exec(mainPool);
    if (ref)
        return { dex: "rhea", poolId: Number(ref[1]) };
    return { dex: "other", raw: mainPool };
}
//# sourceMappingURL=parse.js.map