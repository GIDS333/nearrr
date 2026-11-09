import WebSocket from "ws";
import { loadConfig } from "./config.js";
if (!globalThis.WebSocket) {
    // @ts-expect-error polyfill for Node < 22
    globalThis.WebSocket = WebSocket;
}
import { Db } from "./db.js";
import { Intear } from "./market/intear.js";
import { Ft } from "./near/ft.js";
import { Rpc } from "./near/rpc.js";
import { Signer } from "./near/signer.js";
import { Trader } from "./trader.js";
import { createBot } from "./bot/app.js";
import { Sniper } from "./sniper/sniper.js";
async function main() {
    const cfg = loadConfig();
    const db = new Db(cfg.dbPath);
    db.ensureWallet(cfg.accountId, cfg.privateKey);
    const activeWallet = db.activeWallet() ?? { accountId: cfg.accountId, privateKey: cfg.privateKey, id: 1, isActive: true, createdAt: Date.now() };
    const rpc = new Rpc(cfg.rpcUrls);
    const signer = new Signer(rpc, activeWallet.accountId, activeWallet.privateKey, cfg.dryRun);
    await signer.init();
    const intear = new Intear();
    const ft = new Ft(rpc, activeWallet.accountId);
    const trader = new Trader(rpc, signer, ft, intear, db, { intearApiKey: cfg.intearApiKey, oneClickJwt: cfg.oneClickJwt });
    // Older trade-log rows don't say which wallet made them; settle that from the chain.
    void trader
        .tagLegacyTrades("https://archival-rpc.mainnet.fastnear.com")
        .then((n) => n && console.log(`Tagged ${n} older logged trade(s) with their wallet`))
        .catch(() => { });
    const sniper = new Sniper(db, trader, rpc, cfg.dryRun);
    const bot = createBot({ token: cfg.botToken, adminId: cfg.adminId, db, trader, intear, rpc, sniper, dryRun: cfg.dryRun });
    sniper.start();
    await bot.api.setMyCommands([
        { command: "start", description: "Wallet and menu" },
        { command: "positions", description: "Open positions" },
        { command: "snipe", description: "Snipe a creator's next launch or a token" },
        { command: "wallets", description: "Switch or import wallets" },
        { command: "settings", description: "Buy/sell buttons, slippage, route" },
    ]);
    const stop = () => {
        sniper.stop();
        signer.stop();
        void bot.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`Trading as ${activeWallet.accountId} (key ${signer.publicKey})${cfg.dryRun ? " [DRY RUN]" : ""}`);
    await bot.start({ drop_pending_updates: true, allowed_updates: ["message", "callback_query"] });
}
main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map