# NEAR Trading Bot (Telegram)

A private Telegram bot that trades NEAR memecoins from **JustHoot**, **Nearly**, **meme.cooking** and the **Intear** ecosystem, plus Nearly's **Ondo stocks**. One tap trades: there are no confirmation prompts. Only your admin Telegram account can use it.

## How each token is routed

The bot reads every token's live home pool (`main_pool` from the Intear API) and trades there. That is its "original route".

| Token | Route |
|---|---|
| JustHoot / Nearly token with its own NEAR pool | Built directly against its own **Rhea DCL** pool (`dclv2.ref-labs.near`). One quote view, one swap transaction, no router hop. |
| Nearly / JustHoot token paired with NEARLY, QTC, RHEA, USDC... | Rhea DCL only, so the last hop is always the token's launch pool (e.g. NEAR → NEARLY → token). If DCL has no NEAR leg (e.g. BTC pair), it uses Nearly's two-leg route: NEAR → pair on Rhea, then pair → token on its DCL pool. |
| Token whose home is a classic **Rhea** pool (launched meme.cooking tokens, older tokens) | Intear router limited to `Rhea`. |
| Aidols / Intear Plach tokens | Intear router limited to that DEX. |
| **meme.cooking** raise still cooking | Buy = deposit NEAR into the raise. Sell = withdraw (meme.cooking keeps 2%). Failed raises: Sell/Claim gets your NEAR back. |
| **Ondo stocks** (NVDA, TSLA, SPY...) | NEAR Intents 1Click, the route nearly.trade uses. Minimum about $25, settles in about a minute, may have no quotes outside market hours. |

Settings → **Route** can switch to *Best price (all DEXes)* if you ever prefer price over venue.

## What the bot shows

- **Token card**: price, market cap, liquidity, your **entry price**, **entry market cap**, PnL, holdings, and **worth in NEAR and USD**. The entry is rebuilt from on-chain trade history, so trades made outside the bot count too.
- **Buy buttons**: 20 / 50 / 100 NEAR and **X** (asks for an amount, then buys immediately). Edit, add or remove them in Settings.
- **Sell buttons**: 25 / 50 / 75 / 100 %, editable in Settings.
- **Positions**: tokens, stocks and raise deposits worth **more than $1**. The threshold is editable.
- **Slippage**: 50% by default, editable (1–99%). A swap that would fill worse than this is refunded instead of filling.

## Wallets (👛 on the home screen, or /wallets)

- **Import wallet:** tap *➕ Import Wallet* and send your private key (`ed25519:...`) or account name and key (`<account.near> <private_key>`). The bot automatically removes your key message immediately for security, verifies the key on-chain, and sets it as the active wallet.
- **Auto-discovery:** pasting just a private key automatically queries FastNEAR to look up associated named accounts or falls back to the implicit account.
- **Multi-wallet switching:** switch between imported wallets with a single tap. Each wallet keeps its own separate positions and snipes.
- **Create new wallet:** generate fresh key pairs and implicit account addresses directly inside Telegram.
- **Export & remove:** view your active wallet's private key securely or remove unused wallets.

## Sniper (🎯 on the home screen, or /snipe)

- **Creator snipe:** give a wallet and an amount. The bot watches launches on JustHoot, Nearly and meme.cooking
  (Intear's free live event feed, only events from the launchpads' own contracts are trusted). When that wallet
  launches a token, the bot registers on it straight away and buys the moment its pool can fill the order
  (meme.cooking: deposits into the new raise). It buys once, then the snipe ends. A launch the bot sees later
  than the max delay (default 20s, changeable on the Sniper screen) is skipped and it keeps watching.
- **Token snipe:** paste a token that isn't trading yet; the bot checks every 1.5s and buys as soon as it trades
  (right away if it already does).
- Snipes are saved, survive restarts, and belong to the wallet that set them. No auto-sell: the token card is
  posted after the buy so you can sell with the usual buttons.

## Speed

- The nonce and block hash are kept in memory, so signing never waits on the chain.
- Each transaction goes to every RPC endpoint at once and the first answer wins.
- Results come back at optimistic execution (about 1–2 s), not finality.
- Home pools and token registrations are cached, and the token card pre-warms them.
- Trades run in the background, so you can tap again while one is in flight.

Put paid RPC endpoints (FastNEAR, Lava...) first in `RPC_URLS` for the lowest latency.

## Deploy on Railway

1. In Railway: **New Project → Deploy from GitHub repo** and pick this repo. `railway.json` sets the build (`npm run build`) and start command, one replica, and restart-always.
2. **Add a Volume** to the service, mounted at `/data`. It keeps your settings and trade log across deploys.
3. **Variables:** add `BOT_TOKEN`, `ADMIN_ID`, `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`, and `DB_PATH=/data/bot.db`. The optional ones are listed in `.env.example`.
4. Deploy. The logs should show `Trading as <account>`.

Only run **one** copy of the bot. Telegram rejects two copies polling the same bot token, so stop any local copy before the Railway one starts.

## Setup (VPS, Ubuntu)

```bash
# 1. Node 22 and pm2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs build-essential
sudo npm i -g pm2

# 2. Code and dependencies (copy this folder to the server first)
cd near-trade-bot && npm ci && npm run build

# 3. Config: fill in BOT_TOKEN, ADMIN_ID, NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY
cp .env.example .env && nano .env && chmod 600 .env

# 4. Check in dry-run first (DRY_RUN=true in .env): buttons show the exact transactions without sending
npm start

# 5. Go live: set DRY_RUN=false, then
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

- `BOT_TOKEN`: from @BotFather.
- `ADMIN_ID`: your numeric Telegram ID (ask @userinfobot).
- `NEAR_PRIVATE_KEY`: a full-access `ed25519:...` key for the trading account.

## Security

- The private key only lives in `.env` on your server. Keep it `chmod 600`, and never commit it (`.env` is git-ignored).
- Use a dedicated trading wallet that holds only what you are willing to trade, since trades fire with no confirmation.
- The bot always leaves 0.05 NEAR for gas.

## Commands

```bash
npm test                 # unit tests
npm run typecheck
npm run quote -- yourname.near 1                       # read-only: quote every route on mainnet, print the txs it would sign
npm run quote -- yourname.near 5 <token-or-link> ...   # same, for specific tokens
```
