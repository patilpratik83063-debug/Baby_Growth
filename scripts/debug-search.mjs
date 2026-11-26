// Debug: raw web-search annotations per model. node --env-file=.env scripts/debug-search.mjs <model> [engine]
const [model, engine] = process.argv.slice(2);
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ model, max_tokens: 1500, plugins: [{ id: "web", max_results: 3, ...(engine ? { engine } : {}) }], messages: [{ role: "user", content: "What are the best online dictionaries? Name 3." }] }),
});
const j = await res.json();
const m = j.choices?.[0]?.message || {};
console.log("status", res.status, "keys", Object.keys(m), "finish", j.choices?.[0]?.finish_reason);
console.log("annotations", JSON.stringify((m.annotations || []).slice(0, 3).map((a) => ({ type: a.type, url: a.url_citation?.url?.slice(0, 90), title: a.url_citation?.title }))));
console.log("content head:", String(m.content).slice(0, 300).replace(/\n/g, " "));
console.log("usage cost", j.usage?.cost, j.error ? JSON.stringify(j.error) : "");
