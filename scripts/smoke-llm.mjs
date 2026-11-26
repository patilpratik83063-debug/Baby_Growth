// Real OpenRouter smoke test with per-call cost: node --env-file=.env scripts/smoke-llm.mjs
import { z } from "zod";
import { generateJson, generateText, askWithWebSearch, ENGINES, MODELS, isMock, spend } from "../server/llm.js";

if (isMock()) { console.error("OPENROUTER_API_KEY not set (mock mode)."); process.exit(1); }
const t = async (label, p) => {
  const before = spend.totalUsd, t0 = Date.now();
  try { const v = await p; console.log(`PASS ${label}  ${Date.now() - t0}ms  $${(spend.totalUsd - before).toFixed(5)}`, v); }
  catch (e) { console.log(`FAIL ${label}:`, e.message); }
};

await t(`json   ${MODELS.fast}`, generateJson({
  system: "Extract facts.", prompt: "Acme Dental is a family dentist in Austin, Texas offering cleanings, braces and implants.",
  schema: z.object({ brand: z.string(), city: z.string(), services: z.array(z.string()) }),
}));
await t(`plan   ${MODELS.research}`, generateJson({
  model: MODELS.research, system: "You are an SEO strategist.", prompt: "Give 3 article ideas for a family dentist in Austin.",
  schema: z.object({ items: z.array(z.object({ title: z.string(), keyword: z.string(), articleType: z.enum(["how-to", "listicle", "comparison", "guide"]) })) }),
}).then((r) => r.items.map((i) => i.title)));
for (const [k, e] of Object.entries(ENGINES)) {
  await t(`search ${k.padEnd(10)} ${e.model}`, askWithWebSearch({ model: e.model, prompt: "What is the best family dentist software for small clinics? Name 3 products.", maxResults: 3 })
    .then((r) => ({ chars: r.answer.length, sources: r.sources.length, first: r.sources[0]?.url })));
}
await t(`research ${MODELS.research}`, askWithWebSearch({ model: MODELS.research, prompt: "Research 'how often should you go to the dentist'. Facts with sources.", maxResults: 5 })
  .then((r) => ({ chars: r.answer.length, sources: r.sources.length })));
await t(`write  ${MODELS.writer} (~1800 words)`, generateText({ system: "You write SEO articles in Markdown.", prompt: "Write a 1,800-word article: '# How often should you go to the dentist?' with TL;DR, H2 sections, a table and an FAQ.", maxTokens: 8000 })
  .then((s) => ({ words: s.split(/\s+/).length, startsWithH1: s.startsWith("# ") })));
console.log(`\nTOTAL $${spend.totalUsd.toFixed(4)} for ${spend.calls} calls`, JSON.stringify(spend.byModel));
