const LOCAL_FALLBACK_KEY = "frans2_progress_fallback_v1";
const STATUS_LABELS = {
  niet_gestart: "Niet gestart",
  oefenen: "Oefenen",
  beheerst: "Beheerst",
};

const App = {
  curriculum: null,
  progress: null,
  config: { model: "gemini-3.5-flash-lite", hasKey: false, maskedKey: "", keySource: "none" },
  serverMode: true,
  activeTab: "dashboard",
  wfFilter: "all",
  wfSearch: "",
  saveTimer: null,
};

function defaultProgress() {
  return {
    version: 1,
    updatedAt: null,
    woordvelden: {},
    grammatica: {},
    evaluaties: [],
    zwakkePunten: [],
  };
}

function normalizeProgress(raw) {
  const base = defaultProgress();
  if (!raw || typeof raw !== "object") return base;
  return {
    version: 1,
    updatedAt: raw.updatedAt || null,
    woordvelden: raw.woordvelden && typeof raw.woordvelden === "object" ? raw.woordvelden : {},
    grammatica: raw.grammatica && typeof raw.grammatica === "object" ? raw.grammatica : {},
    evaluaties: Array.isArray(raw.evaluaties) ? raw.evaluaties : [],
    zwakkePunten: Array.isArray(raw.zwakkePunten) ? raw.zwakkePunten : [],
  };
}

/* ---------- API & Storage ---------- */

function setSaveStatus(text, tone = "") {
  const el = document.getElementById("save-status");
  el.textContent = text;
  el.className = `status-chip ${tone}`.trim();
}

function showBanner(msg, isError = false) {
  const el = document.getElementById("global-banner");
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.className = `banner${isError ? " error" : ""}`;
}

async function loadInitialData() {
  const currResp = await fetch("./curriculum.json");
  if (!currResp.ok) throw new Error("Kan curriculum.json niet laden.");
  App.curriculum = await currResp.json();

  try {
    const [progResp, cfgResp] = await Promise.all([
      fetch("./api/progress"),
      fetch("./api/config"),
    ]);
    if (!progResp.ok || !cfgResp.ok) throw new Error("Server API niet beschikbaar");
    App.progress = normalizeProgress(await progResp.json());
    App.config = await cfgResp.json();
    App.serverMode = true;
    setSaveStatus("Opgeslagen op server", "ok");
  } catch {
    App.serverMode = false;
    const cached = localStorage.getItem(LOCAL_FALLBACK_KEY);
    App.progress = normalizeProgress(cached ? JSON.parse(cached) : null);
    setSaveStatus("Lokale browseropslag", "warn");
    showBanner("Start de app via 'python server.py' voor automatische serveropslag en Gemini AI-functies.");
  }

  updateApiIndicator();
}

function scheduleSaveProgress() {
  App.progress.updatedAt = new Date().toISOString();
  localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify(App.progress));
  if (!App.serverMode) {
    setSaveStatus("Lokaal bewaard", "warn");
    return;
  }
  setSaveStatus("Opslaan…");
  clearTimeout(App.saveTimer);
  App.saveTimer = setTimeout(async () => {
    try {
      const resp = await fetch("./api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(App.progress),
      });
      if (!resp.ok) throw new Error();
      setSaveStatus("Opgeslagen op server", "ok");
    } catch {
      setSaveStatus("Opslagfout (lokaal bewaard)", "warn");
    }
  }, 250);
}

/* ---------- Gemini Client (compact, <= 1500 tokens) ---------- */

