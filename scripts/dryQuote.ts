/**
 * Read-only check of every route against mainnet: resolves each token's home venue, quotes a buy,
 * and prints the exact transactions the bot would sign. Nothing is signed or sent.
 *
 *   npm run quote -- <account.near> [amountNear] [token-or-link ...]
 */
import { KeyPair } from "@near-js/crypto";
import { fromRaw, yoctoToNear } from "../src/amount.js";
import { DEFAULT_SETTINGS } from "../src/db.js";
import type { Db } from "../src/db.js";
import { Intear } from "../src/market/intear.js";
import { Ft } from "../src/near/ft.js";
import { Rpc } from "../src/near/rpc.js";
import { Signer } from "../src/near/signer.js";
import { Trader } from "../src/trader.js";
import { parseInput } from "../src/venues/parse.js";

const [account = "wrap.near", amount = "1", ...inputs] = process.argv.slice(2);
const tokens = inputs.length
  ? inputs
  : [
      "https://justhoot.fun/p/hoot-8ecf65.launchpad.justhoot.near", // JustHoot -> own DCL pool
      "https://nearly.trade/nearly-993927.nearlytrade.near", // Nearly -> own DCL pool
      "https://nearly.trade/eclipse.nearlytrade.near", // Nearly, NEARLY pair -> router via DCL
      "https://justhoot.fun/p/quawk-98a6c4.launchpad.justhoot.near", // JustHoot, QTC pair
      "rheacat.nearlytrade.near", // Nearly, RHEA pair
      "btc.nearlytrade.near", // Nearly, BTC pair -> two legs
      "https://meme.cooking/meme/1992", // meme.cooking raise link
      "omgy-1992.meme-cooking.near", // meme.cooking launched -> classic Rhea pool
      "blackdragon.tkn.near", // classic Rhea
      "NVDA", // Nearly stock -> 1Click
    ];

const rpc = new Rpc((process.env.RPC_URLS ?? "https://rpc.mainnet.fastnear.com,https://near.lava.build").split(","));
const intear = new Intear();
const signer = new Signer(rpc, account, KeyPair.fromRandom("ed25519").toString(), true);
const noDb = { trades: () => [], addTrade: () => {} } as unknown as Db;
const trader = new Trader(rpc, signer, new Ft(rpc, account), intear, noDb, {});

for (const input of tokens) {
  const p = parseInput(input);
  if (!p) {
    console.log(`\n✗ ${input}: not a token`);
    continue;
  }
  const ref = p.kind === "token" ? p.accountId : p.kind === "meme" ? `meme:${p.memeId}` : `stock:${p.stock.symbol}`;
  const t0 = Date.now();
  try {
    const { route, quote } = await trader.preview(ref, "buy", Number(amount), DEFAULT_SETTINGS);
    const info = ref.includes(":") ? null : await intear.token(ref);
    const dec = info?.decimals ?? (ref.startsWith("stock:") ? 18 : 24);
    console.log(`\n✓ ${ref}  (${Date.now() - t0} ms)`);
    console.log(`  route: ${route.label}  ->  via ${quote.via}`);
    console.log(`  buy ${amount} NEAR -> ~${fromRaw(quote.expectedOut, dec).toLocaleString()} ${info?.symbol ?? ""} (min ${fromRaw(quote.minOut, dec).toLocaleString()} at ${DEFAULT_SETTINGS.slippagePct}% slippage)`);
    if (info) console.log(`  price $${info.priceUsd} · mcap $${Math.round(info.marketCapUsd).toLocaleString()} · liq $${Math.round(info.liquidityUsd).toLocaleString()}`);
    for (const tx of quote.txs) {
      console.log(`  tx -> ${tx.receiverId}`);
      for (const c of tx.calls) {
        const args = c.args instanceof Uint8Array ? Buffer.from(c.args).toString() : JSON.stringify(c.args);
        console.log(`       ${c.method} ${args.length > 220 ? args.slice(0, 220) + "…" : args}  [${c.gas / 10n ** 12n} TGas, ${c.deposit === 1n ? "1 yocto" : `${yoctoToNear(c.deposit)} NEAR`}]`);
      }
    }
  } catch (e) {
    console.log(`\n✗ ${ref}: ${e instanceof Error ? e.message : e}  (${Date.now() - t0} ms)`);
  }
}
