import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type RouteMode = "original" | "best";

export interface Settings {
  /** Buy buttons, in NEAR. */
  buyPresets: number[];
  /** Sell buttons, in percent of holdings. */
  sellPresets: number[];
  slippagePct: number;
  /** "original" = the token's own pool; "best" = best price across all DEXes. */
  routeMode: RouteMode;
  /** Positions worth less than this (USD) are hidden. */
  minPositionUsd: number;
  /** A creator snipe skips a launch the bot noticed more than this many seconds after it happened. */
  snipeMaxDelaySec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  buyPresets: [20, 50, 100],
  sellPresets: [25, 50, 75, 100],
  slippagePct: 50,
  routeMode: "original",
  minPositionUsd: 1,
  snipeMaxDelaySec: 20,
};

export interface TradeRow {
  /** Wallet that made the trade. */
  account: string;
  token: string;
  side: "buy" | "sell";
  nearAmount: number;
  tokenAmount: number;
  usdValue: number;
  via: string;
  txHash: string;
  ts: number;
}

export type SnipeKind = "creator" | "token";
export type SnipeStatus = "active" | "done" | "failed" | "cancelled";

export interface SnipeRow {
  id: number;
  /** Wallet the snipe buys with. */
  account: string;
  /** "creator": buy the first fresh token this wallet launches. "token": buy this token once it trades. */
  kind: SnipeKind;
  /** Creator wallet, or a token ref (account or "meme:<id>"). */
  target: string;
  nearAmount: number;
  status: SnipeStatus;
  createdAt: number;
  result: string | null;
}

export class Db {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL, side TEXT NOT NULL,
        near_amount REAL NOT NULL, token_amount REAL NOT NULL, usd_value REAL NOT NULL,
        via TEXT NOT NULL, tx_hash TEXT NOT NULL, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trades_token ON trades(token);
      CREATE TABLE IF NOT EXISTS snipes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, near_amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, result TEXT
      );
    `);
    // Older logs have no wallet column; rows added before it stay NULL until tagged.
    const cols = this.db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "account")) this.db.exec("ALTER TABLE trades ADD COLUMN account TEXT");
  }

  settings(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  /**
   * Short numeric id for a token reference, so Telegram button data stays under 64 bytes.
   * A ref is a token account, "meme:<id>" or "stock:<symbol>".
   */
  tokenId(ref: string): number {
    this.db.prepare("INSERT OR IGNORE INTO tokens (ref) VALUES (?)").run(ref);
    return (this.db.prepare("SELECT id FROM tokens WHERE ref = ?").get(ref) as { id: number }).id;
  }

  tokenRef(id: number): string | null {
    return (this.db.prepare("SELECT ref FROM tokens WHERE id = ?").get(id) as { ref: string } | undefined)?.ref ?? null;
  }

  addTrade(t: TradeRow): void {
    this.db
      .prepare("INSERT INTO trades (account, token, side, near_amount, token_amount, usd_value, via, tx_hash, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.account, t.token, t.side, t.nearAmount, t.tokenAmount, t.usdValue, t.via, t.txHash, t.ts);
  }

  /** One wallet's logged trades of a token, oldest first. */
  trades(token: string, account: string): TradeRow[] {
    return (
      this.db
        .prepare("SELECT account, token, side, near_amount, token_amount, usd_value, via, tx_hash, ts FROM trades WHERE token = ? AND account = ? ORDER BY ts")
        .all(token, account) as Array<{ account: string; token: string; side: "buy" | "sell"; near_amount: number; token_amount: number; usd_value: number; via: string; tx_hash: string; ts: number }>
    ).map((r) => ({ account: r.account, token: r.token, side: r.side, nearAmount: r.near_amount, tokenAmount: r.token_amount, usdValue: r.usd_value, via: r.via, txHash: r.tx_hash, ts: r.ts }));
  }

  /** Trades logged before wallets were recorded. */
  untaggedTrades(): Array<{ id: number; txHash: string }> {
    return (this.db.prepare("SELECT id, tx_hash FROM trades WHERE account IS NULL").all() as Array<{ id: number; tx_hash: string }>).map((r) => ({ id: r.id, txHash: r.tx_hash }));
  }

  tagTrade(id: number, account: string): void {
    this.db.prepare("UPDATE trades SET account = ? WHERE id = ?").run(account, id);
  }

  addSnipe(account: string, kind: SnipeKind, target: string, nearAmount: number): SnipeRow {
    const r = this.db
      .prepare("INSERT INTO snipes (account, kind, target, near_amount, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(account, kind, target, nearAmount, Date.now());
    return this.snipe(Number(r.lastInsertRowid))!;
  }

  snipe(id: number): SnipeRow | null {
    const r = this.db.prepare("SELECT * FROM snipes WHERE id = ?").get(id) as RawSnipe | undefined;
    return r ? toSnipe(r) : null;
  }

  /** One wallet's snipes still waiting to fire, oldest first. */
  activeSnipes(account: string): SnipeRow[] {
    return (this.db.prepare("SELECT * FROM snipes WHERE account = ? AND status = 'active' ORDER BY id").all(account) as RawSnipe[]).map(toSnipe);
  }

  /** Ends a snipe; false if it had already ended (so only one caller ever acts on it). */
  finishSnipe(id: number, status: Exclude<SnipeStatus, "active">, result: string): boolean {
    return this.db.prepare("UPDATE snipes SET status = ?, result = ? WHERE id = ? AND status = 'active'").run(status, result, id).changes > 0;
  }
}

type RawSnipe = { id: number; account: string; kind: SnipeKind; target: string; near_amount: number; status: SnipeStatus; created_at: number; result: string | null };

function toSnipe(r: RawSnipe): SnipeRow {
  return { id: r.id, account: r.account, kind: r.kind, target: r.target, nearAmount: r.near_amount, status: r.status, createdAt: r.created_at, result: r.result };
}
