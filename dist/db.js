import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
export const DEFAULT_SETTINGS = {
    buyPresets: [20, 50, 100],
    sellPresets: [25, 50, 75, 100],
    slippagePct: 50,
    routeMode: "original",
    minPositionUsd: 1,
    snipeMaxDelaySec: 20,
};
export class Db {
    db;
    constructor(path) {
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
        const cols = this.db.prepare("PRAGMA table_info(trades)").all();
        if (!cols.some((c) => c.name === "account"))
            this.db.exec("ALTER TABLE trades ADD COLUMN account TEXT");
        const snipeCols = this.db.prepare("PRAGMA table_info(snipes)").all();
        if (!snipeCols.some((c) => c.name === "target_mcap"))
            this.db.exec("ALTER TABLE snipes ADD COLUMN target_mcap REAL");
        if (!snipeCols.some((c) => c.name === "mcap_direction"))
            this.db.exec("ALTER TABLE snipes ADD COLUMN mcap_direction TEXT");
        if (!snipeCols.some((c) => c.name === "sell_pct"))
            this.db.exec("ALTER TABLE snipes ADD COLUMN sell_pct REAL");
        // Fix legacy HOOT buy if it was incorrectly divided by 10^24 instead of 10^18
        this.db.exec("UPDATE trades SET token_amount = 103222.71334958014 WHERE token = 'hoot-8ecf65.launchpad.justhoot.near' AND side = 'buy' AND token_amount < 1");
    }
    settings() {
        const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
        return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
    }
    saveSettings(patch) {
        const next = { ...this.settings(), ...patch };
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
        return next;
    }
    /**
     * Short numeric id for a token reference, so Telegram button data stays under 64 bytes.
     * A ref is a token account, "meme:<id>" or "stock:<symbol>".
     */
    tokenId(ref) {
        this.db.prepare("INSERT OR IGNORE INTO tokens (ref) VALUES (?)").run(ref);
        return this.db.prepare("SELECT id FROM tokens WHERE ref = ?").get(ref).id;
    }
    tokenRef(id) {
        return this.db.prepare("SELECT ref FROM tokens WHERE id = ?").get(id)?.ref ?? null;
    }
    addTrade(t) {
        this.db
            .prepare("INSERT INTO trades (account, token, side, near_amount, token_amount, usd_value, via, tx_hash, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(t.account, t.token, t.side, t.nearAmount, t.tokenAmount, t.usdValue, t.via, t.txHash, t.ts);
    }
    /** One wallet's logged trades of a token, oldest first. */
    trades(token, account) {
        return this.db
            .prepare("SELECT account, token, side, near_amount, token_amount, usd_value, via, tx_hash, ts FROM trades WHERE token = ? AND account = ? ORDER BY ts")
            .all(token, account).map((r) => ({ account: r.account, token: r.token, side: r.side, nearAmount: r.near_amount, tokenAmount: r.token_amount, usdValue: r.usd_value, via: r.via, txHash: r.tx_hash, ts: r.ts }));
    }
    /** Trades logged before wallets were recorded. */
    untaggedTrades() {
        return this.db.prepare("SELECT id, tx_hash FROM trades WHERE account IS NULL").all().map((r) => ({ id: r.id, txHash: r.tx_hash }));
    }
    tagTrade(id, account) {
        this.db.prepare("UPDATE trades SET account = ? WHERE id = ?").run(account, id);
    }
    addSnipe(account, kind, target, nearAmount, targetMcap, mcapDirection, sellPct) {
        const r = this.db
            .prepare("INSERT INTO snipes (account, kind, target, near_amount, target_mcap, mcap_direction, sell_pct, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(account, kind, target, nearAmount, targetMcap ?? null, mcapDirection ?? null, sellPct ?? null, Date.now());
        return this.snipe(Number(r.lastInsertRowid));
    }
    snipe(id) {
        const r = this.db.prepare("SELECT * FROM snipes WHERE id = ?").get(id);
        return r ? toSnipe(r) : null;
    }
    /** One wallet's snipes still waiting to fire, oldest first. */
    activeSnipes(account) {
        return this.db.prepare("SELECT * FROM snipes WHERE account = ? AND status = 'active' ORDER BY id").all(account).map(toSnipe);
    }
    /** Ends a snipe; false if it had already ended (so only one caller ever acts on it). */
    finishSnipe(id, status, result) {
        return this.db.prepare("UPDATE snipes SET status = ?, result = ? WHERE id = ? AND status = 'active'").run(status, result, id).changes > 0;
    }
    ensureWallet(accountId, privateKey) {
        const count = this.db.prepare("SELECT count(*) as c FROM wallets").get().c;
        if (count === 0) {
            this.addWallet(accountId, privateKey, true);
        }
    }
    wallets() {
        const rows = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets ORDER BY created_at ASC").all();
        return rows.map((r) => ({
            id: r.id,
            accountId: r.account_id,
            privateKey: r.private_key,
            isActive: r.is_active === 1,
            createdAt: r.created_at,
        }));
    }
    activeWallet() {
        const row = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets WHERE is_active = 1 LIMIT 1").get();
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
            this.setActiveWallet(all[0].id);
            return { ...all[0], isActive: true };
        }
        return null;
    }
    wallet(accountId) {
        const row = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets WHERE account_id = ?").get(accountId);
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
    walletById(id) {
        const row = this.db.prepare("SELECT id, account_id, private_key, is_active, created_at FROM wallets WHERE id = ?").get(id);
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
    addWallet(accountId, privateKey, setActive = true) {
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
    setActiveWallet(idOrAccountId) {
        const target = typeof idOrAccountId === "number" ? this.walletById(idOrAccountId) : this.wallet(idOrAccountId);
        if (!target)
            return false;
        this.db.transaction(() => {
            this.db.prepare("UPDATE wallets SET is_active = 0").run();
            this.db.prepare("UPDATE wallets SET is_active = 1 WHERE id = ?").run(target.id);
        })();
        return true;
    }
    removeWallet(id) {
        const target = this.walletById(id);
        if (!target)
            return false;
        return this.db.transaction(() => {
            this.db.prepare("DELETE FROM wallets WHERE id = ?").run(id);
            if (target.isActive) {
                const remaining = this.wallets();
                if (remaining.length > 0) {
                    this.db.prepare("UPDATE wallets SET is_active = 1 WHERE id = ?").run(remaining[0].id);
                }
            }
            return true;
        })();
    }
}
function toSnipe(r) {
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
//# sourceMappingURL=db.js.map