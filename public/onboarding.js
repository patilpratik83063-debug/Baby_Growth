/* Guest onboarding funnel wired to the guest-onboarding API (same contract as the reference, recovered with REA):
   select-website -> select-language -> business-details -> select-competitors -> brand-voice -> email + password */
(function () {
  "use strict";
  const { mountBgGrid, bindUrlForm, normalizeUrlToOrigin, isValidUrl, toast } = window.GG;
  const $ = (s, r = document) => r.querySelector(s);
  mountBgGrid($("#bgGrid"));

  const STEPS = ["select-website", "select-language", "business-details", "select-competitors", "brand-voice", "email", "done"];
  const GUEST_KEY = "gg_guest_id";
  const state = { website: "", language: "en", competitors: [], voice: [], email: "", suggestions: [] };
  let guestId = localStorage.getItem(GUEST_KEY);

  async function api(method, path, body) {
    const res = await fetch("/api" + path, {
      method, credentials: "same-origin",
      headers: { "content-type": "application/json", ...(guestId ? { "x-guest-id": guestId } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.message || "Something went wrong."); e.status = res.status; e.code = data.code; throw e; }
    return data;
  }
  const saveDraft = (section, value) => api("PUT", "/guest-onboarding/draft", { section, value, completesStep: true });
  const fail = (e) => { toast(location.protocol === "file:" ? "Start the server: npm start, then open http://localhost:3000" : e.message); };

  /* ---------- router ---------- */
  const current = () => { const h = location.hash.slice(1); return STEPS.includes(h) ? h : null; };
  function show(step) {
    if (STEPS.indexOf(step) >= 1 && STEPS.indexOf(step) <= 5 && !guestId) step = "select-website";
    document.querySelectorAll(".ob__step").forEach((s) => s.classList.toggle("is-on", s.dataset.step === step));
    $("#obBar").style.width = (Math.min(STEPS.indexOf(step), 6) / 6) * 100 + "%";
    onEnter[step] && onEnter[step]();
    const f = document.querySelector(`.ob__step[data-step="${step}"] input, .ob__step[data-step="${step}"] textarea`);
    if (f) setTimeout(() => f.focus(), 50);
  }
  const go = (step) => { if (location.hash.slice(1) === step) show(step); else location.hash = step; };
  addEventListener("hashchange", () => show(current() || STEPS[0]));

  const busy = (btn, on) => { if (btn) { btn.disabled = on; btn.style.opacity = on ? ".6" : ""; } };
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-back]")) { e.preventDefault(); history.back(); return; }
    const next = e.target.closest("[data-next]");
    if (!next) return;
    e.preventDefault();
    const step = next.closest(".ob__step").dataset.step;
    busy(next, true);
    try { if (await submit[step]()) go(STEPS[STEPS.indexOf(step) + 1]); }
    catch (err) { fail(err); }
    finally { busy(next, false); }
  });

  /* ---------- 1. website ---------- */
  bindUrlForm($("#siteForm"), async (origin, { btn }) => {
    busy(btn, true);
    try {
      if (!guestId || origin !== state.website) {
        const { data } = await api("POST", "/guest-onboarding/start", { url: origin });
        guestId = data.guestId; localStorage.setItem(GUEST_KEY, guestId);
      }
      state.website = origin;
      go("select-language");
    } catch (e) { fail(e); } finally { busy(btn, false); }
  });

  /* ---------- 2. language ---------- */
  const LANGS = { English: "en", Spanish: "es", German: "de", French: "fr", Portuguese: "pt", Italian: "it", Dutch: "nl", Hindi: "hi", Japanese: "ja" };
  options($("#langOptions"), Object.keys(LANGS), () => [Object.keys(LANGS).find((k) => LANGS[k] === state.language)], (v) => { state.language = LANGS[v[0]]; });

  /* ---------- 3. business details (prefilled by AI analysis of the site) ---------- */
  let bizLoadedFor = "";
  const onEnter = {
    "business-details": async () => {
      const key = guestId + state.language;
      if (bizLoadedFor === key) return;
      $("#bizLead").textContent = "Reading your website...";
      try {
        const { data } = await api("GET", "/guest-onboarding/business-info?language=" + state.language);
        bizLoadedFor = key;
        if (!$("#bizName").value) $("#bizName").value = data.brandName || "";
        if (!$("#bizDesc").value) $("#bizDesc").value = data.description || "";
        if (!$("#bizAudience").value) $("#bizAudience").value = (data.targetAudience || []).join("; ");
        state.industry = data.industry; state.mainServices = data.mainServices || [];
        if (!state.voice.length && data.voice?.length) { state.voice = data.voice.filter((v) => VOICES.includes(v)).slice(0, 3); paintVoice(); }
        $("#bizLead").textContent = data.needsReview
          ? "We couldn't read your website's content (it may load with JavaScript, or the domain may be parked). Please describe your business so we track the right AI search questions."
          : data.contentSource === "web_search" ? "Your site loads with JavaScript, so we filled this from a web search. Please check it." : "We pre-filled this from your website. Edit anything that's off.";
      } catch (e) { $("#bizLead").textContent = "Tell us in a sentence or two what you do."; }
    },
    "select-competitors": async () => {
      if (state.suggestions.length || state.competitors.length) return;
      const hint = document.createElement("p"); hint.className = "lead"; hint.id = "compHint"; hint.textContent = "Finding your competitors...";
      $("#compBox").after(hint);
      try {
        const q = new URLSearchParams({ description: $("#bizDesc").value, industry: state.industry || "", audience: $("#bizAudience").value, language: state.language });
        const { data } = await api("GET", "/guest-onboarding/organic-competitors?" + q);
        state.suggestions = data || [];
        hint.innerHTML = state.suggestions.length ? "Suggested: " : "No suggestions found. Add competitors manually.";
        state.suggestions.forEach((c) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.style.cursor = "pointer"; b.style.margin = "4px";
          b.textContent = "+ " + c.url.replace(/^https?:\/\//, "");
          b.onclick = () => { addCompetitor(c.url); b.remove(); };
          hint.appendChild(b);
        });
      } catch { hint.textContent = "Add competitors manually."; }
    },
  };

  /* ---------- 4. competitors ---------- */
  const compBox = $("#compBox"), compInput = $("#compInput");
  function paintComps() {
    compBox.querySelectorAll(".chip").forEach((c) => c.remove());
    state.competitors.forEach((c, i) => {
      const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = c.replace(/^https?:\/\//, "");
      const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove " + c);
      x.onclick = () => { state.competitors.splice(i, 1); paintComps(); };
      chip.appendChild(x); compBox.insertBefore(chip, compInput);
    });
  }
  function addCompetitor(raw) {
    const o = normalizeUrlToOrigin(raw);
    if (!o || !isValidUrl(o)) { toast("Enter a valid competitor URL."); return; }
    if (o === state.website) { toast("That's your own website."); return; }
    if (state.competitors.includes(o)) return;
    if (state.competitors.length >= 5) { toast("You can add up to 5 competitors."); return; }
    state.competitors.push(o); paintComps();
  }
  compInput.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCompetitor(compInput.value); compInput.value = ""; } });

  /* ---------- 5. voice ---------- */
  const VOICES = ["Friendly", "Professional", "Expert", "Playful", "Bold", "Empathetic", "Concise", "Storytelling", "Data-driven"];
  const paintVoice = options($("#voiceOptions"), VOICES, () => state.voice, (v) => { state.voice = v; }, 3);

  /* ---------- step submitters ---------- */
  const submit = {
    "select-language": async () => { await saveDraft("market", { selectedLanguage: state.language }); return true; },
    "business-details": async () => {
      const description = $("#bizDesc").value.trim(), name = $("#bizName").value.trim();
      if (!name) { toast("Please add your business name."); return false; }
      if (description.length < 10) { toast("Please describe what you offer in a sentence."); return false; }
      await saveDraft("business", { brandName: name, description, industry: state.industry || null, mainServices: state.mainServices || [],
        targetAudience: $("#bizAudience").value.split(";").map((s) => s.trim()).filter(Boolean) });
      return true;
    },
    "select-competitors": async () => { await saveDraft("competitors", { urls: state.competitors }); return true; },
    "brand-voice": async () => { if (!state.voice.length) { toast("Pick at least one tone."); return false; } await saveDraft("voice", { tones: state.voice }); return true; },
  };

  /* ---------- 6. email + password -> account, signed in, agent starts ---------- */
  $("#emailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#emailInput").value.trim(), password = $("#pwInput").value;
    if (!/^[^s@]+@[^s@]+.[^s@]{2,}$/.test(email)) { toast("Please enter a valid email."); return; }
    if (password.length < 8) { toast("Password must be at least 8 characters."); return; }
    const btn = $("#finishBtn"); busy(btn, true);
    try {
      await api("POST", "/guest-onboarding/set-email", { email, password });
      await api("POST", "/onboarding/start");
      localStorage.removeItem(GUEST_KEY);
      go("done");
      setTimeout(() => (location.href = "app.html"), 1500);
    } catch (err) {
      if (err.code === "EMAIL_TAKEN") { toast(err.message); setTimeout(() => (location.href = "sign-in.html"), 1800); }
      else fail(err);
    } finally { busy(btn, false); }
  });

  function options(host, values, get, set, max = 1) {
    host.innerHTML = values.map((v) => `<button type="button" class="option" data-v="${v}">${v}</button>`).join("");
    const paint = () => host.querySelectorAll(".option").forEach((b) => b.classList.toggle("is-on", get().includes(b.dataset.v)));
    host.addEventListener("click", (e) => {
      const b = e.target.closest(".option"); if (!b) return;
      let cur = [...get()].filter(Boolean);
      if (max === 1) cur = [b.dataset.v];
      else if (cur.includes(b.dataset.v)) cur = cur.filter((x) => x !== b.dataset.v);
      else if (cur.length < max) cur.push(b.dataset.v);
      else { toast(`Pick up to ${max}.`); return; }
      set(cur); paint();
    });
    paint();
    return paint;
  }

  /* ---------- boot: resume a guest session or start from ?website= ---------- */
  (async () => {
    // Personal deployments close sign-ups: send visitors to sign in (or to "Add website" if already signed in).
    const cfg = await fetch("/api/auth/config").then((r) => r.json()).catch(() => ({}));
    if (cfg.data && !cfg.data.signupsOpen) {
      const me = await fetch("/api/users/me", { credentials: "same-origin" }).catch(() => null);
      location.replace(me?.ok ? "app.html#add-site" : "sign-in.html");
      return;
    }
    const qs = new URLSearchParams(location.search).get("website");
    const fromQs = qs && normalizeUrlToOrigin(qs);
    if (guestId) {
      try {
        const { data } = await api("GET", "/guest-onboarding/session");
        if (fromQs && data.websiteUrl !== fromQs) throw new Error("different site");
        state.website = data.websiteUrl;
        const d = data.draft || {};
        state.language = d.market?.selectedLanguage || "en";
        state.competitors = d.competitors?.urls || [];
        state.voice = d.voice?.tones || [];
        if (d.business) { $("#bizName").value = d.business.brandName || ""; $("#bizDesc").value = d.business.description || ""; $("#bizAudience").value = (d.business.targetAudience || []).join("; "); }
        paintComps(); paintVoice();
      } catch { guestId = null; localStorage.removeItem(GUEST_KEY); }
    }
    if (state.website) $("#siteInput").value = state.website.replace(/^https?:\/\//, "");
    if (!guestId && fromQs && isValidUrl(fromQs)) {
      $("#siteInput").value = fromQs.replace(/^https?:\/\//, "");
      try { const { data } = await api("POST", "/guest-onboarding/start", { url: fromQs }); guestId = data.guestId; localStorage.setItem(GUEST_KEY, guestId); state.website = fromQs; }
      catch (e) { fail(e); }
    }
    if (!current()) { history.replaceState(null, "", "#select-website"); if (guestId) history.pushState(null, "", "#select-language"); }
    show(current());
  })();
})();
