/**
 * The amount of `target` a swap actually paid out, read from the exchanges' own logs:
 * Rhea DCL emits a `dcl.ref` swap event, classic Rhea logs "Swapped A x for B y".
 * Only hops that end in `target` count, so multi-hop routes report their final output.
 * Returns null when no swap log mentions the target (e.g. an unfamiliar exchange).
 */
export function swappedOut(results, target, swapper) {
    let total = 0n;
    let found = false;
    for (const r of results) {
        for (const ro of r.receipts_outcome ?? []) {
            for (const log of ro.outcome.logs ?? []) {
                if (log.startsWith("EVENT_JSON:")) {
                    let ev;
                    try {
                        ev = JSON.parse(log.slice("EVENT_JSON:".length));
                    }
                    catch {
                        continue;
                    }
                    if (ev.standard !== "dcl.ref" || ev.event !== "swap")
                        continue;
                    for (const d of ev.data ?? []) {
                        if (d.token_out !== target || !d.amount_out)
                            continue;
                        if (swapper && d.swapper && d.swapper !== swapper)
                            continue;
                        total += BigInt(d.amount_out);
                        found = true;
                    }
                    continue;
                }
                const m = /^Swapped (\d+) (\S+) for (\d+) (\S+)$/.exec(log);
                if (m && m[4] === target) {
                    total += BigInt(m[3]);
                    found = true;
                }
            }
        }
    }
    return found ? total : null;
}
//# sourceMappingURL=receipts.js.map