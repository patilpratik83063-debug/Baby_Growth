/* GeoGrowth shared runtime.
   Behaviours here were reverse-engineered with REA from the reference bundle
   (useBgGrid, normalizeUrlToOrigin/isValidUrl, trackLandingCta, toasts). */
(function () {
  "use strict";

  /* ---------------- Background tile grid ----------------
     Reference algorithm:
       cols = ceil((w + 4) / 40), rows = ceil((h + 4) / 40)   (36px cell + 4px gap)
       every 5..15 tiles -> an AI platform tile (opacity .65..1.1, rendered at 0.5x, saturate .5)
       otherwise         -> one of three "squares" icons with its own opacity range
       recomputed on resize, debounced 300ms. */
  const SQ_POS = [0.15, 9.81, 19.48];
  function squaresSvg(variant) {
    let rects = "";
    for (const x of SQ_POS) for (const y of SQ_POS) {
      const style =
        variant === 0 ? 'fill="currentColor" fill-opacity="0.45" stroke="currentColor" stroke-width="0.3"' :
        variant === 1 ? 'fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="0.3"' :
                        'stroke="currentColor" stroke-opacity="0.62" stroke-width="0.3"';
      rects += `<rect x="${x}" y="${y}" width="8.37" height="8.37" rx="0.85" ${style}/>`;
    }
    return `<svg class="sq" viewBox="0 0 28 28" fill="none">${rects}</svg>`;
  }
  const SQUARES = [
    { v: 0, min: 0.55, max: 1 },
    { v: 1, min: 0.55, max: 1 },
    { v: 2, min: 0.65, max: 0.8 },
  ];
  const PLATFORMS = [
    { id: "e-chatgpt", color: "#000" },
    { id: "e-claude", color: "#d97757" },
    { id: "e-gemini", color: "#4f7cf3" },
    { id: "e-perplexity", color: "#20808d" },
  ];
  const rand = (a) => a[Math.floor(Math.random() * a.length)];

  function buildTiles(count) {
    const out = [];
    let since = 0;
    let gap = 5 + Math.floor(11 * Math.random());
    while (out.length < count) {
      if (since >= gap) {
        const p = rand(PLATFORMS);
        const op = 0.65 + 0.45 * Math.random();
        out.push(`<div class="bg-grid__cell"><div class="bg-grid__plat" style="opacity:${(0.5 * op).toFixed(3)}"><svg style="color:${p.color}"><use href="#${p.id}"/></svg></div></div>`);
        since = 0;
        gap = 5 + Math.floor(11 * Math.random());
      } else {
        const s = rand(SQUARES);
        const op = s.min + Math.random() * (s.max - s.min);
        out.push(`<div class="bg-grid__cell" style="opacity:${op.toFixed(3)}">${squaresSvg(s.v)}</div>`);
        since++;
      }
    }
    return out.join("");
  }

  function mountBgGrid(el) {
    if (!el) return;
    const host = el.parentElement;
    let last = "";
    const render = () => {
      const w = host.clientWidth, h = host.clientHeight;
      const cols = Math.ceil((w + 4) / 40), rows = Math.ceil((h + 4) / 40);
      const key = cols + "x" + rows;
      if (key === last) return;
      last = key;
      el.style.gridTemplateColumns = `repeat(${cols}, 36px)`;
      el.innerHTML = buildTiles(cols * rows);
    };
    render();
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(render, 300); }).observe(host);
  }

  /* ---------------- URL helpers ---------------- */
  function normalizeUrlToOrigin(raw) {
    let v = String(raw || "").trim().toLowerCase();
    if (!v) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = "https://" + v;
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.origin;
    } catch { return ""; }
  }
  function isValidUrl(origin) {
    try {
      const u = new URL(origin);
      const host = u.hostname;
      return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) && !host.startsWith("-");
    } catch { return false; }
  }

  /* ---------------- Toasts ---------------- */
  function toast(message, kind = "error", ms = 3800) {
    const host = document.getElementById("toasts");
    if (!host) return;
    const el = document.createElement("div");
    el.className = "toast toast--" + (kind === "ok" ? "ok" : "error");
    el.innerHTML = `<i>${kind === "ok" ? "&#10003;" : "!"}</i><span></span>`;
    el.querySelector("span").textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /* ---------------- CTA tracking (local only) ---------------- */
  function trackCta(location, dest) {
    try {
      const log = JSON.parse(localStorage.getItem("gg_cta") || "[]");
      log.push({ location, dest, at: new Date().toISOString() });
      localStorage.setItem("gg_cta", JSON.stringify(log.slice(-50)));
    } catch { /* storage unavailable */ }
  }

  /* ---------------- URL form binder ----------------
     Mirrors the reference: lowercase on input, normalize on blur,
     submit disabled until the normalized value is valid. */
  function bindUrlForm(form, onValid) {
    if (!form) return;
    const input = form.querySelector("input");
    const btn = form.querySelector("button[type=submit]");
    const sync = () => { btn.disabled = !isValidUrl(normalizeUrlToOrigin(input.value)); };
    input.addEventListener("input", () => { input.value = input.value.toLowerCase(); sync(); });
    input.addEventListener("blur", () => { const n = normalizeUrlToOrigin(input.value); if (n) input.value = n.replace(/^https?:\/\//, ""); sync(); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const origin = normalizeUrlToOrigin(input.value);
      if (!origin || !isValidUrl(origin)) { toast("Please enter a valid website URL."); return; }
      onValid(origin, { input, btn });
    });
    sync();
  }

  window.GG = { mountBgGrid, normalizeUrlToOrigin, isValidUrl, toast, trackCta, bindUrlForm };
})();
