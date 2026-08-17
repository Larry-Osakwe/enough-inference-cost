# @enough/inference-cost

The arithmetic behind [enough.engineering/calculator](https://enough.engineering/calculator):
what a workload costs to serve, and what caching, batching, a smaller tier, or
your own hardware does to that number.

No dependencies. The published site imports this package directly, so the
calculator and this repo can't disagree.

## Install

```sh
pnpm add github:Larry-Osakwe/enough-inference-cost
```

## Use

```ts
import { costOf, compareTiers, selfHostBreakeven } from "@enough/inference-cost";

const monthly = costOf({
  model: "claude-opus-5",
  calls: 250_000,
  inputTokens: 2_000,
  outputTokens: 400,
});

monthly.total;        // 5000
monthly.outputShare;  // 0.5
monthly.warnings;     // things worth knowing about this workload
```

## What it knows

Three asymmetries drive most findings:

- Output costs 5× input on every tier.
- Cache reads cost 0.1× input. Writes cost 1.25× (5m TTL) or 2.0× (1h).
- Batch is a flat 50% off both input and output.

And one silent failure it will warn you about: the minimum cacheable prefix is
model-dependent and **not** monotonic across generations. Below it, caching does
nothing and the API reports success with no error. `costOf` also flags cache
writes with no reads, prompts past the context window, promotional rates that
are about to lapse, and output above 60% of spend.

## Prices

Rates live in [`models.json`](./models.json) as data, so a correction is a
reviewable change rather than a code edit. Nothing here is estimated: every
number is a published rate from the provider or from a community dataset,
and each entry says which. Promotional pricing carries its end date and
`ratesFor()` stops applying it on that date without anyone intervening.

Each entry carries a `source`. `first-party` means the rate was read off the
provider's own pricing page; `community` means it came from the LiteLLM dataset
and still needs that check. `minCacheablePrefix` is `0` where the model's
minimum has not been confirmed, which only disables the below-minimum warning.

The table is curated, not exhaustive: roughly two dozen models that are live
candidates for a placement decision, no dated snapshots, no previews, no
fine-tunes, and one representative host per open-weight model. Anything else is
covered by the rate-override fields on the calculator.

**Found a wrong price?** Open a pull request against `models.json` with a link
to the provider's pricing page. That is the fastest way to fix it for everyone.

A weekly job diffs this table against
[LiteLLM's community dataset](https://github.com/BerriAI/litellm) and opens a
pull request when the two disagree. It never publishes a rate on its own: the
feed is a signal, and a human confirms against the provider before merging.

## Tests

```sh
pnpm install
pnpm test
```

## License

MIT.
