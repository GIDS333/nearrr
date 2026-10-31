import { describe, expect, it } from "vitest";
import { LivePrices } from "../src/market/pools.js";
import type { Rpc } from "../src/near/rpc.js";

function fakeRpc(views: Record<string, unknown>): Rpc {
  return { view: async (contract: string, method: string) => views[`${contract}.${method}`] } as unknown as Rpc;
}

describe("LivePrices", () => {
  it("prices a token from its DCL point (real HOOT pool state)", async () => {
    const p = new LivePrices(
      fakeRpc({
        "dclv2.ref-labs.near.get_pool": { token_x: "hoot.near", token_y: "wrap.near", current_point: 58040 },
        "hoot.near.ft_metadata": { decimals: 18 },
      }),
    );
    const near = await p.priceNear("hoot.near", { dex: "dcl", poolId: "hoot.near|wrap.near|10000", tokens: ["hoot.near", "wrap.near"] }, async () => 0);
    expect(near).toBeCloseTo(3.3153e-4, 7);
  });

  it("inverts the price when the token is the pool's y side, and prices the pair in NEAR", async () => {
    const p = new LivePrices(
      fakeRpc({
        "dclv2.ref-labs.near.get_pool": { token_x: "nearly.near", token_y: "cat.near", current_point: -46054 }, // ~0.01 cat per nearly
        "nearly.near.ft_metadata": { decimals: 18 },
        "cat.near.ft_metadata": { decimals: 18 },
      }),
    );
    const near = await p.priceNear("cat.near", { dex: "dcl", poolId: "x", tokens: ["nearly.near", "cat.near"] }, async () => 0.5);
    // 1 cat = 100 nearly, 1 nearly = 0.5 NEAR
    expect(near).toBeCloseTo(50, 0);
  });

  it("prices a classic Rhea pool from its reserves and uses the live supply", async () => {
    const p = new LivePrices(
      fakeRpc({
        "v2.ref-finance.near.get_pool": { token_account_ids: ["wrap.near", "dog.near"], amounts: ["2000000000000000000000000000", "1000000000000000000000000000000"], pool_kind: "SIMPLE_POOL" },
        "dog.near.ft_metadata": { decimals: 24 },
        "dog.near.ft_total_supply": "870000000000000000000000000000000",
      }),
    );
    expect(await p.priceNear("dog.near", { dex: "rhea", poolId: 1 }, async () => 0)).toBeCloseTo(0.002);
    expect(await p.totalSupply("dog.near")).toBeCloseTo(870_000_000);
  });
});
