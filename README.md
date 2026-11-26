# GeoGrowth

An AI SEO and GEO (generative engine optimization) platform: onboarding, brand
analysis, content plans, brand-voice articles, publishing, a backlink exchange,
AI-search visibility tracking, GEO audits, free SEO tools and billing.

The product structure, API contract and data model were reverse-engineered
from babylovegrowth.ai with **REA** (`rea-agents` 6.10.1). The brand, copy,
prompts and all server logic are original.

## Run

```bash
npm install
cp .env.example .env     # set OPENROUTER_API_KEY (one key for every model)
npm start                # loads .env; without a key the AI runs in mock mode
npm run mock             # force mock mode (no AI cost)
```

Open http://localhost:3000. Requires Node 24 or newer (it uses the built-in `node:sqlite`).

- Landing page: `/`
- Guest onboarding: `/onboarding.html`
- Sign in: `/sign-in.html`
- Dashboard: `/app.html`
- Hosted blog: `/blog/:websiteId`

Without `RESEND_API_KEY`, sign-in codes are printed to the server console. `GET /api/health` shows the active models.

## AI models (OpenRouter)

| Job | Default (budget) model | Price per M tokens (in / out) |
| --- | --- | --- |
| Articles, research, analysis, plan, extraction | `anthropic/claude-haiku-5.5` | $0.10 / $0.50 |
| AI visibility: ChatGPT | `openai/gpt-5-nano` | $0.05 / $0.40 |
| AI visibility: Claude | `anthropic/claude-haiku-5.5` | $0.10 / $0.50 |
| AI visibility: Gemini | `google/gemini-2.5-flash-lite` | $0.10 / $0.40 |
| AI visibility: Perplexity | `perplexity/sonar` (native search) | $1.00 / $1.00 |
| Web search backend | Parallel "fast" | $0.001 per search |

Every model and the search backend can be overridden in `.env` (for example `GEO_MODEL_WRITER=anthropic/claude-sonnet-5.5` for higher-quality articles).
- **JSON outputs:** strict `json_schema` from zod, validated, with one repair retry.
- **Transient errors** are retried with backoff.
- **A failing engine** never blocks the others.
- **Spend tracking:** `GET /api/health` shows AI spend since the server started.

**Measured costs with budget models (Nov 2026):**
- **One article** (web research + ~2,000 words + metadata): about $0.006.
- **One prompt checked on all 4 engines:** about $0.012.
- **A full onboarding run** (analysis, 13-item plan, one article, 5 prompts × 4 engines, public audit): $0.11.

## What REA recovered from the reference

| Evidence | Source | Used for |
| --- | --- | --- |
| Next.js/React app, 137 scripts | `rea analyze-web-bundle` | Architecture |
| 170+ app routes (dashboard, onboarding, free tools, admin) | REA route inventory | Module list |
| Full API map, ~400 endpoints in 35+ modules, base `api.<domain>/api` | `ENDPOINTS` constant in exported scripts | Our `/api/*` routes |
| Guest onboarding contract: `x-guest-id`, `PUT draft {section,value,completesStep}`, business-info, organic-competitors, brand-colors, claim | Onboarding bundle (`inspect-web-page --include-script-sources`, `export-web-scripts`) | `server/services/onboarding.js` |
| Website data model (`selectedLanguage`, `englishType`, `targetLocations`, `brandName`, `description`, `industry`, `targetAudience[]`, `mainServices[]`, `brandColor`, `brandSecondaryColor`, `exampleArticleUrl`, `heroImageStyle`, `sitemapUrl`, `competitors.urls`) | Onboarding bundle | `websites.profile` |
| Public AI audit: start → poll every 5s until `isCompleted` → email capture | Landing bundle | `/public-llm-visibility/*` |
| Plans: Grow $99, Scale $399 | Page JSON-LD | `billing.js` |
| Hero tile background, engine rotator, marquee, sticky CTA, motion | Landing bundle + CSS | `public/` |

**Not observable, so built as original work:**
- **Server code:** generation prompts, competitor data source, backlink matching rules, plan quotas. Dashboard bundles sit behind a server-side login redirect, and server code is never shipped to browsers.
- **Integrations that need your own credentials** (not implemented yet): Google Search Console, GA4, Google Business Profile, Reddit, Quora, Meta posting, Shopify/Webflow/Wix publishing, white-label, agency reports and AI chat.

