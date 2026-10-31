import { describe, expect, it } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { decodeSignedTransaction } from "@near-js/transactions";
import type { Db } from "../src/db.js";
import type { Intear } from "../src/market/intear.js";
import { Ft } from "../src/near/ft.js";
import type { Rpc, TxResult } from "../src/near/rpc.js";
import { Signer } from "../src/near/signer.js";
import { Trader } from "../src/trader.js";

const NEAR = 10n ** 24n;

function setup(opts: { registered?: boolean } = {}) {
  const sent: string[] = [];
  const rpc = {
    accountExists: async (a: string) => a === "friend.near",
    nearBalance: async () => 10n * NEAR,
    accessKey: async () => ({ nonce: 1n, blockHash: "11111111111111111111111111111111" }),
    latestBlockHash: async () => "11111111111111111111111111111111",
    view: async (_c: string, method: string) => {
      if (method === "ft_metadata") return { decimals: 18 };
      if (method === "ft_balance_of") return (500n * 10n ** 18n).toString();
      if (method === "storage_balance_of") return opts.registered ? { total: "1" } : null;
      if (method === "storage_balance_bounds") return { min: "1250000000000000000000" };
      return null;
    },
    sendTx: async (b64: string): Promise<TxResult> => {
      sent.push(b64);
      return { status: { SuccessValue: "" }, transaction: { hash: `H${sent.length}` }, transaction_outcome: { outcome: { status: {} } }, receipts_outcome: [] };
    },
  } as unknown as Rpc;
  const signer = new Signer(rpc, "bot.near", KeyPair.fromRandom("ed25519").toString());
  const intear = { token: async () => ({ symbol: "HOOT" }) } as unknown as Intear;
  const trader = new Trader(rpc, signer, new Ft(rpc, "bot.near"), intear, {} as Db, {});
  return { trader, signer, sent };
}

describe("withdraw", () => {
  it("rejects bad, own and non-existent destinations", async () => {
    const { trader } = setup();
    await expect(trader.checkDestination("not a wallet!")).rejects.toThrow(/valid NEAR wallet/);
    await expect(trader.checkDestination("bot.near")).rejects.toThrow(/own wallet/);
    await expect(trader.checkDestination("typo.near")).rejects.toThrow(/doesn't exist/);
    expect(await trader.checkDestination("  Friend.near ")).toBe("friend.near");
    expect(await trader.checkDestination("a".repeat(64))).toBe("a".repeat(64));
  });

  it("sends NEAR with max keeping 0.05 for gas, and refuses more than available", async () => {
    const { trader, signer, sent } = setup();
    const plan = await trader.planWithdraw("near", "friend.near", "max");
    expect(plan.amount).toBe(10n * NEAR - 5n * 10n ** 22n);
    await expect(trader.planWithdraw("near", "friend.near", "10")).rejects.toThrow(/can be sent/);

    await signer.init();
    signer.stop();
    await trader.executeWithdraw(plan);
    const tx = decodeSignedTransaction(Buffer.from(sent[0]!, "base64")).transaction;
    expect(tx.receiverId).toBe("friend.near");
    expect(BigInt(tx.actions[0]!.transfer!.deposit)).toBe(plan.amount);
  });

  it("sends tokens, registering the receiver first when needed", async () => {
    const { trader } = setup({ registered: false });
    const plan = await trader.planWithdraw("hoot.near", "friend.near", "12.5");
    expect(plan.amount).toBe(125n * 10n ** 17n);
    expect(plan.symbol).toBe("HOOT");
    expect(plan.txs.map((t) => t.calls[0]!.method)).toEqual(["storage_deposit", "ft_transfer"]);
    expect(plan.note).toMatch(/register/);
    await expect(trader.planWithdraw("hoot.near", "friend.near", "501")).rejects.toThrow(/only hold/);

    const registered = await setup({ registered: true }).trader.planWithdraw("hoot.near", "friend.near", "max");
    expect(registered.amount).toBe(500n * 10n ** 18n);
    expect(registered.txs.map((t) => t.calls[0]!.method)).toEqual(["ft_transfer"]);
  });
});
