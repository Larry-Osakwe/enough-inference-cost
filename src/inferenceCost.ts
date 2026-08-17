/**
 * Inference cost calculator. Ported verbatim from the lab so the published
 * page and the open module can never drift.
 *
 * Built for the Inference Cost and Portability Audit. Every number in MODELS is
 * a published first-party rate; nothing here is estimated.
 *
 * Three asymmetries drive most findings:
 *   1. Output costs 5x input on every tier.
 *   2. Cache reads cost 0.1x input. Writes cost 1.25x (5m TTL) or 2.0x (1h TTL).
 *   3. Batch is a flat 50% off both input and output.
 *
 * And one silent failure: the minimum cacheable prefix is model-dependent and
 * NOT monotonic across generations. Below it, caching does nothing and the API
 * reports no error.
 */

// ---------------------------------------------------------------------------
// Model table
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** Context window in tokens. */
  contextWindow: number;
  /** Minimum cacheable prefix. Below this, cache_control silently no-ops. */
  minCacheablePrefix: number;
  /** Set when the current rate is promotional. */
  introPricing?: {
    inputPerMTok: number;
    outputPerMTok: number;
    /** ISO date. After this, the standard rate applies. */
    endsOn: string;
  };
}

import modelsJson from "../models.json";

/**
 * Published first-party rates. The data lives in models.json so a price
 * correction is a reviewable data change, not a code change.
 */
export const MODELS: Record<string, ModelPricing> = modelsJson;

export type ModelId = string;

// ---------------------------------------------------------------------------
// Multipliers
// ---------------------------------------------------------------------------

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2.0 } as const;
export const BATCH_MULTIPLIER = 0.5;

export type CacheTtl = keyof typeof CACHE_WRITE_MULTIPLIER;

/**
 * Effective rate for a model, honouring promotional pricing.
 *
 * `asOf` defaults to today. Pass it explicitly in tests so results don't drift
 * when a promo lapses.
 */
export function ratesFor(
  model: ModelId,
  asOf: Date = new Date(),
): { inputPerMTok: number; outputPerMTok: number; isIntroRate: boolean } {
  const m = MODELS[model];
  if (m.introPricing && asOf <= new Date(`${m.introPricing.endsOn}T23:59:59Z`)) {
    return {
      inputPerMTok: m.introPricing.inputPerMTok,
      outputPerMTok: m.introPricing.outputPerMTok,
      isIntroRate: true,
    };
  }
  return {
    inputPerMTok: m.inputPerMTok,
    outputPerMTok: m.outputPerMTok,
    isIntroRate: false,
  };
}

// ---------------------------------------------------------------------------
// Workload cost
// ---------------------------------------------------------------------------

export interface Workload {
  model: ModelId;
  /** Calls per month. */
  calls: number;
  /**
   * Uncached input tokens per call. This is the `input_tokens` usage field,
   * which is the uncached REMAINDER, not the whole prompt.
   */
  inputTokens: number;
  /** Output tokens per call. */
  outputTokens: number;
  /** `cache_read_input_tokens` per call. Billed at 0.1x. */
  cacheReadTokens?: number;
  /** `cache_creation_input_tokens` per call. Billed at 1.25x or 2.0x. */
  cacheWriteTokens?: number;
  cacheTtl?: CacheTtl;
  /** Async work with nobody waiting can use the Batch API for 50% off. */
  batch?: boolean;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  total: number;
  /** input_tokens + cache_creation + cache_read. What dashboards usually miss. */
  totalPromptTokensPerCall: number;
  /** Share of spend going to output. Above ~0.6, length discipline is the first lever to test. */
  outputShare: number;
  warnings: string[];
}

