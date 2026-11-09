import { BlockStream } from "./blocks.js";
import { detectLaunches } from "./launches.js";
/** How long a creator snipe waits for a launched token's pool to get liquidity. */
const LIQUIDITY_WAIT_MS = 10 * 60_000;
/** How often a launched token's pool is checked while waiting (it opens ~10-20s after launch). */
const LAUNCH_POLL_MS = 250;
/** How often a pasted token is checked until it trades. */
const TOKEN_POLL_MS = 1500;
/**
 * Creator snipes watch every new block for a launch by that wallet and buy the token the moment its
 * pool can fill the order (meme.cooking: deposit into the new raise). Token snipes buy a pasted token
 * as soon as it trades. Each snipe buys once; the block stream only runs while a creator snipe is active.
 */
export class Sniper {
    db;
    trader;
    rpc;
    dryRun;
    stream;
    pollers = new Map();
    /** Snipes with a buy under way, so a second launch in the meantime can't buy twice. */
    busy = new Set();
    /** Launches already handled per snipe: JustHoot announces a launch in more than one block. */
    seen = new Set();
    creators = new Map();
    onEvent = () => { };
    constructor(db, trader, rpc, dryRun) {
        this.db = db;
        this.trader = trader;
        this.rpc = rpc;
        this.dryRun = dryRun;
        this.stream = new BlockStream((b) => this.onBlock(b));
    }
    /** Loads this wallet's active snipes (also after a restart) and starts what they need. */
    start() {
        this.refresh();
    }
    stop() {
        this.stream.stop();
        for (const t of this.pollers.values())
            clearInterval(t);
        this.pollers.clear();
    }
    active() {
        return this.db.activeSnipes(this.trader.accountId);
    }
    get watching() {
        return this.stream.active;
    }
    add(kind, target, nearAmount, targetMcap, mcapDirection, sellPct) {
        const row = this.db.addSnipe(this.trader.accountId, kind, target, nearAmount, targetMcap, mcapDirection, sellPct);
        this.refresh();
        return row;
    }
    cancel(id) {
        const ok = this.db.finishSnipe(id, "cancelled", "Cancelled");
        this.refresh();
        return ok;
    }
    refresh() {
        const active = this.active();
        this.creators = new Map();
        for (const s of active.filter((s) => s.kind === "creator")) {
            this.creators.set(s.target, [...(this.creators.get(s.target) ?? []), s]);
        }
        if (this.creators.size)
            this.stream.start();
        else
            this.stream.stop();
        const pollIds = new Set(active.filter((s) => s.kind === "token" || s.kind === "limit_mcap" || s.kind === "limit_sell").map((s) => s.id));
        for (const [id, t] of this.pollers) {
            if (!pollIds.has(id)) {
                clearInterval(t);
                this.pollers.delete(id);
            }
        }
        for (const s of active) {
            if ((s.kind !== "token" && s.kind !== "limit_mcap" && s.kind !== "limit_sell") || this.pollers.has(s.id))
                continue;
            const fn = s.kind === "limit_mcap"
                ? () => void this.pollLimitMcap(s)
                : s.kind === "limit_sell"
                    ? () => void this.pollLimitSell(s)
                    : () => void this.pollToken(s);
            this.pollers.set(s.id, setInterval(fn, TOKEN_POLL_MS));
            void fn();
        }
    }
    // ------------------------------------------------------------ creator snipes
    onBlock(block) {
        if (!this.creators.size)
            return;
        for (const launch of detectLaunches(block)) {
            for (const snipe of this.creators.get(launch.creator) ?? []) {
                const key = `${snipe.id}:${launch.token ?? launch.memeId}`;
                if (this.busy.has(snipe.id) || this.seen.has(key))
                    continue;
                this.seen.add(key);
                void this.fireCreator(snipe, launch);
            }
        }
    }
    async fireCreator(snipe, launch) {
        const settings = this.db.settings();
        const lagSec = (Date.now() - launch.atMs) / 1000;
        if (lagSec > settings.snipeMaxDelaySec) {
            this.onEvent({ type: "skipped", snipe, launch, reason: `the bot saw it ${lagSec.toFixed(0)}s after launch (limit ${settings.snipeMaxDelaySec}s)` });
            return;
        }
        this.busy.add(snipe.id);
        this.onEvent({ type: "launch", snipe, launch });
        const ref = launch.memeId != null ? `meme:${launch.memeId}` : launch.token;
        try {
            const started = Date.now();
            const hint = launch.poolId && launch.quote ? { poolId: launch.poolId, quote: launch.quote } : undefined;
            const route = await this.waitForPool(ref, snipe, launch.atMs + LIQUIDITY_WAIT_MS, LAUNCH_POLL_MS, hint);
            if (!route) {
                this.onEvent({ type: "failed", snipe, ref, error: "Its pool didn't open within 10 minutes. Still watching for their next launch.", ended: false });
                return;
            }
            await this.execute(snipe, ref, route, started, false);
        }
        finally {
            this.busy.delete(snipe.id);
        }
    }
    /**
     * Polls until `ref` can be bought, registering on the token as soon as its contract exists
     * (in parallel, so the buy itself is one transaction). Returns null at the deadline or on cancel.
     */
    async waitForPool(ref, snipe, deadline, everyMs, hint) {
        const settings = this.db.settings();
        let prep = null;
        while (Date.now() < deadline) {
            if (this.db.snipe(snipe.id)?.status !== "active")
                return null;
            if (!prep && !this.dryRun && !ref.startsWith("meme:") && (await this.rpc.accountExists(ref).catch(() => false))) {
                prep = this.trader.prepareBuy(ref).catch(() => { }); // If it fails, the buy registers instead.
            }
            const route = await this.trader.liveRoute(ref, snipe.nearAmount, settings, hint).catch(() => null);
            if (route) {
                await prep;
                return route;
            }
            await new Promise((ok) => setTimeout(ok, everyMs));
        }
        return null;
    }
    // ------------------------------------------------------------ token snipes
    async pollToken(snipe) {
        if (this.busy.has(snipe.id))
            return;
        this.busy.add(snipe.id);
        try {
            if (this.db.snipe(snipe.id)?.status !== "active")
                return;
            const route = await this.trader.liveRoute(snipe.target, snipe.nearAmount, this.db.settings()).catch(() => null);
            if (!route)
                return;
            clearInterval(this.pollers.get(snipe.id));
            this.pollers.delete(snipe.id);
            await this.execute(snipe, snipe.target, route, Date.now(), true);
        }
        finally {
            this.busy.delete(snipe.id);
        }
    }
    async pollLimitMcap(snipe) {
        if (this.busy.has(snipe.id))
            return;
        this.busy.add(snipe.id);
        try {
            if (this.db.snipe(snipe.id)?.status !== "active")
                return;
            const settings = this.db.settings();
            const s = await this.trader.snapshot(snipe.target, settings).catch(() => null);
            if (!s || !s.info || s.info.marketCapUsd <= 0)
                return;
            const currentMcap = s.info.marketCapUsd;
            const targetMcap = snipe.targetMcap;
            if (targetMcap == null || targetMcap <= 0)
                return;
            const triggered = snipe.mcapDirection === "gte"
                ? currentMcap >= targetMcap
                : currentMcap <= targetMcap;
            if (!triggered)
                return;
            clearInterval(this.pollers.get(snipe.id));
            this.pollers.delete(snipe.id);
            const route = await this.trader.liveRoute(snipe.target, snipe.nearAmount, settings).catch(() => null);
            if (!route)
                return;
            await this.execute(snipe, snipe.target, route, Date.now(), true);
        }
        finally {
            this.busy.delete(snipe.id);
        }
    }
    async pollLimitSell(snipe) {
        if (this.busy.has(snipe.id))
            return;
        this.busy.add(snipe.id);
        try {
            if (this.db.snipe(snipe.id)?.status !== "active")
                return;
            const settings = this.db.settings();
            const s = await this.trader.snapshot(snipe.target, settings).catch(() => null);
            if (!s || !s.info || s.info.marketCapUsd <= 0)
                return;
            const currentMcap = s.info.marketCapUsd;
            const targetMcap = snipe.targetMcap;
            if (targetMcap == null || targetMcap <= 0)
                return;
            const triggered = snipe.mcapDirection === "gte"
                ? currentMcap >= targetMcap
                : currentMcap <= targetMcap;
            if (!triggered)
                return;
            if (s.balance <= 0n) {
                this.db.finishSnipe(snipe.id, "failed", "No token balance to sell");
                this.refresh();
                this.onEvent({ type: "failed", snipe, ref: snipe.target, error: "No token balance to sell", ended: true });
                return;
            }
            clearInterval(this.pollers.get(snipe.id));
            this.pollers.delete(snipe.id);
            const sellPct = snipe.sellPct ?? 100;
            await this.executeSell(snipe, snipe.target, sellPct, Date.now());
        }
        finally {
            this.busy.delete(snipe.id);
        }
    }
    // ------------------------------------------------------------ buying & selling
    /**
     * Buys once. A creator snipe that fails keeps watching for the creator's next launch;
     * a token snipe ends either way, so a failing buy can't repeat and burn gas.
     */
    async execute(snipe, ref, route, started, endOnFailure) {
        if (this.dryRun) {
            this.db.finishSnipe(snipe.id, "done", `DRY RUN: would buy ${ref}`);
            this.refresh();
            this.onEvent({ type: "dryRun", snipe, ref, route });
            return;
        }
        try {
            const outcome = await this.trader.buyVia(ref, snipe.nearAmount, this.db.settings(), route);
            this.db.finishSnipe(snipe.id, "done", `Bought ${ref}: ${outcome.hashes.at(-1) ?? ""}`);
            this.refresh();
            this.onEvent({ type: "bought", snipe, ref, outcome, secs: (Date.now() - started) / 1000 });
        }
        catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            if (endOnFailure) {
                this.db.finishSnipe(snipe.id, "failed", error);
                this.refresh();
            }
            this.onEvent({ type: "failed", snipe, ref, error, ended: endOnFailure });
        }
    }
    async executeSell(snipe, ref, pct, started) {
        if (this.dryRun) {
            this.db.finishSnipe(snipe.id, "done", `DRY RUN: would sell ${pct}% of ${ref}`);
            this.refresh();
            this.onEvent({
                type: "dryRun",
                snipe,
                ref,
                route: { kind: "router", label: `Sell ${pct}%` },
            });
            return;
        }
        try {
            const outcome = await this.trader.sell(ref, pct, this.db.settings());
            this.db.finishSnipe(snipe.id, "done", `Sold ${pct}% of ${ref}: ${outcome.hashes.at(-1) ?? ""}`);
            this.refresh();
            this.onEvent({ type: "bought", snipe, ref, outcome, secs: (Date.now() - started) / 1000 });
        }
        catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            this.db.finishSnipe(snipe.id, "failed", error);
            this.refresh();
            this.onEvent({ type: "failed", snipe, ref, error, ended: true });
        }
    }
}
//# sourceMappingURL=sniper.js.map