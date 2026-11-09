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

export type SnipeKind = "creator" | "token" | "limit_mcap" | "limit_sell";
export type SnipeStatus = "active" | "done" | "failed" | "cancelled";
export type McapDirection = "lte" | "gte";

export interface SnipeRow {
  id: number;
  /** Wallet the snipe buys with. */
  account: string;
  /** "creator": buy the first fresh token this wallet launches. "token": buy this token once it trades. "limit_mcap": buy at a specific market cap. "limit_sell": sell at a specific market cap. */
  kind: SnipeKind;
  /** Creator wallet, or a token ref (account or "meme:<id>"). */
  target: string;
  nearAmount: number;
  status: SnipeStatus;
  createdAt: number;
  result: string | null;
  targetMcap?: number | null;
  mcapDirection?: McapDirection | null;
  sellPct?: number | null;
}

export interface WalletRow {
  id: number;
  accountId: string;
  privateKey: string;
  isActive: boolean;
  createdAt: number;
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
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, result TEXT,
        target_mcap REAL, mcap_direction TEXT
      );
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL UNIQUE,
        private_key TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    // Older logs have no wallet column; rows added before it stay NULL until tagged.
    const cols = this.db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "account")) this.db.exec("ALTER TABLE trades ADD COLUMN account TEXT");

    const snipeCols = this.db.prepare("PRAGMA table_info(snipes)").all() as Array<{ name: string }>;
    if (!snipeCols.some((c) => c.name === "target_mcap")) this.db.exec("ALTER TABLE snipes ADD COLUMN target_mcap REAL");
    if (!snipeCols.some((c) => c.name === "mcap_direction")) this.db.exec("ALTER TABLE snipes ADD COLUMN mcap_direction TEXT");
    if (!snipeCols.some((c) => c.name === "sell_pct")) this.db.exec("ALTER TABLE snipes ADD COLUMN sell_pct REAL");

    // Fix legacy HOOT buy if it was incorrectly divided by 10^24 instead of 10^18
    this.db.exec("UPDATE trades SET token_amount = 103222.71334958014 WHERE token = 'hoot-8ecf65.launchpad.justhoot.near' AND side = 'buy' AND token_amount < 1");
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

  addSnipe(
    account: string,
    kind: SnipeKind,
    target: string,
    nearAmount: number,
    targetMcap?: number | null,
    mcapDirection?: McapDirection | null,
    sellPct?: number | null,
  ): SnipeRow {
    const r = this.db
      .prepare(
        "INSERT INTO snipes (account, kind, target, near_amount, target_mcap, mcap_direction, sell_pct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(account, kind, target, nearAmount, targetMcap ?? null, mcapDirection ?? null, sellPct ?? null, Date.now());
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

  ensureWallet(accountId: string, privateKey: string): void {
    const count = (this.db.prepare("SELECT count(*) as c FROM wallets").get() as { c: number }).c;
    if (count === 0) {
      this.addWallet(accountId, privateKey, true);
    }
  }

  wallets(): WalletRow[] {
    const rows = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets ORDER BY created_at ASC").all() as Array<{
      id: number;
      account_id: string;
      private_key: string;
      is_active: number;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      privateKey: r.private_key,
      isActive: r.is_active === 1,
      createdAt: r.created_at,
    }));
  }

  activeWallet(): WalletRow | null {
    const row = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets WHERE is_active = 1 LIMIT 1").get() as
      | { id: number; account_id: string; private_key: string; is_active: number; created_at: number }
      | undefined;
    if (row) {
      return {
        id: row.id,
        accountId: row.account_id,
        privateKey: row.private_key,
        isActive: true,
        createdAt: row.created_at,
      };
    }
    const all = this.wallets();
    if (all.length > 0) {
      this.setActiveWallet(all[0]!.id);
      return { ...all[0]!, isActive: true };
    }
    return null;
  }

  wallet(accountId: string): WalletRow | null {
    const row = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets WHERE account_id = ?").get(accountId) as
      | { id: number; account_id: string; private_key: string; is_active: number; created_at: number }
      | undefined;
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          privateKey: row.private_key,
          isActive: row.is_active === 1,
          createdAt: row.created_at,
        }
      : null;
  }

  walletById(id: number): WalletRow | null {
    const row = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets WHERE id = ?").get(id) as
      | { id: number; account_id: string; private_key: string; is_active: number; created_at: number }
      | undefined;
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          privateKey: row.private_key,
          isActive: row.is_active === 1,
          createdAt: row.created_at,
        }
      : null;
  }

  addWallet(accountId: string, privateKey: string, setActive = true): WalletRow {
    return this.db.transaction(() => {
      if (setActive) {
        this.db.prepare("UPDATE wallets SET is_active = 0").run();
      }
      const createdAt = Date.now();
      const existing = this.wallet(accountId);
      if (existing) {
        this.db
          .prepare("UPDATE wallets SET private_key = ?, is_active = ? WHERE id = ?")
          .run(privateKey, setActive ? 1 : existing.isActive ? 1 : 0, existing.id);
        return {
          id: existing.id,
          accountId,
          privateKey,
          isActive: setActive || existing.isActive,
          createdAt: existing.createdAt,
        };
      }
      const r = this.db
        .prepare("INSERT INTO wallets (account_id, private_key, is_active, created_at) VALUES (?, ?, ?, ?)")
        .run(accountId, privateKey, setActive ? 1 : 0, createdAt);
      return {
        id: Number(r.lastInsertRowid),
        accountId,
        privateKey,
        isActive: setActive,
        createdAt,
      };
    })();
  }

  setActiveWallet(idOrAccountId: number | string): boolean {
    const target = typeof idOrAccountId === "number" ? this.walletById(idOrAccountId) : this.wallet(idOrAccountId);
    if (!target) return false;
    this.db.transaction(() => {
      this.db.prepare("UPDATE wallets SET is_active = 0").run();
      this.db.prepare("UPDATE wallets SET is_active = 1 WHERE id = ?").run(target.id);
    })();
    return true;
  }

  removeWallet(id: number): boolean {
    const target = this.walletById(id);
    if (!target) return false;
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM wallets WHERE id = ?").run(id);
      if (target.isActive) {
        const remaining = this.wallets();
        if (remaining.length > 0) {
          this.db.prepare("UPDATE wallets SET is_active = 1 WHERE id = ?").run(remaining[0]!.id);
        }
      }
      return true;
    })();
  }
}

type RawSnipe = {
  id: number;
  account: string;
  kind: SnipeKind;
  target: string;
  near_amount: number;
  status: SnipeStatus;
  created_at: number;
  result: string | null;
  target_mcap?: number | null;
  mcap_direction?: McapDirection | null;
  sell_pct?: number | null;
};

function toSnipe(r: RawSnipe): SnipeRow {
  return {
    id: r.id,
    account: r.account,
    kind: r.kind,
    target: r.target,
    nearAmount: r.near_amount,
    status: r.status,
    createdAt: r.created_at,
    result: r.result,
    targetMcap: r.target_mcap ?? null,
    mcapDirection: r.mcap_direction ?? null,
    sellPct: r.sell_pct ?? null,
  };
}
