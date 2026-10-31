import { createHash } from "node:crypto";
import bs58 from "bs58";
import { KeyPair, KeyType, type KeyPairString } from "@near-js/crypto";
import { actionCreators, createTransaction, Signature, SignedTransaction, type Action } from "@near-js/transactions";
import { Rpc, RpcError, type TxResult, type WaitUntil } from "./rpc.js";

export interface Call {
  method: string;
  args: object | Uint8Array;
  gas: bigint;
  deposit: bigint;
}

export interface Tx {
  receiverId: string;
  calls: Call[];
  /** Plain NEAR sent to the receiver (yoctoNEAR), as a Transfer action after any calls. */
  transfer?: bigint;
}

export interface SentTx {
  hash: string;
  result: TxResult;
  /** Decoded return value of the transaction's last receipt, when it returned JSON. */
  returnValue: unknown;
}

export class TxFailed extends Error {
  constructor(message: string, readonly hash?: string) {
    super(message);
  }
}

/**
 * Signs and sends transactions from one account with no waiting on reads:
 * the nonce lives in memory and the block hash is refreshed in the background.
 */
export class Signer {
  private readonly keyPair: KeyPair;
  private nonce = 0n;
  private blockHash: Uint8Array = new Uint8Array(32);
  private timer?: NodeJS.Timeout;

  constructor(readonly rpc: Rpc, readonly accountId: string, privateKey: string, readonly dryRun = false) {
    this.keyPair = KeyPair.fromString(privateKey as KeyPairString);
  }

  get publicKey(): string {
    return this.keyPair.getPublicKey().toString();
  }

  async init(): Promise<void> {
    await this.syncNonce();
    // A block hash stays valid for ~24h; refreshing every 30s keeps it fresh without touching the hot path.
    this.timer = setInterval(() => {
      this.rpc.latestBlockHash().then((h) => (this.blockHash = bs58.decode(h))).catch(() => {});
    }, 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async syncNonce(): Promise<void> {
    const { nonce, blockHash } = await this.rpc.accessKey(this.accountId, this.publicKey);
    if (nonce > this.nonce) this.nonce = nonce;
    this.blockHash = bs58.decode(blockHash);
  }

  private sign(tx: Tx, nonce: bigint): { b64: string; hash: string } {
    const actions: Action[] = tx.calls.map((c) => actionCreators.functionCall(c.method, c.args, c.gas, c.deposit));
    if (tx.transfer) actions.push(actionCreators.transfer(tx.transfer));
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
  async send(tx: Tx, waitUntil: WaitUntil = "EXECUTED_OPTIMISTIC"): Promise<SentTx> {
    if (this.dryRun) throw new TxFailed("DRY_RUN is on: transaction not sent");
    for (let attempt = 0; ; attempt++) {
      const { b64, hash } = this.sign(tx, ++this.nonce);
      try {
        const result = await this.rpc.sendTx(b64, waitUntil);
        return checkResult(result, hash);
      } catch (e) {
        if (attempt === 0 && e instanceof RpcError && /InvalidNonce|Expired|InvalidTransaction/i.test(e.message + JSON.stringify(e.data ?? ""))) {
          await this.syncNonce();
          continue;
        }
        if (e instanceof TxFailed) throw e;
        throw new TxFailed(describeRpcError(e), hash);
      }
    }
  }

  /**
   * Sends transactions one after another; each depends on the previous one.
   * Separate trades are not serialized: NEAR only needs nonces to increase, and an
   * out-of-order nonce is re-signed once in send().
   */
  async sendAll(txs: Tx[]): Promise<SentTx[]> {
    const out: SentTx[] = [];
    for (const tx of txs) out.push(await this.send(tx));
    return out;
  }
}

function checkResult(result: TxResult, hash: string): SentTx {
  const failure = result.status?.Failure ?? result.transaction_outcome?.outcome?.status?.Failure;
  if (failure) throw new TxFailed(describeFailure(failure), result.transaction?.hash ?? hash);
  let returnValue: unknown;
  const sv = result.status?.SuccessValue;
  if (sv) {
    try {
      returnValue = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
    } catch {
      returnValue = undefined;
    }
  }
  return { hash: result.transaction?.hash ?? hash, result, returnValue };
}

function describeFailure(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /"ExecutionError":"([^"]+)"/.exec(text)?.[1];
  if (panic) return panic.replace(/^Smart contract panicked:\s*/, "");
  if (/NotEnoughBalance|LackBalanceForState/.test(text)) return "Not enough NEAR in the wallet";
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

function describeRpcError(e: unknown): string {
  if (e instanceof RpcError) {
    const text = e.message + " " + JSON.stringify(e.data ?? "");
    if (/NotEnoughBalance/.test(text)) return "Not enough NEAR in the wallet";
    if (/TIMEOUT|timeout/.test(text)) return "RPC timed out; the transaction may still land. Check the explorer before retrying.";
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
