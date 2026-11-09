/** Average-cost entry tracking. Pure functions, so they're easy to test. */
/**
 * Taxed tokens (e.g. Nearly's up to 4% per side) leave the indexer's sell amount short of what
 * actually left the wallet. A sell that leaves less than this share of the position is a full exit.
 */
const CLOSE_REMAINDER = 0.05;
/**
 * Average-cost method: buys add to the cost basis; sells remove cost in proportion to the
 * tokens sold, so the average entry price is unchanged by selling. A position sold down to
 * dust is closed, so old round-trips never leak into the current entry.
 * When the same transaction appears twice, the first fill wins: pass the bot's own records first.
 */
export function averageEntry(fills) {
    const seen = new Set();
    const ordered = [...fills]
        .filter((f) => {
        if (!f.tx)
            return true;
        if (seen.has(f.tx))
            return false;
        seen.add(f.tx);
        return true;
    })
        .sort((a, b) => a.ts - b.ts);
    let tokens = 0;
    let costNear = 0;
    let costUsd = 0;
    for (const f of ordered) {
        if (f.tokens <= 0)
            continue;
        if (f.side === "buy") {
            tokens += f.tokens;
            costNear += f.near;
            costUsd += f.usd;
        }
        else if (tokens > 0) {
            const sold = Math.min(f.tokens, tokens);
            const keep = (tokens - sold) / tokens;
            if (keep < CLOSE_REMAINDER) {
                tokens = costNear = costUsd = 0;
                continue;
            }
            costNear *= keep;
            costUsd *= keep;
            tokens -= sold;
        }
    }
    if (tokens <= 1e-12 || costNear <= 0)
        return null;
    return { tokens, costNear, costUsd, priceNear: costNear / tokens, priceUsd: costUsd / tokens };
}
/** Market cap at entry, on the same supply basis as the current market cap. */
export function entryMarketCap(entryPriceUsd, currentMcapUsd, currentPriceUsd) {
    if (currentPriceUsd <= 0)
        return 0;
    return entryPriceUsd * (currentMcapUsd / currentPriceUsd);
}
/**
 * What the tokens currently held cost. Holding up to 5% less than the basis is buy tax, not a
 * partial exit, so the full cost applies; otherwise the cost scales with what's held.
 */
export function holdingCost(entry, held) {
    let ratio = entry.tokens > 0 ? Math.min(1, held / entry.tokens) : 0;
    if (ratio < 1 && ratio >= 1 - CLOSE_REMAINDER)
        ratio = 1;
    return { near: entry.costNear * ratio, usd: entry.costUsd * ratio };
}
export function pnlPct(currentValue, cost) {
    return cost > 0 ? ((currentValue - cost) / cost) * 100 : null;
}
//# sourceMappingURL=entry.js.map