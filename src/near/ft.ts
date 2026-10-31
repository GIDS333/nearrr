import { TGAS } from "../amount.js";
import type { Rpc } from "./rpc.js";
import type { Tx } from "./signer.js";

export const WRAP = "wrap.near";
const FT_REGISTRATION = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, standard NEP-145 minimum

/** Remembers which contracts the account is registered on, so a buy never waits on that check twice. */
export class Ft {
  private registered = new Set<string>();

  constructor(private readonly rpc: Rpc, private readonly accountId: string) {}

  async isRegistered(contractId: string, accountId = this.accountId): Promise<boolean> {
    const key = `${contractId}:${accountId}`;
    if (this.registered.has(key)) return true;
    const bal = await this.rpc.view<{ total: string } | null>(contractId, "storage_balance_of", { account_id: accountId }).catch(() => null);
    if (bal) this.registered.add(key);
    return !!bal;
  }

  markRegistered(contractId: string, accountId = this.accountId): void {
    this.registered.add(`${contractId}:${accountId}`);
  }

  /** A storage_deposit transaction if the account isn't registered on the token yet, else null. */
  async registrationTx(contractId: string, accountId = this.accountId): Promise<Tx | null> {
    if (await this.isRegistered(contractId, accountId)) return null;
    const bounds = await this.rpc
      .view<{ min: string } | null>(contractId, "storage_balance_bounds", {})
      .catch(() => null);
    const deposit = bounds?.min ? BigInt(bounds.min) : FT_REGISTRATION;
    return {
      receiverId: contractId,
      calls: [{ method: "storage_deposit", args: { account_id: accountId, registration_only: true }, gas: 10n * TGAS, deposit }],
    };
  }

  async balance(contractId: string, accountId = this.accountId): Promise<bigint> {
    const raw = await this.rpc.view<string>(contractId, "ft_balance_of", { account_id: accountId }).catch(() => "0");
    return BigInt(raw ?? "0");
  }
}
