import { describe, expect, it } from "vitest";
import { applySlippage, fromRaw, nearToYocto, percentOf, toRaw } from "../src/amount.js";
import { averageEntry, entryMarketCap, holdingCost, pnlPct, type Fill } from "../src/entry.js";
import { price } from "../src/bot/format.js";
import { memeIdFromAccount, parseInput, parseMainPool } from "../src/venues/parse.js";

describe("parseInput", () => {
  it("reads JustHoot links", () => {
    expect(parseInput("https://justhoot.fun/p/hoot-8ecf65.launchpad.justhoot.near")).toEqual({ kind: "token", accountId: "hoot-8ecf65.launchpad.justhoot.near" });
  });
  it("reads Nearly links", () => {
    expect(parseInput("https://nearly.trade/batman-4.nearlytrade.near")).toEqual({ kind: "token", accountId: "batman-4.nearlytrade.near" });
  });
  it("reads meme.cooking raise links", () => {
    expect(parseInput("https://meme.cooking/meme/1992")).toEqual({ kind: "meme", memeId: 1992 });
  });
  it("reads plain contract addresses", () => {
    expect(parseInput("  blackdragon.tkn.near ")).toEqual({ kind: "token", accountId: "blackdragon.tkn.near" });
  });
  it("skips the NEAR side of a pool link", () => {
    expect(parseInput("https://app.rhea.finance/poolV2/wrap.near%3C%3Eeclipse.nearlytrade.near@10000")).toEqual({ kind: "token", accountId: "eclipse.nearlytrade.near" });
    expect(parseInput("https://dexscreener.com/near/refv2-hoot-8ecf65.launchpad.justhoot.near:wrap.near:10000")).toEqual({ kind: "token", accountId: "hoot-8ecf65.launchpad.justhoot.near" });
  });
  it("reads Intear wallet swap links", () => {
    expect(parseInput("https://wallet.intear.tech/swap?from=near&to=nep141:token.rhealab.near")).toEqual({ kind: "token", accountId: "token.rhealab.near" });
  });
  it("finds stocks by ticker or account", () => {
    expect(parseInput("NVDA")).toMatchObject({ kind: "stock", stock: { symbol: "NVDAon" } });
    expect(parseInput("bnb-0x2494b603319d4d9f9715c9f4496d9e0364b59d93.omdep.near")).toMatchObject({ kind: "stock", stock: { symbol: "TSLAon" } });
  });
  it("rejects text without a token", () => {
    expect(parseInput("hello")).toBeNull();
  });
});

describe("parseMainPool", () => {
  it("parses DCL and classic pools", () => {
    expect(parseMainPool("REFDCL-hoot-8ecf65.launchpad.justhoot.near|wrap.near|10000")).toEqual({
      dex: "dcl",
      poolId: "hoot-8ecf65.launchpad.justhoot.near|wrap.near|10000",
      tokens: ["hoot-8ecf65.launchpad.justhoot.near", "wrap.near"],
    });
    expect(parseMainPool("REF-4276")).toEqual({ dex: "rhea", poolId: 4276 });
    expect(parseMainPool(null)).toBeNull();
  });
  it("gets the meme id from a meme.cooking token", () => {
    expect(memeIdFromAccount("omgy-1992.meme-cooking.near")).toBe(1992);
    expect(memeIdFromAccount("hoot.near")).toBeNull();
  });
});

describe("amounts", () => {
  it("converts NEAR to yocto exactly", () => {
    expect(nearToYocto("20")).toBe(20n * 10n ** 24n);
    expect(nearToYocto("0.5")).toBe(5n * 10n ** 23n);
    expect(toRaw("1.123456789", 6)).toBe(1_123_456n);
    expect(fromRaw("1500000", 6)).toBe(1.5);
  });
  it("applies percent and slippage", () => {
    expect(percentOf(1000n, 25)).toBe(250n);
    expect(percentOf(1000n, 100)).toBe(1000n);
    expect(applySlippage(1000n, 50)).toBe(500n);
  });
});

