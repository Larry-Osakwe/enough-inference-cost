import { describe, expect, it } from "vitest";
import {
  cacheBreakEvenRequests,
  compareTiers,
  costOf,
  MODELS,
  ratesFor,
  selfHostBreakeven,
} from "./inferenceCost";

// Pin the clock so promotional pricing can't drift the expectations.
const ASOF = new Date("2026-08-15T00:00:00Z");

const WORKLOAD = {
  model: "claude-opus-5" as const,
  calls: 250_000,
  inputTokens: 2_000,
  outputTokens: 400,
};

describe("costOf", () => {
  it("prices the note's worked example at $5,000/mo", () => {
    const r = costOf(WORKLOAD, ASOF);
    expect(r.total).toBeCloseTo(5000, 6);
    expect(r.outputShare).toBeCloseTo(0.5, 6);
  });

  it("halves the bill for batch work", () => {
    const r = costOf({ ...WORKLOAD, batch: true }, ASOF);
    expect(r.total).toBeCloseTo(2500, 6);
  });

  it("bills cache reads at a tenth of the input rate", () => {
    const r = costOf({ ...WORKLOAD, cacheReadTokens: 1_000 }, ASOF);
    expect(r.cacheReadCost).toBeCloseTo((1_000 / 1e6) * 5 * 0.1 * 250_000, 6);
  });

  it("warns when a prefix is under the model's cacheable minimum", () => {
    const min = MODELS["claude-opus-5"].minCacheablePrefix;
    const r = costOf({ ...WORKLOAD, cacheReadTokens: min - 1 }, ASOF);
    expect(r.warnings.some((w) => w.includes("silently does nothing"))).toBe(true);
  });

  it("stays quiet when the prefix clears the minimum", () => {
    const min = MODELS["claude-opus-5"].minCacheablePrefix;
    const r = costOf({ ...WORKLOAD, cacheReadTokens: min }, ASOF);
    expect(r.warnings.some((w) => w.includes("silently does nothing"))).toBe(false);
  });
});

describe("cacheBreakEvenRequests", () => {
  it("is 2 requests on the 5m TTL and 3 on the 1h", () => {
    expect(cacheBreakEvenRequests("5m")).toBe(2);
    expect(cacheBreakEvenRequests("1h")).toBe(3);
  });
});

describe("compareTiers", () => {
  it("returns candidates cheapest first with savings against the baseline", () => {
    const tiers = compareTiers(WORKLOAD, ["claude-opus-5", "claude-haiku-4-5"], ASOF);
    expect(tiers[0].monthlyCost).toBeLessThanOrEqual(tiers[1].monthlyCost);
    const baseline = tiers.find((t) => t.model === "claude-opus-5");
    expect(baseline?.savingPct).toBeCloseTo(0, 6);
  });
});

describe("selfHostBreakeven", () => {
  it("calls it unreachable when the crossover exceeds capacity", () => {
    const v = selfHostBreakeven(
      { gpuCostPerHour: 2, gpuCount: 1, tokensPerSecond: 10, utilization: 0.35 },
      ratesFor("claude-opus-5", ASOF).inputPerMTok,
    );
    expect(v.reachable).toBe(false);
    expect(v.verdict).toContain("Stay on the API");
  });

  it("reports a crossover the hardware can actually reach", () => {
    const v = selfHostBreakeven(
      { gpuCostPerHour: 2, gpuCount: 1, tokensPerSecond: 900, utilization: 0.35 },
      15,
    );
    expect(v.reachable).toBe(true);
    expect(v.crossoverTokensPerMonth).toBeLessThanOrEqual(v.monthlyCapacityTokens);
  });
});
