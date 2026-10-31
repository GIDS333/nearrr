/**
 * Live launchpad events from Intear's free event stream (the same feed its own apps use). Only
 * EVENT_JSON logs from the launchpad contracts are sent, so the bot never downloads whole blocks.
 */
import WebSocket from "ws";
const EVENTS_URL = "wss://ws-events-v3.intear.tech/events/log_nep297";
/** Server-side filter: events from the JustHoot, Nearly and meme.cooking contracts only. */
export const LAUNCH_FILTER = {
    Or: [
        { path: "account_id", operator: { Equals: "nearlytrade.near" } },
        { path: "account_id", operator: { Equals: "meme-cooking.near" } },
        { path: "account_id", operator: { EndsWith: "-launchpad.justhoot.near" } },
    ],
};
/** Launch events come in these standards; the rest (token transfers, taxes) is dropped on arrival. */
const LAUNCH_STANDARDS = new Set(["nearpad", "hoot_launcher_v2", "meme-cooking"]);
/** Groups one message's events by block, each event as the EVENT_JSON log it came from. */
export function toChainBlocks(events) {
    const blocks = new Map();
    for (const e of events) {
        if (!LAUNCH_STANDARDS.has(e.event_standard))
            continue;
        let b = blocks.get(e.block_height);
        if (!b) {
            b = { height: e.block_height, timestampMs: Number(BigInt(e.block_timestamp_nanosec) / 1000000n), receipts: [] };
            blocks.set(e.block_height, b);
        }
        const log = `EVENT_JSON:${JSON.stringify({ standard: e.event_standard, version: e.event_version, event: e.event_event, data: e.event_data })}`;
        b.receipts.push({ executor: e.account_id, predecessor: e.predecessor_id, txHash: e.transaction_id ?? null, logs: [log] });
    }
    return [...blocks.values()].sort((a, b) => a.height - b.height);
}
/** Streams launchpad events to `onBlock`, reconnecting on its own; runs only while started. */
export class BlockStream {
    onBlock;
    url;
    running = false;
    ws = null;
    retry;
    constructor(onBlock, url = EVENTS_URL) {
        this.onBlock = onBlock;
        this.url = url;
    }
    get active() {
        return this.running;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.connect();
    }
    stop() {
        this.running = false;
        clearTimeout(this.retry);
        this.ws?.close();
        this.ws = null;
    }
    connect() {
        if (!this.running)
            return;
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.onopen = () => ws.send(JSON.stringify(LAUNCH_FILTER));
        ws.onmessage = (m) => {
            const text = String(m.data);
            try {
                for (const b of toChainBlocks(JSON.parse(text)))
                    this.onBlock(b);
            }
            catch (e) {
                console.error("Sniper event stream:", e instanceof SyntaxError ? text.slice(0, 200) : e);
            }
        };
        ws.onclose = () => {
            if (this.ws !== ws || !this.running)
                return;
            this.retry = setTimeout(() => this.connect(), 1000);
        };
        ws.onerror = () => ws.close();
    }
}
//# sourceMappingURL=blocks.js.map