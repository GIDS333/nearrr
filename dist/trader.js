import { fromRaw, nearToYocto, percentOf, toRaw, yoctoToNear, TGAS } from "./amount.js";
import { averageEntry, holdingCost } from "./entry.js";
import { LivePrices } from "./market/pools.js";
import { WRAP } from "./near/ft.js";
import { DclVenue } from "./venues/dcl.js";
import { MemeCookingVenue } from "./venues/memecooking.js";
import { OneClickVenue } from "./venues/oneclick.js";
import { memeIdFromAccount, parseMainPool } from "./venues/parse.js";
import { swappedOut } from "./venues/receipts.js";
import { routerQuote } from "./venues/router.js";
import { findStock } from "./venues/stocks.js";
/** NEAR always left in the wallet for gas and storage. */
const GAS_RESERVE = nearToYocto("0.05");
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const IMPLICIT_RE = /^([0-9a-f]{64}|0x[0-9a-f]{40})$/;
export class Trader {
    rpc;
    signer;
    ft;
    intear;
    db;
    opts;
    dcl;
    memeCooking;
    oneClick;
    prices;
    constructor(rpc, signer, ft, intear, db, opts) {
        this.rpc = rpc;
        this.signer = signer;
        this.ft = ft;
        this.intear = intear;
        this.db = db;
        this.opts = opts;
        this.dcl = new DclVenue(rpc, ft);
        this.memeCooking = new MemeCookingVenue(rpc, ft, signer.accountId);
        this.oneClick = new OneClickVenue(rpc, ft, signer.accountId, opts.oneClickJwt);
        this.prices = new LivePrices(rpc);
    }
    get accountId() {
        return this.signer.accountId;
    }
    get currentSigner() {
        return this.signer;
    }
    get currentFt() {
        return this.ft;
    }
    switchSigner(signer, ft) {
        this.signer.stop();
        this.signer = signer;
        this.ft = ft;
        this.dcl = new DclVenue(this.rpc, ft);
        this.memeCooking = new MemeCookingVenue(this.rpc, ft, signer.accountId);
        this.oneClick = new OneClickVenue(this.rpc, ft, signer.accountId, this.opts.oneClickJwt);
        this.routes.clear();
    }
    async tokenDecimals(token, info) {
        if (typeof info?.decimals === "number" && info.decimals > 0)
            return info.decimals;
        return this.prices.decimalsOf(token).catch(() => 24);
    }
    routes = new Map();
    /** Works out the token's original venue from its live main pool (or uses the best price, if set). */
    async route(ref, settings, info) {
        // Home pools don't move; cache for 2 minutes so a tap never waits on market data.
        const key = `${settings.routeMode}:${ref}`;
        const cached = this.routes.get(key);
        if (cached && Date.now() - cached.at < 120_000)
            return cached.route;
        const route = await this.findRoute(ref, settings, info);
        this.routes.set(key, { at: Date.now(), route });
        return route;
    }
    async findRoute(ref, settings, info) {
        if (ref.startsWith("stock:"))
            return { kind: "stock", symbol: ref.slice(6), label: "NEAR Intents 1Click" };
        if (ref.startsWith("meme:"))
            return { kind: "memecooking", memeId: Number(ref.slice(5)), label: "meme.cooking raise" };
        if (settings.routeMode === "best")
            return { kind: "router", label: "Best price, all DEXes" };
        const tokenInfo = info === undefined ? await this.intear.token(ref).catch(() => null) : info;
        const pool = parseMainPool(tokenInfo?.mainPool ?? null);
        if (pool?.dex === "dcl") {
            if (pool.tokens.includes(WRAP))
                return { kind: "dcl", poolId: pool.poolId, label: `Rhea DCL · own NEAR pool` };
            const pair = pool.tokens.find((t) => t !== ref) ?? "?";
            return { kind: "dclPair", poolId: pool.poolId, pair, label: `Rhea DCL · own ${pairName(pair)} pool` };
        }
        if (pool?.dex === "rhea")
            return { kind: "router", dexes: ["Rhea"], label: `Rhea pool #${pool.poolId}` };
        if (pool?.dex === "other") {
            if (/aidol/i.test(pool.raw))
                return { kind: "router", dexes: ["Aidols"], label: "Aidols" };
            if (/plach|intear/i.test(pool.raw))
                return { kind: "router", dexes: ["Plach"], label: "Intear Plach" };
        }
        if (ref.endsWith(".aidols.near"))
            return { kind: "router", dexes: ["Aidols", "RheaDcl", "Rhea"], label: "Aidols" };
        return { kind: "router", label: "Best available (no main pool found)" };
    }
    /**
     * Tags trades logged before wallets were recorded with the wallet that actually signed them,
     * read from the transaction on-chain. Runs once in the background at startup.
     * Trades this wallet didn't sign are tagged "other" so they never count toward its entry.
     */
    async tagLegacyTrades(archivalRpc) {
        let tagged = 0;
        for (const t of this.db.untaggedTrades()) {
            let signer = null;
            if (t.txHash) {
                const res = await fetch(archivalRpc, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: t.txHash, sender_account_id: this.accountId, wait_until: "NONE" } }),
                    signal: AbortSignal.timeout(10_000),
                })
                    .then((r) => r.json())
                    .catch(() => null);
                if (!res)
                    continue; // Network trouble: try again next startup.
                signer = res.result?.transaction?.signer_id ?? null;
            }
            this.db.tagTrade(t.id, signer === this.accountId ? this.accountId : signer ?? "other");
            tagged++;
        }
        return tagged;
    }
    /** Checks a withdrawal destination: valid NEAR account, not this wallet, and existing (named accounts). */
    async checkDestination(raw) {
        const to = raw.trim().toLowerCase();
        if (!ACCOUNT_RE.test(to))
            throw new Error(`"${raw.trim()}" isn't a valid NEAR wallet address`);
        if (to === this.accountId)
            throw new Error("That's the bot's own wallet");
        // Implicit accounts (64-hex or 0x...) come into existence when they first receive NEAR.
        if (!IMPLICIT_RE.test(to) && !(await this.rpc.accountExists(to))) {
            throw new Error(`The wallet ${to} doesn't exist on NEAR. Check the spelling`);
        }
        return to;
    }
    /** A wallet to watch for launches: a valid NEAR account that exists (implicit ones always can). */
    async checkWallet(raw) {
        const id = raw.trim().toLowerCase();
        if (!ACCOUNT_RE.test(id))
            throw new Error(`"${raw.trim()}" isn't a valid NEAR wallet address`);
        if (!IMPLICIT_RE.test(id) && !(await this.rpc.accountExists(id)))
            throw new Error(`The wallet ${id} doesn't exist on NEAR. Check the spelling`);
        return id;
    }
    /**
     * Builds a withdrawal of NEAR ("near") or a token to `to`. `amountText` is a number or "max".
     * NEAR keeps the gas reserve in the wallet; tokens register the receiver if needed so they arrive.
     */
    async planWithdraw(asset, to, amountText) {
        const text = amountText.trim().toLowerCase();
        const max = text === "max" || text === "all";
        if (asset === "near") {
            const free = await this.walletNear();
            const available = free > GAS_RESERVE ? free - GAS_RESERVE : 0n;
            const amount = max ? available : nearToYocto(text);
            if (amount <= 0n)
                throw new Error("Amount must be more than 0");
            if (amount > available)
                throw new Error(`Only ${yoctoToNear(available).toFixed(4)} NEAR can be sent (0.05 is kept for gas)`);
            return { asset, symbol: "NEAR", decimals: 24, to, amount, txs: [{ receiverId: to, calls: [], transfer: amount }] };
        }
        const [decimals, balance, info, registration] = await Promise.all([
            this.prices.decimalsOf(asset),
            this.ft.balance(asset),
            this.intear.token(asset, 60_000).catch(() => null),
            this.ft.registrationTx(asset, to),
        ]);
        const amount = max ? balance : toRaw(text, decimals);
        if (amount <= 0n)
            throw new Error("Amount must be more than 0");
        if (amount > balance)
            throw new Error(`You only hold ${fromRaw(balance, decimals).toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
        const send = {
            receiverId: asset,
            calls: [{ method: "ft_transfer", args: { receiver_id: to, amount: amount.toString() }, gas: 30n * TGAS, deposit: 1n }],
        };
        return {
            asset,
            symbol: info?.symbol ?? asset.split(".")[0],
            decimals,
            to,
            amount,
            txs: registration ? [registration, send] : [send],
            note: registration ? "The receiver isn't registered on this token yet; the bot pays ~0.00125 NEAR to register it." : undefined,
        };
    }
    async executeWithdraw(plan) {
        const sent = await this.signer.sendAll(plan.txs);
        return sent.map((s) => s.hash);
    }
    async walletNear() {
        return this.rpc.nearBalance(this.accountId);
    }
    // ---------------------------------------------------------------- snapshots
    async snapshot(ref, settings) {
        const nearUsdP = this.intear.nearUsd().catch(() => 0);
        const walletP = this.walletNear().then(yoctoToNear).catch(() => 0);
        if (ref.startsWith("stock:")) {
            const stock = findStock(ref.slice(6));
            if (!stock)
                throw new Error("Unknown stock");
            const [h, price, nearUsd, walletNear] = await Promise.all([
                this.oneClick.holdings(stock),
                this.oneClick.price(stock).catch(() => undefined),
                nearUsdP,
                walletP,
            ]);
            return {
                ref, kind: "stock", route: await this.route(ref, settings), info: null, nearUsd, walletNear,
                balance: h.intents + h.wallet, decimals: 18, entry: this.entryFromDb(ref, nearUsd), stock, stockPrice: price,
            };
        }
        if (ref.startsWith("meme:")) {
            const memeId = Number(ref.slice(5));
            const meme = await this.memeCooking.state(memeId);
            if (meme.status === "launched") {
                // Launched raises trade like any other token, on their Rhea pool.
                return { ...(await this.snapshot(meme.token, settings)), meme };
            }
            const [deposit, nearUsd, walletNear] = await Promise.all([this.memeCooking.myDeposit(memeId), nearUsdP, walletP]);
            return {
                ref, kind: "meme", route: await this.route(ref, settings), info: null, nearUsd, walletNear,
                balance: deposit, decimals: 24, entry: null, meme,
            };
        }
        const [info, nearUsd, walletNear] = await Promise.all([this.intear.token(ref, 1500).catch(() => null), nearUsdP, walletP]);
        const decimals = await this.tokenDecimals(ref, info);
        const [route, balance, entry, live] = await Promise.all([
            this.route(ref, settings, info),
            this.ft.balance(ref),
            this.entry(ref, decimals, nearUsd).catch(() => this.entryFromDb(ref, nearUsd)),
            info ? this.liveInfo(info, nearUsd) : Promise.resolve(null),
        ]);
        // Warm the registration cache so the first buy doesn't wait on it.
        void this.ft.isRegistered(ref).catch(() => { });
        return { ref, kind: "token", route, info: live ?? info, nearUsd, walletNear, balance, decimals, entry };
    }
    /**
     * Token data with the price read live from its own pool and market cap = that price x the
     * on-chain total supply (burns removed). Falls back to the indexer's figures if a read fails.
     */
    async liveInfo(info, nearUsd) {
        const pairPrice = async (t) => (await this.intear.token(t, 30_000))?.priceNear ?? 0;
        const [priceNear, supply] = await Promise.all([
            this.prices.priceNear(info.accountId, parseMainPool(info.mainPool), pairPrice).catch(() => null),
            this.prices.totalSupply(info.accountId).catch(() => null),
        ]);
        const pNear = priceNear ?? info.priceNear;
        const pUsd = priceNear != null && nearUsd > 0 ? priceNear * nearUsd : info.priceUsd;
        const supplyWhole = supply ?? info.mcapSupply;
        return { ...info, priceNear: pNear, priceUsd: pUsd, marketCapUsd: pUsd * supplyWhole, mcapSupply: supplyWhole };
    }
    /** Entry from on-chain trade history (all trades, wherever made) merged with the bot's own log. */
    async entry(token, decimals, nearUsd) {
        const chain = await this.intear.trades(this.accountId, token);
        // The bot's own records go first: for the same tx they win, and they hold the after-tax amount received.
        const fills = this.db.trades(token, this.accountId).map((r) => ({ side: r.side, tokens: r.tokenAmount, near: r.nearAmount, usd: r.usdValue, tx: r.txHash, ts: r.ts }));
        for (const t of chain) {
            const buy = t.tokenOut === token;
            const tokens = fromRaw(buy ? t.amountOut : t.amountIn, decimals);
            const otherSide = buy ? t.tokenIn : t.tokenOut;
            const otherAmount = buy ? t.amountIn : t.amountOut;
            const usd = t.usdValue ?? 0;
            const near = otherSide === WRAP ? yoctoToNear(otherAmount) : nearUsd > 0 ? usd / nearUsd : 0;
            fills.push({ side: buy ? "buy" : "sell", tokens, near, usd: usd || near * nearUsd, tx: t.txId, ts: t.timestampMillis });
        }
        return averageEntry(fills);
    }
    entryFromDb(ref, _nearUsd) {
        return averageEntry(this.db.trades(ref, this.accountId).map((r) => ({ side: r.side, tokens: r.tokenAmount, near: r.nearAmount, usd: r.usdValue, tx: r.txHash, ts: r.ts })));
    }
    // ---------------------------------------------------------------- trading
    async ensureFunds(amountIn) {
        const free = await this.walletNear();
        if (free < amountIn + GAS_RESERVE) {
            throw new Error(`Not enough NEAR: wallet has ${yoctoToNear(free).toFixed(3)}, need ${yoctoToNear(amountIn + GAS_RESERVE).toFixed(3)} (incl. 0.05 gas reserve)`);
        }
    }
    async quoteToken(side, token, amountIn, route, settings) {
        if (route.kind === "dcl") {
            return side === "buy"
                ? this.dcl.buy(route.poolId, token, amountIn, settings.slippagePct)
                : this.dcl.sell(route.poolId, token, amountIn, settings.slippagePct);
        }
        if (route.kind === "dclPair")
            return this.quoteDclPair(side, token, amountIn, route.poolId, route.pair, settings);
        if (route.kind !== "router")
            throw new Error(`Unexpected route ${route.kind}`);
        return routerQuote({
            tokenIn: side === "buy" ? "near" : token,
            tokenOut: side === "buy" ? token : "near",
            amountIn,
            slippagePct: settings.slippagePct,
            trader: this.accountId,
            dexes: route.dexes,
            apiKey: this.opts.intearApiKey,
        });
    }
    async quoteDclPair(side, token, amountIn, poolId, pair, settings) {
        const base = { trader: this.accountId, slippagePct: settings.slippagePct, apiKey: this.opts.intearApiKey };
        try {
            // Rhea DCL alone can usually reach the pair from NEAR (e.g. NEAR -> QTC -> token), all in one swap.
            return await routerQuote({ ...base, tokenIn: side === "buy" ? "near" : token, tokenOut: side === "buy" ? token : "near", amountIn, dexes: ["RheaDcl"] });
        }
        catch (e) {
            if (!(e instanceof Error) || !/No route/.test(e.message))
                throw e;
        }
        // Two legs, as nearly.trade does it: the pair's NEAR leg on Rhea, the token leg on its own DCL pool.
        if (side === "buy") {
            const leg1 = await routerQuote({ ...base, tokenIn: "near", tokenOut: pair, amountIn });
            const leg2 = await this.dcl.swap(poolId, pair, token, leg1.minOut, settings.slippagePct);
            return { ...leg2, txs: [...leg1.txs, ...leg2.txs], via: `${leg1.via} + Rhea DCL` };
        }
        const leg1 = await this.dcl.swap(poolId, token, pair, amountIn, settings.slippagePct);
        const leg2 = await routerQuote({ ...base, tokenIn: pair, tokenOut: "near", amountIn: leg1.minOut });
        return { ...leg2, txs: [...leg1.txs, ...leg2.txs], via: `Rhea DCL + ${leg2.via}` };
    }
    /** Quotes a trade and builds its transactions without sending anything (DRY_RUN and the quote script). */
    async preview(ref, side, amount, settings) {
        if (ref.startsWith("stock:")) {
            const stock = findStock(ref.slice(6));
            const raw = side === "buy" ? nearToYocto(amount) : 10n ** 18n;
            const q = await this.oneClick.quote(side, stock, raw, settings.slippagePct, true);
            return {
                route: await this.route(ref, settings),
                quote: { expectedOut: BigInt(q.amountOut), minOut: BigInt(q.minAmountOut ?? "0"), txs: [], via: "NEAR Intents 1Click (dry quote)" },
            };
        }
        if (ref.startsWith("meme:")) {
            const state = await this.memeCooking.state(Number(ref.slice(5)));
            if (state.status === "launched")
                return this.preview(state.token, side, amount, settings);
            if (state.status !== "cooking")
                throw new Error(raiseClosed(state.status));
            const raw = nearToYocto(amount);
            const txs = side === "buy" ? await this.memeCooking.depositTxs(state.meme, raw) : this.memeCooking.withdrawTxs(state.meme.id, raw);
            return { route: await this.route(ref, settings), quote: { expectedOut: raw, minOut: raw, txs, via: "meme.cooking" } };
        }
        const route = await this.route(ref, settings);
        const amountIn = side === "buy" ? nearToYocto(amount) : percentOf(await this.ft.balance(ref), amount);
        if (amountIn <= 0n)
            throw new Error("Nothing to sell");
        return { route, quote: await this.quoteToken(side, ref, amountIn, route, settings) };
    }
    assertNotRefunded(sent, quote) {
        if (quote.refundCheck && sent.at(-1)?.returnValue === "0") {
            throw new Error(`Price moved more than your slippage limit, so the swap was refunded. Tx: ${sent.at(-1).hash}`);
        }
    }
    /**
     * Sends the registrations a buy of `token` needs (token, wNEAR, exchange) ahead of time, so the
     * snipe itself is a single swap transaction.
     */
    async prepareBuy(token) {
        const txs = await this.dcl.prep(token, WRAP);
        if (!txs.length)
            return;
        await this.signer.sendAll(txs);
        for (const t of txs)
            this.ft.markRegistered(t.receiverId);
    }
    /**
     * A route that can fill a `nearAmount` buy of `ref` right now, or null while it can't trade yet.
     * `poolHint` is the pool a launchpad announced; otherwise the token's own pool is looked up.
     */
    async liveRoute(ref, nearAmount, settings, poolHint) {
        const amountIn = nearToYocto(nearAmount);
        if (ref.startsWith("meme:")) {
            const state = await this.memeCooking.state(Number(ref.slice(5))).catch(() => null);
            if (state?.status === "cooking")
                return this.route(ref, settings);
            return state?.status === "launched" ? this.liveRoute(state.token, nearAmount, settings) : null;
        }
        const tryRoute = async (route) => (await this.quoteToken("buy", ref, amountIn, route, settings).then(() => route).catch(() => null));
        const pool = poolHint ?? (/\.(nearlytrade|v\d+-launchpad\.justhoot)\.near$/.test(ref) ? { poolId: `${ref}|${WRAP}|10000`, quote: WRAP } : null);
        if (pool) {
            const route = pool.quote === WRAP
                ? { kind: "dcl", poolId: pool.poolId, label: "Rhea DCL · own NEAR pool" }
                : { kind: "dclPair", poolId: pool.poolId, pair: pool.quote, label: `Rhea DCL · own ${pairName(pool.quote)} pool` };
            // The pair leg goes through the router, so only check that the pool itself can fill.
            if (route.kind === "dclPair")
                return (await this.dcl.quoteOut(pool.poolId, pool.quote, ref, 10n ** BigInt(await this.prices.decimalsOf(pool.quote))).then(() => route).catch(() => null));
            if (await tryRoute(route))
                return route;
            if (poolHint)
                return null;
        }
        // Anything else: whatever the indexer now knows, then any DEX the router can reach.
        const info = await this.intear.token(ref, 1000).catch(() => null);
        if (info?.mainPool) {
            const found = await tryRoute(await this.findRoute(ref, settings, info));
            if (found)
                return found;
        }
        return tryRoute({ kind: "router", label: "Best available" });
    }
    /** Buys with a route the caller already found (snipes), and remembers it for the token's card. */
    async buyVia(ref, nearAmount, settings, route) {
        if (route.kind === "dcl" || route.kind === "dclPair") {
            for (const mode of ["original", "best"])
                this.routes.set(`${mode}:${ref}`, { at: Date.now(), route });
        }
        return this.buy(ref, nearAmount, settings, route);
    }
    async buy(ref, nearAmount, settings, routeOverride) {
        const amountIn = nearToYocto(nearAmount);
        if (amountIn <= 0n)
            throw new Error("Amount must be more than 0");
        if (ref.startsWith("stock:"))
            return this.buyStock(ref, amountIn, settings);
        if (ref.startsWith("meme:")) {
            const state = await this.memeCooking.state(Number(ref.slice(5)));
            if (state.status === "launched")
                return this.buy(state.token, nearAmount, settings);
            if (state.status !== "cooking")
                throw new Error(raiseClosed(state.status));
            const [txs] = await Promise.all([this.memeCooking.depositTxs(state.meme, amountIn), this.ensureFunds(amountIn)]);
            const sent = await this.signer.sendAll(txs);
            this.record(ref, "buy", nearAmount, 0, nearAmount * (await this.intear.nearUsd().catch(() => 0)), "meme.cooking", sent);
            return { hashes: sent.map((s) => s.hash), via: "meme.cooking deposit", nearAmount: amountIn, tokenAmount: 0n };
        }
        const token = ref;
        const memeId = memeIdFromAccount(token);
        if (memeId != null && !(await this.rpc.accountExists(token)))
            return this.buy(`meme:${memeId}`, nearAmount, settings);
        const route = routeOverride ?? (await this.route(token, settings));
        const [quote, before] = await Promise.all([this.quoteToken("buy", token, amountIn, route, settings), this.ft.balance(token), this.ensureFunds(amountIn)]);
        const sent = await this.signer.sendAll(quote.txs);
        try {
            this.assertNotRefunded(sent, quote);
        }
        catch (e) {
            // DCL buys keep refunds as wNEAR; unwrap them so the wallet holds plain NEAR again.
            if (route.kind === "dcl")
                await this.signer.send({ receiverId: WRAP, calls: [{ method: "near_withdraw", args: { amount: amountIn.toString() }, gas: 10n * TGAS, deposit: 1n }] }).catch(() => { });
            throw e;
        }
        const [info, nearUsd] = await Promise.all([this.intear.token(token, 60_000).catch(() => null), this.intear.nearUsd().catch(() => 0)]);
        const decimals = await this.tokenDecimals(token, info);
        const swapped = swappedOut(sent.map((x) => x.result), token, this.accountId) ?? quote.expectedOut;
        // Bookkeeping runs after the result is reported, so it never slows the trade down.
        const recorded = (async () => {
            // A taxed token delivers less than the swap output; the balance change is what you hold.
            const after = await this.ft.balance(token).catch(() => before + swapped);
            const got = after > before ? after - before : swapped;
            this.record(token, "buy", nearAmount, fromRaw(got, decimals), nearAmount * nearUsd, quote.via, sent);
        })().catch(() => { });
        const summary = { side: "buy", symbol: info?.symbol ?? token.split(".")[0], tokens: fromRaw(swapped, decimals), near: nearAmount, usd: nearAmount * nearUsd };
        return { hashes: sent.map((s) => s.hash), via: quote.via, nearAmount: amountIn, tokenAmount: swapped, recorded, summary };
    }
    async sell(ref, pct, settings) {
        if (pct <= 0 || pct > 100)
            throw new Error("Sell percent must be between 0 and 100");
        if (ref.startsWith("stock:"))
            return this.sellStock(ref, pct, settings);
        if (ref.startsWith("meme:")) {
            const memeId = Number(ref.slice(5));
            const state = await this.memeCooking.state(memeId);
            if (state.status === "launched")
                return this.sell(state.token, pct, settings);
            if (state.status === "failed")
                return this.claimMeme(memeId);
            const deposit = await this.memeCooking.myDeposit(memeId);
            const amount = percentOf(deposit, pct);
            if (amount <= 0n)
                throw new Error("You have no deposit in this raise");
            const sent = await this.signer.sendAll(this.memeCooking.withdrawTxs(memeId, amount));
            const near = yoctoToNear(amount) * 0.98;
            const nearUsd = await this.intear.nearUsd().catch(() => 0);
            this.record(ref, "sell", near, 0, near * nearUsd, "meme.cooking", sent);
            const summary = { side: "sell", symbol: `raise #${memeId}`, tokens: 0, near, usd: near * nearUsd };
            return { hashes: sent.map((s) => s.hash), via: "meme.cooking withdraw (2% fee)", nearAmount: amount, tokenAmount: 0n, summary };
        }
        const token = ref;
        const [route, balance, info, nearUsd] = await Promise.all([
            this.route(token, settings),
            this.ft.balance(token),
            this.intear.token(token, 60_000).catch(() => null),
            this.intear.nearUsd().catch(() => 0),
        ]);
        const amount = percentOf(balance, pct);
        if (amount <= 0n)
            throw new Error("You don't hold this token");
        const decimals = await this.tokenDecimals(token, info);
        // The entry is worked out while the sell is quoted and sent, so it adds no delay.
        const entryP = this.entry(token, decimals, nearUsd).catch(() => null);
        const quote = await this.quoteToken("sell", token, amount, route, settings);
        const sent = await this.signer.sendAll(quote.txs);
        this.assertNotRefunded(sent, quote);
        // What the swap actually paid, from the exchange's own logs (falls back to the quote).
        const receivedRaw = swappedOut(sent.map((x) => x.result), WRAP, this.accountId) ?? quote.expectedOut;
        const near = yoctoToNear(receivedRaw);
        const soldTokens = fromRaw(amount, decimals);
        const recorded = Promise.resolve().then(() => this.record(token, "sell", near, soldTokens, near * nearUsd, quote.via, sent));
        const summary = { side: "sell", symbol: info?.symbol ?? token.split(".")[0], tokens: soldTokens, near, usd: near * nearUsd };
        const entry = await Promise.race([entryP, new Promise((ok) => setTimeout(() => ok(null), 1500))]);
        if (entry) {
            // Cost of the part sold: the position's cost, scaled by the share of the holding sold.
            const cost = holdingCost(entry, fromRaw(balance, decimals)).near * (Number(amount) / Number(balance));
            if (cost > 0) {
                summary.pnlNear = near - cost;
                summary.pnlPct = ((near - cost) / cost) * 100;
            }
        }
        return { hashes: sent.map((s) => s.hash), via: quote.via, nearAmount: receivedRaw, tokenAmount: amount, recorded, summary };
    }
    /** Claims tokens from a finished meme.cooking raise. */
    async claimMeme(memeId) {
        const state = await this.memeCooking.state(memeId);
        if (state.status !== "launched" && state.status !== "failed")
            throw new Error("Nothing to claim yet");
        const refund = state.status === "failed";
        const sent = await this.signer.sendAll(await this.memeCooking.claimTxs(state.meme, refund));
        return { hashes: sent.map((s) => s.hash), via: refund ? "meme.cooking refund" : "meme.cooking claim", nearAmount: 0n, tokenAmount: 0n };
    }
    async buyStock(ref, amountIn, settings) {
        const stock = findStock(ref.slice(6));
        if (!stock)
            throw new Error("Unknown stock");
        const [quote] = await Promise.all([this.oneClick.quote("buy", stock, amountIn, settings.slippagePct), this.ensureFunds(amountIn)]);
        const sent = await this.signer.sendAll(await this.oneClick.buyTxs(quote.depositAddress, amountIn));
        const last = sent.at(-1).hash;
        await this.oneClick.submit(quote.depositAddress, last).catch(() => { });
        const nearAmount = yoctoToNear(amountIn);
        const settle = this.oneClick.waitForSettlement(quote.depositAddress).then((s) => {
            if (s.status !== "SUCCESS")
                return `1Click: ${s.status}`;
            const shares = BigInt(s.amountOut ?? quote.amountOut);
            this.intear.nearUsd().then((usd) => this.record(ref, "buy", nearAmount, fromRaw(shares, 18), nearAmount * usd, "1Click", sent)).catch(() => { });
            return `Settled: received ${fromRaw(shares, 18).toFixed(4)} ${stock.symbol}`;
        });
        return { hashes: sent.map((s) => s.hash), via: "NEAR Intents 1Click", nearAmount: amountIn, tokenAmount: BigInt(quote.amountOut), settle, note: "Settling through 1Click (about a minute)" };
    }
    async sellStock(ref, pct, settings) {
        const stock = findStock(ref.slice(6));
        if (!stock)
            throw new Error("Unknown stock");
        const h = await this.oneClick.holdings(stock);
        const total = h.intents + h.wallet;
        const amount = percentOf(total, pct);
        if (amount <= 0n)
            throw new Error(`You don't hold ${stock.symbol}`);
        const fromIntents = amount <= h.intents ? amount : h.intents;
        const fromWallet = amount - fromIntents;
        const quote = await this.oneClick.quote("sell", stock, amount, settings.slippagePct);
        const sent = await this.signer.sendAll(this.oneClick.sellTxs(stock, quote.depositAddress, fromIntents, fromWallet));
        await this.oneClick.submit(quote.depositAddress, sent.at(-1).hash).catch(() => { });
        const settle = this.oneClick.waitForSettlement(quote.depositAddress).then(async (s) => {
            if (s.status !== "SUCCESS")
                return `1Click: ${s.status}`;
            const wnear = BigInt(s.amountOut ?? quote.amountOut);
            // Proceeds arrive as wNEAR; unwrap them to NEAR.
            await this.signer.send({ receiverId: WRAP, calls: [{ method: "near_withdraw", args: { amount: wnear.toString() }, gas: 10n * TGAS, deposit: 1n }] }).catch(() => { });
            const near = yoctoToNear(wnear);
            this.intear.nearUsd().then((usd) => this.record(ref, "sell", near, fromRaw(amount, 18), near * usd, "1Click", sent)).catch(() => { });
            return `Settled: received ${near.toFixed(4)} NEAR`;
        });
        return { hashes: sent.map((s) => s.hash), via: "NEAR Intents 1Click", nearAmount: BigInt(quote.amountOut), tokenAmount: amount, settle, note: "Settling through 1Click (about a minute)" };
    }
    record(token, side, near, tokens, usd, via, sent) {
        this.db.addTrade({ account: this.accountId, token, side, nearAmount: near, tokenAmount: tokens, usdValue: usd, via, txHash: sent.at(-1)?.hash ?? "", ts: Date.now() });
    }
}
function raiseClosed(status) {
    if (status === "ended")
        return "This raise has ended and is waiting to launch";
    if (status === "failed")
        return "This raise didn't reach its soft cap; use Sell or Claim to get your NEAR back";
    return "Raise not found";
}
const PAIR_NAMES = {
    "nearly-993927.nearlytrade.near": "NEARLY",
    "ninu-4.nearlytrade.near": "NINU",
    "diarhea.nearlytrade.near": "DIARHEA",
    "token.rhealab.near": "RHEA",
    "zec.omft.near": "ZEC",
    "qtc.omft.near": "QTC",
    "kat.token0.near": "KAT",
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC",
    "usdt.tether-token.near": "USDT",
    "eth.bridge.near": "ETH",
    "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near": "BTC",
};
function pairName(account) {
    return PAIR_NAMES[account] ?? account.split(".")[0].split("-")[0].toUpperCase();
}
//# sourceMappingURL=trader.js.map