import { Bot, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { fromRaw, yoctoToNear } from "../amount.js";
import { holdingCost, pnlPct } from "../entry.js";
import { parseInput } from "../venues/parse.js";
import { STOCKS } from "../venues/stocks.js";
import { INTENTS, stockAsset } from "../venues/oneclick.js";
import { MEME_COOKING } from "../venues/memecooking.js";
import { compact, esc, near, parseMcap, pct, pnlEmoji, tokenCard, txLink, usd } from "./format.js";
import { pnlCardData, renderPnlCard } from "./pnlCard.js";
import { generateNewWallet, findAccountsForPublicKey, parsePrivateKey, parseWalletInput, verifyAccessKey } from "../near/wallet.js";
import { Signer } from "../near/signer.js";
import { Ft } from "../near/ft.js";
const HTML = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
export function createBot(d) {
    const bot = new Bot(d.token);
    const pending = new Map();
    // Only the admin can use the bot; everyone else is silently ignored.
    bot.use(async (ctx, next) => {
        if (ctx.from?.id !== d.adminId)
            return;
        await next();
    });
    // ------------------------------------------------------------- views
    function cardKeyboard(tid, s, settings) {
        const kb = new InlineKeyboard();
        settings.buyPresets.forEach((amt, i) => {
            kb.text(`🟢 Buy ${amt} Ⓝ`, `b:${tid}:${i}`);
            if (i % 3 === 2)
                kb.row();
        });
        kb.text("🟢 Buy X Ⓝ", `bx:${tid}`).row();
        settings.sellPresets.forEach((p) => kb.text(`🔴 ${p}%`, `s:${tid}:${p}`));
        kb.row();
        if (s.kind !== "stock") {
            kb.text("🎯 Limit Buy", `lb:${tid}`).text("🔴 Limit Sell", `ls:${tid}`).row();
        }
        if (s.meme?.status === "launched")
            kb.text("🎁 Claim from raise", `c:${tid}`).row();
        if (s.meme?.status === "failed")
            kb.text("↩️ Claim NEAR refund", `c:${tid}`).row();
        if (!s.ref.includes(":") && s.balance > 0n)
            kb.text("💸 Withdraw", `w:${tid}`).row();
        kb.text("🔄 Refresh", `o:${tid}`).text("📸 PnL", `p:${tid}`).text("📈 Positions", "pos").text("⚙️", "set");
        return kb;
    }
    async function renderCard(ref) {
        const settings = d.db.settings();
        const tid = d.db.tokenId(ref);
        const s = await d.trader.snapshot(ref, settings);
        return { text: tokenCard(s), kb: cardKeyboard(tid, s, settings) };
    }
    /** The live card message for each token, so a trade can replace it with a fresh one below. */
    const liveCards = new Map();
    async function showCard(ctx, ref, edit) {
        const { text, kb } = await renderCard(ref);
        if (edit) {
            await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
            const id = ctx.callbackQuery?.message?.message_id;
            if (id)
                liveCards.set(ref, id);
        }
        else {
            const m = await ctx.reply(text, { ...HTML, reply_markup: kb });
            liveCards.set(ref, m.message_id);
        }
    }
    /** Posts an up-to-date card at the bottom of the chat and removes the previous one. */
    async function repostCard(ctx, ref, fallbackOld) {
        await postCard(ctx.chat.id, ref, fallbackOld);
    }
    async function postCard(chatId, ref, fallbackOld) {
        const old = liveCards.get(ref) ?? fallbackOld;
        const { text, kb } = await renderCard(ref);
        const m = await bot.api.sendMessage(chatId, text, { ...HTML, reply_markup: kb });
        liveCards.set(ref, m.message_id);
        if (old && old !== m.message_id)
            await bot.api.deleteMessage(chatId, old).catch(() => { });
    }
    async function home(ctx, edit = false) {
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
            .text("👛 Wallets", "wallets").text("💸 Withdraw NEAR", "w:near").text("🔄 Refresh", "home");
        if (edit)
            await ctx.editMessageText(text, { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
        else
            await ctx.reply(text, { ...HTML, reply_markup: kb });
    }
    async function walletsView() {
        const list = d.db.wallets();
        const [bal, nearUsd] = await Promise.all([
            d.trader.walletNear().then(yoctoToNear).catch(() => 0),
            d.intear.nearUsd().catch(() => 0),
        ]);
        const lines = [
            "<b>👛 Wallets</b>",
            "",
            `Active: <code>${esc(d.trader.accountId)}</code>`,
            `Balance: <b>${near(bal)}</b> · ${usd(bal * nearUsd)}`,
            `Public key: <code>${esc(d.trader.currentSigner.publicKey)}</code>`,
            "",
            `<b>Saved Wallets (${list.length}):</b>`,
        ];
        for (const w of list) {
            const isAct = w.accountId === d.trader.accountId;
            const label = w.accountId.length > 24 ? `${w.accountId.slice(0, 10)}…${w.accountId.slice(-8)}` : w.accountId;
            lines.push(`${isAct ? "✅ <b>" : "• <code>"}${esc(label)}${isAct ? "</b> (Active)" : "</code>"}`);
        }
        const kb = new InlineKeyboard();
        const others = list.filter((w) => w.accountId !== d.trader.accountId);
        if (others.length > 0) {
            others.forEach((w, i) => {
                const short = w.accountId.length > 18 ? `${w.accountId.slice(0, 8)}…${w.accountId.slice(-6)}` : w.accountId;
                kb.text(`Switch: ${short}`, `w_act:${w.id}`);
                if (i % 2 === 1)
                    kb.row();
            });
            if (others.length % 2 === 1)
                kb.row();
        }
        kb.text("➕ Import Wallet", "w_import").text("✨ New Wallet", "w_new").row();
        if (list.length > 1) {
            kb.text("🗑 Remove Wallet", "w_rm_menu");
        }
        kb.text("🔑 Export Key", "w_export").text("⬅️ Home", "home");
        return { text: lines.join("\n"), kb };
    }
    async function showWallets(ctx, edit = false) {
        const v = await walletsView();
        if (edit)
            await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.kb }).catch(ignoreNotModified);
        else
            await ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
    }
    function settingsView() {
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
    async function positions(ctx, edit) {
        const settings = d.db.settings();
        const [holdings, nearUsd, stockBalances, mcAccount] = await Promise.all([
            d.intear.holdings(d.trader.accountId).catch(() => []),
            d.intear.nearUsd().catch(() => 0),
            d.rpc
                .view(INTENTS, "mt_batch_balance_of", { account_id: d.trader.accountId, token_ids: STOCKS.map(stockAsset) })
                .catch(() => STOCKS.map(() => "0")),
            d.rpc.view(MEME_COOKING, "get_account", { account_id: d.trader.accountId }).catch(() => null),
        ]);
        const rows = [];
        // Live pool prices, so worth and the minimum filter match the token card.
        const live = await Promise.all(holdings.map((h) => (h.token.accountId === "wrap.near" ? h.token : d.trader.liveInfo(h.token, nearUsd).catch(() => h.token))));
        holdings.forEach((h, i) => (h.token = live[i]));
        for (const h of holdings) {
            if (h.token.accountId === "wrap.near")
                continue;
            const value = fromRaw(h.balance, h.token.decimals) * h.token.priceUsd;
            if (value < settings.minPositionUsd)
                continue;
            rows.push({ ref: h.token.accountId, label: h.token.symbol, usd: value, near: nearUsd ? value / nearUsd : 0, pnl: null });
        }
        // Stocks held inside NEAR Intents.
        const heldStocks = STOCKS.map((s, i) => ({ s, bal: BigInt(stockBalances[i] ?? "0") })).filter((x) => x.bal > 0n);
        const stockPrices = await Promise.all(heldStocks.map((x) => d.trader.oneClick.price(x.s).catch(() => null)));
        heldStocks.forEach((x, i) => {
            const value = fromRaw(x.bal, 18) * (stockPrices[i]?.usd ?? 0);
            if (value >= settings.minPositionUsd)
                rows.push({ ref: `stock:${x.s.symbol}`, label: x.s.symbol, usd: value, near: nearUsd ? value / nearUsd : 0, pnl: null });
        });
        // NEAR deposited in meme.cooking raises.
        for (const dep of mcAccount?.deposits ?? []) {
            const [id, amount] = Array.isArray(dep) ? dep : [];
            const n = yoctoToNear(String(amount ?? "0"));
            if (n * nearUsd >= settings.minPositionUsd)
                rows.push({ ref: `meme:${id}`, label: `Raise #${id}`, usd: n * nearUsd, near: n, pnl: null });
        }
        rows.sort((a, b) => b.usd - a.usd);
        // PnL for the top positions, fetched in parallel.
        await Promise.all(rows.slice(0, 15).map(async (r) => {
            if (r.ref.includes(":"))
                return;
            const info = holdings.find((h) => h.token.accountId === r.ref).token;
            const e = await d.trader.entry(r.ref, info.decimals, nearUsd).catch(() => null);
            if (e) {
                const held = fromRaw(holdings.find((h) => h.token.accountId === r.ref).balance, info.decimals);
                r.pnl = pnlPct(r.near, holdingCost(e, held).near);
            }
        }));
        const total = rows.reduce((a, r) => a + r.usd, 0);
        const lines = [`<b>📈 Positions</b> (over $${settings.minPositionUsd})`, ""];
        if (!rows.length)
            lines.push("No positions above the minimum.");
        for (const r of rows)
            lines.push(`${pnlEmoji(r.pnl)} <b>${esc(r.label)}</b> · ${near(r.near)} · ${usd(r.usd)} · ${pct(r.pnl)}`);
        if (rows.length)
            lines.push("", `Total: <b>${near(nearUsd ? total / nearUsd : 0)}</b> · <b>${usd(total)}</b>`);
        const kb = new InlineKeyboard();
        rows.slice(0, 30).forEach((r, i) => {
            kb.text(r.label, `o:${d.db.tokenId(r.ref)}:n`);
            if (i % 3 === 2)
                kb.row();
        });
        kb.row().text("🔄 Refresh", "pos").text("⬅️ Home", "home");
        if (edit)
            await ctx.editMessageText(lines.join("\n"), { ...HTML, reply_markup: kb }).catch(ignoreNotModified);
        else
            await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
    }
    // ------------------------------------------------------------- trading
    /**
     * Runs a trade with no confirmation: a status message is posted at once and edited with the result.
     * Handlers don't await it, so the bot keeps taking taps while a trade is in flight.
     */
    async function runTrade(ctx, tid, label, run) {
        const ref = d.db.tokenRef(tid);
        if (!ref)
            return void ctx.reply("Token expired, paste it again.");
        const chatId = ctx.chat.id;
        const cardMsgId = ctx.callbackQuery?.message?.message_id;
        const started = Date.now();
        const status = await ctx.reply(`⚡ ${esc(label)}…`, HTML).catch(() => null);
        const edit = async (text) => {
            if (status)
                await ctx.api.editMessageText(chatId, status.message_id, text, HTML).catch(() => { });
            else
                await ctx.reply(text, HTML).catch(() => { });
        };
        let r;
        try {
            r = await run(ref, d.db.settings());
        }
        catch (e) {
            await edit(`❌ ${esc(label)} failed\n${esc(errorText(e))}`);
            return;
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const lines = [`✅ ${esc(label)} · ${esc(r.via)} · ${secs}s`, ...summaryLines(r), r.hashes.map(txLink).join(" ")];
        if (r.note)
            lines.push(`⏳ ${esc(r.note)}`);
        await edit(lines.join("\n"));
        // Fresh card right under the result, once the trade is logged so entry and PnL include it.
        await Promise.race([r.recorded, new Promise((ok) => setTimeout(ok, 3000))]).catch(() => { });
        await repostCard(ctx, ref, cardMsgId).catch(() => { });
        r.settle
            ?.then(async (msg) => {
            await edit([...lines.slice(0, 2), `✅ ${esc(msg)}`].join("\n"));
            await repostCard(ctx, ref);
        })
            .catch(() => { });
    }
    /** In DRY_RUN the buttons quote and show the exact transactions instead of sending them. */
    async function dryOutcome(ref, side, amount, s) {
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
    const buy = (ref, amount, s) => (d.dryRun ? dryOutcome(ref, "buy", amount, s) : d.trader.buy(ref, amount, s));
    const sell = (ref, p, s) => (d.dryRun ? dryOutcome(ref, "sell", p, s) : d.trader.sell(ref, p, s));
    // ------------------------------------------------------------- handlers
    bot.command(["start", "home"], (ctx) => home(ctx));
    bot.command("positions", (ctx) => positions(ctx, false));
    bot.command(["wallets", "wallet"], (ctx) => showWallets(ctx));
    bot.command("settings", (ctx) => {
        const v = settingsView();
        return ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
    });
    bot.callbackQuery("wallets", async (ctx) => {
        await ctx.answerCallbackQuery();
        await showWallets(ctx, true);
    });
    bot.callbackQuery(/^w_act:(\d+)$/, async (ctx) => {
        const id = Number(ctx.match[1]);
        const w = d.db.walletById(id);
        if (!w)
            return void ctx.answerCallbackQuery("Wallet not found.");
        await ctx.answerCallbackQuery(`Switching to ${w.accountId}…`);
        try {
            const newSigner = new Signer(d.rpc, w.accountId, w.privateKey, d.dryRun);
            await newSigner.init();
            const newFt = new Ft(d.rpc, w.accountId);
            d.trader.switchSigner(newSigner, newFt);
            d.db.setActiveWallet(id);
            d.sniper.refresh();
            await showWallets(ctx, true);
        }
        catch (e) {
            await ctx.reply(`⚠️ Failed to switch wallet: ${esc(errorText(e))}`, HTML);
        }
    });
    bot.callbackQuery("w_import", async (ctx) => {
        await ctx.answerCallbackQuery();
        pending.set(ctx.chat.id, { kind: "importWallet" });
        const kb = new InlineKeyboard().text("✖️ Cancel", "w_cancel");
        const text = [
            "📥 <b>Import Wallet</b>",
            "",
            "Send your NEAR private key (e.g. <code>ed25519:...</code>) or account and private key:",
            "<code>&lt;account.near&gt; &lt;ed25519:...&gt;</code>",
            "",
            "<i>🔒 For your security, your message will be automatically deleted immediately after being received.</i>",
        ].join("\n");
        await ctx.reply(text, { ...HTML, reply_markup: kb });
    });
    bot.callbackQuery("w_new", async (ctx) => {
        await ctx.answerCallbackQuery();
        try {
            const generated = generateNewWallet();
            const row = d.db.addWallet(generated.implicitAccountId, generated.privateKey, false);
            const kb = new InlineKeyboard()
                .text("⚡ Switch to this wallet", `w_act:${row.id}`)
                .row()
                .text("👛 Wallets", "wallets")
                .text("🗑 Delete message", "del_msg");
            const text = [
                "✨ <b>New NEAR Wallet Created</b>",
                "",
                `Address (Implicit): <code>${generated.implicitAccountId}</code>`,
                `Public Key: <code>${esc(generated.publicKey)}</code>`,
                "",
                `Private Key:\n<code>${esc(generated.privateKey)}</code>`,
                "",
                "⚠️ <b>SAVE THIS KEY NOW!</b> The key is saved in the bot's database, but you should back it up.",
                "Fund this wallet with at least 0.1 NEAR from any exchange or wallet to activate it on-chain.",
            ].join("\n");
            await ctx.reply(text, { ...HTML, reply_markup: kb });
        }
        catch (e) {
            await ctx.reply(`⚠️ Failed to generate wallet: ${esc(errorText(e))}`, HTML);
        }
    });
    bot.callbackQuery("w_export", async (ctx) => {
        await ctx.answerCallbackQuery();
        const kb = new InlineKeyboard()
            .text("👁 Reveal Private Key", "w_export_confirm")
            .text("✖️ Cancel", "wallets");
        await ctx.reply(`⚠️ <b>Export Private Key</b>\n\nAre you sure you want to reveal the private key for <code>${esc(d.trader.accountId)}</code>?\n\nMake sure nobody else can see your screen.`, { ...HTML, reply_markup: kb });
    });
    bot.callbackQuery("w_export_confirm", async (ctx) => {
        await ctx.answerCallbackQuery();
        const w = d.db.activeWallet();
        if (!w)
            return void ctx.reply("Active wallet not found in database.");
        const kb = new InlineKeyboard().text("🗑 Delete this message", "del_msg").text("👛 Wallets", "wallets");
        const text = [
            `🔑 <b>Private Key for ${esc(w.accountId)}</b>:`,
            "",
            `<code>${esc(w.privateKey)}</code>`,
            "",
            "<i>🔒 Copy your key and tap 'Delete this message' when finished.</i>",
        ].join("\n");
        await ctx.reply(text, { ...HTML, reply_markup: kb });
    });
    bot.callbackQuery("w_rm_menu", async (ctx) => {
        await ctx.answerCallbackQuery();
        const list = d.db.wallets();
        if (list.length <= 1)
            return void ctx.reply("Cannot remove the only wallet.");
        const kb = new InlineKeyboard();
        for (const w of list) {
            const short = w.accountId.length > 20 ? `${w.accountId.slice(0, 8)}…${w.accountId.slice(-6)}` : w.accountId;
            kb.text(`❌ Remove ${short}`, `w_rm:${w.id}`).row();
        }
        kb.text("⬅️ Back to Wallets", "wallets");
        await ctx.reply("Select a wallet to remove from the bot:", { ...HTML, reply_markup: kb });
    });
    bot.callbackQuery(/^w_rm:(\d+)$/, async (ctx) => {
        const id = Number(ctx.match[1]);
        const target = d.db.walletById(id);
        if (!target)
            return void ctx.answerCallbackQuery("Wallet not found.");
        const list = d.db.wallets();
        if (list.length <= 1)
            return void ctx.answerCallbackQuery("Cannot remove the only wallet.");
        await ctx.answerCallbackQuery(`Removed ${target.accountId}`);
        const wasActive = target.accountId === d.trader.accountId;
        d.db.removeWallet(id);
        if (wasActive) {
            const nextActive = d.db.activeWallet();
            if (nextActive) {
                const newSigner = new Signer(d.rpc, nextActive.accountId, nextActive.privateKey, d.dryRun);
                await newSigner.init();
                const newFt = new Ft(d.rpc, nextActive.accountId);
                d.trader.switchSigner(newSigner, newFt);
                d.sniper.refresh();
            }
        }
        await showWallets(ctx);
    });
    bot.callbackQuery(/^w_pick:(.+)$/, async (ctx) => {
        const pick = ctx.match[1];
        const p = pending.get(ctx.chat.id);
        if (!p || p.kind !== "importWalletAccount") {
            await ctx.answerCallbackQuery("Import session expired.");
            return void ctx.reply("Import session expired. Please tap '➕ Import Wallet' again.", HTML);
        }
        let accountId = "";
        if (pick === "imp" || pick === "implicit") {
            accountId = p.implicitAccountId;
        }
        else {
            const idx = Number(pick);
            if (Number.isInteger(idx) && p.candidates && p.candidates[idx]) {
                accountId = p.candidates[idx];
            }
            else {
                accountId = pick;
            }
        }
        await ctx.answerCallbackQuery(`Selected ${accountId.length > 15 ? accountId.slice(0, 12) + "…" : accountId}`);
        await finalizeWalletImport(ctx, accountId, p.privateKey, p.publicKey);
    });
    bot.callbackQuery("w_cancel", async (ctx) => {
        pending.delete(ctx.chat.id);
        await ctx.answerCallbackQuery("Cancelled");
        await showWallets(ctx);
    });
    bot.callbackQuery("del_msg", async (ctx) => {
        await ctx.deleteMessage().catch(() => { });
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
        if (ref)
            await showCard(ctx, ref, !ctx.match[2]);
    });
    bot.callbackQuery(/^b:(\d+):(\d+)$/, async (ctx) => {
        const amount = d.db.settings().buyPresets[Number(ctx.match[2])];
        if (amount == null)
            return void ctx.answerCallbackQuery("Button changed, refresh the card");
        await ctx.answerCallbackQuery(`Buying ${amount} NEAR`);
        void runTrade(ctx, Number(ctx.match[1]), `Buy ${amount} NEAR`, (ref, s) => buy(ref, amount, s));
    });
    bot.callbackQuery(/^bx:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        pending.set(ctx.chat.id, { kind: "buyX", tid: Number(ctx.match[1]) });
        await ctx.reply("How much NEAR? Reply with a number, e.g. <code>35</code>", { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.callbackQuery(/^lb:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const tid = Number(ctx.match[1]);
        const ref = d.db.tokenRef(tid);
        if (!ref)
            return void ctx.reply("Token expired, paste it again.");
        let currentMcap;
        try {
            const s = await d.trader.snapshot(ref, d.db.settings());
            if (s.info?.marketCapUsd && s.info.marketCapUsd > 0) {
                currentMcap = s.info.marketCapUsd;
            }
        }
        catch { }
        pending.set(ctx.chat.id, { kind: "limitMcapTarget", target: ref, currentMcap });
        const mcapInfo = currentMcap ? `\nCurrent Market Cap: <b>$${compact(currentMcap)}</b>\n` : "";
        await ctx.reply(`🎯 <b>Limit Buy</b> for <code>${esc(ref)}</code>${mcapInfo}\nReply with target <b>Market Cap</b> in USD (e.g. <code>50k</code>, <code>500000</code>, <code>1.5m</code>):`, { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.callbackQuery(/^ls:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const tid = Number(ctx.match[1]);
        const ref = d.db.tokenRef(tid);
        if (!ref)
            return void ctx.reply("Token expired, paste it again.");
        let currentMcap;
        let held = 0;
        let symbol = ref.split(".")[0].toUpperCase();
        try {
            const s = await d.trader.snapshot(ref, d.db.settings());
            if (s.info?.marketCapUsd && s.info.marketCapUsd > 0) {
                currentMcap = s.info.marketCapUsd;
            }
            if (s.info?.symbol)
                symbol = s.info.symbol;
            held = fromRaw(s.balance, s.decimals);
        }
        catch { }
        pending.set(ctx.chat.id, { kind: "limitSellMcapTarget", target: ref, currentMcap, held, symbol });
        const mcapInfo = currentMcap ? `\nCurrent Market Cap: <b>$${compact(currentMcap)}</b>` : "";
        const balanceInfo = held > 0 ? `\n📦 Holding: <b>${compact(held)} ${esc(symbol)}</b>` : "";
        await ctx.reply(`🔴 <b>Limit Sell</b> for <code>${esc(ref)}</code>${balanceInfo}${mcapInfo}\n\nReply with target <b>Market Cap</b> in USD to trigger the sell (e.g. <code>250k</code>, <code>1.5m</code>, <code>50k</code>):`, { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.callbackQuery(/^s:(\d+):([\d.]+)$/, async (ctx) => {
        const p = Number(ctx.match[2]);
        await ctx.answerCallbackQuery(`Selling ${p}%`);
        void runTrade(ctx, Number(ctx.match[1]), `Sell ${p}%`, (ref, s) => sell(ref, p, s));
    });
    bot.callbackQuery(/^p:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery("Making PnL card…");
        const ref = d.db.tokenRef(Number(ctx.match[1]));
        if (!ref)
            return void ctx.reply("Token expired, paste it again.");
        const s = await d.trader.snapshot(ref, d.db.settings());
        const data = pnlCardData(s);
        if (!data)
            return void ctx.reply("No open position with a known entry for this token.");
        const caption = `$${esc(data.symbol)} · ${pct(data.pnlPct)} · ${data.pnlNear >= 0 ? "+" : "−"}${Math.abs(data.pnlNear).toFixed(2)} NEAR`;
        await ctx.replyWithPhoto(new InputFile(renderPnlCard(data), `pnl-${data.symbol}.png`), { caption, parse_mode: "HTML" });
    });
    // ------------------------------------------------------------- withdraw
    // Tap Withdraw -> type destination -> type amount (or max) -> review -> Confirm.
    /** Withdrawals waiting for their confirm tap, by short id. They expire after 5 minutes. */
    const withdrawals = new Map();
    bot.callbackQuery(/^w:(near|\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const asset = ctx.match[1] === "near" ? "near" : d.db.tokenRef(Number(ctx.match[1]));
        if (!asset || asset.includes(":"))
            return void ctx.reply("This can't be withdrawn from here.");
        pending.set(ctx.chat.id, { kind: "wdAddr", asset });
        const what = asset === "near" ? "NEAR" : "this token";
        await ctx.reply(`💸 Withdraw ${what}\n\nSend the <b>destination wallet</b> (e.g. <code>yourname.near</code>).`, {
            ...HTML,
            reply_markup: { force_reply: true },
        });
    });
    async function withdrawStep(ctx, p, text) {
        const chatId = ctx.chat.id;
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
        }
        catch (e) {
            // Keep the step open so the user can just send a corrected value.
            await ctx.reply(`⚠️ ${esc(errorText(e))}\nSend it again, or tap another button to cancel.`, HTML);
        }
    }
    bot.callbackQuery(/^wx:(\w+)$/, async (ctx) => {
        withdrawals.delete(ctx.match[1]);
        await ctx.answerCallbackQuery("Cancelled");
        await ctx.editMessageText("✖️ Withdrawal cancelled.").catch(() => { });
    });
    bot.callbackQuery(/^wc:(\w+)$/, async (ctx) => {
        const entry = withdrawals.get(ctx.match[1]);
        withdrawals.delete(ctx.match[1]);
        if (!entry || Date.now() - entry.at > 5 * 60_000) {
            await ctx.answerCallbackQuery("Expired");
            return void (await ctx.editMessageText("⌛ This withdrawal expired. Start again with 💸 Withdraw.").catch(() => { }));
        }
        await ctx.answerCallbackQuery("Sending…");
        const { plan } = entry;
        const amount = fromRaw(plan.amount, plan.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 });
        const label = `${amount} ${esc(plan.symbol)} to <code>${esc(plan.to)}</code>`;
        await ctx.editMessageText(`⚡ Sending ${label}…`, HTML).catch(() => { });
        if (d.dryRun)
            return void (await ctx.editMessageText(`DRY RUN, nothing sent: ${label}`, HTML).catch(() => { }));
        try {
            const hashes = await d.trader.executeWithdraw(plan);
            await ctx.editMessageText(`✅ Sent ${label}\n${hashes.map(txLink).join(" ")}`, HTML).catch(() => { });
        }
        catch (e) {
            await ctx.editMessageText(`❌ Withdrawal failed\n${esc(errorText(e))}`, HTML).catch(() => { });
        }
    });
    // ------------------------------------------------------------- sniper
    // Creator: watch a wallet and buy the first fresh token it launches. Token: buy a pasted token once it trades.
    function snipeTarget(s) {
        if (s.kind === "creator")
            return s.target;
        return s.target.startsWith("meme:") ? `meme.cooking raise #${s.target.slice(5)}` : s.target;
    }
    function sniperView() {
        const active = d.sniper.active();
        const delay = d.db.settings().snipeMaxDelaySec;
        const lines = ["<b>🎯 Sniper & Limit Orders</b>", ""];
        if (!active.length)
            lines.push("No active orders.");
        for (const s of active) {
            if (s.kind === "creator") {
                lines.push(`👤 <code>${esc(s.target)}</code>\n    buys <b>${near(s.nearAmount)}</b> of their next launch (JustHoot, Nearly, meme.cooking)`);
            }
            else if (s.kind === "limit_mcap") {
                const dir = s.mcapDirection === "gte" ? "≥" : "≤";
                const mcapStr = s.targetMcap ? `$${compact(s.targetMcap)}` : "–";
                lines.push(`🎯 <code>${esc(snipeTarget(s))}</code>\n    limit buy <b>${near(s.nearAmount)}</b> when MCap ${dir} <b>${mcapStr}</b>`);
            }
            else if (s.kind === "limit_sell") {
                const dir = s.mcapDirection === "gte" ? "≥" : "≤";
                const mcapStr = s.targetMcap ? `$${compact(s.targetMcap)}` : "–";
                const pctStr = `${s.sellPct ?? 100}%`;
                const tpSl = s.mcapDirection === "gte" ? "Take Profit" : "Stop Loss";
                lines.push(`🔴 <code>${esc(snipeTarget(s))}</code>\n    limit sell <b>${pctStr}</b> (${tpSl}) when MCap ${dir} <b>${mcapStr}</b>`);
            }
            else {
                lines.push(`🪙 <code>${esc(snipeTarget(s))}</code>\n    buys <b>${near(s.nearAmount)}</b> as soon as it trades`);
            }
        }
        lines.push("", `📡 Launch watcher: ${d.sniper.watching ? "🟢 live" : "⚪ off (starts with a creator snipe)"}`, `⏱ Skip a launch seen more than <b>${delay}s</b> late`);
        const kb = new InlineKeyboard();
        for (const s of active) {
            const icon = s.kind === "creator" ? "👤" : s.kind === "limit_mcap" ? "🎯" : s.kind === "limit_sell" ? "🔴" : "🪙";
            kb.text(`✖️ Cancel ${icon} ${snipeTarget(s).slice(0, 20)}`, `snx:${s.id}`).row();
        }
        kb.text("➕ Creator", "snp:c").text("➕ Token", "snp:t").row();
        kb.text("🎯 Limit Buy", "snp:m").text("🔴 Limit Sell", "snp:ls").row();
        kb.text(`⏱ Max delay ${delay}s`, "set:delay").text("🔄", "snp").text("⬅️ Home", "home");
        return { text: lines.join("\n"), kb };
    }
    async function showSniper(ctx, edit) {
        const v = sniperView();
        if (edit)
            await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.kb }).catch(ignoreNotModified);
        else
            await ctx.reply(v.text, { ...HTML, reply_markup: v.kb });
    }
    bot.command("snipe", (ctx) => showSniper(ctx, false));
    bot.callbackQuery("snp", async (ctx) => {
        await ctx.answerCallbackQuery();
        await showSniper(ctx, ctx.callbackQuery.message?.text?.startsWith("🎯") ?? false);
    });
    bot.callbackQuery(/^snp:(c|t)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const mode = ctx.match[1] === "c" ? "creator" : "token";
        pending.set(ctx.chat.id, { kind: "snipeTarget", mode });
        const ask = mode === "creator"
            ? "👤 Send the <b>creator's wallet</b> (e.g. <code>dev.near</code>).\nThe bot buys the first token they launch on JustHoot, Nearly or meme.cooking, then stops."
            : "🪙 Send the <b>token address or link</b>.\nThe bot buys it as soon as it can be traded (right away if it already trades).";
        await ctx.reply(ask, { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.callbackQuery("snp:m", async (ctx) => {
        await ctx.answerCallbackQuery();
        pending.set(ctx.chat.id, { kind: "limitTokenAddress" });
        await ctx.reply("🎯 <b>Limit Buy (Market Cap)</b>\n\nSend the <b>token address or link</b> you want to place a limit buy for:", { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.callbackQuery("snp:ls", async (ctx) => {
        await ctx.answerCallbackQuery();
        pending.set(ctx.chat.id, { kind: "limitSellTokenAddress" });
        await ctx.reply("🔴 <b>Limit Sell (Market Cap)</b>\n\nSend the <b>token address or link</b> you want to place a limit sell for:", { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.callbackQuery(/^lsp:(\d+)$/, async (ctx) => {
        const pct = Number(ctx.match[1]);
        const chatId = ctx.chat.id;
        const p = pending.get(chatId);
        if (!p || p.kind !== "limitSellPct") {
            return void ctx.answerCallbackQuery("Order expired or changed");
        }
        await ctx.answerCallbackQuery(`Selling ${pct}%`);
        pending.delete(chatId);
        const row = d.sniper.add("limit_sell", p.target, 0, p.targetMcap, p.direction, pct);
        const dirSymbol = p.direction === "gte" ? "≥" : "≤";
        const tpSl = p.direction === "gte" ? "Take Profit" : "Stop Loss";
        const lines = [
            `✅ <b>Limit Sell Placed!</b> (${tpSl})`,
            `🪙 Token: <code>${esc(p.target)}</code>`,
            `🎯 Trigger: MCap ${dirSymbol} <b>$${compact(p.targetMcap)}</b>`,
            `🔴 Selling: <b>${pct}%</b> of holdings`,
        ];
        if (d.dryRun)
            lines.push("DRY RUN: the limit sell will report instead of selling.");
        const v = sniperView();
        await ctx.reply(`${lines.join("\n")}\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
    });
    bot.callbackQuery("lsp:cancel", async (ctx) => {
        pending.delete(ctx.chat.id);
        await ctx.answerCallbackQuery("Cancelled");
        await showSniper(ctx, true);
    });
    bot.callbackQuery(/^snx:(\d+)$/, async (ctx) => {
        const ok = d.sniper.cancel(Number(ctx.match[1]));
        await ctx.answerCallbackQuery(ok ? "Order cancelled" : "Already ended");
        await showSniper(ctx, true);
    });
    async function snipeStep(ctx, p, text) {
        const chatId = ctx.chat.id;
        if (p.kind === "snipeTarget") {
            let target;
            try {
                if (p.mode === "creator")
                    target = await d.trader.checkWallet(text);
                else {
                    const parsed = parseInput(text);
                    if (!parsed)
                        throw new Error("That isn't a token address or link");
                    if (parsed.kind === "stock")
                        throw new Error("Stocks trade all the time; just buy them from their card");
                    target = parsed.kind === "meme" ? `meme:${parsed.memeId}` : parsed.accountId;
                }
            }
            catch (e) {
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
        if (wallet != null && wallet < amount + 0.1)
            lines.push(`⚠️ The wallet only has ${near(wallet)}. Top it up before the snipe fires.`);
        if (d.dryRun)
            lines.push("DRY RUN: the snipe will report instead of buying.");
        const v = sniperView();
        await ctx.reply(`${lines.join("\n")}\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
        return true;
    }
    async function limitBuyStep(ctx, p, text) {
        const chatId = ctx.chat.id;
        if (p.kind === "limitTokenAddress") {
            const parsed = parseInput(text);
            if (!parsed) {
                await ctx.reply("⚠️ That isn't a valid token address or link. Please send it again:", HTML);
                return true;
            }
            if (parsed.kind === "stock") {
                await ctx.reply("⚠️ Stocks are not supported for limit orders.", HTML);
                return true;
            }
            const target = parsed.kind === "meme" ? `meme:${parsed.memeId}` : parsed.accountId;
            let currentMcap;
            try {
                const s = await d.trader.snapshot(target, d.db.settings());
                if (s.info?.marketCapUsd && s.info.marketCapUsd > 0) {
                    currentMcap = s.info.marketCapUsd;
                }
            }
            catch { }
            pending.set(chatId, { kind: "limitMcapTarget", target, currentMcap });
            const mcapInfo = currentMcap ? `\nCurrent Market Cap: <b>$${compact(currentMcap)}</b>\n` : "";
            await ctx.reply(`🎯 Token: <code>${esc(target)}</code>${mcapInfo}\nReply with target <b>Market Cap</b> in USD (e.g. <code>50k</code>, <code>500000</code>, <code>1.5m</code>):`, { ...HTML, reply_markup: { force_reply: true } });
            return true;
        }
        if (p.kind === "limitMcapTarget") {
            const targetMcap = parseMcap(text);
            if (!targetMcap || targetMcap <= 0) {
                await ctx.reply("⚠️ Please enter a valid market cap, e.g. <code>50k</code>, <code>250000</code>, or <code>1.5m</code>:", HTML);
                return true;
            }
            const dir = p.currentMcap != null && targetMcap > p.currentMcap ? "gte" : "lte";
            pending.set(chatId, {
                kind: "limitMcapAmount",
                target: p.target,
                targetMcap,
                direction: dir,
            });
            const dirDesc = dir === "gte" ? `≥ $${compact(targetMcap)} (when MCap rises to target)` : `≤ $${compact(targetMcap)} (when MCap dips to target)`;
            await ctx.reply(`🎯 Target Market Cap: <b>$${compact(targetMcap)}</b>\nTriggers: <b>${dirDesc}</b>\n\nHow much <b>NEAR</b> should this limit buy spend? (e.g. <code>10</code>)`, { ...HTML, reply_markup: { force_reply: true } });
            return true;
        }
        if (p.kind === "limitMcapAmount") {
            const amount = Number(text.replace(",", "."));
            if (!Number.isFinite(amount) || amount <= 0) {
                await ctx.reply("⚠️ Send a valid amount of NEAR to spend, e.g. <code>10</code>.", HTML);
                return true;
            }
            pending.delete(chatId);
            const row = d.sniper.add("limit_mcap", p.target, amount, p.targetMcap, p.direction);
            const wallet = await d.trader.walletNear().then(yoctoToNear).catch(() => null);
            const dirSymbol = p.direction === "gte" ? "≥" : "≤";
            const lines = [
                `✅ <b>Limit Buy Placed!</b>`,
                `🪙 Token: <code>${esc(p.target)}</code>`,
                `🎯 Trigger: MCap ${dirSymbol} <b>$${compact(p.targetMcap)}</b>`,
                `💰 Spending: <b>${near(amount)}</b>`,
            ];
            if (wallet != null && wallet < amount + 0.1) {
                lines.push(`⚠️ Your active wallet only has ${near(wallet)}. Be sure it has funds when the limit triggers.`);
            }
            if (d.dryRun)
                lines.push("DRY RUN: the limit buy will report instead of buying.");
            const v = sniperView();
            await ctx.reply(`${lines.join("\n")}\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
            return true;
        }
        return false;
    }
    async function limitSellStep(ctx, p, text) {
        const chatId = ctx.chat.id;
        if (p.kind === "limitSellTokenAddress") {
            const parsed = parseInput(text);
            if (!parsed) {
                await ctx.reply("⚠️ That isn't a valid token address or link. Please send it again:", HTML);
                return true;
            }
            if (parsed.kind === "stock") {
                await ctx.reply("⚠️ Stocks are not supported for limit orders.", HTML);
                return true;
            }
            const target = parsed.kind === "meme" ? `meme:${parsed.memeId}` : parsed.accountId;
            let currentMcap;
            let held = 0;
            let symbol = target.split(".")[0].toUpperCase();
            try {
                const s = await d.trader.snapshot(target, d.db.settings());
                if (s.info?.marketCapUsd && s.info.marketCapUsd > 0) {
                    currentMcap = s.info.marketCapUsd;
                }
                if (s.info?.symbol)
                    symbol = s.info.symbol;
                held = fromRaw(s.balance, s.decimals);
            }
            catch { }
            pending.set(chatId, { kind: "limitSellMcapTarget", target, currentMcap, held, symbol });
            const mcapInfo = currentMcap ? `\nCurrent Market Cap: <b>$${compact(currentMcap)}</b>` : "";
            const balanceInfo = held > 0 ? `\n📦 Holding: <b>${compact(held)} ${esc(symbol)}</b>` : "";
            await ctx.reply(`🔴 Token: <code>${esc(target)}</code>${balanceInfo}${mcapInfo}\n\nReply with target <b>Market Cap</b> in USD to trigger the sell (e.g. <code>250k</code>, <code>1.5m</code>, <code>50k</code>):`, { ...HTML, reply_markup: { force_reply: true } });
            return true;
        }
        if (p.kind === "limitSellMcapTarget") {
            const targetMcap = parseMcap(text);
            if (!targetMcap || targetMcap <= 0) {
                await ctx.reply("⚠️ Please enter a valid market cap, e.g. <code>250k</code>, <code>500000</code>, or <code>1.5m</code>:", HTML);
                return true;
            }
            const dir = p.currentMcap != null && targetMcap < p.currentMcap ? "lte" : "gte";
            pending.set(chatId, {
                kind: "limitSellPct",
                target: p.target,
                targetMcap,
                direction: dir,
            });
            const dirDesc = dir === "gte" ? `≥ $${compact(targetMcap)} (Take Profit)` : `≤ $${compact(targetMcap)} (Stop Loss)`;
            const kb = new InlineKeyboard()
                .text("25%", "lsp:25")
                .text("50%", "lsp:50")
                .text("75%", "lsp:75")
                .text("100%", "lsp:100")
                .row()
                .text("✖️ Cancel", "lsp:cancel");
            await ctx.reply(`🔴 Target Market Cap: <b>$${compact(targetMcap)}</b>\nTriggers: <b>${dirDesc}</b>\n\nWhat <b>percentage</b> of your tokens should be sold?\nTap a preset below or reply with a number (e.g. <code>50</code>):`, { ...HTML, reply_markup: kb });
            return true;
        }
        if (p.kind === "limitSellPct") {
            const pct = Number(text.replace(/%/, "").replace(",", "."));
            if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
                await ctx.reply("⚠️ Send a percentage between 1 and 100 (e.g. <code>50</code> or <code>100</code>).", HTML);
                return true;
            }
            pending.delete(chatId);
            const row = d.sniper.add("limit_sell", p.target, 0, p.targetMcap, p.direction, pct);
            const dirSymbol = p.direction === "gte" ? "≥" : "≤";
            const tpSl = p.direction === "gte" ? "Take Profit" : "Stop Loss";
            const lines = [
                `✅ <b>Limit Sell Placed!</b> (${tpSl})`,
                `🪙 Token: <code>${esc(p.target)}</code>`,
                `🎯 Trigger: MCap ${dirSymbol} <b>$${compact(p.targetMcap)}</b>`,
                `🔴 Selling: <b>${pct}%</b> of holdings`,
            ];
            if (d.dryRun)
                lines.push("DRY RUN: the limit sell will report instead of selling.");
            const v = sniperView();
            await ctx.reply(`${lines.join("\n")}\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
            return true;
        }
        return false;
    }
    /** Snipe news goes to the admin's chat, since nothing the user tapped started it. */
    d.sniper.onEvent = (e) => void reportSnipe(e).catch((err) => console.error("Snipe report:", err));
    async function reportSnipe(e) {
        const chatId = d.adminId;
        const send = (text) => bot.api.sendMessage(chatId, text, HTML);
        const who = `<code>${esc(e.snipe.kind === "creator" ? e.snipe.target : snipeTarget(e.snipe))}</code>`;
        switch (e.type) {
            case "launch": {
                const l = e.launch;
                const what = l.memeId != null ? `meme.cooking raise <b>#${l.memeId}</b>${l.symbol ? ` (${esc(l.symbol)})` : ""}` : `<b>${esc(l.symbol ?? l.token.split(".")[0])}</b> on ${l.platform}\n<code>${esc(l.token)}</code>`;
                const next = l.memeId != null ? `Depositing ${near(e.snipe.nearAmount)}…` : `Buying ${near(e.snipe.nearAmount)} the moment its pool opens…`;
                await send(`🎯 ${who} just launched ${what}\n${next}`);
                return;
            }
            case "bought": {
                const r = e.outcome;
                const headline = e.snipe.kind === "limit_mcap"
                    ? `🎯 <b>Limit Buy Filled</b>`
                    : e.snipe.kind === "limit_sell"
                        ? `🔴 <b>Limit Sell Filled</b>`
                        : `✅ <b>Sniped</b>`;
                await send([`${headline} ${who} · ${esc(r.via)} · ${e.secs.toFixed(1)}s`, ...summaryLines(r), r.hashes.map(txLink).join(" ")].join("\n"));
                await Promise.race([r.recorded, new Promise((ok) => setTimeout(ok, 3000))]).catch(() => { });
                await postCard(chatId, e.ref).catch(() => { });
                return;
            }
            case "failed": {
                const headline = e.snipe.kind === "limit_mcap"
                    ? `❌ <b>Limit Buy failed</b>`
                    : e.snipe.kind === "limit_sell"
                        ? `❌ <b>Limit Sell failed</b>`
                        : `❌ <b>Snipe failed</b>`;
                await send(`${headline} ${who}${e.ref && e.ref !== e.snipe.target ? `\n<code>${esc(e.ref)}</code>` : ""}\n${esc(e.error)}${e.ended ? "\nThis order has ended." : ""}`);
                return;
            }
            case "skipped":
                await send(`⏭ Skipped <code>${esc(e.launch.token ?? `raise #${e.launch.memeId}`)}</code> from ${who}: ${esc(e.reason)}. Still watching.`);
                return;
            case "dryRun": {
                const headline = e.snipe.kind === "limit_mcap" ? "limit buy" : e.snipe.kind === "limit_sell" ? "limit sell" : "snipe";
                await send(`🧪 DRY RUN: would ${headline} of <code>${esc(e.ref)}</code> via ${esc(e.route.label)}. Nothing sent.`);
                return;
            }
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
        const prompts = {
            buy: [{ kind: "setBuy" }, `Send your buy amounts in NEAR, separated by spaces. Add or remove numbers to add or remove buttons.\nNow: <code>${s.buyPresets.join(" ")}</code>`],
            sell: [{ kind: "setSell" }, `Send your sell percentages, separated by spaces.\nNow: <code>${s.sellPresets.join(" ")}</code>`],
            slip: [{ kind: "setSlip" }, `Send slippage in percent (1-99).\nNow: <code>${s.slippagePct}</code>`],
            min: [{ kind: "setMin" }, `Hide positions worth less than how many USD?\nNow: <code>${s.minPositionUsd}</code>`],
            delay: [{ kind: "setDelay" }, `Skip a creator's launch if the bot sees it more than how many seconds late?\nNow: <code>${s.snipeMaxDelaySec}</code>`],
        };
        const [p, text] = prompts[what];
        pending.set(ctx.chat.id, p);
        await ctx.reply(text, { ...HTML, reply_markup: { force_reply: true } });
    });
    bot.on("message:text", async (ctx) => {
        const text = ctx.message.text.trim();
        const p = pending.get(ctx.chat.id);
        if (p) {
            const handled = await handlePending(ctx, p, text);
            if (handled)
                return;
        }
        const parsed = parseInput(text);
        if (!parsed)
            return void ctx.reply("Paste a token contract address or a JustHoot / Nearly / meme.cooking / Intear link.");
        const ref = parsed.kind === "token" ? parsed.accountId : parsed.kind === "meme" ? `meme:${parsed.memeId}` : `stock:${parsed.stock.symbol}`;
        await showCard(ctx, ref, false);
    });
    async function importWalletStep(ctx, text) {
        const chatId = ctx.chat.id;
        await ctx.deleteMessage().catch(() => { });
        const parsedInput = parseWalletInput(text);
        const keyCandidate = parsedInput.privateKeyCandidate;
        if (!keyCandidate) {
            await ctx.reply("⚠️ Could not find a private key in your message.\nPlease send a valid ed25519 private key, e.g. <code>ed25519:...</code>", HTML);
            return true;
        }
        let parsedKey;
        try {
            parsedKey = parsePrivateKey(keyCandidate);
        }
        catch (e) {
            await ctx.reply(`⚠️ ${esc(errorText(e))}`, HTML);
            return true;
        }
        if (parsedInput.accountId) {
            return await finalizeWalletImport(ctx, parsedInput.accountId, parsedKey.privateKey, parsedKey.publicKey);
        }
        const statusMsg = await ctx.reply("🔍 Checking accounts for this key…", HTML).catch(() => null);
        const discovered = await findAccountsForPublicKey(parsedKey.publicKey);
        if (statusMsg)
            await ctx.api.deleteMessage(chatId, statusMsg.message_id).catch(() => { });
        if (discovered.length === 1) {
            return await finalizeWalletImport(ctx, discovered[0], parsedKey.privateKey, parsedKey.publicKey);
        }
        if (discovered.length > 1) {
            pending.set(chatId, {
                kind: "importWalletAccount",
                privateKey: parsedKey.privateKey,
                publicKey: parsedKey.publicKey,
                implicitAccountId: parsedKey.implicitAccountId,
                candidates: discovered,
            });
            const kb = new InlineKeyboard();
            discovered.slice(0, 6).forEach((acc, i) => {
                const label = acc.length > 20 ? `${acc.slice(0, 8)}…${acc.slice(-6)}` : acc;
                kb.text(label, `w_pick:${i}`);
                if (i % 2 === 1)
                    kb.row();
            });
            if (discovered.length % 2 === 1)
                kb.row();
            kb.text("✖️ Cancel", "w_cancel");
            await ctx.reply(`Found multiple accounts for this key:\n${discovered.map((a) => `• <code>${esc(a)}</code>`).join("\n")}\n\nTap an account below or reply with the account ID you wish to use:`, { ...HTML, reply_markup: kb });
            return true;
        }
        const implicitExists = await d.rpc.accountExists(parsedKey.implicitAccountId).catch(() => false);
        if (implicitExists) {
            return await finalizeWalletImport(ctx, parsedKey.implicitAccountId, parsedKey.privateKey, parsedKey.publicKey);
        }
        pending.set(chatId, {
            kind: "importWalletAccount",
            privateKey: parsedKey.privateKey,
            publicKey: parsedKey.publicKey,
            implicitAccountId: parsedKey.implicitAccountId,
        });
        const kb = new InlineKeyboard()
            .text(`Use Implicit (${parsedKey.implicitAccountId.slice(0, 8)}…)`, "w_pick:imp")
            .row()
            .text("✖️ Cancel", "w_cancel");
        await ctx.reply(`🔑 <b>Key Verified</b>\nPublic key: <code>${esc(parsedKey.publicKey)}</code>\n\nCould not automatically find an account on-chain for this key.\n\nReply with your <b>NEAR Account ID</b> (e.g. <code>alice.near</code>) or tap below to use the implicit account:`, { ...HTML, reply_markup: kb });
        return true;
    }
    async function finalizeWalletImport(ctx, accountId, privateKey, publicKey) {
        const chatId = ctx.chat.id;
        pending.delete(chatId);
        const checkingMsg = await ctx.reply(`⚡ Verifying access key for <code>${esc(accountId)}</code>…`, HTML).catch(() => null);
        const res = await verifyAccessKey(d.rpc, accountId, publicKey);
        if (checkingMsg)
            await ctx.api.deleteMessage(chatId, checkingMsg.message_id).catch(() => { });
        if (!res.valid) {
            await ctx.reply(`❌ <b>Verification Failed</b>\nAccount: <code>${esc(accountId)}</code>\n\n${esc(res.error ?? "The key is not authorized for this account.")}\n\nMake sure the account ID and private key match.`, HTML);
            return true;
        }
        try {
            d.db.addWallet(accountId, privateKey, true);
            const newSigner = new Signer(d.rpc, accountId, privateKey, d.dryRun);
            await newSigner.init();
            const newFt = new Ft(d.rpc, accountId);
            d.trader.switchSigner(newSigner, newFt);
            d.sniper.refresh();
            const [bal, nearUsd] = await Promise.all([
                d.trader.walletNear().then(yoctoToNear).catch(() => 0),
                d.intear.nearUsd().catch(() => 0),
            ]);
            const kb = new InlineKeyboard().text("👛 Wallets", "wallets").text("⬅️ Home", "home");
            const lines = [
                "✅ <b>Wallet Imported & Activated!</b>",
                "",
                `Account: <code>${esc(accountId)}</code>`,
                `Balance: <b>${near(bal)}</b> · ${usd(bal * nearUsd)}`,
                `Key Type: ${res.permission === "FullAccess" ? "Full Access Key" : "Function Call Key"}`,
                `Public Key: <code>${esc(publicKey)}</code>`,
                "",
                "The bot is now trading with this wallet.",
            ];
            await ctx.reply(lines.join("\n"), { ...HTML, reply_markup: kb });
            return true;
        }
        catch (e) {
            await ctx.reply(`⚠️ Failed to activate wallet: ${esc(errorText(e))}`, HTML);
            return true;
        }
    }
    async function handlePending(ctx, p, text) {
        const chatId = ctx.chat.id;
        if (p.kind === "wdAddr" || p.kind === "wdAmount") {
            await withdrawStep(ctx, p, text);
            return true;
        }
        if (p.kind === "snipeTarget" || p.kind === "snipeAmount")
            return snipeStep(ctx, p, text);
        if (p.kind === "limitTokenAddress" || p.kind === "limitMcapTarget" || p.kind === "limitMcapAmount") {
            return await limitBuyStep(ctx, p, text);
        }
        if (p.kind === "limitSellTokenAddress" || p.kind === "limitSellMcapTarget" || p.kind === "limitSellPct") {
            return await limitSellStep(ctx, p, text);
        }
        if (p.kind === "importWallet")
            return await importWalletStep(ctx, text);
        if (p.kind === "importWalletAccount") {
            await ctx.deleteMessage().catch(() => { });
            const accountId = text.toLowerCase() === "implicit" ? p.implicitAccountId : text.trim();
            return await finalizeWalletImport(ctx, accountId, p.privateKey, p.publicKey);
        }
        const numbers = text.split(/[\s,]+/).filter(Boolean).map(Number);
        const valid = numbers.length > 0 && numbers.every((n) => Number.isFinite(n) && n > 0);
        if (!valid) {
            pending.delete(chatId);
            return false; // Not a number: treat it as a new token paste.
        }
        pending.delete(chatId);
        switch (p.kind) {
            case "buyX": {
                const amount = numbers[0];
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
                if (numbers[0] >= 100) {
                    await ctx.reply("Slippage must be under 100%.");
                    return true;
                }
                d.db.saveSettings({ slippagePct: numbers[0] });
                break;
            case "setMin":
                d.db.saveSettings({ minPositionUsd: numbers[0] });
                break;
            case "setDelay":
                d.db.saveSettings({ snipeMaxDelaySec: numbers[0] });
                await showSniper(ctx, false);
                return true;
        }
        const v = settingsView();
        await ctx.reply(`Saved.\n\n${v.text}`, { ...HTML, reply_markup: v.kb });
        return true;
    }
    bot.catch((err) => {
        console.error("Bot error:", err.error);
        err.ctx.reply(`⚠️ ${esc(errorText(err.error))}`, HTML).catch(() => { });
    });
    return bot;
}
/** "Sold 1.2M HOOT → 12.3 NEAR ($64)" plus the profit on that sale, when the entry is known. */
function summaryLines(r) {
    const t = r.summary;
    if (!t)
        return [];
    const amt = t.tokens > 0 ? `${compact(t.tokens)} ${esc(t.symbol)}` : esc(t.symbol);
    if (t.side === "buy")
        return [`🛒 Bought <b>${amt}</b> for <b>${near(t.near)}</b> (${usd(t.usd)})`];
    const out = [`💰 Sold <b>${amt}</b> → <b>${near(t.near)}</b> (${usd(t.usd)})`];
    if (t.pnlNear != null && t.pnlPct != null) {
        out.push(`${pnlEmoji(t.pnlPct)} PnL on this sale: <b>${t.pnlNear >= 0 ? "+" : "−"}${near(Math.abs(t.pnlNear))}</b> (${pct(t.pnlPct)})`);
    }
    return out;
}
function errorText(e) {
    return e instanceof Error ? e.message : String(e);
}
function ignoreNotModified(e) {
    if (e instanceof GrammyError && /not modified/.test(e.description))
        return;
    throw e;
}
//# sourceMappingURL=app.js.map