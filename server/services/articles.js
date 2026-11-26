// Article engine: research (web search) -> brief -> brand-voice article -> FAQ + JSON-LD -> SEO checks -> cover.
// Reference endpoints: GET /articles, /articles/:id/export-html, /articles/rewrite-text.
import { z } from "zod";
import { one, all, run, uid, now, parse, logActivity } from "../db.js";
import { bad, notFound, str } from "../http.js";
import { generateJson, generateText, askWithWebSearch, seeded } from "../llm.js";
import { renderMarkdown, extractFaq, slugify, plainText, esc } from "../markdown.js";
import { hostOf, tryFetch, extract } from "../crawl.js";
import { selectPartner, recordBacklink } from "./backlinks.js";
import { enqueue } from "./jobs.js";

const LANG_NAMES = { en: "English", es: "Spanish", de: "German", fr: "French", pt: "Portuguese", it: "Italian", nl: "Dutch", hi: "Hindi", ja: "Japanese", pl: "Polish" };

export const articleDto = (a, full = false) => ({
  id: a.id, websiteId: a.website_id, planId: a.plan_id, title: a.title, slug: a.slug, metaDescription: a.meta_description,
  keyword: a.keyword, wordCount: a.word_count, status: a.status, publishedUrl: a.published_url, publishedAt: a.published_at,
  checks: parse(a.checks, {}), coverUrl: `/media/covers/${a.id}.svg`, createdAt: a.created_at, updatedAt: a.updated_at,
  ...(full ? { markdown: a.markdown, html: a.html, faq: parse(a.faq, []), jsonLd: parse(a.json_ld, null) } : {}),
});

/* ---------------- helpers ---------------- */
const tokens = (s) => new Set(String(s || "").toLowerCase().split(/[^a-z0-9\u00c0-\u024f]+/).filter((w) => w.length > 3));
function internalLinkCandidates(website, keyword, limit = 6) {
  const p = parse(website.profile, {});
  const kw = tokens(keyword);
  const own = all("SELECT title, keyword, published_url FROM articles WHERE website_id = ? AND status = 'published' AND published_url IS NOT NULL ORDER BY published_at DESC LIMIT 100", website.id)
    .map((a) => ({ url: a.published_url, label: a.title, t: tokens(a.title + " " + a.keyword) }));
  const pages = (p.knownPages || []).map((u) => { const path = (() => { try { return new URL(u).pathname; } catch { return ""; } })(); return { url: u, label: path.replace(/[-_/]+/g, " ").trim() || "home", t: tokens(path) }; });
  return [...own, ...pages].map((c) => ({ ...c, s: [...kw].filter((x) => c.t.has(x)).length })).filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s).slice(0, limit).map(({ url, label }) => ({ url, label }));
}

