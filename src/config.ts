import "dotenv/config";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing ${key} in .env (see .env.example)`);
  return value;
}

function optional(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

export interface Config {
  botToken: string;
  adminId: number;
  accountId: string;
  privateKey: string;
  rpcUrls: string[];
  intearApiKey?: string;
  oneClickJwt?: string;
  dryRun: boolean;
  dbPath: string;
}

export function loadConfig(): Config {
  const adminId = Number(required("ADMIN_ID"));
  if (!Number.isSafeInteger(adminId)) throw new Error("ADMIN_ID must be your numeric Telegram user ID");
  const privateKey = required("NEAR_PRIVATE_KEY");
  if (!privateKey.startsWith("ed25519:")) throw new Error("NEAR_PRIVATE_KEY must start with ed25519:");
  return {
    botToken: required("BOT_TOKEN"),
    adminId,
    accountId: required("NEAR_ACCOUNT_ID"),
    privateKey,
    rpcUrls: (optional("RPC_URLS") ?? "https://rpc.mainnet.fastnear.com,https://rpc.mainnet.near.org,https://archival-rpc.mainnet.near.org")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    intearApiKey: optional("INTEAR_API_KEY"),
    oneClickJwt: optional("ONECLICK_JWT"),
    dryRun: process.env.DRY_RUN?.trim() === "true",
    dbPath: optional("DB_PATH") ?? "data/bot.db",
  };
}
