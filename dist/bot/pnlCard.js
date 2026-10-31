import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { fromRaw } from "../amount.js";
import { entryMarketCap, holdingCost, pnlPct } from "../entry.js";
import { compact } from "./format.js";
const W = 1200;
const H = 675;
const fontDir = dirname(createRequire(import.meta.url).resolve("@expo-google-fonts/inter/package.json"));
const FONT_FILES = ["400Regular/Inter_400Regular.ttf", "600SemiBold/Inter_600SemiBold.ttf", "800ExtraBold/Inter_800ExtraBold.ttf"].map((f) => join(fontDir, f));
// Fail at startup, not on the first tap, if a font is missing.
FONT_FILES.forEach((f) => readFileSync(f));
/** Bull for profit, bear for loss: Microsoft Fluent Emoji artwork (MIT), 32x32 SVG bodies. */
const emoji = createRequire(import.meta.url)("@iconify-json/fluent-emoji/icons.json");
const ANIMALS = { bull: emoji.icons.ox.body, bear: emoji.icons.bear.body };
/** Places a 32x32 artwork at (x, y) with the given size; ids are prefixed so they can't clash. */
function art(body, px, py, size, prefix) {
    const scoped = body.replace(/id="([^"]+)"/g, `id="${prefix}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`).replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`);
    return `<g transform="translate(${px} ${py}) scale(${size / 32})">${scoped}</g>`;
}
const x = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const nearAmt = (n) => (Math.abs(n) >= 1000 ? compact(n, 1) : Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2));
const signed = (n, s) => `${n >= 0 ? "+" : "−"}${s}`;
export function pnlCardSvg(d) {
    const up = d.pnlPct >= 0;
    const accent = up ? "#22e58b" : "#ff4d6a";
    const glow = up ? "#0f6b45" : "#7a1a2c";
    const pctText = signed(d.pnlPct, `${Math.abs(d.pnlPct) >= 1000 ? compact(Math.abs(d.pnlPct), 1) : Math.abs(d.pnlPct).toFixed(1)}%`);
    const pctSize = pctText.length > 8 ? 120 : 150;
    const multiple = d.investedNear > 0 ? d.worthNear / d.investedNear : 0;
    const date = new Date().toISOString().slice(0, 10);
    const stat = (col, row, label, value, color = "#e8edf2") => {
        const sx = 72 + col * 270;
        const sy = 498 + row * 0;
        return `
      <text x="${sx}" y="${sy}" font-family="Inter" font-weight="400" font-size="22" fill="#7d8a99" letter-spacing="1">${x(label)}</text>
      <text x="${sx}" y="${sy + 44}" font-family="Inter" font-weight="600" font-size="36" fill="${color}">${x(value)}</text>`;
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="78%" cy="30%" r="70%">
      <stop offset="0%" stop-color="${glow}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#0a0e13" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="55%" stop-color="#0a0e13" stop-opacity="0"/>
      <stop offset="78%" stop-color="#0a0e13" stop-opacity="0.92"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0d1218"/>
      <stop offset="100%" stop-color="#070a0e"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g opacity="0.92">${art(up ? ANIMALS.bull : ANIMALS.bear, 690, 34, 420, "a-")}</g>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="28" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>

  <circle cx="108" cy="112" r="40" fill="${accent}" fill-opacity="0.15" stroke="${accent}" stroke-width="2"/>
  <text x="108" y="126" text-anchor="middle" font-family="Inter" font-weight="800" font-size="38" fill="${accent}">${x(d.symbol.slice(0, 1).toUpperCase())}</text>
  <text x="168" y="108" font-family="Inter" font-weight="800" font-size="44" fill="#ffffff">$${x(clip(d.symbol.toUpperCase(), 14))}</text>
  <text x="170" y="146" font-family="Inter" font-weight="400" font-size="24" fill="#7d8a99">${x(clip(d.name, 34))} · ${x(clip(d.venue, 28))}</text>

  <text x="72" y="${238 + (150 - pctSize) / 3}" font-family="Inter" font-weight="400" font-size="24" fill="#7d8a99" letter-spacing="2">PNL</text>
  <text x="66" y="${370 - (150 - pctSize) / 2}" font-family="Inter" font-weight="800" font-size="${pctSize}" fill="${accent}">${x(pctText)}</text>
  <text x="72" y="428" font-family="Inter" font-weight="600" font-size="40" fill="${accent}">${x(signed(d.pnlNear, `${nearAmt(Math.abs(d.pnlNear))} NEAR`))}${multiple ? `<tspan dx="18" fill="#e8edf2" font-weight="400">· ${multiple.toFixed(2)}x</tspan>` : ""}</text>

  <line x1="72" y1="456" x2="${W - 72}" y2="456" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>
  ${stat(0, 0, "INVESTED", `${nearAmt(d.investedNear)} NEAR`)}
  ${stat(1, 0, "WORTH NOW", `${nearAmt(d.worthNear)} NEAR`, accent)}
  ${stat(2, 0, "ENTRY MC", d.entryMcUsd ? `$${compact(d.entryMcUsd, 1)}` : "–")}
  ${stat(3, 0, "CURRENT MC", d.currentMcUsd ? `$${compact(d.currentMcUsd, 1)}` : "–")}

  <text x="72" y="${H - 52}" font-family="Inter" font-weight="400" font-size="20" fill="#56616e">≈ $${x(d.worthUsd >= 1000 ? compact(d.worthUsd, 1) : d.worthUsd.toFixed(2))} · ${date}</text>
  <text x="${W - 72}" y="${H - 52}" text-anchor="end" font-family="Inter" font-weight="600" font-size="20" fill="#56616e" letter-spacing="2">NEAR PROTOCOL</text>
</svg>`;
}
export function renderPnlCard(d) {
    const resvg = new Resvg(pnlCardSvg(d), {
        font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
        fitTo: { mode: "width", value: W },
    });
    return Buffer.from(resvg.render().asPng());
}
/** Card numbers for the open position in a snapshot, or null when there's nothing to show. */
export function pnlCardData(s) {
    if (!s.entry || s.balance <= 0n)
        return null;
    const held = fromRaw(s.balance, s.decimals);
    const cost = holdingCost(s.entry, held);
    const stockNear = s.stockPrice?.near ?? 0;
    const worthNear = s.kind === "stock" ? held * stockNear : s.nearUsd > 0 ? (held * (s.info?.priceUsd ?? 0)) / s.nearUsd : held * (s.info?.priceNear ?? 0);
    const pnl = pnlPct(worthNear, cost.near);
    if (pnl == null)
        return null;
    const i = s.info;
    return {
        symbol: i?.symbol ?? s.stock?.symbol ?? s.ref.split(".")[0],
        name: i?.name ?? s.stock?.name ?? "",
        pnlPct: pnl,
        pnlNear: worthNear - cost.near,
        investedNear: cost.near,
        worthNear,
        worthUsd: worthNear * s.nearUsd,
        entryMcUsd: i ? entryMarketCap(s.entry.priceUsd, i.marketCapUsd, i.priceUsd) : 0,
        currentMcUsd: i?.marketCapUsd ?? 0,
        venue: s.route.label.split(" · ")[0],
    };
}
//# sourceMappingURL=pnlCard.js.map