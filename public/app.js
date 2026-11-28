/* GeoGrowth dashboard: a vanilla SPA over the /api contract. */
(function () {
  "use strict";
  const { toast } = window.GG;
  const $ = (s, r = document) => r.querySelector(s);
  const view = $("#view");
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || ""; } };
  const date = (d) => d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  const ago = (d) => { const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
  const pill = (s) => `<span class="pill-s ${esc(s)}">${esc(String(s).replace(/_/g, " "))}</span>`;

  let siteId = localStorage.getItem("gg_site");
  async function api(method, path, body) {
    const res = await fetch("/api" + path, { method, credentials: "same-origin", headers: { "content-type": "application/json", ...(siteId ? { "x-website-id": siteId } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = "sign-in.html"; throw new Error("Signed out"); }
    if (!res.ok) { const e = new Error(data.message || "Something went wrong."); e.code = data.code; throw e; }
    return data.data !== undefined ? data.data : data;
  }
  const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg, "ok"); return r; } catch (e) { toast(e.message); return null; } };

  /* ---------------- boot ---------------- */
  let me, sites = [];
  async function boot() {
    me = await api("GET", "/users/me");
    $("#whoami").textContent = me.email;
    const guestId = localStorage.getItem("gg_guest_id");
    if (guestId) { // a guest draft started before signing in: claim it
      const w = await act(() => api("POST", "/guest-onboarding/claim", { guestId }));
      localStorage.removeItem("gg_guest_id");
      if (w?.id) { siteId = w.id; localStorage.setItem("gg_site", siteId); await act(() => api("POST", "/onboarding/start")); }
    }
    await loadSites();
    route();
  }
  async function loadSites() {
    sites = await api("GET", "/organization/get-org-websites");
    if (!sites.find((s) => s.id === siteId)) siteId = sites[0]?.id || null;
    if (siteId) localStorage.setItem("gg_site", siteId);
    $("#siteSelect").innerHTML = sites.map((s) => `<option value="${s.id}" ${s.id === siteId ? "selected" : ""}>${esc(s.brandName || host(s.url))}</option>`).join("") + `<option value="__add">+ Add website</option>`;
  }
  $("#siteSelect").onchange = (e) => {
    if (e.target.value === "__add") { location.hash = "add-site"; e.target.value = siteId || ""; return; }
    siteId = e.target.value; localStorage.setItem("gg_site", siteId); route();
  };
  $("#logoutBtn").onclick = async () => { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); location.href = "sign-in.html"; };

  /* ---------------- router ---------------- */
  let poll;
  function route() {
    clearInterval(poll);
    const [name, arg] = location.hash.slice(1).split("/");
    const v = name || "overview";
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("is-on", a.dataset.view === v || (v === "article" && a.dataset.view === "articles")));
    if (!siteId && v !== "add-site" && v !== "account") return views["add-site"]();
    (views[v] || views.overview)(arg).catch((e) => { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  }
  addEventListener("hashchange", route);
  const head = (title, sub, actions = "") => `<div class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div><div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div></div>`;
  const refreshWhilePending = (check, ms = 4000) => { clearInterval(poll); poll = setInterval(async () => { if (await check()) route(); }, ms); };
  const pendingJobs = async () => (await api("GET", "/async-jobs")).filter((j) => j.status === "queued" || j.status === "running");

  const views = {};

  /* ---------------- overview ---------------- */
  views.overview = async () => {
    const [stats, checklist, acts, jobs] = await Promise.all([api("GET", "/organization/get-org-website-stats"), api("GET", "/overview/setup-checklist"), api("GET", "/overview/agent-activities"), pendingJobs()]);
    const site = sites.find((s) => s.id === siteId);
    const sub = stats.subscription;
    view.innerHTML = head(esc(site?.brandName || host(site?.url)), `<a href="${esc(site?.url)}" target="_blank" rel="noopener">${esc(host(site?.url))}</a>`) +
      (sub.status === "trialing" ? `<div class="banner"><span>Your free trial ends ${date(sub.trialEndsAt)}. ${stats.usage.articlesThisMonth}/${stats.usage.articlesPerMonth} trial articles used.</span><a class="btn btn--accent btn-xs" href="#billing">Choose a plan</a></div>` :
        !sub.active ? `<div class="banner"><span>Your plan is inactive, so autopilot is paused.</span><a class="btn btn--accent btn-xs" href="#billing">Reactivate</a></div>` : "") +
      (jobs.length ? `<div class="banner"><span>Your growth agent is working: ${jobs.map((j) => esc(j.type.replace(/[._]/g, " "))).join(", ")}...</span></div>` : "") +
      `<div class="grid grid--4">
        <div class="card stat"><b>${stats.published}</b><span>Articles published</span></div>
        <div class="card stat"><b>${stats.planned}</b><span>Articles planned</span></div>
        <div class="card stat"><b>${stats.aiMentionRate ?? "–"}${stats.aiMentionRate != null ? "%" : ""}</b><span>AI mention rate (30d)</span></div>
        <div class="card stat"><b>${stats.geoScore ?? "–"}</b><span>GEO audit score</span></div>
      </div>
      <div class="grid grid--2" style="margin-top:16px">
        <div class="card"><h3>Agent activity</h3><div class="list">${acts.map((a) => `<div class="row"><div class="row__main"><b style="white-space:normal">${esc(a.message)}</b><small>${ago(a.createdAt)}</small></div></div>`).join("") || `<div class="empty">No activity yet.</div>`}</div></div>
        <div class="card"><h3>Setup checklist <small style="color:var(--muted);font-weight:500">${checklist.completed}/${checklist.total}</small></h3>${checklist.items.map((i) => `<div class="check-li ${i.done ? "done" : ""}"><i>${i.done ? "&#10003;" : ""}</i><span>${esc(i.label)}</span></div>`).join("")}
          <div class="kv2" style="margin-top:14px"><span>Backlinks received <b>${stats.backlinksReceived}</b></span><span>Live backlinks <b>${stats.backlinksLive}</b></span></div></div>
      </div>`;
    if (jobs.length) refreshWhilePending(async () => !(await pendingJobs()).length, 5000);
  };

  /* ---------------- content plan ---------------- */
  views.plan = async () => {
    const items = await api("GET", "/content-plan");
    const jobs = await pendingJobs();
    view.innerHTML = head("Content plan", "Your agent writes these on schedule. Edit, skip or write any of them now.",
      `<button class="btn btn--ghost btn-xs" data-act="plan-more">Plan 30 more days</button>`) +
      `<form class="card" id="addTopic" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px"><input name="title" placeholder="Article title" style="flex:2;min-width:220px;border:1px solid var(--line);border-radius:10px;padding:9px 12px;font:inherit"><input name="keyword" placeholder="Primary keyword" style="flex:1;min-width:160px;border:1px solid var(--line);border-radius:10px;padding:9px 12px;font:inherit"><button class="btn btn--dark btn-xs">Add topic</button></form>` +
      `<div class="card"><div class="list">${items.map((i) => `<div class="row" data-id="${i.id}">
        <div style="width:92px;font-size:13px;color:var(--muted)">${date(i.scheduledFor)}</div>
        <div class="row__main"><b data-title>${esc(i.title)}</b><small>${esc(i.keyword)} · ${esc(i.articleType || "")} · ${esc(i.searchIntent || "")}</small></div>
        ${pill(i.status)}
        ${i.status === "planned" || i.status === "failed" ? `<button class="btn btn--ghost btn-xs" data-act="plan-edit">Edit</button><button class="btn btn--accent btn-xs" data-act="plan-write">Write now</button><button class="btn btn--ghost btn-xs" data-act="plan-skip">Skip</button>` : ""}
        ${i.articleId ? `<a class="btn btn--ghost btn-xs" href="#article/${i.articleId}">Open</a>` : ""}
      </div>`).join("") || `<div class="empty">${jobs.length ? "Your agent is building the plan..." : "No plan yet."}</div>`}</div></div>`;
    $("#addTopic").onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); if (await act(() => api("POST", "/content-plan", { title: f.get("title"), keyword: f.get("keyword") }), "Topic added.")) route(); };
    if (jobs.length || items.some((i) => i.status === "generating")) refreshWhilePending(async () => !(await pendingJobs()).length);
  };

  /* ---------------- articles ---------------- */
  views.articles = async () => {
    const list = await api("GET", "/articles");
    view.innerHTML = head("Articles", "Every article is optimized for Google and AI search before it goes live.") +
      `<div class="card"><div class="list">${list.map((a) => `<div class="row"><img src="${a.coverUrl}" alt="" style="width:84px;height:44px;object-fit:cover;border-radius:8px"><div class="row__main"><b><a href="#article/${a.id}">${esc(a.title)}</a></b><small>${a.wordCount} words · ${esc(a.keyword)} · ${date(a.createdAt)}</small></div>${pill(a.status)}${a.publishedUrl ? `<a class="btn btn--ghost btn-xs" href="${esc(a.publishedUrl)}" target="_blank" rel="noopener">View live</a>` : ""}</div>`).join("") || `<div class="empty">No articles yet. Pick a topic in your <a href="#plan">content plan</a> and click "Write now".</div>`}</div></div>`;
  };

  views.article = async (id) => {
    const a = await api("GET", "/articles/" + id);
    const c = a.checks || {};
    const yes = (v) => v === true ? pill("yes") : v === false ? pill("no") : esc(v ?? "–");
    view.innerHTML = head(esc(a.title), `${pill(a.status)} ${a.publishedUrl ? `<a href="${esc(a.publishedUrl)}" target="_blank" rel="noopener">${esc(a.publishedUrl)}</a>` : ""}`,
      `<a class="btn btn--ghost btn-xs" href="/api/articles/${a.id}/export-html?websiteId=${siteId}">Export HTML</a>
       <button class="btn btn--ghost btn-xs" data-act="art-regen" data-id="${a.id}">Regenerate</button>
       <button class="btn btn--ghost btn-xs" data-act="art-delete" data-id="${a.id}">Delete</button>
       <button class="btn btn--accent btn-xs" data-act="art-publish" data-id="${a.id}">${a.status === "published" ? "Republish" : "Publish"}</button>`) +
      `<div class="card" style="margin-bottom:16px"><div class="field" style="margin:0"><label>Meta description <small style="color:var(--muted)">(${(a.metaDescription || "").length} chars)</small></label><input id="metaInput" value="${esc(a.metaDescription)}"></div></div>
      <div class="card" style="margin-bottom:16px"><h3>SEO &amp; AI-search checks</h3><div class="kv2">
        <span>Word count <b>${c.wordCount ?? "–"}</b></span><span>Answer-first intro ${yes(c.answerFirst)}</span>
        <span>Keyword in title ${yes(c.keywordInTitle)}</span><span>Keyword in intro ${yes(c.keywordInIntro)}</span>
        <span>TL;DR section ${yes(c.hasTldr)}</span><span>FAQ questions <b>${c.faqCount ?? 0}</b></span>
        <span>Headings <b>${c.headings ?? 0}</b></span><span>Comparison table ${yes(c.hasTable)}</span>
        <span>Statistics ${yes(c.hasStatistics)}</span><span>Internal links <b>${c.internalLinks ?? 0}</b></span>
        <span>External sources <b>${c.externalLinks ?? 0}</b></span><span>JSON-LD (Article + FAQ) ${yes(c.jsonLd)}</span>
      </div></div>
      <div class="editor"><div><textarea id="mdInput" spellcheck="true">${esc(a.markdown)}</textarea><div style="margin-top:10px;display:flex;gap:8px"><button class="btn btn--dark btn-xs" data-act="art-save" data-id="${a.id}">Save changes</button></div></div>
      <div class="prose" id="preview">${a.html}</div></div>`;
  };

  /* ---------------- visibility ---------------- */
  views.visibility = async () => {
    const [ins, prompts, brands, sources, hist, allow] = await Promise.all([api("GET", "/llm-visibility/overall-insights"), api("GET", "/llm-visibility/prompts"), api("GET", "/llm-visibility/brands-mentioned"), api("GET", "/llm-visibility/top-sources"), api("GET", "/llm-visibility/history"), api("GET", "/llm-visibility/prompt-allowance")]);
    const site = sites.find((s) => s.id === siteId);
    const pct = (v) => v == null ? "–" : v + "%";
    const winners = (ins.topCompetitors || []).slice(0, 3).map((b) => `<b>${esc(b.name)}</b>`).join(", ");
    let notice = "";
    if (!site?.description) notice = `<div class="banner"><span>Your business profile has no description yet, so we can't know which buyer questions to track. Add one and tracking starts automatically.</span><a class="btn btn--accent btn-xs" href="#settings">Complete profile</a></div>`;
    else if (ins.pending) notice = `<div class="banner"><span>Checking ChatGPT, Claude, Gemini and Perplexity now. Results appear here as each prompt finishes.</span></div>`;
    else if (ins.discoveryRuns > 0 && ins.mentionRate === 0)
      notice = `<div class="banner" style="display:block"><b>AI search doesn't recommend ${esc(ins.brand)} for these buyer questions yet.</b> That is a real result from ${ins.discoveryRuns} live answers, not missing data.
        ${winners ? `It recommends ${winners} instead.` : ""} ${ins.brandAwareness === 0 ? `It also didn't recognise your brand when asked about it directly, so check that your <a href="#settings">business profile</a> matches your website.` : ins.brandAwareness ? `When asked about you directly, AI knows you (${ins.brandAwareness}% of answers), so the gap is discovery.` : ""}
        Open a prompt below to read each answer, then click <b>Create content</b> to plan an article that targets it.</div>`;
    view.innerHTML = head("AI visibility", `How often AI search recommends ${esc(ins.brand)} when buyers ask unbranded questions. Engines: ${ins.engines.map(esc).join(", ")}.`, `<button class="btn btn--accent btn-xs" data-act="vis-run" ${ins.pending ? "disabled" : ""}>${ins.pending ? "Checking..." : "Run checks now"}</button>`) + notice +
      `<div class="grid grid--4">
        <div class="card stat"><b>${ins.discoveryRuns ? ins.mentionRate + "%" : "–"}</b><span>Mention rate (30d, unbranded questions)</span></div>
        <div class="card stat"><b>${ins.averagePosition ? "#" + ins.averagePosition : "–"}</b><span>Average position when mentioned</span></div>
        <div class="card stat"><b>${ins.discoveryRuns ? ins.shareOfVoice + "%" : "–"}</b><span>Share of voice vs competitors</span></div>
        <div class="card stat"><b>${pct(ins.brandAwareness)}</b><span>Brand awareness (asked about you)</span></div>
      </div>
      <div class="card" style="margin-top:16px"><h3>By AI engine <small style="color:var(--muted);font-weight:500">${ins.runs} answers checked</small></h3><div class="grid grid--4">${(ins.byEngine || []).map((e) => `<div class="stat"><b>${pct(e.mentionRate)}</b><span>${esc(e.label)}${e.averagePosition ? ` · avg #${e.averagePosition}` : ""} · ${e.runs} answers</span></div>`).join("")}</div></div>
      <div class="card" style="margin-top:16px"><h3>Mention rate over time</h3>${hist.length ? `<div class="bar-chart">${hist.map((h) => `<span title="${esc(h.date)}: ${h.mentionRate}% of ${h.runs} answers" style="height:${Math.max(2, h.mentionRate)}%"><i style="position:absolute;top:-18px;left:0;right:0;text-align:center;font-style:normal;font-size:11px;color:var(--muted)">${h.mentionRate}%</i></span>`).join("")}</div><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:6px"><span>${esc(hist[0].date)}</span><span>${esc(hist[hist.length - 1].date)}</span></div>` : `<div class="empty">No data yet.</div>`}</div>
      <div class="grid grid--2" style="margin-top:16px">
        <div class="card"><h3>Tracked prompts <small style="color:var(--muted);font-weight:500">${allow.used}/${allow.limit}</small></h3>
          <form id="addPrompt" style="display:flex;gap:8px;margin-bottom:8px"><input name="prompt" placeholder="e.g. What is the best CRM for small agencies?" style="flex:1;border:1px solid var(--line);border-radius:10px;padding:9px 12px;font:inherit"><button class="btn btn--dark btn-xs" ${allow.remaining <= 0 ? "disabled title='Prompt limit reached'" : ""}>Track</button></form>
          <div class="list">${prompts.map((p) => `<div class="row" data-id="${p.id}" style="flex-wrap:wrap"><div class="row__main" style="cursor:pointer" data-act="vis-open"><b style="white-space:normal">${p.kind === "brand" ? `<span class="pill-s planned" style="margin-right:6px">Brand</span>` : ""}${esc(p.prompt)}</b><small>${p.lastRunAt ? "Checked " + ago(p.lastRunAt) : "Not checked yet"}${p.mentionRate != null ? ` · mentioned ${p.mentionRate}% of the time` : ""} · <u>see answers</u></small></div><span title="${esc((p.engines || []).map((e) => `${e.label}: ${e.mentioned ? (e.position ? "#" + e.position : "mentioned") : "not mentioned"}`).join(" | "))}">${p.lastMentioned == null ? pill("queued") : `<span class="pill-s ${p.mentionedBy ? "yes" : "no"}">${p.mentionedBy}/${p.enginesChecked} engines</span>`}</span>${p.lastMentioned === false && p.kind !== "brand" ? `<button class="btn btn--accent btn-xs" data-act="vis-content">Create content</button>` : ""}<button class="btn btn--ghost btn-xs" data-act="vis-del">Remove</button><div class="vis-detail" style="flex-basis:100%"></div></div>`).join("") || `<div class="empty">No prompts yet.</div>`}</div></div>
        <div class="grid">
          <div class="card"><h3>Brands AI recommends</h3>${brands.slice(0, 10).map((b) => `<div class="row"><div class="row__main"><b>${esc(b.name)}${b.isYou ? " (you)" : ""}</b>${b.domain ? `<small>${esc(b.domain)}</small>` : ""}</div><span>${b.mentions} answers</span></div>`).join("") || `<div class="empty">No data yet.</div>`}</div>
          <div class="card"><h3>Most-cited sources <small style="color:var(--muted);font-weight:500">get featured here</small></h3>${sources.slice(0, 10).map((s) => `<div class="row"><div class="row__main"><b><a href="${esc(s.exampleUrl)}" target="_blank" rel="noopener">${esc(s.domain)}</a></b></div><span>${s.citations}</span></div>`).join("") || `<div class="empty">No data yet.</div>`}</div>
        </div>
      </div>`;
    $("#addPrompt").onsubmit = async (e) => { e.preventDefault(); if (await act(() => api("POST", "/llm-visibility/prompts", { prompt: new FormData(e.target).get("prompt") }), "Prompt added. Checking now...")) route(); };
    if (ins.pending || prompts.some((p) => p.lastMentioned == null)) refreshWhilePending(async () => !(await api("GET", "/llm-visibility/overall-insights")).pending, 6000);
  };

  async function openPromptDetail(row, id) {
    const box = row.querySelector(".vis-detail");
    if (box.innerHTML) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="empty">Loading answers...</div>`;
    const p = await api("GET", "/llm-visibility/prompts/" + id);
    const latest = new Map(); for (const r of p.runs) if (!latest.has(r.engine)) latest.set(r.engine, r);
    const label = (k) => ({ chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", perplexity: "Perplexity" })[k] || k;
    box.innerHTML = [...latest.values()].map((r) => `<details style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-top:8px;background:#fff">
      <summary style="cursor:pointer;font-size:13.5px"><b>${esc(label(r.engine))}</b> · ${r.mentioned ? `<span style="color:#1f8a4c">mentioned${r.position ? " #" + r.position : ""}</span>` : `<span style="color:#c2341a">not mentioned</span>`} · recommends ${r.brands.slice(0, 4).map((b) => esc(b.name)).join(", ") || "no brands"}</summary>
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.55;margin-top:8px;max-height:280px;overflow:auto">${esc(r.answer).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")}</div>
      ${r.sources.length ? `<div style="font-size:12px;margin-top:8px;color:var(--muted)">Sources: ${r.sources.slice(0, 6).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(host(s.url))}</a>`).join(" · ")}</div>` : ""}
    </details>`).join("") || `<div class="empty">No answers yet.</div>`;
  }

  /* ---------------- GEO audit ---------------- */
  views.audit = async () => {
    const a = await api("GET", "/geo-audit/data");
    const running = a && !a.isCompleted && a.status === "processing";
    view.innerHTML = head("GEO audit", "Can AI search engines crawl, understand and cite your site?",
      `${a?.isCompleted ? `<button class="btn btn--ghost btn-xs" data-act="audit-share">Copy share link</button>` : ""}<button class="btn btn--accent btn-xs" data-act="audit-run" ${running ? "disabled" : ""}>${running ? "Running..." : "Run audit"}</button>`) +
      (!a ? `<div class="card empty">No audit yet. Click "Run audit".</div>` : a.status === "failed" ? `<div class="card empty">The last audit failed: ${esc(a.error)}</div>` : !a.isCompleted ? `<div class="card empty">Auditing ${esc(host(a.url))}...</div>` :
      `<div class="grid grid--4"><div class="card stat"><b>${a.score}/100</b><span>Score</span></div>${Object.entries(a.categories || {}).slice(0, 3).map(([k, v]) => `<div class="card stat"><b>${v.passed}/${v.total}</b><span>${esc(k.replace(/_/g, " "))}</span></div>`).join("")}</div>
       <div class="card" style="margin-top:16px"><h3>Checks <small style="color:var(--muted);font-weight:500">${date(a.createdAt)}</small></h3>${a.checks.map((c) => `<div class="row"><span style="font-weight:700;color:${c.pass ? "#1f8a4c" : "#c2341a"}">${c.pass ? "&#10003;" : "&#10005;"}</span><div class="row__main"><b>${esc(c.label)}</b><small>${esc(c.detail)}${c.pass ? "" : " Fix: " + esc(c.fix)}</small></div>${pill(c.category)}</div>`).join("")}</div>`);
    if (running) refreshWhilePending(async () => (await api("GET", "/geo-audit/data"))?.isCompleted !== false);
  };

  /* ---------------- backlinks ---------------- */
  views.backlinks = async () => {
    const [bl, pool, slots] = await Promise.all([api("GET", "/backlinks"), api("GET", "/backlinks/exchange-pool"), api("GET", "/backlinks/credit-slots-availability")]);
    const site = sites.find((s) => s.id === siteId);
    view.innerHTML = head("Backlinks", "Contextual links from relevant sites in the exchange network, placed inside real articles.",
      `<button class="btn btn--${site?.inBacklinkPool ? "ghost" : "accent"} btn-xs" data-act="pool-toggle">${site?.inBacklinkPool ? "Leave network" : "Join network"}</button>`) +
      `<div class="grid grid--4"><div class="card stat"><b>${bl.totals.received}</b><span>Backlinks received</span></div><div class="card stat"><b>${bl.totals.live}</b><span>Live</span></div><div class="card stat"><b>${slots.available}/${slots.monthlyLimit}</b><span>Slots left this month</span></div><div class="card stat"><b>${pool.sites}</b><span>Sites in network</span></div></div>
      <div class="grid grid--2" style="margin-top:16px">
        <div class="card"><h3>Received</h3>${bl.received.map((b) => `<div class="row"><div class="row__main"><b>${esc(b.sourceTitle || b.sourceSite)}</b><small>${esc(b.sourceSite)} → anchor "${esc(b.anchor)}"</small></div>${pill(b.status)}${b.sourceUrl ? `<a class="btn btn--ghost btn-xs" href="${esc(b.sourceUrl)}" target="_blank" rel="noopener">View</a>` : ""}</div>`).join("") || `<div class="empty">No backlinks yet. They arrive as other sites in the network publish.</div>`}</div>
        <div class="card"><h3>Given</h3>${bl.given.map((b) => `<div class="row"><div class="row__main"><b>${esc(b.targetSite)}</b><small>anchor "${esc(b.anchor)}"</small></div>${pill(b.status)}</div>`).join("") || `<div class="empty">None yet.</div>`}</div>
      </div>`;
  };

  /* ---------------- integrations ---------------- */
  views.integrations = async () => {
    const list = await api("GET", "/integrations");
    const active = list.find((i) => i.status === "active");
    view.innerHTML = head("Publishing", "Where your articles go live. One active destination at a time.") +
      `<div class="card" style="margin-bottom:16px"><h3>Current destination</h3>${active ? `<div class="row"><div class="row__main"><b>${esc(active.type)}</b><small>${esc(active.config.siteUrl || active.config.url || active.config.blogUrl || "")}${active.lastError ? " · last error: " + esc(active.lastError) : ""}</small></div>${pill(active.status)}<button class="btn btn--ghost btn-xs" data-act="int-del" data-id="${active.id}">Disconnect</button></div>` : `<div class="empty">Not connected. Articles stay as drafts until you connect a destination.</div>`}</div>
      <div class="grid grid--2">
        <form class="card form" id="wpForm"><h3>WordPress</h3>
          <div class="field"><label>Site URL</label><input name="siteUrl" placeholder="https://yourblog.com"></div>
          <div class="field"><label>Username</label><input name="username"></div>
          <div class="field"><label>Application password <small style="color:var(--muted)">(Users → Profile → Application Passwords)</small></label><input name="applicationPassword" type="password"></div>
          <div class="field"><label>Post status</label><select name="postStatus"><option value="publish">Publish immediately</option><option value="draft">Save as draft</option></select></div>
          <button class="btn btn--dark btn-xs">Connect WordPress</button></form>
        <div class="grid">
          <form class="card form" id="hookForm"><h3>Webhook (any stack)</h3><p style="font-size:13.5px;color:var(--muted)">We POST each article as JSON, signed with HMAC-SHA256 in <code>x-geogrowth-signature</code>. Return <code>{"url": "..."}</code> to record the live URL.</p>
            <div class="field"><label>HTTPS endpoint</label><input name="url" placeholder="https://yoursite.com/api/geogrowth"></div><button class="btn btn--dark btn-xs">Connect webhook</button><div id="hookSecret"></div></form>
          <div class="card"><h3>Hosted blog</h3><p style="font-size:13.5px;color:var(--muted);margin-bottom:12px">No setup: we host your articles with full SEO markup.</p><button class="btn btn--dark btn-xs" data-act="int-hosted">Use hosted blog</button></div>
        </div>
      </div>`;
    $("#wpForm").onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); if (await act(() => api("POST", "/integrations", { type: "wordpress", config: f }), "WordPress connected.")) route(); };
    $("#hookForm").onsubmit = async (e) => { e.preventDefault(); const r = await act(() => api("POST", "/integrations", { type: "webhook", config: { url: new FormData(e.target).get("url") } }), "Webhook connected."); if (r) $("#hookSecret").innerHTML = `<p style="font-size:13px;margin-top:10px">Signing secret (shown once):</p><div class="code-box">${esc(r.config.secret)}</div>`; };
  };

  /* ---------------- settings (business profile) ---------------- */
  views.settings = async () => {
    const w = await api("GET", "/organization/business-profile");
    const f = (k, label, v, ph = "") => `<div class="field"><label>${label}</label><input name="${k}" value="${esc(v)}" placeholder="${esc(ph)}"></div>`;
    view.innerHTML = head("Business profile", "Your agent uses this to plan, write and track. Keep it accurate.", `<button class="btn btn--ghost btn-xs" data-act="brand-analysis">Re-analyze my website</button>`) +
      `<form class="card form" id="profileForm" style="max-width:none">
        <div class="grid grid--2" style="grid-template-columns:1fr 1fr">${f("brandName", "Brand name", w.brandName)}${f("industry", "Industry", w.industry)}</div>
        <div class="field"><label>What you offer</label><textarea name="description" rows="3">${esc(w.description)}</textarea></div>
        <div class="grid grid--2" style="grid-template-columns:1fr 1fr">${f("targetAudience", "Target audience (separate with ;)", (w.targetAudience || []).join("; "))}${f("mainServices", "Products/services (separate with ;)", (w.mainServices || []).join("; "))}</div>
        <div class="grid grid--2" style="grid-template-columns:1fr 1fr">${f("targetLocations", "Target locations (separate with ;)", (w.targetLocations || []).join("; "), "Global")}${f("voice", "Tone of voice (separate with ;)", (w.voice || []).join("; "))}</div>
        <div class="grid grid--2" style="grid-template-columns:1fr 1fr 1fr 1fr">${f("selectedLanguage", "Language code", w.selectedLanguage, "en")}${f("brandColor", "Brand colour", w.brandColor, "#f25533")}${f("brandSecondaryColor", "Secondary colour", w.brandSecondaryColor)}${f("articlesPerWeek", "Articles per week", w.articlesPerWeek)}</div>
        ${f("exampleArticleUrl", "Example article URL (to match your writing style)", w.exampleArticleUrl, "https://...")}
        ${f("competitors", "Competitors (separate with ;)", (w.competitors || []).join("; "))}
        <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" name="autopilot" ${w.autopilot ? "checked" : ""}> Autopilot: write and publish on schedule</label>
        <div><button class="btn btn--dark btn-xs">Save profile</button></div>
      </form>`;
    $("#profileForm").onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const arr = (s) => String(s || "").split(";").map((x) => x.trim()).filter(Boolean);
      const body = { ...d, targetAudience: arr(d.targetAudience), mainServices: arr(d.mainServices), targetLocations: arr(d.targetLocations), voice: arr(d.voice), competitors: arr(d.competitors), autopilot: !!d.autopilot, articlesPerWeek: Number(d.articlesPerWeek) || 0 };
      if (await act(() => api("PUT", "/organization/business-profile", body), "Profile saved.")) { await loadSites(); }
    };
  };

  /* ---------------- billing ---------------- */
  views.billing = async () => {
    const [s, inv] = await Promise.all([api("GET", "/subscriptions/get-org-website-subscription"), api("GET", "/subscriptions/invoices")]);
    const planCard = (key) => { const p = s.plans[key]; const current = s.plan === key && s.status === "active"; return `<div class="card"><h3>${esc(p.name)} <b style="font-family:var(--font-head);font-size:22px">$${p.price}<small style="font-size:13px;color:var(--muted)">/mo</small></b></h3><div class="kv2" style="grid-template-columns:1fr"><span>Websites <b>${p.websites}</b></span><span>Articles per month <b>${p.articlesPerMonth}</b></span><span>AI prompts tracked <b>${p.prompts}</b></span><span>Backlink network <b>Included</b></span></div><div style="margin-top:14px">${current ? pill("active") : `<button class="btn btn--accent btn-xs" data-act="checkout" data-plan="${key}">Choose ${esc(p.name)}</button>`}</div></div>`; };
    view.innerHTML = head("Billing", `Status: ${pill(s.status)} ${s.trialEndsAt && s.status === "trialing" ? "· trial ends " + date(s.trialEndsAt) : ""}`, s.hasBilling ? `<button class="btn btn--ghost btn-xs" data-act="portal">Manage billing</button>` : "") +
      `<div class="grid grid--2" style="grid-template-columns:1fr 1fr">${planCard("grow")}${planCard("scale")}</div>
       <div class="card" style="margin-top:16px"><h3>Usage this month</h3><div class="kv2"><span>Articles <b>${s.usage.articlesThisMonth}/${s.limits.articlesPerMonth}</b></span><span>Prompt limit <b>${s.limits.prompts}</b></span></div></div>
       <div class="card" style="margin-top:16px"><h3>Invoices</h3>${inv.map((i) => `<div class="row"><div class="row__main"><b>${esc(i.number || i.id)}</b><small>${date(i.createdAt)}</small></div><span>${i.total} ${esc(i.currency.toUpperCase())}</span>${pill(i.status)}${i.url ? `<a class="btn btn--ghost btn-xs" href="${esc(i.url)}" target="_blank" rel="noopener">View</a>` : ""}</div>`).join("") || `<div class="empty">No invoices yet.</div>`}</div>`;
  };

  /* ---------------- team & API ---------------- */
  views.account = async () => {
    const org = await api("GET", "/organization");
    view.innerHTML = head("Team & API", esc(org.name)) +
      `<div class="grid grid--2">
        <div class="card"><h3>Members</h3>${org.members.map((m) => `<div class="row"><div class="row__main"><b>${esc(m.name || m.email)}</b><small>${esc(m.email)}</small></div>${pill(m.role)}</div>`).join("")}
          <form id="inviteForm" style="display:flex;gap:8px;margin-top:12px"><input name="email" type="email" placeholder="teammate@company.com" style="flex:1;border:1px solid var(--line);border-radius:10px;padding:9px 12px;font:inherit"><button class="btn btn--dark btn-xs">Invite</button></form></div>
        <div class="card"><h3>API key</h3><p style="font-size:13.5px;color:var(--muted);margin-bottom:12px">Use <code>x-api-key</code> to call the API from your own tools.${org.apiKeyHint ? ` Current key ends in <b>${esc(org.apiKeyHint)}</b>.` : ""}</p><button class="btn btn--dark btn-xs" data-act="apikey">${org.apiKeyHint ? "Rotate key" : "Generate key"}</button><div id="keyBox" style="margin-top:10px"></div></div>
      </div>`;
    $("#inviteForm").onsubmit = async (e) => { e.preventDefault(); if (await act(() => api("POST", "/organization/invite-member", { email: new FormData(e.target).get("email") }), "Invitation sent.")) route(); };
  };

  /* ---------------- add website ---------------- */
  views["add-site"] = async () => {
    view.innerHTML = head("Add a website", "We'll analyze it, build a content plan and start tracking AI visibility.") +
      `<form class="card form" id="siteForm"><div class="field"><label>Website URL</label><input name="url" placeholder="yourwebsite.com"></div><button class="btn btn--accent btn-xs">Add website</button></form>`;
    $("#siteForm").onsubmit = async (e) => {
      e.preventDefault();
      const w = await act(() => api("POST", "/organization/create-org-website", { url: new FormData(e.target).get("url") }), "Website added. Analyzing...");
      if (!w) return;
      siteId = w.id; localStorage.setItem("gg_site", siteId);
      await act(() => api("POST", "/onboarding/start"));
      await loadSites(); location.hash = "overview";
    };
  };

  /* ---------------- actions ---------------- */
  view.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const row = b.closest("[data-id]"); const id = b.dataset.id || row?.dataset.id;
    const a = b.dataset.act;
    b.disabled = true;
    try {
      if (a === "plan-write") { if (await act(() => api("POST", `/content-plan/${id}/generate`), "Writing your article. This takes a minute or two.")) route(); }
      else if (a === "plan-skip") { if (await act(() => api("DELETE", `/content-plan/${id}`))) row.remove(); }
      else if (a === "plan-more") { if (await act(() => api("POST", "/content-plan/generate", { days: 30 }), "Planning 30 more days...")) route(); }
      else if (a === "plan-edit") {
        const t = row.querySelector("[data-title]");
        if (row.querySelector("input")) return;
        t.innerHTML = `<input value="${esc(t.textContent)}" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit">`;
        b.textContent = "Save"; b.dataset.act = "plan-save";
      } else if (a === "plan-save") { if (await act(() => api("PUT", `/content-plan/${id}`, { title: row.querySelector("input").value }), "Saved.")) route(); }
      else if (a === "art-save") {
        const r = await act(() => api("PUT", "/articles/" + id, { markdown: $("#mdInput").value, metaDescription: $("#metaInput").value }), "Saved.");
        if (r) $("#preview").innerHTML = r.html;
      } else if (a === "art-publish") { if (await act(() => api("POST", `/articles/${id}/publish`), "Published.")) route(); }
      else if (a === "art-regen") { if (await act(() => api("POST", `/articles/${id}/regenerate`), "Regenerating...")) location.hash = "plan"; }
      else if (a === "art-delete") { if (b.dataset.confirm) { if (await act(() => api("DELETE", "/articles/" + id), "Deleted.")) location.hash = "articles"; } else { b.dataset.confirm = "1"; b.textContent = "Click again to delete"; } }
      else if (a === "vis-run") { const r = await act(() => api("POST", "/llm-visibility/run"), "Checking AI search now..."); if (r) route(); }
      else if (a === "vis-open") { await act(() => openPromptDetail(row, id)); }
      else if (a === "vis-content") { const r = await act(() => api("POST", `/llm-visibility/prompts/${id}/create-content`)); if (r) toast(`Planned "${r.title}" for ${date(r.scheduledFor)}. See Content plan.`, "ok", 6000); }
      else if (a === "vis-del") { if (await act(() => api("DELETE", "/llm-visibility/prompts/" + id))) row.remove(); }
      else if (a === "audit-run") { if (await act(() => api("POST", "/geo-audit/start"), "Audit started.")) route(); }
      else if (a === "audit-share") { const r = await act(() => api("POST", "/geo-audit/share-link")); if (r) { const url = location.origin + "/api/geo-audit/public/share/" + r.shareToken; await navigator.clipboard?.writeText(url).catch(() => {}); toast("Share link copied: " + url, "ok", 6000); } }
      else if (a === "pool-toggle") { const site = sites.find((s) => s.id === siteId); if (await act(() => api("PUT", "/organization/update-org-website", { inBacklinkPool: !site.inBacklinkPool }), "Updated.")) { await loadSites(); route(); } }
      else if (a === "int-del") { if (await act(() => api("DELETE", "/integrations/" + id), "Disconnected.")) route(); }
      else if (a === "int-hosted") { if (await act(() => api("POST", "/integrations", { type: "hosted" }), "Hosted blog enabled.")) route(); }
      else if (a === "brand-analysis") { await act(() => api("POST", "/organization/run-brand-analysis", { overwrite: false }), "Re-analyzing your website. Empty fields will be filled."); }
      else if (a === "checkout") { const r = await act(() => api("POST", "/subscriptions/create-customer-checkout", { plan: b.dataset.plan })); if (r?.url) location.href = r.url; }
      else if (a === "portal") { const r = await act(() => api("POST", "/subscriptions/create-portal-session")); if (r?.url) location.href = r.url; }
      else if (a === "apikey") { const r = await act(() => api("POST", "/organization/generate-api-key")); if (r) $("#keyBox").innerHTML = `<p style="font-size:13px">Copy it now. It won't be shown again.</p><div class="code-box">${esc(r.apiKey)}</div>`; }
    } finally { b.disabled = false; }
  });

  boot().catch(() => {});
})();