export function costOf(w: Workload, asOf: Date = new Date()): CostBreakdown {
  const rates = ratesFor(w.model, asOf);
  const spec = MODELS[w.model];
  const warnings: string[] = [];

  const cacheRead = w.cacheReadTokens ?? 0;
  const cacheWrite = w.cacheWriteTokens ?? 0;
  const ttl = w.cacheTtl ?? "5m";
  const discount = w.batch ? BATCH_MULTIPLIER : 1;

  const perMTok = (tokens: number, rate: number, multiplier = 1) =>
    (tokens / 1_000_000) * rate * multiplier * discount * w.calls;

  const inputCost = perMTok(w.inputTokens, rates.inputPerMTok);
  const outputCost = perMTok(w.outputTokens, rates.outputPerMTok);
  const cacheReadCost = perMTok(cacheRead, rates.inputPerMTok, CACHE_READ_MULTIPLIER);
  const cacheWriteCost = perMTok(
    cacheWrite,
    rates.inputPerMTok,
    CACHE_WRITE_MULTIPLIER[ttl],
  );

  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  const totalPromptTokensPerCall = w.inputTokens + cacheRead + cacheWrite;

  // The silent failure: a prefix under the model's minimum never caches, and
  // the API reports success with cache_creation_input_tokens = 0.
  const attemptedPrefix = cacheWrite || cacheRead;
  if (attemptedPrefix > 0 && attemptedPrefix < spec.minCacheablePrefix) {
    warnings.push(
      `Prefix of ${attemptedPrefix} tokens is below ${w.model}'s ${spec.minCacheablePrefix}-token minimum. Caching silently does nothing on this model.`,
    );
  }
  if (cacheWrite > 0 && cacheRead === 0) {
    warnings.push(
      "Paying cache-write premiums with zero cache reads. Either a silent invalidator is present or the gap between requests exceeds the TTL.",
    );
  }
  if (totalPromptTokensPerCall > spec.contextWindow) {
    warnings.push(
      `Prompt of ${totalPromptTokensPerCall} tokens exceeds ${w.model}'s ${spec.contextWindow}-token context window.`,
    );
  }
  if (rates.isIntroRate) {
    warnings.push(
      `Using promotional pricing for ${w.model}, which ends ${spec.introPricing!.endsOn}. Standard rate is $${spec.inputPerMTok}/$${spec.outputPerMTok}.`,
    );
  }
  if (!w.batch && total > 0 && outputCost / total > 0.6) {
    warnings.push(
      "Output is over 60% of spend. Response-length discipline is the first lever to test here.",
    );
  }

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    total,
    totalPromptTokensPerCall,
    outputShare: total === 0 ? 0 : outputCost / total,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Cache break-even
// ---------------------------------------------------------------------------

/**
 * Smallest number of requests sharing a prefix at which caching is cheaper
 * than not caching. Returns 2 for the 5m TTL and 3 for the 1h TTL.
 *
 * Cost in multiples of the base input rate:
 *   cached   = writeMultiplier + (n - 1) * 0.1
 *   uncached = n
 */
export function cacheBreakEvenRequests(ttl: CacheTtl): number {
  const write = CACHE_WRITE_MULTIPLIER[ttl];
  for (let n = 1; n <= 100; n++) {
    if (write + (n - 1) * CACHE_READ_MULTIPLIER < n) return n;
  }
  throw new Error("no break-even found");
}

// ---------------------------------------------------------------------------
// Model tiering
// ---------------------------------------------------------------------------

export interface TierOption {
  model: ModelId;
  monthlyCost: number;
  savingVsBaseline: number;
  savingPct: number;
  warnings: string[];
}

/**
 * Same workload priced across candidate models, cheapest first.
 *
 * A saving here is a HYPOTHESIS, not a recommendation. It is only real once an
 * eval on the client's own workload shows quality holds.
 */
export function compareTiers(
  w: Workload,
  candidates: readonly ModelId[] = Object.keys(MODELS) as ModelId[],
  asOf: Date = new Date(),
): TierOption[] {
  const baseline = costOf(w, asOf).total;
  return candidates
    .map((model) => {
      const r = costOf({ ...w, model }, asOf);
      return {
        model,
        monthlyCost: r.total,
        savingVsBaseline: baseline - r.total,
        savingPct: baseline === 0 ? 0 : (baseline - r.total) / baseline,
        warnings: r.warnings,
      };
    })
    .sort((a, b) => a.monthlyCost - b.monthlyCost);
}

// ---------------------------------------------------------------------------
// Self-host breakeven
// ---------------------------------------------------------------------------

export interface SelfHostInputs {
  gpuCostPerHour: number;
  gpuCount: number;
  /** Measured sustained output tokens/sec at the target latency SLO. */
  tokensPerSecond: number;
  /**
   * Fraction of wall-clock the hardware is actually serving at that rate.
   * This is the number optimistic models fake. Measure it or assume 0.3-0.5.
   */
  utilization: number;
  /** Hours/month the GPUs are paid for. 24/7 reserved capacity is 730. */
  paidHoursPerMonth?: number;
}

export interface SelfHostVerdict {
  costPerMTok: number;
  monthlyFixedCost: number;
  /** Ceiling the hardware can physically produce at this utilization. */
  monthlyCapacityTokens: number;
  /** Volume at which self-hosting beats the API price. */
  crossoverTokensPerMonth: number;
  /** False when crossover exceeds capacity: self-hosting never wins on cost. */
  reachable: boolean;
  verdict: string;
}

/**
 * Self-host economics against a blended API rate.
 *
 * The honest answer is usually "stay on the API". Killing a self-hosting
 * project before it is staffed is a legitimate deliverable, and saying so in
 * the engagement letter keeps it from reading as a failed one.
 */
export function selfHostBreakeven(
  inputs: SelfHostInputs,
  blendedApiPricePerMTok: number,
): SelfHostVerdict {
  const hours = inputs.paidHoursPerMonth ?? 730; // 24/7 reserved capacity
  const monthlyFixedCost = inputs.gpuCostPerHour * inputs.gpuCount * hours;

  const tokensPerHourEffective =
    inputs.tokensPerSecond * 3600 * inputs.utilization * inputs.gpuCount;
  const monthlyCapacityTokens = tokensPerHourEffective * hours;

  const costPerMTok =
    tokensPerHourEffective === 0
      ? Infinity
      : (inputs.gpuCostPerHour * inputs.gpuCount) /
        (tokensPerHourEffective / 1_000_000);

  const crossoverTokensPerMonth =
    (monthlyFixedCost / blendedApiPricePerMTok) * 1_000_000;
  const reachable = crossoverTokensPerMonth <= monthlyCapacityTokens;

  const m = (n: number) => `${(n / 1_000_000).toFixed(0)}M`;
  const verdict = reachable
    ? `Self-hosting wins above ${m(crossoverTokensPerMonth)} tokens/month. Capacity ceiling is ${m(monthlyCapacityTokens)}/month.`
    : `Self-hosting never wins at this utilization: breakeven needs ${m(crossoverTokensPerMonth)} tokens/month but the hardware caps at ${m(monthlyCapacityTokens)}. Stay on the API.`;

  return {
    costPerMTok,
    monthlyFixedCost,
    monthlyCapacityTokens,
    crossoverTokensPerMonth,
    reachable,
    verdict,
  };
}

/** Blended $/MTok for a given input:output token split. */
export function blendedRate(
  model: ModelId,
  inputShare: number,
  asOf: Date = new Date(),
): number {
  const r = ratesFor(model, asOf);
  return inputShare * r.inputPerMTok + (1 - inputShare) * r.outputPerMTok;
}

/** Rates in MODELS were last verified against first-party pricing on this date. */
export const RATES_AS_OF = "2026-08-15";

/** Days before the page starts disclosing its own age. */
export const RATES_STALE_AFTER_DAYS = 45;

export function ratesAgeInDays(now: Date = new Date()): number {
  const asOf = new Date(`${RATES_AS_OF}T00:00:00Z`);
  return Math.floor((now.getTime() - asOf.getTime()) / 86_400_000);
}
