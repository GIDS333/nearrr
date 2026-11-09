/** Minimal NEAR JSON-RPC client: reads fail over between endpoints, sends race all of them. */

export type WaitUntil = "NONE" | "INCLUDED" | "EXECUTED_OPTIMISTIC" | "INCLUDED_FINAL" | "EXECUTED" | "FINAL";

export interface ExecutionStatus {
  SuccessValue?: string;
  Failure?: unknown;
}

export interface TxResult {
  status: ExecutionStatus;
  transaction: { hash: string };
  transaction_outcome: { outcome: { status: ExecutionStatus } };
  receipts_outcome: Array<{ id: string; outcome: { status: ExecutionStatus; logs: string[]; executor_id: string } }>;
}

export class RpcError extends Error {
  constructor(message: string, readonly data?: unknown) {
    super(message);
  }
}

export class Rpc {
  private id = 0;

  constructor(private readonly urls: string[]) {
    if (!urls.length) throw new Error("No RPC endpoints configured");
  }

  private async post<T>(url: string, method: string, params: unknown, timeoutMs: number): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: { name?: string; info?: unknown } } };
    if (body.error) {
      const e = body.error;
      throw new RpcError(e.cause?.name ?? (typeof e.data === "string" ? e.data : e.message ?? "RPC error"), e.data ?? e.cause);
    }
    if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) {
      throw new RpcError(String(body.result.error));
    }
    return body.result as T;
  }

  /** Read call: try endpoints in order, move on when one fails or is slow. */
  async call<T>(method: string, params: unknown, timeoutMs = 6000): Promise<T> {
    let last: unknown;
    for (const url of this.urls) {
      try {
        return await this.post<T>(url, method, params, timeoutMs);
      } catch (e) {
        last = e;
        continue;
      }
    }
    throw last instanceof Error ? last : new Error("All RPC endpoints failed");
  }

  async view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
    const r = await this.call<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
  }

  async accountExists(accountId: string): Promise<boolean> {
    try {
      await this.call("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
      return true;
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message + JSON.stringify(e.data ?? ""))) return false;
      throw e;
    }
  }

  async nearBalance(accountId: string): Promise<bigint> {
    const r = await this.call<{ amount: string; locked: string; storage_usage: number }>("query", {
      request_type: "view_account",
      finality: "optimistic",
      account_id: accountId,
    });
    // Storage costs 1e19 yocto per byte; that part of the balance can't be spent.
    const storageLocked = BigInt(r.storage_usage) * 10n ** 19n;
    const free = BigInt(r.amount) - storageLocked;
    return free > 0n ? free : 0n;
  }

  async accessKey(accountId: string, publicKey: string): Promise<{ nonce: bigint; blockHash: string }> {
    const r = await this.accessKeyInfo(accountId, publicKey);
    return { nonce: r.nonce, blockHash: r.blockHash };
  }

  async accessKeyInfo(accountId: string, publicKey: string): Promise<{ nonce: bigint; permission: unknown; blockHash: string }> {
    const r = await this.call<{ nonce: number | string; permission: unknown; block_hash: string }>("query", {
      request_type: "view_access_key",
      finality: "optimistic",
      account_id: accountId,
      public_key: publicKey,
    });
    return { nonce: BigInt(r.nonce), permission: r.permission, blockHash: r.block_hash };
  }

  async latestBlockHash(): Promise<string> {
    const r = await this.call<{ header: { hash: string } }>("block", { finality: "final" });
    return r.header.hash;
  }

  /** Broadcast to every endpoint at once and take the first answer. Same signed tx, so no double-spend. */
  async sendTx(signedTxBase64: string, waitUntil: WaitUntil): Promise<TxResult> {
    const attempts = this.urls.map((url) =>
      this.post<TxResult>(url, "send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil }, 60_000),
    );
    try {
      return await Promise.any(attempts);
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e];
      // Prefer a real execution error over network noise.
      throw errors.find((x) => x instanceof RpcError) ?? errors[0];
    }
  }
}