describe("averageEntry", () => {
  it("averages buys and keeps the entry price after a sell", () => {
    const e = averageEntry([
      { side: "buy", tokens: 100, near: 10, usd: 50, ts: 1 },
      { side: "buy", tokens: 100, near: 30, usd: 150, ts: 2 },
      { side: "sell", tokens: 100, near: 25, usd: 125, ts: 3 },
    ])!;
    expect(e.tokens).toBe(100);
    expect(e.priceNear).toBeCloseTo(0.2);
    expect(e.priceUsd).toBeCloseTo(1);
    expect(e.costNear).toBeCloseTo(20);
  });
  it("drops duplicate transactions from the bot log and chain history", () => {
    const e = averageEntry([
      { side: "buy", tokens: 100, near: 10, usd: 50, tx: "abc", ts: 1 },
      { side: "buy", tokens: 100, near: 10, usd: 50, tx: "abc", ts: 1 },
    ])!;
    expect(e.tokens).toBe(100);
  });
  it("is null once fully sold", () => {
    expect(averageEntry([
      { side: "buy", tokens: 100, near: 10, usd: 50, ts: 1 },
      { side: "sell", tokens: 100, near: 12, usd: 60, ts: 2 },
    ])).toBeNull();
  });
  it("closes taxed round-trips so old trades don't leak into the current entry (real MEAR history)", () => {
    // Indexer sells show ~98% of what was bought (2% sell tax leaves separately); every sell was a full exit.
    const fills: Fill[] = [
      { side: "buy", tokens: 13_024_850, near: 30, usd: 154.5, tx: "a", ts: 1 },
      { side: "sell", tokens: 12_765_656, near: 32.777, usd: 173.92, tx: "b", ts: 2 },
      { side: "buy", tokens: 15_736_396, near: 40, usd: 206.4, tx: "c", ts: 3 },
      { side: "sell", tokens: 15_423_242, near: 38.452, usd: 205.66, tx: "d", ts: 4 },
      // The bot's record of its own buy (after-tax amount received) beats the indexer's pre-tax row.
      { side: "buy", tokens: 197_007.79, near: 1, usd: 5.33, tx: "e", ts: 5 },
      { side: "buy", tokens: 198_998, near: 1, usd: 5.33, tx: "e", ts: 5 },
    ];
    const e = averageEntry(fills)!;
    expect(e.tokens).toBeCloseTo(197_007.79);
    expect(e.costNear).toBeCloseTo(1);
    // Worth 0.9805 NEAR now -> -1.95%, not the +5.6% the old blending produced.
    expect(pnlPct(0.9805, holdingCost(e, 197_007.79).near)).toBeCloseTo(-1.95, 1);
  });
  it("treats a few % fewer tokens than bought as buy tax, not a partial exit", () => {
    const e = averageEntry([{ side: "buy", tokens: 198_998, near: 1, usd: 5, ts: 1 }])!;
    expect(holdingCost(e, 197_008).near).toBe(1);
    expect(holdingCost(e, 99_499).near).toBeCloseTo(0.5);
  });
  it("keeps a real partial position after a partial sell", () => {
    const e = averageEntry([
      { side: "buy", tokens: 1000, near: 10, usd: 50, ts: 1 },
      { side: "sell", tokens: 500, near: 6, usd: 30, ts: 2 },
    ])!;
    expect(e.tokens).toBe(500);
    expect(e.costNear).toBeCloseTo(5);
  });
  it("scales entry market cap with the current supply basis", () => {
    expect(entryMarketCap(0.001, 1_000_000, 0.002)).toBe(500_000);
  });
});

describe("price formatting", () => {
  it("uses subscript zeros for tiny prices", () => {
    expect(price(0.00000123)).toBe("0.0₅123");
    expect(price(0.00123)).toBe("0.00123");
    expect(price(5.3615)).toBe("5.3615");
  });
});
