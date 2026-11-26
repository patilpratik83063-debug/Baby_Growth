/* GeoGrowth landing page behaviour. */
(function () {
  "use strict";
  const { mountBgGrid, bindUrlForm, toast, trackCta } = window.GG;
  const $ = (s, r = document) => r.querySelector(s);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Hero tile background */
  mountBgGrid($("#bgGrid"));

  /* Header border on scroll + mobile menu */
  const header = $("#header");
  const burger = $("#burger");
  const mobileNav = $("#mobileNav");
  burger.addEventListener("click", () => {
    const open = mobileNav.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", String(open));
  });
  mobileNav.addEventListener("click", (e) => { if (e.target.tagName === "A") mobileNav.classList.remove("is-open"); });

  /* Sticky mobile CTA: reference shows it when scrollY > 600 and hides it near the bottom. */
  const sticky = $("#stickyCta");
  const onScroll = () => {
    header.classList.toggle("is-scrolled", scrollY > 4);
    const nearBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 400;
    sticky.classList.toggle("is-on", scrollY > 600 && !nearBottom);
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* Rotating AI engine every 3s with a blur-in remount (reference: RotatingPlatformLogo). */
  const ENGINES = [
    { name: "Gemini", icon: "e-gemini", color: "#4f7cf3" },
    { name: "ChatGPT", icon: "e-chatgpt", color: "#171717" },
    { name: "Claude", icon: "e-claude", color: "#d97757" },
    { name: "Perplexity", icon: "e-perplexity", color: "#20808d" },
    { name: "Google", icon: "e-google", color: "#4285f4" },
  ];
  const engine = $("#engine");
  const engineName = $("#engineName");
  const engineUse = engine.querySelector("use");
  const rankEngine = $("#rankEngine");
  let ei = 0;
  const paintEngine = () => {
    const e = ENGINES[ei];
    engineName.textContent = e.name;
    engineUse.setAttribute("href", "#" + e.icon);
    engine.style.color = e.color;
    engine.classList.remove("is-in"); void engine.offsetWidth; engine.classList.add("is-in");
    rankEngine.textContent = e.name;
    rankEngine.style.animation = "none"; void rankEngine.offsetWidth; rankEngine.style.animation = "";
  };
  paintEngine();
  if (!reduceMotion) setInterval(() => { ei = (ei + 1) % ENGINES.length; paintEngine(); }, 3000);

  /* CTA tracking on every [data-cta] link */
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-cta]");
    if (a) trackCta(a.dataset.cta, a.getAttribute("href"));
  });

  /* Hero + final URL forms -> guest onboarding with the website prefilled. */
  const toOnboarding = (where) => (origin) => {
    trackCta(where, "onboarding");
    location.href = "onboarding.html?website=" + encodeURIComponent(origin);
  };
  bindUrlForm($("#heroForm"), toOnboarding("hero"));
  bindUrlForm($("#finalForm"), toOnboarding("final"));

  /* ---------------- Free AI search audit ----------------
     Reference: POST mutation -> full-screen loading state; 429 -> rate-limit toast;
     other errors -> server message or generic failure. */
  const overlay = $("#auditOverlay");
  const steps = [...document.querySelectorAll("#auditSteps li")];
  const progress = $("#auditProgress");
  let stepTimer;

  function runSteps() {
    let i = 0;
    steps.forEach((s) => s.classList.remove("is-active", "is-done"));
    const tick = () => {
      if (i > 0) steps[i - 1].classList.replace("is-active", "is-done");
      if (i < steps.length - 1) { steps[i].classList.add("is-active"); progress.style.width = ((i + 1) / (steps.length + 1)) * 100 + "%"; i++; stepTimer = setTimeout(tick, 900); }
      else if (i === steps.length - 1) { steps[i].classList.add("is-active"); progress.style.width = "92%"; }
    };
    tick();
  }

  function openOverlay(origin) {
    $("#auditSite").textContent = origin.replace(/^https?:\/\//, "");
    $("#auditRunning").style.display = "";
    $("#auditReport").classList.remove("is-on");
    overlay.classList.add("is-on");
    document.body.style.overflow = "hidden";
    runSteps();
  }
  function closeOverlay() {
    clearTimeout(stepTimer);
    overlay.classList.remove("is-on");
    document.body.style.overflow = "";
  }
  $("#auditClose").addEventListener("click", closeOverlay);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay.classList.contains("is-on")) closeOverlay(); });

  function showReport(origin, data) {
    clearTimeout(stepTimer);
    steps.forEach((s) => { s.classList.remove("is-active"); s.classList.add("is-done"); });
    progress.style.width = "100%";
    setTimeout(() => {
      $("#auditRunning").style.display = "none";
      $("#reportSite").textContent = origin.replace(/^https?:\/\//, "");
      const ring = $("#scoreRing");
      const num = $("#scoreNum");
      const target = data.score;
      let cur = 0;
      const anim = () => { cur = Math.min(target, cur + Math.max(1, Math.round(target / 30))); num.textContent = cur; ring.style.setProperty("--p", cur); if (cur < target) requestAnimationFrame(anim); };
      anim();
      const label = target >= 80 ? "Strong AI search readiness" : target >= 55 ? "Good foundation, clear gaps" : "AI assistants will struggle to cite you";
      $("#scoreLabel").textContent = label;
      $("#scoreText").textContent = `${data.passed} of ${data.total} checks passed. Fetched in ${data.fetchMs} ms.`;
      const list = $("#checksList");
      list.innerHTML = "";
      for (const c of data.checks) {
        const row = document.createElement("div");
        row.innerHTML = `<span class="${c.pass ? "ok" : "bad"}">${c.pass ? "&#10003;" : "&#10005;"}</span><div><b></b><small></small></div>`;
        row.querySelector("b").textContent = c.label;
        row.querySelector("small").textContent = c.detail;
        list.appendChild(row);
      }
      $("#reportCta").href = "onboarding.html?website=" + encodeURIComponent(origin);
      $("#auditReport").classList.add("is-on");
    }, 400);
  }

  bindUrlForm($("#auditForm"), async (origin, { input, btn }) => {
    trackCta("geo_audit", "ai_search_audit");
    btn.disabled = true; input.disabled = true;
    openOverlay(origin);
    try {
      const res = await fetch("/api/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: origin }) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) { closeOverlay(); toast("Too many audits. Please try again in a minute."); return; }
      if (!res.ok) { closeOverlay(); toast(body.message || "The audit request failed. Please try again."); return; }
      showReport(origin, body);
    } catch {
      closeOverlay();
      toast(location.protocol === "file:" ? "Start the backend first: run `node server.js` and open http://localhost:3000" : "The audit request failed. Please try again.");
    } finally {
      input.disabled = false; btn.disabled = false;
    }
  });

  /* ---------------- Growth bars (reference heights) ---------------- */
  const bars = $("#growthBars");
  [12, 20, 30, 42, 56, 72, 92].forEach((h, i) => {
    const s = document.createElement("span");
    s.style.height = h + "%";
    s.style.transitionDelay = i * 0.07 + "s";
    bars.appendChild(s);
  });

  /* ---------------- Case studies (sample data) ---------------- */
  const CASES = [
    { quote: true, initials: "AS", text: "Using GeoGrowth we saw steady, measurable organic growth within weeks. The trend keeps improving our visibility and inbound demand.", name: "Alex S.", role: "Founder, sample company" },
    { niche: "Specialty foods", tag: "Food & beverage", site: "Northwind", from: 119, to: 4931, growth: "+4,044%", posts: 107 },
    { niche: "Travel rentals", tag: "Hospitality", site: "Harborline", from: 37, to: 909, growth: "+2,357%", posts: 61 },
    { niche: "Dental clinic", tag: "Healthcare", site: "Cedar Dental", from: 265, to: 3641, growth: "+1,274%", posts: 53 },
    { niche: "Law firm", tag: "Legal", site: "Acme Legal", from: 305, to: 2516, growth: "+725%", posts: 48 },
    { niche: "Auto service", tag: "Automotive", site: "Fieldstone", from: 110, to: 541, growth: "+392%", posts: 30 },
    { niche: "Tax advisory", tag: "Finance", site: "Vantage Tax", from: 125, to: 559, growth: "+347%", posts: 34 },
  ];
  function chart(from, to) {
    const pts = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const y = from + (to - from) * Math.pow(t, 2.2) + (Math.sin(i * 1.7) * (to - from) * 0.03);
      pts.push([10 + t * 240, 100 - (y / to) * 80]);
    }
    const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 260 112" width="100%" height="100%" preserveAspectRatio="none">
      <defs><linearGradient id="g${from}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f25533" stop-opacity=".25"/><stop offset="1" stop-color="#f25533" stop-opacity="0"/></linearGradient></defs>
      <path d="${d} L250 104 L10 104 Z" fill="url(#g${from})"/>
      <path d="${d}" fill="none" stroke="#f25533" stroke-width="2.2" stroke-linecap="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="#f25533"/>
      <text x="12" y="98" font-size="10" fill="#8a8580">${from}</text><text x="226" y="${Math.max(12, last[1] - 8)}" font-size="10" fill="#171717">${to.toLocaleString()}</text>
    </svg>`;
  }
  $("#cases").innerHTML = CASES.map((c) => c.quote
    ? `<article class="case case--quote"><div class="case__photo">${c.initials}</div><div class="case__body"><blockquote>&ldquo;${c.text}&rdquo;</blockquote><div><b style="color:var(--ink)">${c.name}</b><br><small style="color:var(--muted)">${c.role}</small></div></div></article>`
    : `<article class="case"><div class="case__chart">${chart(c.from, c.to)}</div><div class="case__body">
        <div class="case__meta"><span>${c.niche}</span><em>${c.tag}</em></div>
        <h3>How <b>${c.site}</b> grew organic clicks from ${c.from} to ${c.to.toLocaleString()}</h3>
        <div class="case__stats"><div><strong>${c.growth}</strong><small>Organic growth</small></div><div><strong>${c.posts}</strong><small>Articles published</small></div></div>
      </div></article>`).join("");

  /* ---------------- Brand voice tabs ---------------- */
  const BRANDS = [
    { key: "saas", label: "Marketing SaaS", name: "Kitebox", colors: ["#2b1d4a", "#8b7cf6", "#a9b4fb", "#eef0fe"], tone: ["practical", "process-driven", "evidence-backed", "no-nonsense"], products: ["Campaign planner", "Creator CRM", "Reporting suite", "Payments"],
      title: "Campaign Management: A Workflow That Holds Up", lead: "Campaign management is the work of taking a campaign from an agreed plan to a final report. This guide lays out the steps in order, with what to decide at each one.",
      list: ["Set one objective and one primary KPI before you brief anyone.", "Choose partners for audience fit and past performance, not follower count.", "Review results weekly and cut what does not move the KPI."], stats: [["Word count", "2,247"], ["Keywords", "3"], ["Images", "3"], ["Internal links", "10"]] },
    { key: "realestate", label: "Real estate", name: "Harborline", colors: ["#123b3a", "#2f7f6f", "#b9d8c8", "#f2f7f3"], tone: ["warm", "local", "trustworthy", "clear"], products: ["Home valuations", "Buyer guides", "Neighbourhood reports"],
      title: "How to Price a Home in a Shifting Market", lead: "Pricing a home well means reading recent sales, current inventory and buyer demand together. Here is the method agents use, step by step.",
      list: ["Start from sold comparables in the last 90 days, not listings.", "Adjust for condition and lot, then sanity-check price per square foot.", "Revisit the price after two weekends without offers."], stats: [["Word count", "1,864"], ["Keywords", "4"], ["Images", "5"], ["Internal links", "8"]] },
    { key: "health", label: "Health tech", name: "Orbitly", colors: ["#0f2a4a", "#2a5bd7", "#9cc0ff", "#eef4ff"], tone: ["empathetic", "precise", "plain-language", "reassuring"], products: ["Patient app", "Remote monitoring", "Care team portal"],
      title: "Remote Patient Monitoring: What Clinics Need to Know", lead: "Remote monitoring lets clinics follow patients between visits. This guide covers devices, workflows and what to measure in the first 90 days.",
      list: ["Pick one condition and one metric to start.", "Define who reviews alerts and how fast.", "Measure readmissions and patient adherence monthly."], stats: [["Word count", "2,031"], ["Keywords", "3"], ["Images", "4"], ["Internal links", "9"]] },
  ];
  const tabs = $("#brandTabs");
  tabs.innerHTML = BRANDS.map((b, i) => `<button class="brand-tab${i ? "" : " is-active"}" data-i="${i}">${b.name}<small>${b.label}</small></button>`).join("");
  function paintBrand(i) {
    const b = BRANDS[i];
    tabs.querySelectorAll(".brand-tab").forEach((t, j) => t.classList.toggle("is-active", j === i));
    $("#brandProfile").innerHTML = `
      <div><h4>Tailored to</h4><div class="profile__name">${b.name}</div></div>
      <div><h4>Brand colors</h4><div class="swatches">${b.colors.map((c) => `<i style="background:${c}"></i>`).join("")}</div></div>
      <div><h4>Voice &amp; tone</h4><div class="chips">${b.tone.map((t) => `<span class="chip">${t}</span>`).join("")}</div></div>
      <div><h4>Key products</h4><div class="chips">${b.products.map((t) => `<span class="chip">${t}</span>`).join("")}</div></div>`;
    $("#artTag").textContent = b.label;
    $("#artTitle").textContent = b.title;
    $("#artLead").textContent = b.lead;
    $("#artList").innerHTML = b.list.map((l) => `<li>${l}</li>`).join("");
    $("#artStats").innerHTML = b.stats.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
  }
  tabs.addEventListener("click", (e) => { const t = e.target.closest(".brand-tab"); if (t) paintBrand(+t.dataset.i); });
  paintBrand(0);

  /* ---------------- Radar blips ---------------- */
  const radar = $("#radar");
  for (let i = 0; i < 22; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = 14 + Math.random() * 34;
    const b = document.createElement("span");
    b.className = "radar__blip";
    b.style.left = 50 + Math.cos(ang) * r + "%";
    b.style.top = 50 + Math.sin(ang) * r + "%";
    // delay so each blip lights up as the 4s sweep passes its angle
    const deg = ((ang * 180) / Math.PI + 90 + 360) % 360;
    b.style.animationDelay = -(4 - (deg / 360) * 4) + "s";
    radar.appendChild(b);
  }

  /* ---------------- Testimonials wall ---------------- */
  const T = [
    ["Traffic now comes from AI answers too", "We are now mentioned in AI answers for our core category, which is bringing in a new stream of traffic.", "Maya R.", "Growth lead", "#7c5cff"],
    ["Domain rating up, traffic doubled", "Very happy with it. Strong articles, useful tools and real results in three months.", "Daniel M.", "VP Sales", "#2a5bd7"],
    ["Fully set up in 20 minutes", "Connected the site, approved the plan and content started going live the same day.", "Natasha F.", "Founder", "#f25533"],
    ["From 120 to 12,000 monthly visits", "Organic traffic grew steadily across a year with consistent upward growth in authority.", "Matt T.", "Agency owner", "#1f8a4c"],
    ["138K impressions in two months", "It turned SEO into a repeatable engine for us. Rankings followed quickly.", "Alex R.", "CMO", "#d97757"],
    ["1.4M search impressions", "For the first time SEO became a dependable growth channel for our product.", "Muskaan S.", "Designer", "#20808d"],
    ["3 to 100+ daily visits in one week", "SEO was the last thing I still did manually. Now I focus on the product.", "Amal P.", "CEO", "#8b6f5c"],
    ["Organic reach from 620 to 14K", "Measurable, steady organic growth that improved our inbound demand.", "Andrew S.", "Founder", "#6b4fd8"],
    ["+15 SEO clients in 2 months", "We onboarded new SEO clients quickly because the process is automated.", "Ramon B.", "Agency founder", "#2b1d4a"],
    ["10x domain rating", "Started with low authority. Months later we compete for real keywords.", "Pieter N.", "Founder", "#123b3a"],
  ];
  const card = ([h, p, n, r, c]) => `<figure class="tcard"><h4>${h}</h4><p>${p}</p><footer><div class="person"><span class="avatar" style="background:${c}">${n.split(" ").map((x) => x[0]).join("")}</span><div><b>${n}</b><small>${r}</small></div></div></footer></figure>`;
  const half = Math.ceil(T.length / 2);
  const row1 = T.slice(0, half), row2 = T.slice(half);
  $("#wallRow1").innerHTML = [...row1, ...row1].map(card).join("");
  $("#wallRow2").innerHTML = [...row2, ...row2].map(card).join("");
  const wall = $("#wallEl");
  wall.addEventListener("mouseenter", () => wall.classList.add("is-paused"));
  wall.addEventListener("mouseleave", () => wall.classList.remove("is-paused"));
  $("#logoTrack").innerHTML += $("#logoTrack").innerHTML;

  /* ---------------- FAQ show more ---------------- */
  $("#faqMore").addEventListener("click", (e) => {
    document.querySelectorAll("#faqList .is-hidden").forEach((d) => d.classList.remove("is-hidden"));
    e.currentTarget.remove();
  });

  /* ---------------- Reveal on scroll (once, -80px margin) + counters ---------------- */
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      en.target.classList.add("is-in");
      en.target.querySelectorAll("[data-count]").forEach(countUp);
      io.unobserve(en.target);
    }
  }, { rootMargin: "0px 0px -80px 0px" });
  document.querySelectorAll(".reveal, .step__art").forEach((el) => io.observe(el));
  function countUp(el) {
    const end = +el.dataset.count, suf = el.dataset.suffix || "+";
    const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 1200); el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))).toLocaleString() + (k === 1 ? suf : ""); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  $("#year").textContent = new Date().getFullYear();
})();