async function callGemini({ prompt, systemInstruction = "", jsonMode = false, contents = null, maxOutputTokens = 900 }) {
  if (!App.serverMode) {
    throw new Error("Start eerst 'python server.py' om Gemini AI-calls te gebruiken.");
  }
  const body = {
    model: App.config.model,
    contents: contents || [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens,
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  const resp = await fetch("./api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `API-fout (${resp.status})`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
  if (!text) throw new Error("Leeg antwoord ontvangen van Gemini.");
  if (jsonMode) {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(cleaned);
  }
  return text;
}

/* ---------- Progress Helpers ---------- */

function getWfProgress(id) {
  return App.progress.woordvelden[id] || { status: "niet_gestart", score: null, attempts: 0 };
}

function setWfStatus(id, status) {
  const cur = getWfProgress(id);
  App.progress.woordvelden[id] = { ...cur, status, lastPracticed: new Date().toISOString() };
  scheduleSaveProgress();
  renderDashboard();
}

function getGrProgress(id) {
  return App.progress.grammatica[id] || { status: "niet_gestart", score: null, attempts: 0 };
}

function setGrStatus(id, status) {
  const cur = getGrProgress(id);
  App.progress.grammatica[id] = { ...cur, status, lastPracticed: new Date().toISOString() };
  scheduleSaveProgress();
  renderDashboard();
}

function getDomainStats(domain) {
  const list = App.progress.evaluaties.filter((e) => e.domein === domain);
  if (!list.length) {
    return { status: "niet_gestart", count: 0, lastScore: null, avgScore: null };
  }
  const scores = list.map((e) => Number(e.scorePct)).filter((n) => Number.isFinite(n));
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const last = scores.length ? scores[scores.length - 1] : null;
  const status = avg !== null && avg >= 75 && scores.length >= 2 ? "beheerst" : "oefenen";
  return { status, count: list.length, lastScore: last, avgScore: avg };
}

function computeWeightedReadiness() {
  const w = App.curriculum.examen.weging;
  const parts = [
    { weight: w.schrijven, stats: getDomainStats("schrijven") },
    { weight: w.monoloog, stats: getDomainStats("monoloog") },
    { weight: w.gesprek, stats: getDomainStats("gesprek") },
    { weight: w.literatuurbeleving, stats: getDomainStats("literatuur") },
  ];
  let weightedSum = 0;
  let coveredWeight = 0;
  for (const p of parts) {
    if (p.stats.avgScore !== null) {
      weightedSum += (p.stats.avgScore * p.weight) / 100;
      coveredWeight += p.weight;
    }
  }
  return { totalPct: Math.round(weightedSum), coveredWeight };
}

/* ---------- Navigation ---------- */

function switchTab(tabId, subtabId = null) {
  App.activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${tabId}`);
  });
  if (subtabId) switchSubtab(subtabId);
  if (tabId === "dashboard") renderDashboard();
}

function switchSubtab(subtabId) {
  document.querySelectorAll(".subtab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.subtab === subtabId);
  });
  document.querySelectorAll(".subtab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `subtab-${subtabId}`);
  });
}

/* ---------- Tab 1: Dashboard ---------- */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStatusSelect(currentStatus, dataAttr, id) {
  const opts = Object.entries(STATUS_LABELS)
    .map(([val, label]) => `<option value="${val}"${val === currentStatus ? " selected" : ""}>${label}</option>`)
    .join("");
  return `<select class="status-select status-${currentStatus}" data-${dataAttr}="${escapeHtml(id)}" aria-label="Status">${opts}</select>`;
}

function renderDashboard() {
  if (!App.curriculum || !App.progress) return;
  const wfList = App.curriculum.woordvelden;
  const grAll = App.curriculum.grammatica.flatMap((p) => p.onderdelen);

  const wfMastered = wfList.filter((w) => getWfProgress(w.id).status === "beheerst").length;
  const wfPracticing = wfList.filter((w) => getWfProgress(w.id).status === "oefenen").length;
  const grMastered = grAll.filter((g) => getGrProgress(g.id).status === "beheerst").length;
  const grPracticing = grAll.filter((g) => getGrProgress(g.id).status === "oefenen").length;
  const readiness = computeWeightedReadiness();

  const nextTip = !App.config.hasKey
    ? "Stel je Gemini API-key in bij Instellingen voor AI-feedback."
    : wfMastered < 5
      ? "Oefen een paar woordvelden om je basiswoordenschat op te bouwen."
      : getDomainStats("schrijven").count === 0
        ? "Maak je eerste schrijfopdracht (58% van het examen)."
        : "Blijf afwisselen tussen schrijven, spreken en grammatica.";

  document.getElementById("dashboard-kpis").innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Examengereedheid (gewogen)</div>
      <div class="kpi-value">${readiness.totalPct}%</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${readiness.totalPct}%"></div></div>
      <div class="kpi-sub">${readiness.coveredWeight}% van de examendomeinen geoefend</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Woordenschat (23 velden)</div>
      <div class="kpi-value">${wfMastered} / ${wfList.length}</div>
      <div class="progress-bar"><div class="progress-fill ok" style="width:${Math.round((wfMastered / wfList.length) * 100)}%"></div></div>
      <div class="kpi-sub">${wfPracticing} bezig met oefenen · ${wfList.length - wfMastered - wfPracticing} niet gestart</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Grammatica (4 pijlers)</div>
      <div class="kpi-value">${grMastered} / ${grAll.length}</div>
      <div class="progress-bar"><div class="progress-fill ok" style="width:${Math.round((grMastered / grAll.length) * 100)}%"></div></div>
      <div class="kpi-sub">${grPracticing} bezig met oefenen · ${grAll.length - grMastered - grPracticing} niet gestart</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Volgende stap</div>
      <div class="kpi-value" style="font-size:1.05rem;line-height:1.35;margin-top:0.45rem;">${escapeHtml(nextTip)}</div>
      <div class="kpi-sub">${App.progress.evaluaties.length} AI-evaluatie(s) opgeslagen</div>
    </div>
  `;

  // Exam domain cards
  const w = App.curriculum.examen.weging;
  const domains = [
    { key: "schrijven", title: "Schrijven & Interactie", weight: `${w.schrijven}%`, desc: "29% schrijven + 29% schriftelijke interactie · 90 min (2 opdrachten)", tab: "schrijven" },
    { key: "monoloog", title: "Spreken — Monoloog", weight: `${w.monoloog}%`, desc: "Thuisopdracht · voorbereiding + Franse monoloog", tab: "spreken" },
    { key: "gesprek", title: "Mondeling Gesprek", weight: `${w.gesprek}%`, desc: "15 min voorbereiding (kladblad) + 10 min examengesprek", tab: "spreken" },
    { key: "literatuur", title: "Literatuurbeleving", weight: `${w.literatuurbeleving}%`, desc: "Eigen ervaring en gevoelens verwoorden bij B1-tekst", tab: "literatuur" },
  ];

  document.getElementById("dashboard-exam-cards").innerHTML = domains.map((d) => {
    const st = getDomainStats(d.key);
    const scoreLine = st.count
      ? `Laatste: <strong>${st.lastScore}%</strong> · Gem.: <strong>${st.avgScore}%</strong> (${st.count}×)`
      : "Nog geen evaluaties";
    return `
      <div class="exam-card">
        <div class="exam-card-top">
          <h3>${d.title}</h3>
          <span class="weight-pill">${d.weight}</span>
        </div>
        <div class="exam-meta">${d.desc}</div>
        <div class="exam-meta">${scoreLine}</div>
        <div class="exam-footer">
          <span class="status-pill status-${st.status}">${STATUS_LABELS[st.status]}</span>
          <button class="btn btn-secondary btn-sm" type="button" data-goto-tab="${d.tab}">Oefen →</button>
        </div>
      </div>
    `;
  }).join("");

  // 23 Woordvelden
  document.getElementById("wf-summary-text").textContent =
    `${wfMastered} beheerst · ${wfPracticing} aan het oefenen · 460 kernwoorden`;

  const q = App.wfSearch.trim().toLowerCase();
  const filteredWf = wfList.filter((wf) => {
    const st = getWfProgress(wf.id).status;
    if (App.wfFilter !== "all" && st !== App.wfFilter) return false;
    if (q && !wf.titel_nl.toLowerCase().includes(q) && !wf.titel_fr.toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById("dashboard-wf-grid").innerHTML = filteredWf.length
    ? filteredWf.map((wf) => {
        const prog = getWfProgress(wf.id);
        const scoreTxt = prog.score !== null ? ` · ${prog.score}%` : "";
        return `
          <div class="wf-card">
            <div class="wf-head">
              <span class="wf-num">${String(wf.nummer).padStart(2, "0")}</span>
              <span class="wf-title">${escapeHtml(wf.titel_nl)}</span>
            </div>
            <div class="wf-fr">${escapeHtml(wf.titel_fr)}${scoreTxt}</div>
            <div class="wf-actions">
              ${renderStatusSelect(prog.status, "wf-status", wf.id)}
              <button class="btn btn-secondary btn-sm" type="button" data-open-wf="${wf.id}">Oefen</button>
            </div>
          </div>
        `;
      }).join("")
    : `<div class="card muted">Geen woordvelden gevonden voor deze filter.</div>`;

  // Grammatica (4 pijlers)
  document.getElementById("gr-summary-text").textContent =
    `${grMastered} van ${grAll.length} onderdelen beheerst`;

  document.getElementById("dashboard-gr-pillars").innerHTML = App.curriculum.grammatica.map((p) => {
    const doneCount = p.onderdelen.filter((o) => getGrProgress(o.id).status === "beheerst").length;
    const items = p.onderdelen.map((o) => {
      const prog = getGrProgress(o.id);
      const scoreTxt = prog.score !== null ? ` (${prog.score}%)` : "";
      return `
        <li class="gr-item">
          <div class="gr-item-name">${escapeHtml(o.naam)}${scoreTxt}</div>
          <div class="gr-item-bar">
            ${renderStatusSelect(prog.status, "gr-status", o.id)}
            <button class="btn btn-secondary btn-sm" type="button" data-open-gr="${o.id}">Oefen</button>
          </div>
        </li>
      `;
    }).join("");
    return `
      <div class="gr-pillar">
        <h3>
          <span>${escapeHtml(p.titel)}</span>
          <span class="muted">${doneCount}/${p.onderdelen.length}</span>
        </h3>
        <ul class="gr-list">${items}</ul>
      </div>
    `;
  }).join("");

  // Recente evaluaties
  const historyEl = document.getElementById("dashboard-history");
  const recent = [...App.progress.evaluaties].reverse().slice(0, 8);
  if (!recent.length) {
    historyEl.innerHTML = `<p class="muted" style="margin:0;">Nog geen AI-evaluaties opgeslagen. Zodra je schrijf-, spreek- of literatuuropdrachten maakt, verschijnen je scores en feedback hier automatisch.</p>`;
  } else {
    historyEl.innerHTML = `<div class="history-list">${recent.map((e) => `
      <div class="history-row">
        <div>
          <strong>${escapeHtml(e.titel || e.domein)}</strong>
          <div class="muted">${new Date(e.datum).toLocaleDateString("nl-BE")} · ${escapeHtml(e.domein)}</div>
        </div>
        <span class="score-badge">${escapeHtml(e.scorePct)}%</span>
      </div>
    `).join("")}</div>`;
  }
}

/* ---------- Settings Modal ---------- */

function updateApiIndicator() {
  const dot = document.getElementById("api-dot");
  dot.classList.toggle("ready", Boolean(App.config.hasKey));
  document.getElementById("cfg-model").value = App.config.model || "gemini-3.5-flash-lite";
  const keyStatus = document.getElementById("cfg-key-status");
  if (App.config.hasKey) {
    keyStatus.innerHTML = `Sleutel actief (${escapeHtml(App.config.maskedKey)}, bron: <code>${escapeHtml(App.config.keySource)}</code>). Laat het veld leeg om huidige sleutel te behouden.`;
  } else {
    keyStatus.innerHTML = `Nog geen API-key ingesteld. Vraag een gratis/goedkope key aan via Google AI Studio en plak ze hier.`;
  }
}

function showConfigFeedback(msg, isError = false) {
  const el = document.getElementById("cfg-feedback");
  if (!msg) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.className = `inline-feedback ${isError ? "error" : "ok"}`;
}

function openSettings() {
  updateApiIndicator();
  document.getElementById("cfg-apikey").value = "";
  showConfigFeedback("");
  document.getElementById("settings-modal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}

async function saveConfig(clearKey = false) {
  if (!App.serverMode) {
    showConfigFeedback("Start eerst 'python server.py' om serverinstellingen op te slaan.", true);
    return;
  }
  const model = document.getElementById("cfg-model").value.trim() || "gemini-3.5-flash-lite";
  const apiKey = document.getElementById("cfg-apikey").value.trim();
  try {
    const resp = await fetch("./api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, apiKey: clearKey ? "" : apiKey, clearKey }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Opslaan mislukt");
    App.config = data;
    document.getElementById("cfg-apikey").value = "";
    updateApiIndicator();
    renderDashboard();
    showConfigFeedback(clearKey ? "API-key gewist." : "Instellingen opgeslagen op server.");
  } catch (err) {
    showConfigFeedback(err.message, true);
  }
}

async function testApiConnection() {
  showConfigFeedback("Verbinding testen…");
  try {
    const reply = await callGemini({
      prompt: "Réponds uniquement par: OK",
      maxOutputTokens: 16,
    });
    showConfigFeedback(`Verbinding geslaagd (${App.config.model}): "${reply}"`);
  } catch (err) {
    showConfigFeedback(err.message, true);
  }
}

function exportProgressJson() {
  const blob = new Blob([JSON.stringify(App.progress, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `frans2-voortgang-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importProgressJson(file) {
  try {
    const parsed = JSON.parse(await file.text());
    App.progress = normalizeProgress(parsed);
    scheduleSaveProgress();
    renderDashboard();
    showConfigFeedback("Voortgang succesvol geïmporteerd en opgeslagen.");
  } catch {
    showConfigFeedback("Ongeldig JSON-bestand.", true);
  }
}

/* ---------- Events & Init ---------- */

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSubtab(btn.dataset.subtab));
  });

  document.getElementById("wf-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    App.wfFilter = chip.dataset.filter;
    document.querySelectorAll("#wf-filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    renderDashboard();
  });

  document.getElementById("wf-search").addEventListener("input", (e) => {
    App.wfSearch = e.target.value;
    renderDashboard();
  });

  document.getElementById("tab-dashboard").addEventListener("change", (e) => {
    const wfId = e.target.dataset.wfStatus;
    const grId = e.target.dataset.grStatus;
    if (wfId) setWfStatus(wfId, e.target.value);
    if (grId) setGrStatus(grId, e.target.value);
  });

  document.getElementById("tab-dashboard").addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-goto-tab]");
    if (tabBtn) switchTab(tabBtn.dataset.gotoTab);
    const wfBtn = e.target.closest("[data-open-wf]");
    if (wfBtn) switchTab("drill", "vocab");
    const grBtn = e.target.closest("[data-open-gr]");
    if (grBtn) switchTab("drill", "grammar");
  });

  document.getElementById("btn-settings").addEventListener("click", openSettings);
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target.dataset.closeModal) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettings();
  });

  document.querySelectorAll(".quick-models .chip").forEach((c) => {
    c.addEventListener("click", () => {
      document.getElementById("cfg-model").value = c.dataset.model;
    });
  });

  document.getElementById("btn-save-config").addEventListener("click", () => saveConfig(false));
  document.getElementById("btn-clear-key").addEventListener("click", () => saveConfig(true));
  document.getElementById("btn-test-api").addEventListener("click", testApiConnection);
  document.getElementById("btn-export").addEventListener("click", exportProgressJson);
  document.getElementById("input-import").addEventListener("change", (e) => {
    if (e.target.files?.[0]) importProgressJson(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("btn-reset-progress").addEventListener("click", () => {
    if (!confirm("Weet je zeker dat je alle voortgang wilt wissen?")) return;
    App.progress = defaultProgress();
    scheduleSaveProgress();
    renderDashboard();
    showConfigFeedback("Voortgang gewist.");
  });
}

async function init() {
  bindEvents();
  try {
    await loadInitialData();
    renderDashboard();
  } catch (err) {
    showBanner(`Fout bij opstarten: ${err.message}`, true);
  }
}

init();
