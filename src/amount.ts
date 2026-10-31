export const NEAR_DECIMALS = 24;
export const ONE_YOCTO = 1n;
export const TGAS = 1_000_000_000_000n;

/** "1.5" with 24 decimals -> 1500000000000000000000000n. Truncates extra precision. */
export function toRaw(amount: string | number, decimals: number): bigint {
  const s = typeof amount === "number" ? amount.toFixed(Math.min(decimals, 20)) : amount.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`Invalid amount: ${amount}`);
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Raw integer -> JS number of whole units (precision is fine for display and USD math). */
export function fromRaw(raw: bigint | string, decimals: number): number {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  return Number(whole) + Number(frac) / Number(base);
}

export const nearToYocto = (near: string | number) => toRaw(near, NEAR_DECIMALS);
export const yoctoToNear = (yocto: bigint | string) => fromRaw(yocto, NEAR_DECIMALS);

/** amount * pct / 100 with bigint precision (pct may be fractional, e.g. 33.3). */
export function percentOf(amount: bigint, pct: number): bigint {
  if (pct >= 100) return amount;
  return (amount * BigInt(Math.round(pct * 100))) / 10000n;
}

/** Minimum acceptable output for a slippage tolerance in percent. */
export function applySlippage(expected: bigint, slippagePct: number): bigint {
  return (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
}
