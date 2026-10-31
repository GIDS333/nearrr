import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyPair } from "@near-js/crypto";
import { decodeSignedTransaction, encodeTransaction } from "@near-js/transactions";
import { Signer } from "../src/near/signer.js";
import type { Rpc, TxResult } from "../src/near/rpc.js";

/** Fake RPC that records what would be broadcast. */
function fakeRpc(sent: string[], nonce = 100n): Rpc {
  return {
    accessKey: async () => ({ nonce, blockHash: "11111111111111111111111111111111" }),
    latestBlockHash: async () => "11111111111111111111111111111111",
    sendTx: async (b64: string): Promise<TxResult> => {
      sent.push(b64);
      return {
        status: { SuccessValue: Buffer.from('"42"').toString("base64") },
        transaction: { hash: "HASH" },
        transaction_outcome: { outcome: { status: {} } },
        receipts_outcome: [],
      };
    },
  } as unknown as Rpc;
}

describe("Signer", () => {
  it("signs a valid transaction with increasing nonces, without reading the chain per trade", async () => {
    const key = KeyPair.fromRandom("ed25519");
    const sent: string[] = [];
    const signer = new Signer(fakeRpc(sent), "me.near", key.toString());
    await signer.init();
    signer.stop();

    const [a, b] = await signer.sendAll([
      { receiverId: "wrap.near", calls: [{ method: "near_deposit", args: {}, gas: 5_000_000_000_000n, deposit: 1n }] },
      { receiverId: "wrap.near", calls: [{ method: "ft_transfer_call", args: Buffer.from('{"x":1}'), gas: 1n, deposit: 1n }] },
    ]);
    expect(a!.returnValue).toBe("42");
    expect(b!.hash).toBe("HASH");

    const txs = sent.map((s) => decodeSignedTransaction(Buffer.from(s, "base64")));
    expect(txs.map((t) => t.transaction.nonce)).toEqual([101n, 102n]);
    expect(txs[0]!.transaction.signerId).toBe("me.near");
    expect(Array.from(txs[1]!.transaction.actions[0]!.functionCall!.args)).toEqual(Array.from(Buffer.from(`{"x":1}`)));

    // The signature verifies against the account's public key.
    const t = txs[0]!;
    const digest = createHash("sha256").update(encodeTransaction(t.transaction)).digest();
    const sig = t.signature as unknown as { ed25519Signature?: { data: number[] }; data?: number[] };
    expect(key.verify(digest, Uint8Array.from(sig.ed25519Signature?.data ?? sig.data ?? []))).toBe(true);
  });

  it("refuses to send in dry-run mode", async () => {
    const signer = new Signer(fakeRpc([]), "me.near", KeyPair.fromRandom("ed25519").toString(), true);
    await expect(signer.send({ receiverId: "x.near", calls: [] })).rejects.toThrow(/DRY_RUN/);
  });
});
