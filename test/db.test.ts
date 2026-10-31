import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

const trade = (account: string, tx: string) => ({ account, token: "hoot.near", side: "buy" as const, nearAmount: 1, tokenAmount: 100, usdValue: 5, via: "Rhea DCL", txHash: tx, ts: 1 });

describe("Db trade log", () => {
  it("keeps each wallet's trades apart", () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), "bot-")), "bot.db"));
    db.addTrade(trade("old.near", "a"));
    db.addTrade(trade("new.near", "b"));
    expect(db.trades("hoot.near", "new.near").map((t) => t.txHash)).toEqual(["b"]);
    expect(db.trades("hoot.near", "old.near").map((t) => t.txHash)).toEqual(["a"]);
  });

  it("upgrades an old log without wallets and leaves its rows out until tagged", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bot-")), "bot.db");
    const raw = new Database(path);
    raw.exec(`CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL, side TEXT NOT NULL,
      near_amount REAL NOT NULL, token_amount REAL NOT NULL, usd_value REAL NOT NULL, via TEXT NOT NULL, tx_hash TEXT NOT NULL, ts INTEGER NOT NULL);
      INSERT INTO trades (token, side, near_amount, token_amount, usd_value, via, tx_hash, ts) VALUES ('hoot.near','buy',1,100,5,'x','legacy',1);`);
    raw.close();

    const db = new Db(path);
    expect(db.trades("hoot.near", "new.near")).toEqual([]);
    const [legacy] = db.untaggedTrades();
    expect(legacy!.txHash).toBe("legacy");
    db.tagTrade(legacy!.id, "new.near");
    expect(db.trades("hoot.near", "new.near").map((t) => t.txHash)).toEqual(["legacy"]);
    expect(db.untaggedTrades()).toEqual([]);
  });
});
