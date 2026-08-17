import { describe, expect, it } from "vitest";
import { MODELS } from "./inferenceCost";

/**
 * The table is data, so its failure mode is a bad row rather than bad code.
 * These pin the shape a row has to have for the UI to group it and for the
 * promo-expiry warning to mean anything.
 */
describe("the model table", () => {
  const entries = Object.entries(MODELS);

  it("has every model grouped and attributed", () => {
    for (const [id, m] of entries) {
      expect(m.provider, `${id} has no provider`).toBeTruthy();
      expect(["first-party", "community"], `${id} source`).toContain(m.source);
    }
  });

  it("prices every model with positive rates and a context window", () => {
    for (const [id, m] of entries) {
      expect(m.inputPerMTok, `${id} input`).toBeGreaterThan(0);
      expect(m.outputPerMTok, `${id} output`).toBeGreaterThan(0);
      expect(m.contextWindow, `${id} context`).toBeGreaterThan(0);
    }
  });

  it("only calls a rate promotional when it is below the standard rate", () => {
    // A promo that costs more than standard means the two got swapped, which
    // would quietly invert the "rate goes up on <date>" warning.
    for (const [id, m] of entries) {
      if (!m.introPricing) continue;
      expect(m.introPricing.inputPerMTok, `${id} promo input`).toBeLessThan(m.inputPerMTok);
      expect(m.introPricing.outputPerMTok, `${id} promo output`).toBeLessThan(m.outputPerMTok);
      expect(m.introPricing.endsOn, `${id} promo end date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("keeps the roster small enough to be a menu", () => {
    // The long tail is served by the rate-override fields, not by scrolling.
    expect(entries.length).toBeLessThanOrEqual(40);
    expect(entries.length).toBeGreaterThan(10);
  });
});
