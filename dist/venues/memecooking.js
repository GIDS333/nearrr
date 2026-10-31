import { TGAS } from "../amount.js";
import { WRAP } from "../near/ft.js";
/** meme.cooking: a fair auction. NEAR is deposited during "cooking"; at the end the token launches on Rhea. */
export const MEME_COOKING = "meme-cooking.near";
export const WITHDRAW_FEE_PCT = 2;
const API = "https://api.meme.cooking";
export const memeTokenAccount = (m) => `${m.symbol.toLowerCase()}-${m.id}.${MEME_COOKING}`;
export class MemeCookingVenue {
    rpc;
    ft;
    accountId;
    constructor(rpc, ft, accountId) {
        this.rpc = rpc;
        this.ft = ft;
        this.accountId = accountId;
    }
    /**
     * Raise status. The contract is the source of truth for live raises; meme.cooking's API is the only
     * place a failed raise (no launch, refunds open) is still visible.
     */
    async state(memeId) {
        const [active, finalized, api] = await Promise.all([
            this.rpc.view(MEME_COOKING, "get_meme", { meme_id: memeId }).catch(() => null),
            this.rpc.view(MEME_COOKING, "get_finalized_meme", { meme_id: memeId }).catch(() => null),
            fetch(`${API}/meme/${memeId}`, { signal: AbortSignal.timeout(4000) })
                .then((r) => (r.ok ? r.json() : null))
                .then((b) => b?.meme ?? null)
                .catch(() => null),
        ]);
        if (finalized)
            return { status: "launched", meme: finalized, token: memeTokenAccount(finalized) };
        if (active) {
            const endsAt = Number(active.end_timestamp_ms);
            return { status: endsAt > Date.now() ? "cooking" : "ended", meme: active, endsAt };
        }
        if (!api)
            return { status: "missing" };
        const meme = {
            id: api.meme_id,
            owner: api.owner,
            end_timestamp_ms: String(api.end_timestamp_ms),
            name: api.name,
            symbol: api.symbol,
            decimals: api.decimals,
            total_supply: api.total_supply,
            deposit_token_id: api.deposit_token_id,
            soft_cap: api.soft_cap,
            hard_cap: api.hard_cap ?? undefined,
            total_staked: api.total_deposit,
        };
        if (api.is_finalized && api.token_id)
            return { status: "launched", meme, token: api.token_id };
        const endsAt = Number(api.end_timestamp_ms);
        if (api.is_finalized)
            return { status: "failed", meme, endsAt };
        return { status: endsAt > Date.now() ? "cooking" : "ended", meme, endsAt };
    }
    /** The account's NEAR deposited into a raise (raw wNEAR). */
    async myDeposit(memeId) {
        const acc = await this.rpc
            .view(MEME_COOKING, "get_account", { account_id: this.accountId })
            .catch(() => null);
        for (const d of acc?.deposits ?? []) {
            // Entries are [meme_id, amount]; accept an object shape too.
            const [id, amount] = Array.isArray(d) ? d : [d.meme_id, d.amount];
            if (Number(id) === memeId)
                return BigInt(String(amount ?? "0"));
        }
        return 0n;
    }
    async claimable(memeId) {
        const v = await this.rpc
            .view(MEME_COOKING, "get_claimable", { account_id: this.accountId, meme_id: memeId })
            .catch(() => null);
        return BigInt(v ?? "0");
    }
    async depositTxs(meme, amount) {
        if (meme.deposit_token_id !== WRAP)
            throw new Error(`This raise takes ${meme.deposit_token_id}, not NEAR`);
        const [storage, costs, regWrap] = await Promise.all([
            this.rpc.view(MEME_COOKING, "storage_balance_of", { account_id: this.accountId }).catch(() => null),
            this.rpc.view(MEME_COOKING, "storage_costs", {}),
            this.ft.registrationTx(WRAP),
        ]);
        const txs = [];
        if (!storage) {
            txs.push({ receiverId: MEME_COOKING, calls: [{ method: "storage_deposit", args: {}, gas: 30n * TGAS, deposit: BigInt(costs.account) }] });
        }
        if (regWrap)
            txs.push(regWrap);
        txs.push({
            receiverId: WRAP,
            calls: [
                { method: "near_deposit", args: {}, gas: 15n * TGAS, deposit: amount },
                {
                    method: "ft_transfer_call",
                    args: { receiver_id: MEME_COOKING, amount: amount.toString(), msg: JSON.stringify({ Deposit: { meme_id: meme.id } }) },
                    gas: 100n * TGAS,
                    deposit: 1n,
                },
            ],
        });
        return txs;
    }
    /** Withdraw from a raise; meme.cooking keeps a 2% fee, the rest is unwrapped back to NEAR. */
    withdrawTxs(memeId, amount) {
        const received = amount - (amount * BigInt(WITHDRAW_FEE_PCT)) / 100n;
        return [
            { receiverId: MEME_COOKING, calls: [{ method: "withdraw", args: { meme_id: memeId, amount: amount.toString() }, gas: 100n * TGAS, deposit: 1n }] },
            { receiverId: WRAP, calls: [{ method: "near_withdraw", args: { amount: received.toString() }, gas: 20n * TGAS, deposit: 1n }] },
        ];
    }
    /** Claim launched tokens from a finished raise, or the NEAR refund from a failed one. */
    async claimTxs(meme, refund = false) {
        const reg = refund ? null : await this.ft.registrationTx(memeTokenAccount(meme));
        const claim = { receiverId: MEME_COOKING, calls: [{ method: "claim", args: { meme_id: meme.id }, gas: 50n * TGAS, deposit: 1n }] };
        return reg ? [reg, claim] : [claim];
    }
}
//# sourceMappingURL=memecooking.js.map