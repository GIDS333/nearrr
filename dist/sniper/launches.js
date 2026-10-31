import { WRAP } from "../near/ft.js";
const NEARLY = "nearlytrade.near";
const JUSTHOOT = /^v\d+-launchpad\.justhoot\.near$/;
const MEME_COOKING = "meme-cooking.near";
function events(logs) {
    const out = [];
    for (const l of logs) {
        if (!l.startsWith("EVENT_JSON:"))
            continue;
        try {
            out.push(JSON.parse(l.slice(11)));
        }
        catch {
            // Not valid JSON: ignore.
        }
    }
    return out;
}
const items = (data) => (Array.isArray(data) ? data : [data]).filter((x) => !!x && typeof x === "object");
const str = (v) => (typeof v === "string" && v ? v.toLowerCase() : undefined);
/**
 * Finds launches in a block. Events are only trusted from the launchpads' own contracts (anyone can
 * write an EVENT_JSON log), and the token must be a sub-account the launchpad created.
 */
export function detectLaunches(block) {
    const found = [];
    const pools = new Map();
    for (const r of block.receipts) {
        const base = { atMs: block.timestampMs, txHash: r.txHash };
        for (const e of events(r.logs)) {
            if (r.executor === NEARLY && e.standard === "nearpad" && e.event === "launch_started") {
                for (const d of items(e.data)) {
                    const token = str(d.token), creator = str(d.creator);
                    if (!token?.endsWith(`.${NEARLY}`) || !creator)
                        continue;
                    const quote = str(d.quote) ?? WRAP;
                    found.push({ ...base, platform: "Nearly", creator, token, quote, poolId: str(d.pool_id) ?? `${token}|${quote}|10000`, symbol: d.symbol });
                }
            }
            else if (JUSTHOOT.test(r.executor) && e.standard === "hoot_launcher_v2") {
                for (const d of items(e.data)) {
                    const token = str(d.token_id);
                    if (!token?.endsWith(`.${r.executor}`))
                        continue;
                    const plan = d.plan;
                    const pool = str(plan?.pool_id) ?? str(d.pool_id);
                    if (pool)
                        pools.set(token, pool);
                    const creator = str(d.creator_id);
                    // launch_priced comes first; meme_launched is the backup if that event ever changes.
                    if (creator && (e.event === "launch_priced" || e.event === "meme_launched")) {
                        const quote = str(d.quote_token_id) ?? WRAP;
                        found.push({ ...base, platform: "JustHoot", creator, token, quote, poolId: `${token}|${quote}|10000` });
                    }
                }
            }
            else if (r.executor === MEME_COOKING && e.standard === "meme-cooking" && e.event === "create_meme") {
                for (const d of items(e.data)) {
                    const creator = str(d.owner);
                    const memeId = Number(d.meme_id);
                    if (creator && Number.isInteger(memeId))
                        found.push({ ...base, platform: "meme.cooking", creator, memeId, symbol: d.symbol });
                }
            }
        }
    }
    // The launchpad's own plan names the pool exactly (fee tier included) when it's in the same block.
    for (const l of found)
        if (l.token && pools.has(l.token))
            l.poolId = pools.get(l.token);
    // One launch per token: JustHoot can log both launch events in one block.
    return found.filter((l, i) => found.findIndex((o) => (o.token ?? o.memeId) === (l.token ?? l.memeId)) === i);
}
//# sourceMappingURL=launches.js.map