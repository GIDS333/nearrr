import bs58 from "bs58";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import type { Rpc } from "./rpc.js";

export interface ParsedKey {
  keyPair: KeyPair;
  privateKey: string;
  publicKey: string;
  implicitAccountId: string;
}

export function parsePrivateKey(raw: string): ParsedKey {
  let cleaned = raw.trim();
  if (!cleaned.startsWith("ed25519:")) {
    cleaned = `ed25519:${cleaned}`;
  }
  try {
    const keyPair = KeyPair.fromString(cleaned as KeyPairString);
    const publicKey = keyPair.getPublicKey().toString();
    const pubBytes = bs58.decode(publicKey.replace("ed25519:", ""));
    const implicitAccountId = Buffer.from(pubBytes).toString("hex");
    return {
      keyPair,
      privateKey: cleaned,
      publicKey,
      implicitAccountId,
    };
  } catch (e) {
    throw new Error(
      `Invalid ed25519 private key: ${e instanceof Error ? e.message : String(e)}. Key should start with ed25519: followed by base58 encoded secret.`,
    );
  }
}

export function generateNewWallet(): ParsedKey {
  const keyPair = KeyPair.fromRandom("ed25519");
  const privateKey = keyPair.toString();
  const publicKey = keyPair.getPublicKey().toString();
  const pubBytes = bs58.decode(publicKey.replace("ed25519:", ""));
  const implicitAccountId = Buffer.from(pubBytes).toString("hex");
  return {
    keyPair,
    privateKey,
    publicKey,
    implicitAccountId,
  };
}

export function parseWalletInput(text: string): { accountId?: string; privateKeyCandidate?: string } {
  const tokens = text.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) return {};
  if (tokens.length === 1) {
    const t = tokens[0]!;
    if (t.startsWith("ed25519:") || t.length > 50) {
      return { privateKeyCandidate: t };
    }
    return { accountId: t };
  }
  let privateKeyCandidate: string | undefined;
  let accountId: string | undefined;
  for (const t of tokens) {
    if (t.startsWith("ed25519:") || (!privateKeyCandidate && t.length > 50)) {
      privateKeyCandidate = t;
    } else if (!accountId) {
      accountId = t;
    }
  }
  return { accountId, privateKeyCandidate };
}

export async function findAccountsForPublicKey(publicKey: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.fastnear.com/v1/public_key/${encodeURIComponent(publicKey)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { account_ids?: string[] };
    return Array.isArray(data.account_ids) ? data.account_ids.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export async function verifyAccessKey(
  rpc: Rpc,
  accountId: string,
  publicKey: string,
): Promise<{ valid: boolean; permission?: string; error?: string }> {
  try {
    const info = await rpc.accessKeyInfo(accountId, publicKey);
    const perm = typeof info.permission === "string" ? info.permission : "FunctionCall";
    return { valid: true, permission: perm };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist/i.test(msg)) {
      return { valid: false, error: "Access key not found on this account." };
    }
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(msg)) {
      return { valid: false, error: "Account does not exist on NEAR mainnet." };
    }
    return { valid: false, error: msg };
  }
}
