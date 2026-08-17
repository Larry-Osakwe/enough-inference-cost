/**
 * Weekly drift check against LiteLLM's community pricing dataset.
 *
 * It never publishes a rate. It rewrites models.json only so a human has a
 * diff to review, and the workflow opens a pull request with the provider's
 * own pricing page linked for confirmation. LiteLLM is a signal, not a source
 * of truth: fields it does not carry (minCacheablePrefix, promotional pricing)
 * are left alone.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FEED =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PER_MTOK = 1_000_000;

const models = JSON.parse(readFileSync("models.json", "utf8"));
const res = await fetch(FEED);
if (!res.ok) {
  console.error(`could not reach the pricing feed: ${res.status}`);
  process.exit(1);
}
const feed = await res.json();

const changes = [];
for (const [id, ours] of Object.entries(models)) {
  const theirs = feed[id];
  if (!theirs) {
    console.log(`- ${id}: not in the feed, leaving alone`);
    continue;
  }
  // A live promotional rate looks exactly like drift to the feed, which only
  // publishes one number. Ours is the more precise record, so leave it be.
  const promoRunning =
    ours.introPricing && new Date() <= new Date(`${ours.introPricing.endsOn}T23:59:59Z`);
  if (promoRunning) {
    console.log(`- ${id}: promotional pricing runs to ${ours.introPricing.endsOn}, skipping`);
    continue;
  }

  const compare = [
    ["inputPerMTok", theirs.input_cost_per_token],
    ["outputPerMTok", theirs.output_cost_per_token],
    ["contextWindow", theirs.max_input_tokens],
  ];
  for (const [field, raw] of compare) {
    if (raw == null) continue;
    const value = field === "contextWindow" ? raw : Number((raw * PER_MTOK).toFixed(4));
    if (ours[field] !== value) {
      changes.push({ id, field, from: ours[field], to: value });
      ours[field] = value;
    }
  }
}

if (changes.length === 0) {
  console.log("no drift");
  process.exit(0);
}

writeFileSync("models.json", `${JSON.stringify(models, null, 2)}\n`);

const rows = changes
  .map((c) => `| \`${c.id}\` | ${c.field} | ${c.from} | **${c.to}** |`)
  .join("\n");
const body = `LiteLLM's dataset disagrees with \`models.json\`.

| model | field | ours | feed |
| --- | --- | --- | --- |
${rows}

Confirm against the provider's own pricing page before merging — the feed is
community-maintained and can be wrong or early. If it is right, bump
\`RATES_AS_OF\` in the same commit.
`;
writeFileSync("pricing-diff.md", body);
console.log(body);
