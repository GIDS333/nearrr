import { fromRaw, yoctoToNear } from "../amount.js";
import { entryMarketCap, holdingCost, pnlPct } from "../entry.js";
import { WITHDRAW_FEE_PCT } from "../venues/memecooking.js";
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
export const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function compact(n, digits = 2) {
    const a = Math.abs(n);
    if (a >= 1e9)
        return (n / 1e9).toFixed(digits) + "B";
    if (a >= 1e6)
        return (n / 1e6).toFixed(digits) + "M";
    if (a >= 1e3)
        return (n / 1e3).toFixed(digits) + "K";
    return n.toFixed(a >= 1 ? digits : 4);
}
/** Parses user input like "50k", "$1.5m", "250,000", "500000" into a USD number. */
export function parseMcap(text) {
    const clean = text.trim().replace(/^\$/, "").replace(/,/g, "").trim().toLowerCase();
    const match = clean.match(/^([\d.]+)\s*([kmbt])?$/);
    if (!match)
        return null;
    const val = Number(match[1]);
    if (!Number.isFinite(val) || val <= 0)
        return null;
    const suffix = match[2];
    if (!suffix)
        return val;
    if (suffix === "k")
        return val * 1_000;
    if (suffix === "m")
        return val * 1_000_000;
    if (suffix === "b")
        return val * 1_000_000_000;
    if (suffix === "t")
        return val * 1_000_000_000_000;
    return null;
}
/** Small prices use subscript zeros: 0.00000123 -> 0.0₅123 */
export function price(n) {
    if (!Number.isFinite(n) || n <= 0)
        return "0";
    if (n >= 1)
        return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    const zeros = Math.floor(-Math.log10(n));
    if (zeros < 4)
        return n.toPrecision(4).replace(/0+$/, "");
    const sig = Math.round(n * 10 ** (zeros + 4)).toString().slice(0, 4).replace(/0+$/, "");
    return `0.0${String(zeros).split("").map((d) => SUBSCRIPT[Number(d)]).join("")}${sig}`;
}
export const usd = (n) => (Math.abs(n) >= 1000 ? `$${compact(n)}` : `$${n.toFixed(2)}`);
export const usdPrice = (n) => `$${price(n)}`;
export const near = (n) => `${n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3)} Ⓝ`;
export const signedNear = (n) => `${n >= 0 ? "+" : "−"}${near(Math.abs(n))}`;
export const signedUsd = (n) => `${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}`;
export const pct = (n) => (n == null ? "–" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
export const pnlEmoji = (n) => (n == null ? "⚪" : n >= 0 ? "🟢" : "🔴");
export const txLink = (hash) => `<a href="https://nearblocks.io/txns/${hash}">tx</a>`;
export function tokenCard(s) {
    if (s.kind === "stock")
        return stockCard(s);
    if (s.kind === "meme")
        return memeCard(s);
    const i = s.info;
    const symbol = i?.symbol ?? s.ref.split(".")[0].toUpperCase();
    const held = fromRaw(s.balance, s.decimals);
    const priceUsd = i?.priceUsd ?? 0;
    const worthUsd = held * priceUsd;
    const worthNear = s.nearUsd > 0 ? worthUsd / s.nearUsd : held * (i?.priceNear ?? 0);
    const lines = [];
    lines.push(`<b>${esc(symbol)}</b> · ${esc(i?.name ?? "")}`);
    lines.push(`<code>${esc(s.ref)}</code>`);
    lines.push(`🛣 ${esc(s.route.label)}`);
    lines.push("");
    lines.push(`📊 Market cap: <b>${i?.marketCapUsd ? usd(i.marketCapUsd) : "–"}</b>${i?.change24h != null ? `  (${pct(i.change24h * 100)} 24h)` : ""}`);
    if (s.entry) {
        const mcAtEntry = i ? entryMarketCap(s.entry.priceUsd, i.marketCapUsd, i.priceUsd) : 0;
        const cost = holdingCost(s.entry, held);
        const p = pnlPct(worthNear, cost.near);
        const gainNear = worthNear - cost.near;
        const gainUsd = worthUsd - cost.usd;
        lines.push(`🎯 Entry MC: <b>${mcAtEntry ? usd(mcAtEntry) : "–"}</b>`);
        if (held > 0) {
            lines.push("");
            lines.push(`${pnlEmoji(p)} <b>PnL: ${pct(p)} · ${signedNear(gainNear)} (${signedUsd(gainUsd)})</b>`);
        }
    }
    else {
        lines.push(`🎯 Entry MC: –`);
    }
    lines.push("");
    lines.push(`💰 Worth: <b>${near(worthNear)}</b> · <b>${usd(worthUsd)}</b>`);
    lines.push(`📦 Holding: <b>${compact(held)} ${esc(symbol)}</b>`);
    lines.push("");
    lines.push(`👛 Wallet: <b>${near(s.walletNear)}</b>`);
    return lines.join("\n");
}
function memeCard(s) {
    const m = s.meme;
    if (!m || m.status === "missing" || m.status === "launched")
        return "meme.cooking raise not found";
    if (m.status === "failed") {
        return [
            `<b>${esc(m.meme.symbol)}</b> · ${esc(m.meme.name)}`,
            `🍳 meme.cooking raise #${m.meme.id} · <b>didn't launch</b> (soft cap not reached)`,
            `📦 Your deposit: <b>${near(yoctoToNear(s.balance))}</b>`,
            s.balance > 0n ? "Tap Claim (or any Sell) to get your NEAR back." : "",
            "",
            `👛 Wallet: ${near(s.walletNear)}`,
        ].join("\n");
    }
    const raised = yoctoToNear(m.meme.total_staked);
    const softCap = yoctoToNear(m.meme.soft_cap);
    const mine = yoctoToNear(s.balance);
    const left = Math.max(0, m.endsAt - Date.now());
    const time = left > 0 ? `${Math.floor(left / 3_600_000)}h ${Math.floor((left % 3_600_000) / 60_000)}m left` : "ended, waiting for launch";
    return [
        `<b>${esc(m.meme.symbol)}</b> · ${esc(m.meme.name)}`,
        `🍳 meme.cooking raise #${m.meme.id} · ${time}`,
        `🛣 Buy = deposit NEAR into the raise · Sell = withdraw (${WITHDRAW_FEE_PCT}% fee)`,
        "",
        `💧 Raised: ${near(raised)} (${usd(raised * s.nearUsd)}) · soft cap ${near(softCap)}`,
        `📦 Your deposit: <b>${near(mine)}</b> · <b>${usd(mine * s.nearUsd)}</b>`,
        "",
        `👛 Wallet: ${near(s.walletNear)}`,
    ].join("\n");
}
function stockCard(s) {
    const st = s.stock;
    const held = fromRaw(s.balance, 18);
    const pUsd = s.stockPrice?.usd ?? 0;
    const pNear = s.stockPrice?.near ?? 0;
    const p = s.entry ? pnlPct(held * pNear, holdingCost(s.entry, held).near) : null;
    return [
        `<b>${esc(st.symbol)}</b> · ${esc(st.name)}`,
        `<code>${esc(st.token)}</code>`,
        `🛣 ${esc(s.route.label)} (min ~$25, settles in ~1 min)`,
        "",
        `💲 Price: ${pUsd ? usd(pUsd) : "no quote (market closed?)"}${pNear ? ` · ${near(pNear)}` : ""}`,
        s.entry ? `🎯 Entry: ${usd(s.entry.priceUsd)} · ${near(s.entry.priceNear)}` : `🎯 Entry: –`,
        s.entry && held > 0 ? `${pnlEmoji(p)} PnL: ${pct(p)}` : "",
        `📦 Holding: ${held.toFixed(4)} ${esc(st.symbol)}`,
        `💰 Worth: <b>${near(held * pNear)}</b> · <b>${usd(held * pUsd)}</b>`,
        "",
        `👛 Wallet: ${near(s.walletNear)}`,
    ]
        .filter((l, i, a) => l !== "" || a[i - 1] !== "")
        .join("\n");
}
//# sourceMappingURL=format.js.map