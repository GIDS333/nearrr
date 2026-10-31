import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import { fromRaw, yoctoToNear } from "../amount.js";
import type { Db, Settings } from "../db.js";
import { holdingCost, pnlPct } from "../entry.js";
import type { Intear } from "../market/intear.js";
import type { Rpc } from "../near/rpc.js";
import type { Trader, Snapshot, TradeOutcome, WithdrawPlan } from "../trader.js";
import { parseInput } from "../venues/parse.js";
import { STOCKS } from "../venues/stocks.js";
import { INTENTS, stockAsset } from "../venues/oneclick.js";
import { MEME_COOKING } from "../venues/memecooking.js";
import { compact, esc, near, pct, pnlEmoji, tokenCard, txLink, usd } from "./format.js";
import { pnlCardData, renderPnlCard } from "./pnlCard.js";
import type { SnipeRow } from "../db.js";
import type { Sniper, SnipeEvent } from "../sniper/sniper.js";

type Pending =
  | { kind: "buyX"; tid: number }
  | { kind: "setBuy" }
  | { kind: "setSell" }
  | { kind: "setSlip" }
  | { kind: "setMin" }
  | { kind: "wdAddr"; asset: string }
  | { kind: "wdAmount"; asset: string; to: string }
  | { kind: "snipeTarget"; mode: SnipeRow["kind"] }
  | { kind: "snipeAmount"; mode: SnipeRow["kind"]; target: string }
  | { kind: "setDelay" };

