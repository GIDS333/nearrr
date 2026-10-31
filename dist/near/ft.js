import { TGAS } from "../amount.js";
export const WRAP = "wrap.near";
const FT_REGISTRATION = 1250000000000000000000n; // 0.00125 NEAR, standard NEP-145 minimum
/** Remembers which contracts the account is registered on, so a buy never waits on that check twice. */
export class Ft {
    rpc;
    accountId;
    registered = new Set();
    constructor(rpc, accountId) {
        this.rpc = rpc;
        this.accountId = accountId;
    }
    async isRegistered(contractId, accountId = this.accountId) {
        const key = `${contractId}:${accountId}`;
        if (this.registered.has(key))
            return true;
        const bal = await this.rpc.view(contractId, "storage_balance_of", { account_id: accountId }).catch(() => null);
        if (bal)
            this.registered.add(key);
        return !!bal;
    }
    markRegistered(contractId, accountId = this.accountId) {
        this.registered.add(`${contractId}:${accountId}`);
    }
    /** A storage_deposit transaction if the account isn't registered on the token yet, else null. */
    async registrationTx(contractId, accountId = this.accountId) {
        if (await this.isRegistered(contractId, accountId))
            return null;
        const bounds = await this.rpc
            .view(contractId, "storage_balance_bounds", {})
            .catch(() => null);
        const deposit = bounds?.min ? BigInt(bounds.min) : FT_REGISTRATION;
        return {
            receiverId: contractId,
            calls: [{ method: "storage_deposit", args: { account_id: accountId, registration_only: true }, gas: 10n * TGAS, deposit }],
        };
    }
    async balance(contractId, accountId = this.accountId) {
        const raw = await this.rpc.view(contractId, "ft_balance_of", { account_id: accountId }).catch(() => "0");
        return BigInt(raw ?? "0");
    }
}
//# sourceMappingURL=ft.js.map