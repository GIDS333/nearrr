const ROUTE_URL = "https://router.intear.tech/route";
const DEX_NAMES = {
    Rhea: "Rhea",
    RheaDcl: "Rhea DCL",
    Plach: "Intear Plach",
    Aidols: "Aidols",
    Wrap: "Wrap",
};
/** Router token id: "near" for native NEAR, nep141:<account> otherwise. */
export const routerToken = (id) => (id === "near" ? "near" : `nep141:${id}`);
/** Intear DEX aggregator: covers Rhea, Rhea DCL, Intear Plach and Aidols, and returns ready-to-sign transactions. */
export async function routerQuote(req) {
    const params = new URLSearchParams({
        token_in: routerToken(req.tokenIn),
        token_out: routerToken(req.tokenOut),
        amount_in: req.amountIn.toString(),
        // A single DEX answers fast; give "all DEXes" a little longer.
        max_wait_ms: req.dexes?.length === 1 ? "600" : "1200",
        slippage_type: "Fixed",
        slippage: String(req.slippagePct / 100),
        trader_account_id: req.trader,
    });
    if (req.dexes?.length)
        params.set("dexes", req.dexes.join(","));
    if (req.apiKey)
        params.set("key", req.apiKey);
    const res = await fetch(`${ROUTE_URL}?${params}`, { signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    if (!res.ok)
        throw new Error(`Router: ${text.slice(0, 200)}`);
    const quotes = JSON.parse(text);
    const best = quotes[0];
    if (!best)
        throw new Error(req.dexes ? `No route on ${req.dexes.map((d) => DEX_NAMES[d] ?? d).join(" / ")} for this token` : "No route found for this token");
    const txs = best.execution_instructions.map((instr) => {
        const kind = Object.keys(instr)[0];
        const t = kind === "NearTransaction" ? instr.NearTransaction : undefined;
        if (!t)
            throw new Error(`Router returned an unsupported step (${kind}); not executing`);
        return {
            receiverId: t.receiver_id,
            calls: t.actions.map((a) => {
                const fc = a.FunctionCall;
                if (!fc)
                    throw new Error(`Router returned an unsupported action (${Object.keys(a)[0]}); not executing`);
                return { method: fc.method_name, args: Buffer.from(fc.args, "base64"), gas: BigInt(fc.gas), deposit: BigInt(fc.deposit) };
            }),
        };
    });
    return {
        expectedOut: BigInt(best.estimated_amount.amount_out ?? "0"),
        minOut: BigInt(best.worst_case_amount.amount_out ?? "0"),
        txs,
        via: DEX_NAMES[best.dex_id] ?? best.dex_id,
        refundCheck: txs.at(-1)?.calls.at(-1)?.method === "ft_transfer_call",
    };
}
//# sourceMappingURL=router.js.map