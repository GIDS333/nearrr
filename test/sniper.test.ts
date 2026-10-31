import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { toChainBlocks, type ChainReceipt } from "../src/sniper/blocks.js";
import { detectLaunches } from "../src/sniper/launches.js";

// Event logs from real launches: GLD on Nearly, FATCAT on JustHoot, GOP on meme.cooking.
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/launches.json", import.meta.url), "utf8")) as Record<string, ChainReceipt[]>;
const block = (receipts: ChainReceipt[]) => ({ height: 1, timestampMs: 1000, receipts });

describe("detectLaunches", () => {
  it("finds a Nearly launch with its creator and pool", () => {
    expect(detectLaunches(block(fixtures.nearly!))).toEqual([
      expect.objectContaining({
        platform: "Nearly",
        creator: "1cd754c78eeb71972510c2cd6450d2c6f112c5ea84fe87c206eb3b82d849c088",
        token: "gld.nearlytrade.near",
        poolId: "gld.nearlytrade.near|wrap.near|10000",
        quote: "wrap.near",
      }),
    ]);
  });

  it("finds a JustHoot launch once, though it's announced twice", () => {
    expect(detectLaunches(block(fixtures.justhoot!))).toEqual([
      expect.objectContaining({
        platform: "JustHoot",
        creator: "soonseal1786.near",
        token: "fatcat-2.v2-launchpad.justhoot.near",
        poolId: "fatcat-2.v2-launchpad.justhoot.near|wrap.near|10000",
      }),
    ]);
  });

  it("finds a new meme.cooking raise", () => {
    expect(detectLaunches(block(fixtures.memecooking!))).toEqual([expect.objectContaining({ platform: "meme.cooking", creator: "arz20.tg", memeId: 2301 })]);
  });

  it("ignores the same events written by any other contract", () => {
    const fake = [...fixtures.nearly!, ...fixtures.justhoot!, ...fixtures.memecooking!].map((r) => ({ ...r, executor: "scam.near" }));
    expect(detectLaunches(block(fake))).toEqual([]);
    // A real launchpad can't announce a token outside its own accounts either.
    const foreign = fixtures.nearly!.map((r) => ({ ...r, logs: r.logs.map((l) => l.replaceAll("gld.nearlytrade.near", "gld.scam.near")) }));
    expect(detectLaunches(block(foreign))).toEqual([]);
  });
});

describe("toChainBlocks", () => {
  it("turns streamed events back into launchpad logs, grouped by block", () => {
    const ev = (height: number, data: unknown) => ({
      account_id: "nearlytrade.near", predecessor_id: "dev.near", block_height: height, block_timestamp_nanosec: "1793355917859436134",
      transaction_id: "T", receipt_id: "R", event_standard: "nearpad", event_version: "2.0.0", event_event: "launch_started", event_data: data,
    });
    const blocks = toChainBlocks([ev(8, [{ token: "b.nearlytrade.near", creator: "dev.near" }]), ev(7, [{ token: "a.nearlytrade.near", creator: "dev.near" }])]);
    expect(blocks.map((b) => b.height)).toEqual([7, 8]);
    expect(blocks[0]!.timestampMs).toBe(1793355917859);
    expect(detectLaunches(blocks[0]!)).toEqual([expect.objectContaining({ platform: "Nearly", creator: "dev.near", token: "a.nearlytrade.near", txHash: "T" })]);
  });
});

describe("Db snipes", () => {
  it("keeps snipes per wallet and ends each one only once", () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), "bot-")), "bot.db"));
    const a = db.addSnipe("me.near", "creator", "dev.near", 5);
    db.addSnipe("other.near", "token", "x.near", 1);
    expect(db.activeSnipes("me.near").map((s) => [s.kind, s.target, s.nearAmount])).toEqual([["creator", "dev.near", 5]]);
    expect(db.finishSnipe(a.id, "done", "bought")).toBe(true);
    expect(db.finishSnipe(a.id, "cancelled", "late")).toBe(false);
    expect(db.activeSnipes("me.near")).toEqual([]);
    expect(db.settings().snipeMaxDelaySec).toBe(20);
  });
});
