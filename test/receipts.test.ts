import { describe, expect, it } from "vitest";
import type { TxResult } from "../src/near/rpc.js";
import { swappedOut } from "../src/venues/receipts.js";

const tx = (...logs: Array<[string, string]>): TxResult =>
  ({
    status: { SuccessValue: "" },
    transaction: { hash: "h" },
    transaction_outcome: { outcome: { status: {} } },
    receipts_outcome: logs.map(([executor_id, log], i) => ({ id: String(i), outcome: { status: {}, logs: [log], executor_id } })),
  }) as TxResult;

describe("swappedOut", () => {
  it("reads NEAR received from a Rhea DCL sell (real MEAR sell, 2% tax)", () => {
    const r = tx(
      ["mear.nearlytrade.near", 'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"7b0y.near","new_owner_id":"mear.nearlytrade.near","amount":"128946018453577488399031","memo":"tax"}]}'],
      ["dclv2.ref-labs.near", 'EVENT_JSON:{"data":[{"amount_in":"12765655826904171351504125","amount_out":"32776744378243532432381472","pool_id":"mear.nearlytrade.near|wrap.near|10000","swapper":"7b0y.near","token_in":"mear.nearlytrade.near","token_out":"wrap.near"}],"event":"swap","standard":"dcl.ref","version":"1.0.0"}'],
      ["wrap.near", "Withdraw 32776744378243532432381472 NEAR from dclv2.ref-labs.near"],
    );
    expect(swappedOut([r], "wrap.near", "7b0y.near")).toBe(32776744378243532432381472n);
    expect(swappedOut([r], "wrap.near", "someone-else.near")).toBeNull();
  });

  it("reads NEAR received from a classic Rhea sell (real BLACKDRAGON sell)", () => {
    const r = tx(["v2.ref-finance.near", "Swapped 19253132880234073632647340359680 blackdragon.tkn.near for 43693196130077940106534 wrap.near"]);
    expect(swappedOut([r], "wrap.near")).toBe(43693196130077940106534n);
  });

  it("counts only the final hop of a multi-hop swap", () => {
    const r = tx([
      "dclv2.ref-labs.near",
      'EVENT_JSON:{"standard":"dcl.ref","event":"swap","data":[{"token_out":"nearly.near","amount_out":"500","swapper":"me.near"},{"token_out":"cat.near","amount_out":"9000","swapper":"me.near"}]}',
    ]);
    expect(swappedOut([r], "cat.near", "me.near")).toBe(9000n);
  });

  it("returns null when no swap log mentions the token", () => {
    expect(swappedOut([tx(["x.near", "hello"])], "wrap.near")).toBeNull();
  });
});
