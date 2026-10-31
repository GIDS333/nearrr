/** Minimal NEAR JSON-RPC client: reads fail over between endpoints, sends race all of them. */
export class RpcError extends Error {
    data;
    constructor(message, data) {
        super(message);
        this.data = data;
    }
}
export class Rpc {
    urls;
    id = 0;
    constructor(urls) {
        this.urls = urls;
        if (!urls.length)
            throw new Error("No RPC endpoints configured");
    }
    async post(url, method, params, timeoutMs) {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const body = (await res.json());
        if (body.error) {
            const e = body.error;
            throw new RpcError(e.cause?.name ?? (typeof e.data === "string" ? e.data : e.message ?? "RPC error"), e.data ?? e.cause);
        }
        if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) {
            throw new RpcError(String(body.result.error));
        }
        return body.result;
    }
    /** Read call: try endpoints in order, move on when one fails or is slow. */
    async call(method, params, timeoutMs = 4000) {
        let last;
        for (const url of this.urls) {
            try {
                return await this.post(url, method, params, timeoutMs);
            }
            catch (e) {
                last = e;
                if (e instanceof RpcError && !/timeout|unavailable|too many/i.test(e.message))
                    throw e;
            }
        }
        throw last instanceof Error ? last : new Error("All RPC endpoints failed");
    }
    async view(contractId, method, args = {}) {
        const r = await this.call("query", {
            request_type: "call_function",
            finality: "optimistic",
            account_id: contractId,
            method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        });
        return JSON.parse(Buffer.from(r.result).toString("utf8"));
    }
    async accountExists(accountId) {
        try {
            await this.call("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
            return true;
        }
        catch (e) {
            if (e instanceof RpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message + JSON.stringify(e.data ?? "")))
                return false;
            throw e;
        }
    }
    async nearBalance(accountId) {
        const r = await this.call("query", {
            request_type: "view_account",
            finality: "optimistic",
            account_id: accountId,
        });
        // Storage costs 1e19 yocto per byte; that part of the balance can't be spent.
        const storageLocked = BigInt(r.storage_usage) * 10n ** 19n;
        const free = BigInt(r.amount) - storageLocked;
        return free > 0n ? free : 0n;
    }
    async accessKey(accountId, publicKey) {
        const r = await this.call("query", {
            request_type: "view_access_key",
            finality: "optimistic",
            account_id: accountId,
            public_key: publicKey,
        });
        return { nonce: BigInt(r.nonce), blockHash: r.block_hash };
    }
    async latestBlockHash() {
        const r = await this.call("block", { finality: "final" });
        return r.header.hash;
    }
    /** Broadcast to every endpoint at once and take the first answer. Same signed tx, so no double-spend. */
    async sendTx(signedTxBase64, waitUntil) {
        const attempts = this.urls.map((url) => this.post(url, "send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil }, 60_000));
        try {
            return await Promise.any(attempts);
        }
        catch (e) {
            const errors = e instanceof AggregateError ? e.errors : [e];
            // Prefer a real execution error over network noise.
            throw errors.find((x) => x instanceof RpcError) ?? errors[0];
        }
    }
}
//# sourceMappingURL=rpc.js.map