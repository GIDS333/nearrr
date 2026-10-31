import { createHash } from "node:crypto";
import bs58 from "bs58";
import { KeyPair, KeyType } from "@near-js/crypto";
import { actionCreators, createTransaction, Signature, SignedTransaction } from "@near-js/transactions";
import { RpcError } from "./rpc.js";
export class TxFailed extends Error {
    hash;
    constructor(message, hash) {
        super(message);
        this.hash = hash;
    }
}
/**
 * Signs and sends transactions from one account with no waiting on reads:
 * the nonce lives in memory and the block hash is refreshed in the background.
 */
export class Signer {
    rpc;
    accountId;
    dryRun;
    keyPair;
    nonce = 0n;
    blockHash = new Uint8Array(32);
    timer;
    constructor(rpc, accountId, privateKey, dryRun = false) {
        this.rpc = rpc;
        this.accountId = accountId;
        this.dryRun = dryRun;
        this.keyPair = KeyPair.fromString(privateKey);
    }
    get publicKey() {
        return this.keyPair.getPublicKey().toString();
    }
    async init() {
        await this.syncNonce();
        // A block hash stays valid for ~24h; refreshing every 30s keeps it fresh without touching the hot path.
        this.timer = setInterval(() => {
            this.rpc.latestBlockHash().then((h) => (this.blockHash = bs58.decode(h))).catch(() => { });
        }, 30_000);
        this.timer.unref();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
    }
    async syncNonce() {
        const { nonce, blockHash } = await this.rpc.accessKey(this.accountId, this.publicKey);
        if (nonce > this.nonce)
            this.nonce = nonce;
        this.blockHash = bs58.decode(blockHash);
    }
    sign(tx, nonce) {
        const actions = tx.calls.map((c) => actionCreators.functionCall(c.method, c.args, c.gas, c.deposit));
        if (tx.transfer)
            actions.push(actionCreators.transfer(tx.transfer));
        const transaction = createTransaction(this.accountId, this.keyPair.getPublicKey(), tx.receiverId, nonce, actions, this.blockHash);
        const digest = createHash("sha256").update(transaction.encode()).digest();
        const { signature } = this.keyPair.sign(digest);
        const signed = new SignedTransaction({
            transaction,
            signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
        });
        return { b64: Buffer.from(signed.encode()).toString("base64"), hash: bs58.encode(digest) };
    }
    /** Sends one transaction and waits until it has executed (optimistic, ~1-2s). */
    async send(tx, waitUntil = "EXECUTED_OPTIMISTIC") {
        if (this.dryRun)
            throw new TxFailed("DRY_RUN is on: transaction not sent");
        for (let attempt = 0;; attempt++) {
            const { b64, hash } = this.sign(tx, ++this.nonce);
            try {
                const result = await this.rpc.sendTx(b64, waitUntil);
                return checkResult(result, hash);
            }
            catch (e) {
                if (attempt === 0 && e instanceof RpcError && /InvalidNonce|Expired|InvalidTransaction/i.test(e.message + JSON.stringify(e.data ?? ""))) {
                    await this.syncNonce();
                    continue;
                }
                if (e instanceof TxFailed)
                    throw e;
                throw new TxFailed(describeRpcError(e), hash);
            }
        }
    }
    /**
     * Sends transactions one after another; each depends on the previous one.
     * Separate trades are not serialized: NEAR only needs nonces to increase, and an
     * out-of-order nonce is re-signed once in send().
     */
    async sendAll(txs) {
        const out = [];
        for (const tx of txs)
            out.push(await this.send(tx));
        return out;
    }
}
function checkResult(result, hash) {
    const failure = result.status?.Failure ?? result.transaction_outcome?.outcome?.status?.Failure;
    if (failure)
        throw new TxFailed(describeFailure(failure), result.transaction?.hash ?? hash);
    let returnValue;
    const sv = result.status?.SuccessValue;
    if (sv) {
        try {
            returnValue = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
        }
        catch {
            returnValue = undefined;
        }
    }
    return { hash: result.transaction?.hash ?? hash, result, returnValue };
}
function describeFailure(failure) {
    const text = JSON.stringify(failure);
    const panic = /"ExecutionError":"([^"]+)"/.exec(text)?.[1];
    if (panic)
        return panic.replace(/^Smart contract panicked:\s*/, "");
    if (/NotEnoughBalance|LackBalanceForState/.test(text))
        return "Not enough NEAR in the wallet";
    return text.length > 300 ? text.slice(0, 300) + "…" : text;
}
function describeRpcError(e) {
    if (e instanceof RpcError) {
        const text = e.message + " " + JSON.stringify(e.data ?? "");
        if (/NotEnoughBalance/.test(text))
            return "Not enough NEAR in the wallet";
        if (/TIMEOUT|timeout/.test(text))
            return "RPC timed out; the transaction may still land. Check the explorer before retrying.";
        return e.message;
    }
    return e instanceof Error ? e.message : String(e);
}
//# sourceMappingURL=signer.js.map