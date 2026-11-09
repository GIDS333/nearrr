import { describe, expect, it } from "vitest";
import { generateNewWallet, parsePrivateKey, parseWalletInput } from "../src/near/wallet.js";

describe("near wallet helpers", () => {
  it("generates a new valid ed25519 wallet", () => {
    const w = generateNewWallet();
    expect(w.privateKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(w.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
    expect(w.implicitAccountId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses valid ed25519 private key with and without prefix", () => {
    const generated = generateNewWallet();
    const parsedWithPrefix = parsePrivateKey(generated.privateKey);
    expect(parsedWithPrefix.publicKey).toBe(generated.publicKey);
    expect(parsedWithPrefix.implicitAccountId).toBe(generated.implicitAccountId);

    const rawBase58 = generated.privateKey.replace("ed25519:", "");
    const parsedWithoutPrefix = parsePrivateKey(rawBase58);
    expect(parsedWithoutPrefix.publicKey).toBe(generated.publicKey);
    expect(parsedWithoutPrefix.implicitAccountId).toBe(generated.implicitAccountId);
  });

  it("throws on invalid private key", () => {
    expect(() => parsePrivateKey("not-a-valid-key")).toThrow(/Invalid ed25519 private key/);
  });

  it("parses combined wallet inputs", () => {
    const key = "ed25519:3b9n2kL9j3hG7dF5sA1qW2eR4tY6uI8oP0zX1c2v3b4n5m6";
    expect(parseWalletInput(key)).toEqual({ privateKeyCandidate: key });
    expect(parseWalletInput(`alice.near ${key}`)).toEqual({ accountId: "alice.near", privateKeyCandidate: key });
    expect(parseWalletInput(`${key} bob.near`)).toEqual({ accountId: "bob.near", privateKeyCandidate: key });
    expect(parseWalletInput("charlie.near")).toEqual({ accountId: "charlie.near" });
  });
});