function seoChecks(md, { keyword, title, metaDescription, faq, internal, partnerUrl, origin }) {
  const text = plainText(md);
  const words = text ? text.split(" ").length : 0;
  const firstPara = (md.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "");
  const links = [...md.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  const internalCount = links.filter((l) => hostOf(l) === hostOf(origin)).length;
  const externalCount = links.length - internalCount;
  const kw = keyword.toLowerCase();
  const first100 = text.split(" ").slice(0, 100).join(" ").toLowerCase();
  return {
    wordCount: words,
    answerFirst: firstPara.split(" ").length <= 70,
    keywordInTitle: title.toLowerCase().includes(kw.split(" ")[0]),
    keywordInIntro: first100.includes(kw),
    metaDescriptionLength: (metaDescription || "").length,
    headings: (md.match(/^#{2,3}\s/gm) || []).length,
    internalLinks: internalCount,
    internalLinksSuggested: internal.length,
    externalLinks: externalCount,
    hasTable: /^\s*\|.*\|\s*$/m.test(md),
    hasStatistics: /\d+(\.\d+)?\s?%|[$€£₹]\s?\d|\b\d[\d,.]*\s?(million|billion|thousand|crore|lakh)\b/i.test(md),
    faqCount: faq.length,
    hasTldr: /^#{2,3}\s*(TL;?DR|Key takeaways)/im.test(md),
    partnerLinkPlaced: partnerUrl ? md.includes(partnerUrl) : null,
    jsonLd: true,
  };
}

function buildJsonLd({ title, metaDescription, faq, website, profile, url, publishedAt }) {
  const graph = [{
    "@type": "Article", headline: title, description: metaDescription, inLanguage: profile.selectedLanguage || "en",
    datePublished: publishedAt, dateModified: publishedAt, mainEntityOfPage: url || undefined,
    author: { "@type": "Organization", name: profile.brandName || hostOf(website.url), url: website.url },
    publisher: { "@type": "Organization", name: profile.brandName || hostOf(website.url), url: website.url },
  }];
  if (faq.length) graph.push({ "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })) });
  return { "@context": "https://schema.org", "@graph": graph };
}

const MetaSchema = z.object({ metaDescription: z.string(), slug: z.string() });

/* ---------------- generation ---------------- */
export async function generateArticle(planId) {
  const plan = one("SELECT * FROM content_plan WHERE id = ?", planId);
  if (!plan) throw notFound("Plan item not found.");
  const website = one("SELECT * FROM websites WHERE id = ?", plan.website_id);
  const p = parse(website.profile, {});
  const lang = LANG_NAMES[p.selectedLanguage] || p.selectedLanguage || "English";
  const brand = p.brandName || hostOf(website.url);
  const secondary = parse(plan.secondary_keywords, []);

  // 1) research with live web search
  const research = await askWithWebSearch({
    prompt: `Research "${plan.keyword}" for an article titled "${plan.title}". Find current facts, statistics with their sources, common questions people ask, and what the top-ranking pages cover. Summarize as concise notes with source URLs.`,
    mock: () => ({ answer: `Notes on ${plan.keyword}: key considerations, typical costs, and common questions.`, sources: [] }),
  });

  // 2) example article for voice matching
  let voiceSample = "";
  if (p.exampleArticleUrl) { const r = await tryFetch(p.exampleArticleUrl); if (r && r.status < 400) voiceSample = extract(r.text).text.slice(0, 2500); }

  const internal = internalLinkCandidates(website, plan.keyword);
  const partner = selectPartner(website, plan.keyword);

  // 3) write
  const system = `You are an expert content writer for ${brand}. You write articles that rank on Google and get cited by AI assistants.
Rules:
- Write in ${lang}${p.englishType ? ` (${p.englishType} spelling)` : ""}. Output Markdown only, starting with a single "# " H1.
- Answer-first: the first paragraph directly answers the main question in under 60 words.
- Then "## TL;DR" with 3-5 bullets, then well-structured ## and ### sections, short paragraphs.
- Use concrete numbers and cite sources inline as Markdown links, using only URLs from the research notes. Never invent statistics or URLs.
- Include a comparison table when it helps the reader.
- End with "## FAQ" containing 4-6 "### question" headings each followed by a 2-3 sentence answer, then a short conclusion that mentions ${brand} naturally.
- Tone: ${(p.voice || []).join(", ") || "clear, helpful, expert"}. Do not sound like generic AI; no filler, no "in today's fast-paced world".`;
  const prompt = `Title: ${plan.title}
Primary keyword: ${plan.keyword}
Secondary keywords: ${secondary.join(", ")}
Search intent: ${plan.search_intent}; article type: ${plan.article_type}
About ${brand}: ${p.description || ""}
Products/services: ${(p.mainServices || []).join("; ")}
Audience: ${(p.targetAudience || []).join("; ")}
Target length: 1,600-2,200 words.

Internal links to include where relevant (use these exact URLs):
${internal.map((l) => `- ${l.url} (${l.label})`).join("\n") || "- none"}
${partner ? `\nInclude exactly one natural, contextual link to ${partner.url} with anchor text close to "${partner.anchor}" where it genuinely helps the reader.` : ""}

Research notes:
${research.answer}
Sources:
${research.sources.map((s) => `- ${s.url} (${s.title})`).join("\n") || "- none"}
${voiceSample ? `\nExample of the brand's writing style (match the voice, not the content):\n${voiceSample}` : ""}`;

  const markdown = await generateText({
    system, prompt, effort: "medium",
    mock: () => mockArticle({ plan, brand, internal, partner, secondary, url: website.url }),
  });

  const titleFromMd = (markdown.match(/^#\s+(.+)$/m) || [])[1]?.trim() || plan.title;
  const faq = extractFaq(markdown);
  const meta = await generateJson({
    system: "You write SEO metadata.",
    prompt: `Write a meta description (140-155 characters, includes "${plan.keyword}", compelling, no quotes) and a short URL slug (3-6 words, lowercase, hyphens) for this article in ${lang}.\n\n${markdown.slice(0, 4000)}`,
    schema: MetaSchema,
    mock: () => ({ metaDescription: `${plan.title}: practical answers on ${plan.keyword}, costs and common questions, from ${brand}.`.slice(0, 155), slug: slugify(plan.keyword) }),
  });

  const id = uid(), t = now();
  let slug = slugify(meta.slug || titleFromMd);
  if (one("SELECT 1 FROM articles WHERE website_id = ? AND slug = ?", website.id, slug)) slug += "-" + id.slice(0, 4);
  const html = renderMarkdown(markdown);
  const checks = seoChecks(markdown, { keyword: plan.keyword, title: titleFromMd, metaDescription: meta.metaDescription, faq, internal, partnerUrl: partner?.url, origin: website.url });
  const jsonLd = buildJsonLd({ title: titleFromMd, metaDescription: meta.metaDescription, faq, website, profile: p, publishedAt: t });
  run(`INSERT INTO articles (id, website_id, plan_id, title, slug, meta_description, keyword, markdown, html, faq, json_ld, word_count, checks, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, website.id, plan.id, titleFromMd.slice(0, 200), slug, meta.metaDescription.slice(0, 300), plan.keyword, markdown, html,
    JSON.stringify(faq), JSON.stringify(jsonLd), checks.wordCount, JSON.stringify(checks), "draft", t, t);
  run("UPDATE content_plan SET status = 'generated', article_id = ? WHERE id = ?", id, plan.id);
  recordBacklink(website.id, id, partner, markdown);
  logActivity(website.id, "article", `Wrote "${titleFromMd}" (${checks.wordCount} words).`);

  // 4) autopilot publishing
  if (website.autopilot && one("SELECT 1 FROM integrations WHERE website_id = ? AND status = 'active' LIMIT 1", website.id)) {
    enqueue("article.publish", { articleId: id }, { websiteId: website.id });
  }
  return { articleId: id };
}

export function onGenerateFailed({ planId }) {
  run("UPDATE content_plan SET status = 'failed' WHERE id = ? AND status = 'generating'", planId);
}

function mockArticle({ plan, brand, internal, partner, secondary, url }) {
  const rnd = seeded(plan.id);
  const pct = () => Math.round(20 + rnd() * 60);
  const kw = plan.keyword;
  return `# ${plan.title}

${kw.charAt(0).toUpperCase() + kw.slice(1)} comes down to three things: what you need, what it costs, and who you trust to deliver it. This guide gives you a clear answer for each, with a checklist you can use today.

## TL;DR

- Start by defining the outcome you need from ${kw}.
- Compare at least three options on price, quality and support.
- About ${pct()}% of buyers say reviews were the deciding factor.
- ${brand} can help you get started quickly.

## What to know about ${kw}

Most people searching for ${kw} want a fast, reliable answer. Focus on the essentials first, then refine.${internal[0] ? ` See [${internal[0].label}](${internal[0].url}) for more detail.` : ""}

### Key factors

1. **Quality**: look for proven results and clear guarantees.
2. **Cost**: compare total cost, not just the headline price.
3. **Support**: fast, human support saves time later.

## Comparing your options

| Option | Best for | Typical cost |
| --- | --- | --- |
| DIY | Small budgets | Low |
| Specialist provider | Reliable results | Medium |
| Full-service | Hands-off teams | High |

${partner ? `Many teams also find resources like [${partner.anchor}](${partner.url}) useful when comparing options.\n` : ""}
## Common mistakes

- Choosing on price alone.
- Skipping reviews and references.
- Not planning for ${secondary[0] || "ongoing maintenance"}.

## FAQ

### How much does ${kw} cost?

Costs vary with scope and quality. Get at least three quotes and compare what is included.

### How long does it take?

Simple cases take days; complex ones take a few weeks. Ask for a timeline up front.

### What should I look for in a provider?

Clear pricing, strong reviews and responsive support are the best signals.

### Can ${brand} help?

Yes. ${brand} offers ${kw} with clear pricing and fast support. Visit [${hostOf(url)}](${url}) to learn more.

## Conclusion

${kw.charAt(0).toUpperCase() + kw.slice(1)} is easier when you know what to compare. Use the checklist above, and talk to ${brand} when you are ready.
`;
}

/* ---------------- cover image (SVG, brand colours) ---------------- */
export function coverSvg(articleId) {
  const a = one("SELECT a.title, w.profile, w.url FROM articles a JOIN websites w ON w.id = a.website_id WHERE a.id = ?", articleId);
  if (!a) return null;
  const p = parse(a.profile, {});
  const c1 = /^#[0-9a-f]{6}$/i.test(p.brandColor || "") ? p.brandColor : "#f25533";
  const c2 = /^#[0-9a-f]{6}$/i.test(p.brandSecondaryColor || "") ? p.brandSecondaryColor : "#171717";
  const words = a.title.split(" "); const lines = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > 26) { lines.push(cur.trim()); cur = w; } else cur += " " + w; }
  if (cur.trim()) lines.push(cur.trim());
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<g fill="#fff" opacity=".08">${Array.from({ length: 12 }, (_, i) => `<rect x="${900 + (i % 4) * 70}" y="${60 + Math.floor(i / 4) * 70}" width="54" height="54" rx="8"/>`).join("")}</g>
<text x="80" y="110" fill="#fff" opacity=".8" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="600">${esc(p.brandName || hostOf(a.url))}</text>
${lines.slice(0, 4).map((l, i) => `<text x="80" y="${250 + i * 78}" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="700">${esc(l)}</text>`).join("\n")}
</svg>`;
}

/* ---------------- API ---------------- */
function getOwned(ctx) {
  const a = one("SELECT * FROM articles WHERE id = ? AND website_id = ?", ctx.params.id, ctx.website.id);
  if (!a) throw notFound("Article not found.");
  return a;
}

export function listArticles(ctx) {
  const status = str(ctx.query.status, 20);
  const rows = all(`SELECT * FROM articles WHERE website_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at DESC LIMIT 200`, ctx.website.id, ...(status ? [status] : []));
  return { data: rows.map((a) => articleDto(a)) };
}
export const getArticle = (ctx) => ({ data: articleDto(getOwned(ctx), true) });

export function updateArticle(ctx) {
  const a = getOwned(ctx);
  const markdown = typeof ctx.body.markdown === "string" ? ctx.body.markdown.slice(0, 200_000) : a.markdown;
  const title = str(ctx.body.title, 200) || a.title;
  const metaDescription = "metaDescription" in ctx.body ? str(ctx.body.metaDescription, 300) : a.meta_description;
  const faq = extractFaq(markdown);
  const w = ctx.website, p = parse(w.profile, {});
  const checks = seoChecks(markdown, { keyword: a.keyword, title, metaDescription, faq, internal: [], partnerUrl: null, origin: w.url });
  const jsonLd = buildJsonLd({ title, metaDescription, faq, website: w, profile: p, url: a.published_url, publishedAt: a.published_at || a.created_at });
  run("UPDATE articles SET title = ?, meta_description = ?, markdown = ?, html = ?, faq = ?, json_ld = ?, word_count = ?, checks = ?, updated_at = ? WHERE id = ?",
    title, metaDescription, markdown, renderMarkdown(markdown), JSON.stringify(faq), JSON.stringify(jsonLd), checks.wordCount, JSON.stringify(checks), now(), a.id);
  return { data: articleDto(one("SELECT * FROM articles WHERE id = ?", a.id), true) };
}

export function deleteArticle(ctx) {
  const a = getOwned(ctx);
  run("DELETE FROM articles WHERE id = ?", a.id);
  run("UPDATE content_plan SET status = 'planned', article_id = NULL WHERE article_id = ?", a.id);
  return { data: { ok: true } };
}

export function regenerateArticle(ctx) {
  const a = getOwned(ctx);
  if (!a.plan_id) throw bad("This article has no plan item to regenerate from.");
  run("DELETE FROM articles WHERE id = ?", a.id);
  run("UPDATE content_plan SET status = 'generating', article_id = NULL WHERE id = ?", a.plan_id);
  return { data: enqueue("article.generate", { planId: a.plan_id }, { websiteId: ctx.website.id }) };
}

export function exportHtml(ctx) {
  const a = getOwned(ctx);
  const doc = articleHtmlDocument(a, ctx.website);
  ctx.res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${a.slug}.html"` });
  ctx.res.end(doc);
  return undefined;
}

export function articleHtmlDocument(a, website) {
  const p = parse(website.profile, {});
  return `<!doctype html><html lang="${esc(p.selectedLanguage || "en")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(a.title)}</title><meta name="description" content="${esc(a.meta_description || "")}">
<meta property="og:title" content="${esc(a.title)}"><meta property="og:description" content="${esc(a.meta_description || "")}">
${a.published_url ? `<link rel="canonical" href="${esc(a.published_url)}">` : ""}
<script type="application/ld+json">${(a.json_ld || "{}").replace(/</g, "\\u003c")}</script></head>
<body><article>${a.html}</article></body></html>`;
}

const RewriteSchema = z.object({ text: z.string() });
export async function rewriteText(ctx) {
  const text = str(ctx.body.text, 6000), instruction = str(ctx.body.instruction, 300) || "Improve clarity and flow";
  if (!text) throw bad("Text is required.");
  const out = await generateJson({
    system: "You edit article passages. Keep facts, links and Markdown formatting. Return only the rewritten passage.",
    prompt: `Instruction: ${instruction}\n\nPassage:\n${text}`,
    schema: RewriteSchema, effort: "low",
    mock: () => ({ text: text.replace(/\s+/g, " ").trim() }),
  });
  return { data: { text: out.text } };
}

export const jobGenerateArticle = ({ planId }) => generateArticle(planId);
