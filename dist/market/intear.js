/** Intear API (api.intea.rs): prices, liquidity, market cap, balances and trade history for NEAR tokens. */
const BASE = "https://api.intea.rs";
export const TOKEN_FIELDS = [
    "symbol",
    "name",
    "decimals",
    "price_usd",
    "price_near",
    "liquidity_usd",
    "market_cap_usd",
    "fdv_usd",
    "main_pool",
    "price_change_24h",
];
function rowsToObjects(t) {
    return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
}
async function get(path, params) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json());
    if (!res.ok || body.error)
        throw new Error(`Intear API: ${body.error?.message ?? res.status}`);
    return body;
}
function toTokenInfo(o) {
    const priceUsd = Number(o.price_usd ?? 0);
    const mcap = Number(o.market_cap_usd || 0) || Number(o.fdv_usd || 0);
    return {
        accountId: String(o.account_id),
        symbol: String(o.symbol ?? "?"),
        name: String(o.name ?? o.symbol ?? "?"),
        decimals: Number(o.decimals ?? 0),
        priceUsd,
        priceNear: Number(o.price_near ?? 0),
        liquidityUsd: Number(o.liquidity_usd ?? 0),
        marketCapUsd: mcap,
        mcapSupply: priceUsd > 0 ? mcap / priceUsd : 0,
        mainPool: o.main_pool ?? null,
        change24h: o.price_change_24h == null ? null : Number(o.price_change_24h),
    };
}
export class Intear {
    cache = new Map();
    async tokens(ids, maxAgeMs = 2000) {
        const out = new Map();
        const now = Date.now();
        const missing = ids.filter((id) => {
            const c = this.cache.get(id);
            if (c && now - c.at < maxAgeMs) {
                out.set(id, c.info);
                return false;
            }
            return true;
        });
        if (missing.length) {
            const body = await get("/tokens", { ids: missing.join(","), fields: TOKEN_FIELDS.join(",") });
            for (const o of rowsToObjects(body)) {
                const info = toTokenInfo(o);
                this.cache.set(info.accountId, { at: now, info });
                out.set(info.accountId, info);
            }
        }
        return out;
    }
    async token(id, maxAgeMs) {
        return (await this.tokens([id], maxAgeMs)).get(id) ?? null;
    }
    async nearUsd() {
        return (await this.token("wrap.near", 15_000))?.priceUsd ?? 0;
    }
    /** Every token the account holds directly, with price data. */
    async holdings(accountId) {
        const body = await get("/balances", {
            account: accountId,
            sources: "direct",
            token_fields: TOKEN_FIELDS.join(","),
        });
        const infos = new Map(rowsToObjects(body.tokens ?? { columns: [], rows: [] }).map((o) => [String(o.account_id), toTokenInfo(o)]));
        const out = [];
        for (const b of rowsToObjects(body.balances)) {
            const info = infos.get(String(b.token));
            const balance = BigInt(String(b.balance ?? "0"));
            if (info && balance > 0n)
                out.push({ token: info, balance });
        }
        return out;
    }
    /** The account's swaps of one token, oldest first. */
    async trades(trader, token) {
        const fields = "side,token_in,amount_in,token_out,amount_out,usd_value,timestamp_millis,transaction_id";
        const out = [];
        let cursor = null;
        for (let page = 0; page < 10; page++) {
            const params = { trader, token, fields, limit: 200, order: "oldest" };
            if (cursor)
                params.cursor = cursor;
            const body = await get("/trades", params);
            for (const o of rowsToObjects(body)) {
                if (o.side !== "buy" && o.side !== "sell")
                    continue;
                out.push({
                    side: o.side,
                    tokenIn: String(o.token_in),
                    amountIn: String(o.amount_in),
                    tokenOut: String(o.token_out),
                    amountOut: String(o.amount_out),
                    usdValue: o.usd_value == null ? null : Number(o.usd_value),
                    timestampMillis: Number(o.timestamp_millis),
                    txId: String(o.transaction_id),
                });
            }
            cursor = body.next_cursor;
            if (!cursor)
                break;
        }
        return out;
    }
}
//# sourceMappingURL=intear.js.map