interface Deps {
  token: string;
  adminId: number;
  db: Db;
  trader: Trader;
  intear: Intear;
  rpc: Rpc;
  sniper: Sniper;
  dryRun: boolean;
}

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export function createBot(d: Deps): Bot {
  const bot = new Bot(d.token);
  const pending = new Map<number, Pending>();

  // Only the admin can use the bot; everyone else is silently ignored.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== d.adminId) return;
    await next();
  });

  // ------------------------------------------------------------- views

  function cardKeyboard(tid: number, s: Snapshot, settings: Settings): InlineKeyboard {
    const kb = new InlineKeyboard();
    settings.buyPresets.forEach((amt, i) => {
      kb.text(`🟢 Buy ${amt} Ⓝ`, `b:${tid}:${i}`);
      if (i % 3 === 2) kb.row();
    });
    kb.text("🟢 Buy X Ⓝ", `bx:${tid}`).row();
    settings.sellPresets.forEach((p) => kb.text(`🔴 ${p}%`, `s:${tid}:${p}`));
    kb.row();
    if (s.meme?.status === "launched") kb.text("🎁 Claim from raise", `c:${tid}`).row();
    if (s.meme?.status === "failed") kb.text("↩️ Claim NEAR refund", `c:${tid}`).row();
    if (!s.ref.includes(":") && s.balance > 0n) kb.text("💸 Withdraw", `w:${tid}`).row();
    kb.text("🔄 Refresh", `o:${tid}`).text("📸 PnL", `p:${tid}`).text("📈 Positions", "pos").text("⚙️", "set");
    return kb;
  }

  async function renderCard(ref: string): Promise<{ text: string; kb: InlineKeyboard }> {
    const settings = d.db.settings();
    const tid = d.db.tokenId(ref);
    const s = await d.trader.snapshot(ref, settings);
    return { text: tokenCard(s), kb: cardKeyboard(tid, s, settings) };
  }

  /** The live card message for each token, so a trade can replace it with a fresh one below. */
  const liveCards = new Map<string, number>();

  async function showCard(ctx: Context, ref: string, edit: boolean): Promise<void> {
    const { text, kb } = await renderCard(ref);
    if (edit) {
      await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
      const id = ctx.callbackQuery?.message?.message_id;
      if (id) liveCards.set(ref, id);
    } else {
      const m = await ctx.reply(text, { ...HTML, reply_markup: kb });
      liveCards.set(ref, m.message_id);
    }
  }

  /** Posts an up-to-date card at the bottom of the chat and removes the previous one. */
  async function repostCard(ctx: Context, ref: string, fallbackOld?: number): Promise<void> {
    await postCard(ctx.chat!.id, ref, fallbackOld);
  }

  async function postCard(chatId: number, ref: string, fallbackOld?: number): Promise<void> {
    const old = liveCards.get(ref) ?? fallbackOld;
    const { text, kb } = await renderCard(ref);
    const m = await bot.api.sendMessage(chatId, text, { ...HTML, reply_markup: kb });
    liveCards.set(ref, m.message_id);
    if (old && old !== m.message_id) await bot.api.deleteMessage(chatId, old).catch(() => {});
  }

  async function home(ctx: Context, edit = false): Promise<void> {
    const [bal, nearUsd] = await Promise.all([d.trader.walletNear().then(yoctoToNear), d.intear.nearUsd().catch(() => 0)]);
    const text = [
      `<b>NEAR Trading Bot</b>${d.dryRun ? " · <i>DRY RUN</i>" : ""}`,
      `<code>${esc(d.trader.accountId)}</code>`,
      `👛 ${near(bal)} · ${usd(bal * nearUsd)}`,
      "",
      "Paste a token contract address or a JustHoot / Nearly / meme.cooking / Intear link to trade.",
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("📈 Positions", "pos").text("🎯 Sniper", "snp").text("⚙️ Settings", "set").row()
      .text("💸 Withdraw NEAR", "w:near").text("🔄 Refresh", "home");
    if (edit) await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
    else await ctx.reply(text, { ...HTML, reply_markup: kb });
  }

  function settingsView(): { text: string; kb: InlineKeyboard } {
    const s = d.db.settings();
    const text = [
      "<b>⚙️ Settings</b>",
      "",
      `🟢 Buy buttons: ${s.buyPresets.map((x) => `${x} Ⓝ`).join(", ")} + X`,
      `🔴 Sell buttons: ${s.sellPresets.map((x) => `${x}%`).join(", ")}`,
      `🎚 Slippage: ${s.slippagePct}%`,
      `🛣 Route: ${s.routeMode === "original" ? "Original (token's own pool)" : "Best price (all DEXes)"}`,
      `👁 Hide positions under: $${s.minPositionUsd}`,
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("✏️ Buy buttons", "set:buy").text("✏️ Sell buttons", "set:sell").row()
      .text("🎚 Slippage", "set:slip").text(`🛣 Route: ${s.routeMode === "original" ? "Original" : "Best"}`, "set:route").row()
      .text("👁 Min position $", "set:min").text("⬅️ Home", "home");
    return { text, kb };
  }

  async function positions(ctx: Context, edit: boolean): Promise<void> {
    const settings = d.db.settings();
    const [holdings, nearUsd, stockBalances, mcAccount] = await Promise.all([
      d.intear.holdings(d.trader.accountId).catch(() => []),
      d.intear.nearUsd().catch(() => 0),
      d.rpc
        .view<string[]>(INTENTS, "mt_batch_balance_of", { account_id: d.trader.accountId, token_ids: STOCKS.map(stockAsset) })
        .catch(() => STOCKS.map(() => "0")),
      d.rpc.view<{ deposits?: unknown[] } | null>(MEME_COOKING, "get_account", { account_id: d.trader.accountId }).catch(() => null),
    ]);

    type Row = { ref: string; label: string; usd: number; near: number; pnl: number | null };
    const rows: Row[] = [];
    // Live pool prices, so worth and the minimum filter match the token card.
    const live = await Promise.all(holdings.map((h) => (h.token.accountId === "wrap.near" ? h.token : d.trader.liveInfo(h.token, nearUsd).catch(() => h.token))));
    holdings.forEach((h, i) => (h.token = live[i]!));
    for (const h of holdings) {
      if (h.token.accountId === "wrap.near") continue;
      const value = fromRaw(h.balance, h.token.decimals) * h.token.priceUsd;
      if (value < settings.minPositionUsd) continue;
      rows.push({ ref: h.token.accountId, label: h.token.symbol, usd: value, near: nearUsd ? value / nearUsd : 0, pnl: null });
    }
    // Stocks held inside NEAR Intents.
    const heldStocks = STOCKS.map((s, i) => ({ s, bal: BigInt(stockBalances[i] ?? "0") })).filter((x) => x.bal > 0n);
    const stockPrices = await Promise.all(heldStocks.map((x) => d.trader.oneClick.price(x.s).catch(() => null)));
    heldStocks.forEach((x, i) => {
      const value = fromRaw(x.bal, 18) * (stockPrices[i]?.usd ?? 0);
      if (value >= settings.minPositionUsd) rows.push({ ref: `stock:${x.s.symbol}`, label: x.s.symbol, usd: value, near: nearUsd ? value / nearUsd : 0, pnl: null });
    });
    // NEAR deposited in meme.cooking raises.
    for (const dep of mcAccount?.deposits ?? []) {
      const [id, amount] = Array.isArray(dep) ? dep : [];
      const n = yoctoToNear(String(amount ?? "0"));
      if (n * nearUsd >= settings.minPositionUsd) rows.push({ ref: `meme:${id}`, label: `Raise #${id}`, usd: n * nearUsd, near: n, pnl: null });
    }

    rows.sort((a, b) => b.usd - a.usd);
    // PnL for the top positions, fetched in parallel.
    await Promise.all(
      rows.slice(0, 15).map(async (r) => {
        if (r.ref.includes(":")) return;
        const info = holdings.find((h) => h.token.accountId === r.ref)!.token;
        const e = await d.trader.entry(r.ref, info.decimals, nearUsd).catch(() => null);
        if (e) {
          const held = fromRaw(holdings.find((h) => h.token.accountId === r.ref)!.balance, info.decimals);
          r.pnl = pnlPct(r.near, holdingCost(e, held).near);
        }
      }),
    );

    const total = rows.reduce((a, r) => a + r.usd, 0);
    const lines = [`<b>📈 Positions</b> (over $${settings.minPositionUsd})`, ""];
    if (!rows.length) lines.push("No positions above the minimum.");
    for (const r of rows) lines.push(`${pnlEmoji(r.pnl)} <b>${esc(r.label)}</b> · ${near(r.near)} · ${usd(r.usd)} · ${pct(r.pnl)}`);
    if (rows.length) lines.push("", `Total: <b>${near(nearUsd ? total / nearUsd : 0)}</b> · <b>${usd(total)}</b>`);

    const kb = new InlineKeyboard();
    rows.slice(0, 30).forEach((r, i) => {
      kb.text(r.label, `o:${d.db.tokenId(r.ref)}:n`);
      if (i % 3 === 2) kb.row();
    });
    kb.row().text("🔄 Refresh", "pos").text("⬅️ Home", "home");
    if (edit) await ctx.editMessageText(lines.join("\n"), { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
    else await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
  }

  // ------------------------------------------------------------- trading

  /**
   * Runs a trade with no confirmation: a status message is posted at once and edited with the result.
   * Handlers don't await it, so the bot keeps taking taps while a trade is in flight.
   */
  async function runTrade(ctx: Context, tid: number, label: string, run: (ref: string, s: Settings) => Promise<TradeOutcome>): Promise<void> {
    const ref = d.db.tokenRef(tid);
    if (!ref) return void ctx.reply("Token expired, paste it again.");
    const chatId = ctx.chat!.id;
    const cardMsgId = ctx.callbackQuery?.message?.message_id;
    const started = Date.now();
    const status = await ctx.reply(`⚡ ${esc(label)}…`, HTML).catch(() => null);
    const edit = async (text: string): Promise<void> => {
      if (status) await ctx.api.editMessageText(chatId, status.message_id, text, HTML).catch(() => {});
      else await ctx.reply(text, HTML).catch(() => {});
    };
    let r: TradeOutcome;
    try {
      r = await run(ref, d.db.settings());
    } catch (e) {
      await edit(`❌ ${esc(label)} failed\n${esc(errorText(e))}`);
      return;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const lines = [`✅ ${esc(label)} · ${esc(r.via)} · ${secs}s`, ...summaryLines(r), r.hashes.map(txLink).join(" ")];
    if (r.note) lines.push(`⏳ ${esc(r.note)}`);
    await edit(lines.join("\n"));
    // Fresh card right under the result, once the trade is logged so entry and PnL include it.
    await Promise.race([r.recorded, new Promise((ok) => setTimeout(ok, 3000))]).catch(() => {});
    await repostCard(ctx, ref, cardMsgId).catch(() => {});
    r.settle
      ?.then(async (msg) => {
        await edit([...lines.slice(0, 2), `✅ ${esc(msg)}`].join("\n"));
        await repostCard(ctx, ref);
      })
      .catch(() => {});
  }

  /** In DRY_RUN the buttons quote and show the exact transactions instead of sending them. */
  async function dryOutcome(ref: string, side: "buy" | "sell", amount: number, s: Settings): Promise<TradeOutcome> {
    const { route, quote } = await d.trader.preview(ref, side, amount, s);
    const steps = quote.txs.map((t) => `${t.receiverId}: ${t.calls.map((c) => c.method).join(" + ")}`);
    return {
      hashes: [],
      via: `${route.label} → ${quote.via}`,
      nearAmount: 0n,
      tokenAmount: quote.expectedOut,
      note: `DRY RUN, nothing sent. Would sign ${quote.txs.length} tx:\n${steps.join("\n")}`,
    };
  }
  const buy = (ref: string, amount: number, s: Settings) => (d.dryRun ? dryOutcome(ref, "buy", amount, s) : d.trader.buy(ref, amount, s));
  const sell = (ref: string, p: number, s: Settings) => (d.dryRun ? dryOutcome(ref, "sell", p, s) : d.trader.sell(ref, p, s));

  // ------------------------------------------------------------- handlers

  bot.command(["start", "home"], (ctx) => home(ctx));
  bot.command("positions", (ctx) => positions(ctx, false));
  bot.command("settings", (ctx) => {
    const v = settingsView();
    return ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
  });

  bot.callbackQuery("home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await home(ctx, true);
  });
  bot.callbackQuery("pos", async (ctx) => {
    await ctx.answerCallbackQuery("Loading positions…");
    await positions(ctx, ctx.callbackQuery.message?.text?.startsWith("📈") ?? false);
  });
  bot.callbackQuery("set", async (ctx) => {
    await ctx.answerCallbackQuery();
    const v = settingsView();
    await ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
  });

  bot.callbackQuery(/^o:(\d+)(:n)?$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const ref = d.db.tokenRef(Number(ctx.match[1]));
    if (ref) await showCard(ctx, ref, !ctx.match[2]);
  });

  bot.callbackQuery(/^b:(\d+):(\d+)$/, async (ctx) => {
    const amount = d.db.settings().buyPresets[Number(ctx.match[2])];
    if (amount == null) return void ctx.answerCallbackQuery("Button changed, refresh the card");
    await ctx.answerCallbackQuery(`Buying ${amount} NEAR`);
    void runTrade(ctx, Number(ctx.match[1]), `Buy ${amount} NEAR`, (ref, s) => buy(ref, amount, s));
  });

  bot.callbackQuery(/^bx:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    pending.set(ctx.chat!.id, { kind: "buyX", tid: Number(ctx.match[1]) });
    await ctx.reply("How much NEAR? Reply with a number, e.g. <code>35</code>", { ...HTML, reply_markup: { force_reply: true } });
  });

  bot.callbackQuery(/^s:(\d+):([\d.]+)$/, async (ctx) => {
    const p = Number(ctx.match[2]);
    await ctx.answerCallbackQuery(`Selling ${p}%`);
    void runTrade(ctx, Number(ctx.match[1]), `Sell ${p}%`, (ref, s) => sell(ref, p, s));
  });

  bot.callbackQuery(/^p:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Making PnL card…");
    const ref = d.db.tokenRef(Number(ctx.match[1]));
    if (!ref) return void ctx.reply("Token expired, paste it again.");
    const s = await d.trader.snapshot(ref, d.db.settings());
    const data = pnlCardData(s);
    if (!data) return void ctx.reply("No open position with a known entry for this token.");
    const caption = `$${esc(data.symbol)} · ${pct(data.pnlPct)} · ${data.pnlNear >= 0 ? "+" : "−"}${Math.abs(data.pnlNear).toFixed(2)} NEAR`;
    await ctx.replyWithPhoto(new InputFile(renderPnlCard(data), `pnl-${data.symbol}.png`), { caption, parse_mode: "HTML" });
  });

  // ------------------------------------------------------------- withdraw
  // Tap Withdraw -> type destination -> type amount (or max) -> review -> Confirm.

  /** Withdrawals waiting for their confirm tap, by short id. They expire after 5 minutes. */
  const withdrawals = new Map<string, { plan: WithdrawPlan; at: number }>();

  bot.callbackQuery(/^w:(near|\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const asset = ctx.match[1] === "near" ? "near" : d.db.tokenRef(Number(ctx.match[1]));
    if (!asset || asset.includes(":")) return void ctx.reply("This can't be withdrawn from here.");
    pending.set(ctx.chat!.id, { kind: "wdAddr", asset });
    const what = asset === "near" ? "NEAR" : "this token";
    await ctx.reply(`💸 Withdraw ${what}\n\nSend the <b>destination wallet</b> (e.g. <code>yourname.near</code>).`, {
      ...HTML,
      reply_markup: { force_reply: true },
    });
  });

  async function withdrawStep(ctx: Context, p: Extract<Pending, { kind: "wdAddr" | "wdAmount" }>, text: string): Promise<void> {
    const chatId = ctx.chat!.id;
    try {
      if (p.kind === "wdAddr") {
        const to = await d.trader.checkDestination(text);
        pending.set(chatId, { kind: "wdAmount", asset: p.asset, to });
        const unit = p.asset === "near" ? "NEAR" : "tokens";
        await ctx.reply(`To <code>${esc(to)}</code>\n\nHow much? Send an amount in ${unit}, or <code>max</code>.`, { ...HTML, reply_markup: { force_reply: true } });
        return;
      }
      const plan = await d.trader.planWithdraw(p.asset, p.to, text);
      pending.delete(chatId);
      const id = Math.random().toString(36).slice(2, 10);
      withdrawals.set(id, { plan, at: Date.now() });
      const amount = fromRaw(plan.amount, plan.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 });
      const lines = [
        "<b>Confirm withdrawal</b>",
        "",
        `Send <b>${amount} ${esc(plan.symbol)}</b>`,
        `to <code>${esc(plan.to)}</code>`,
        ...(plan.note ? ["", `ℹ️ ${esc(plan.note)}`] : []),
        "",
        "Check the address: a transfer can't be undone.",
      ];
      const kb = new InlineKeyboard().text("✅ Confirm", `wc:${id}`).text("✖️ Cancel", `wx:${id}`);
      await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
    } catch (e) {
      // Keep the step open so the user can just send a corrected value.
      await ctx.reply(`⚠️ ${esc(errorText(e))}\nSend it again, or tap another button to cancel.`, HTML);
    }
  }

  bot.callbackQuery(/^wx:(\w+)$/, async (ctx) => {
    withdrawals.delete(ctx.match[1]!);
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("✖️ Withdrawal cancelled.").catch(() => {});
  });

  bot.callbackQuery(/^wc:(\w+)$/, async (ctx) => {
    const entry = withdrawals.get(ctx.match[1]!);
    withdrawals.delete(ctx.match[1]!);
    if (!entry || Date.now() - entry.at > 5 * 60_000) {
      await ctx.answerCallbackQuery("Expired");
      return void (await ctx.editMessageText("⌛ This withdrawal expired. Start again with 💸 Withdraw.").catch(() => {}));
    }
    await ctx.answerCallbackQuery("Sending…");
    const { plan } = entry;
    const amount = fromRaw(plan.amount, plan.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 });
    const label = `${amount} ${esc(plan.symbol)} to <code>${esc(plan.to)}</code>`;
    await ctx.editMessageText(`⚡ Sending ${label}…`, HTML).catch(() => {});
    if (d.dryRun) return void (await ctx.editMessageText(`DRY RUN, nothing sent: ${label}`, HTML).catch(() => {}));
    try {
      const hashes = await d.trader.executeWithdraw(plan);
      await ctx.editMessageText(`✅ Sent ${label}\n${hashes.map(txLink).join(" ")}`, HTML).catch(() => {});
    } catch (e) {
      await ctx.editMessageText(`❌ Withdrawal failed\n${esc(errorText(e))}`, HTML).catch(() => {});
    }
  });

  // ------------------------------------------------------------- sniper
  // Creator: watch a wallet and buy the first fresh token it launches. Token: buy a pasted token once it trades.

  function snipeTarget(s: SnipeRow): string {
    if (s.kind === "creator") return s.target;
    return s.target.startsWith("meme:") ? `meme.cooking raise #${s.target.slice(5)}` : s.target;
  }

  function sniperView(): { text: string; kb: InlineKeyboard } {
    const active = d.sniper.active();
    const delay = d.db.settings().snipeMaxDelaySec;
    const lines = ["<b>🎯 Sniper</b>", ""];
    if (!active.length) lines.push("No active snipes.");
    for (const s of active) {
      lines.push(
        s.kind === "creator"
          ? `👤 <code>${esc(s.target)}</code>\n    buys <b>${near(s.nearAmount)}</b> of their next launch (JustHoot, Nearly, meme.cooking)`
          : `🪙 <code>${esc(snipeTarget(s))}</code>\n    buys <b>${near(s.nearAmount)}</b> as soon as it trades`,
      );
    }
    lines.push(
      "",
      `📡 Launch watcher: ${d.sniper.watching ? "🟢 live" : "⚪ off (starts with a creator snipe)"}`,
      `⏱ Skip a launch seen more than <b>${delay}s</b> late`,
    );
    const kb = new InlineKeyboard();
    for (const s of active) kb.text(`✖️ Cancel ${s.kind === "creator" ? "👤" : "🪙"} ${snipeTarget(s).slice(0, 24)}`, `snx:${s.id}`).row();
    kb.text("➕ Snipe creator", "snp:c").text("➕ Snipe token", "snp:t").row();
    kb.text(`⏱ Max delay ${delay}s`, "set:delay").text("🔄", "snp").text("⬅️ Home", "home");
    return { text: lines.join("\n"), kb };
  }

  async function showSniper(ctx: Context, edit: boolean): Promise<void> {
    const v = sniperView();
    if (edit) await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.kb }).catch(ignoreNotModified);
    else await ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
  }

  bot.command("snipe", (ctx) => showSniper(ctx, false));
  bot.callbackQuery("snp", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSniper(ctx, ctx.callbackQuery.message?.text?.startsWith("🎯") ?? false);
  });

  bot.callbackQuery(/^snp:(c|t)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const mode = ctx.match[1] === "c" ? "creator" : "token";
    pending.set(ctx.chat!.id, { kind: "snipeTarget", mode });
    const ask =
      mode === "creator"
        ? "👤 Send the <b>creator's wallet</b> (e.g. <code>dev.near</code>).\nThe bot buys the first token they launch on JustHoot, Nearly or meme.cooking, then stops."
        : "🪙 Send the <b>token address or link</b>.\nThe bot buys it as soon as it can be traded (right away if it already trades).";
    await ctx.reply(ask, { ...HTML, reply_markup: { force_reply: true } });
  });

  bot.callbackQuery(/^snx:(\d+)$/, async (ctx) => {
    const ok = d.sniper.cancel(Number(ctx.match[1]));
    await ctx.answerCallbackQuery(ok ? "Snipe cancelled" : "Already ended");
    await showSniper(ctx, true);
  });

  async function snipeStep(ctx: Context, p: Extract<Pending, { kind: "snipeTarget" | "snipeAmount" }>, text: string): Promise<boolean> {
    const chatId = ctx.chat!.id;
    if (p.kind === "snipeTarget") {
      let target: string;
      try {
        if (p.mode === "creator") target = await d.trader.checkWallet(text);
        else {
          const parsed = parseInput(text);
          if (!parsed) throw new Error("That isn't a token address or link");
          if (parsed.kind === "stock") throw new Error("Stocks trade all the time; just buy them from their card");
          target = parsed.kind === "meme" ? `meme:${parsed.memeId}` : parsed.accountId;
        }
      } catch (e) {
        await ctx.reply(`⚠️ ${esc(errorText(e))}\nSend it again, or tap another button to cancel.`, HTML);
        return true;
      }
      pending.set(chatId, { kind: "snipeAmount", mode: p.mode, target });
      await ctx.reply(`🎯 <code>${esc(target)}</code>\n\nHow much NEAR should the snipe spend?`, { ...HTML, reply_markup: { force_reply: true } });
      return true;
    }
    const amount = Number(text.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply("Send an amount of NEAR, e.g. <code>10</code>.", HTML);
      return true;
    }
    pending.delete(chatId);
    const row = d.sniper.add(p.mode, p.target, amount);
    const wallet = await d.trader.walletNear().then(yoctoToNear).catch(() => null);
    const lines = [
      p.mode === "creator"
        ? `✅ Watching <code>${esc(row.target)}</code>. The first token they launch gets <b>${near(amount)}</b>, then the snipe stops.`
        : `✅ Sniping <code>${esc(snipeTarget(row))}</code> for <b>${near(amount)}</b> as soon as it trades.`,
    ];
    if (wallet != null && wallet < amount + 0.1) lines.push(`⚠️ The wallet only has ${near(wallet)}. Top it up before the snipe fires.`);
    if (d.dryRun) lines.push("DRY RUN: the snipe will report instead of buying.");
    const v = sniperView();
    await ctx.reply(`${lines.join("\n")}\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
    return true;
  }

  /** Snipe news goes to the admin's chat, since nothing the user tapped started it. */
  d.sniper.onEvent = (e: SnipeEvent) => void reportSnipe(e).catch((err) => console.error("Snipe report:", err));

  async function reportSnipe(e: SnipeEvent): Promise<void> {
    const chatId = d.adminId;
    const send = (text: string) => bot.api.sendMessage(chatId, text, HTML);
    const who = `<code>${esc(e.snipe.kind === "creator" ? e.snipe.target : snipeTarget(e.snipe))}</code>`;
    switch (e.type) {
      case "launch": {
        const l = e.launch;
        const what = l.memeId != null ? `meme.cooking raise <b>#${l.memeId}</b>${l.symbol ? ` (${esc(l.symbol)})` : ""}` : `<b>${esc(l.symbol ?? l.token!.split(".")[0]!)}</b> on ${l.platform}\n<code>${esc(l.token!)}</code>`;
        const next = l.memeId != null ? `Depositing ${near(e.snipe.nearAmount)}…` : `Buying ${near(e.snipe.nearAmount)} the moment its pool opens…`;
        await send(`🎯 ${who} just launched ${what}\n${next}`);
        return;
      }
      case "bought": {
        const r = e.outcome;
        await send([`✅ <b>Sniped</b> ${who} · ${esc(r.via)} · ${e.secs.toFixed(1)}s`, ...summaryLines(r), r.hashes.map(txLink).join(" ")].join("\n"));
        await Promise.race([r.recorded, new Promise((ok) => setTimeout(ok, 3000))]).catch(() => {});
        await postCard(chatId, e.ref).catch(() => {});
        return;
      }
      case "failed":
        await send(`❌ <b>Snipe failed</b> ${who}${e.ref && e.ref !== e.snipe.target ? `\n<code>${esc(e.ref)}</code>` : ""}\n${esc(e.error)}${e.ended ? "\nThis snipe has ended." : ""}`);
        return;
      case "skipped":
        await send(`⏭ Skipped <code>${esc(e.launch.token ?? `raise #${e.launch.memeId}`)}</code> from ${who}: ${esc(e.reason)}. Still watching.`);
        return;
      case "dryRun":
        await send(`🧪 DRY RUN: would snipe ${near(e.snipe.nearAmount)} of <code>${esc(e.ref)}</code> via ${esc(e.route.label)}. Nothing sent.`);
        return;
    }
  }

  bot.callbackQuery(/^c:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Claiming");
    void runTrade(ctx, Number(ctx.match[1]), "Claim", (ref) => d.trader.claimMeme(Number(ref.replace(/^meme:/, ""))));
  });

  bot.callbackQuery(/^set:(buy|sell|slip|min|route|delay)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const what = ctx.match[1];
    const s = d.db.settings();
    if (what === "route") {
      d.db.saveSettings({ routeMode: s.routeMode === "original" ? "best" : "original" });
      const v = settingsView();
      return void (await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.kb }).catch(ignoreNotModified));
    }
    const prompts: Record<string, [Pending, string]> = {
      buy: [{ kind: "setBuy" }, `Send your buy amounts in NEAR, separated by spaces. Add or remove numbers to add or remove buttons.\nNow: <code>${s.buyPresets.join(" ")}</code>`],
      sell: [{ kind: "setSell" }, `Send your sell percentages, separated by spaces.\nNow: <code>${s.sellPresets.join(" ")}</code>`],
      slip: [{ kind: "setSlip" }, `Send slippage in percent (1-99).\nNow: <code>${s.slippagePct}</code>`],
      min: [{ kind: "setMin" }, `Hide positions worth less than how many USD?\nNow: <code>${s.minPositionUsd}</code>`],
      delay: [{ kind: "setDelay" }, `Skip a creator's launch if the bot sees it more than how many seconds late?\nNow: <code>${s.snipeMaxDelaySec}</code>`],
    };
    const [p, text] = prompts[what!]!;
    pending.set(ctx.chat!.id, p);
    await ctx.reply(text, { ...HTML, reply_markup: { force_reply: true } });
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    const p = pending.get(ctx.chat.id);
    if (p) {
      const handled = await handlePending(ctx, p, text);
      if (handled) return;
    }
    const parsed = parseInput(text);
    if (!parsed) return void ctx.reply("Paste a token contract address or a JustHoot / Nearly / meme.cooking / Intear link.");
    const ref = parsed.kind === "token" ? parsed.accountId : parsed.kind === "meme" ? `meme:${parsed.memeId}` : `stock:${parsed.stock.symbol}`;
    await showCard(ctx, ref, false);
  });

  async function handlePending(ctx: Context, p: Pending, text: string): Promise<boolean> {
    const chatId = ctx.chat!.id;
    if (p.kind === "wdAddr" || p.kind === "wdAmount") {
      await withdrawStep(ctx, p, text);
      return true;
    }
    if (p.kind === "snipeTarget" || p.kind === "snipeAmount") return snipeStep(ctx, p, text);
    const numbers = text.split(/[\s,]+/).filter(Boolean).map(Number);
    const valid = numbers.length > 0 && numbers.every((n) => Number.isFinite(n) && n > 0);
    if (!valid) {
      pending.delete(chatId);
      return false; // Not a number: treat it as a new token paste.
    }
    pending.delete(chatId);
    switch (p.kind) {
      case "buyX": {
        const amount = numbers[0]!;
        void runTrade(ctx, p.tid, `Buy ${amount} NEAR`, (ref, s) => buy(ref, amount, s));
        return true;
      }
      case "setBuy":
        d.db.saveSettings({ buyPresets: numbers.slice(0, 12) });
        break;
      case "setSell":
        if (numbers.some((n) => n > 100)) {
          await ctx.reply("Percentages must be 100 or less.");
          return true;
        }
        d.db.saveSettings({ sellPresets: numbers.slice(0, 8) });
        break;
      case "setSlip":
        if (numbers[0]! >= 100) {
          await ctx.reply("Slippage must be under 100%.");
          return true;
        }
        d.db.saveSettings({ slippagePct: numbers[0]! });
        break;
      case "setMin":
        d.db.saveSettings({ minPositionUsd: numbers[0]! });
        break;
      case "setDelay":
        d.db.saveSettings({ snipeMaxDelaySec: numbers[0]! });
        await showSniper(ctx, false);
        return true;
    }
    const v = settingsView();
    await ctx.reply(`Saved.\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
    return true;
  }

  bot.catch((err) => {
    console.error("Bot error:", err.error);
    err.ctx.reply(`⚠️ ${esc(errorText(err.error))}`, HTML).catch(() => {});
  });

  return bot;
}

/** "Sold 1.2M HOOT → 12.3 NEAR ($64)" plus the profit on that sale, when the entry is known. */
function summaryLines(r: TradeOutcome): string[] {
  const t = r.summary;
  if (!t) return [];
  const amt = t.tokens > 0 ? `${compact(t.tokens)} ${esc(t.symbol)}` : esc(t.symbol);
  if (t.side === "buy") return [`🛒 Bought <b>${amt}</b> for <b>${near(t.near)}</b> (${usd(t.usd)})`];
  const out = [`💰 Sold <b>${amt}</b> → <b>${near(t.near)}</b> (${usd(t.usd)})`];
  if (t.pnlNear != null && t.pnlPct != null) {
    out.push(`${pnlEmoji(t.pnlPct)} PnL on this sale: <b>${t.pnlNear >= 0 ? "+" : "−"}${near(Math.abs(t.pnlNear))}</b> (${pct(t.pnlPct)})`);
  }
  return out;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ignoreNotModified(e: unknown): void {
  if (e instanceof GrammyError && /not modified/.test(e.description)) return;
  throw e;
}
