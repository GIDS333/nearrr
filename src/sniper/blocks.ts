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

export interface ChainReceipt {
  /** Contract that wrote the log. */
  executor: string;
  predecessor: string;
  txHash: string | null;
  logs: string[];
}

export interface ChainBlock {
  height: number;
  timestampMs: number;
  receipts: ChainReceipt[];
}

export interface RawEvent {
  account_id: string;
  predecessor_id: string;
  block_height: number;
  block_timestamp_nanosec: string;
  transaction_id?: string | null;
  receipt_id: string;
  event_standard: string;
  event_version: string;
  event_event: string;
  event_data: unknown;
}

/** Groups one message's events by block, each event as the EVENT_JSON log it came from. */
export function toChainBlocks(events: RawEvent[]): ChainBlock[] {
  const blocks = new Map<number, ChainBlock>();
  for (const e of events) {
    if (!LAUNCH_STANDARDS.has(e.event_standard)) continue;
    let b = blocks.get(e.block_height);
    if (!b) {
      b = { height: e.block_height, timestampMs: Number(BigInt(e.block_timestamp_nanosec) / 1_000_000n), receipts: [] };
      blocks.set(e.block_height, b);
    }
    const log = `EVENT_JSON:${JSON.stringify({ standard: e.event_standard, version: e.event_version, event: e.event_event, data: e.event_data })}`;
    b.receipts.push({ executor: e.account_id, predecessor: e.predecessor_id, txHash: e.transaction_id ?? null, logs: [log] });
  }
  return [...blocks.values()].sort((a, b) => a.height - b.height);
}

/** Streams launchpad events to `onBlock`, reconnecting on its own; runs only while started. */
export class BlockStream {
  private running = false;
  private ws: WebSocket | null = null;
  private retry?: NodeJS.Timeout;

  constructor(private readonly onBlock: (b: ChainBlock) => void, private readonly url = EVENTS_URL) {}

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(LAUNCH_FILTER));
    ws.onmessage = (m) => {
      const text = String(m.data);
      try {
        for (const b of toChainBlocks(JSON.parse(text) as RawEvent[])) this.onBlock(b);
      } catch (e) {
        console.error("Sniper event stream:", e instanceof SyntaxError ? text.slice(0, 200) : e);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || !this.running) return;
      this.retry = setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
  }
}