## Architecture

```
server/
  index.js            routes (mirror the reference API map), static files, hosted blog, covers, Stripe webhook
  db.js               SQLite schema (node:sqlite)
  http.js             router, errors, cookies, rate limits
  crawl.js            SSRF-safe fetching, HTML facts, platform + brand colour detection, sitemaps, robots
  llm.js              OpenRouter: strict JSON outputs, long-form writing, web search with citations; retries; mock mode
  markdown.js         safe Markdown renderer, FAQ extraction
  services/
    auth.js           password + email-code sign-in, sessions, API keys, email (Resend or console)
    onboarding.js     guest + authenticated onboarding, business analysis, competitor discovery
    contentPlan.js    keyword-led monthly plan
    articles.js       research -> article -> FAQ + JSON-LD -> SEO checks -> SVG cover
    publishing.js     WordPress, signed webhook, hosted blog; AES-256-GCM credential storage
    backlinks.js      exchange network matching with guardrails
    visibility.js     AI-search prompt tracking, mentions, share of voice, sources; public audit
    geoAudit.js       19-check AI-readiness audit, share links
    seotools.js       robots, sitemap, H1, meta, canonical, OG, llms.txt validate/generate, keyword density
    billing.js        plans, limits, Stripe Checkout/Portal/Webhook over REST
    overview.js       activity feed, checklist, stats, milestones, autopilot scheduler
    jobs.js           durable SQLite job queue with retries and backoff
public/               landing, onboarding, sign-in, dashboard
```

## How the agent works

1. **Onboarding.**
   - A guest enters a URL.
   - Claude reads the site and drafts the profile: brand, description, industry, audience, services, locations and tone.
   - Brand colours and the platform are detected from the HTML.
   - Competitor discovery uses live web search, then structured extraction.
2. **Kick-off** (`/onboarding/start`). The agent reads the sitemap, plans 30 days of content, runs a GEO audit and seeds AI-visibility prompts.
3. **Autopilot.** A scheduler runs every minute. It:
   - keeps 14 or more days planned
   - writes due articles within the plan's monthly quota
   - re-checks AI visibility weekly and the GEO audit monthly
4. **Each article:**
   - **Research:** web search for current facts and sources.
   - **Linking:** internal links from your sitemap and past posts, plus one contextual link to a relevant network partner.
   - **Writing:** brand-voice prompt with an answer-first intro, TL;DR, tables, cited statistics and an FAQ.
   - **Packaging:** meta description, slug, Article and FAQPage JSON-LD, SEO checks and a cover in your brand colours.
   - **Publishing:** goes to your WordPress, webhook or hosted blog. Partner backlinks go live when the article does.
5. **AI visibility.** Each tracked prompt is asked to ChatGPT, Claude, Gemini and Perplexity in parallel, each with live web search. Each answer is parsed for brands in order, your mention and position, and the cited sources. That produces mention rate, average position, share of voice, a per-engine breakdown and history.

## Safety

- **Fetching:** every outbound fetch is DNS-checked against private, loopback and reserved ranges on each redirect hop. Only ports 80 and 443 are allowed, with timeouts and size caps.
- **Secrets:** sessions are HttpOnly cookies storing a hashed token. Passwords use scrypt. Sign-in codes are hashed, expire after 10 minutes and allow 5 attempts.
- **Credentials and webhooks:** integration credentials are encrypted at rest. Webhooks are HMAC-signed. The Stripe webhook signature is verified.
- **Rate limits:** per-IP limits on public, auth and heavy endpoints.
- **Rendering:** article HTML comes only from the escaping Markdown renderer.

## Tests

- **Mock mode:** 62/62 end-to-end checks pass, covering the full API flow and four-engine visibility.
- **Real OpenRouter on budget models, one site** (Nov 2026):
  - **Onboarding and content:** a 13-item plan; a 1,734-word article with 6 FAQs, 12 sources, a table and statistics, auto-published with JSON-LD.
  - **AI visibility:** 4-engine tracking (20 answers); the public AI audit scored 75.
  - **Cost:** $0.11 in total.
  - **Not exercised:** the backlink exchange needs two sites and was verified only in mock mode.
# Baby_Growth
