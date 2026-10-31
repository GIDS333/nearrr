import { fromRaw } from "../amount.js";
import { WRAP } from "../near/ft.js";
import { DCL } from "../venues/dcl.js";
const RHEA = "v2.ref-finance.near";
/**
 * Prices read straight from a token's own pool on-chain, and its live total supply.
 * The indexer's price can lag the pool by tens of percent on thin memecoins; the pool can't.
 */
export class LivePrices {
    rpc;
    decimals = new Map([[WRAP, 24]]);
    supplies = new Map();
    constructor(rpc) {
        this.rpc = rpc;
    }
    async decimalsOf(token) {
        const known = this.decimals.get(token);
        if (known != null)
            return known;
        const m = await this.rpc.view(token, "ft_metadata");
        this.decimals.set(token, m.decimals);
        return m.decimals;
    }
    /** Whole tokens in existence right now (burns removed), cached for a minute. */
    async totalSupply(token) {
        const c = this.supplies.get(token);
        const [dec, supply] = await Promise.all([
            this.decimalsOf(token),
            c && Date.now() - c.at < 60_000 ? c.supply : this.rpc.view(token, "ft_total_supply").then(BigInt),
        ]);
        this.supplies.set(token, { at: c && Date.now() - c.at < 60_000 ? c.at : Date.now(), supply });
        return fromRaw(supply, dec);
    }
    /**
     * NEAR per whole token from its main pool, or null if the pool type isn't supported.
     * `nearPriceOf` prices the other side when the pool isn't against wNEAR (NEARLY, QTC, RHEA...).
     */
    async priceNear(token, pool, nearPriceOf) {
        if (!pool || pool.dex === "other")
            return null;
        let other;
        let priceInOther;
        if (pool.dex === "dcl") {
            const p = await this.rpc.view(DCL, "get_pool", { pool_id: pool.poolId });
            const [decX, decY] = await Promise.all([this.decimalsOf(p.token_x), this.decimalsOf(p.token_y)]);
            // DCL price: raw y per raw x = 1.0001^point.
            const xInY = 1.0001 ** p.current_point * 10 ** (decX - decY);
            if (p.token_x === token) {
                other = p.token_y;
                priceInOther = xInY;
            }
            else {
                other = p.token_x;
                priceInOther = 1 / xInY;
            }
        }
        else {
            const p = await this.rpc.view(RHEA, "get_pool", { pool_id: pool.poolId });
            if (p.pool_kind !== "SIMPLE_POOL" || p.token_account_ids.length !== 2)
                return null;
            const i = p.token_account_ids.indexOf(token);
            if (i < 0)
                return null;
            other = p.token_account_ids[1 - i];
            const [decT, decO] = await Promise.all([this.decimalsOf(token), this.decimalsOf(other)]);
            const amtT = fromRaw(p.amounts[i], decT);
            const amtO = fromRaw(p.amounts[1 - i], decO);
            if (amtT <= 0)
                return null;
            priceInOther = amtO / amtT;
        }
        if (!Number.isFinite(priceInOther) || priceInOther <= 0)
            return null;
        return other === WRAP ? priceInOther : priceInOther * (await nearPriceOf(other));
    }
}
//# sourceMappingURL=pools.js.map