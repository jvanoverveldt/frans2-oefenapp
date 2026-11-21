const LOCAL_FALLBACK_KEY = "frans2_progress_fallback_v1";
const FRENCH_ACCENTS = ["é", "è", "ê", "ë", "à", "â", "ç", "ù", "û", "ô", "î", "ï", "œ"];
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
  vocab: {
    scope: "wf01",
    mode: "lijst",
    hideMode: "none",
    flashDir: "nl-fr",
    flashHardOnly: false,
    session: null,
  },
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
  const raw = App.progress.woordvelden[id] || {};
  return {
    status: raw.status || "niet_gestart",
    score: raw.score ?? null,
    attempts: raw.attempts || 0,
    hardWords: Array.isArray(raw.hardWords) ? raw.hardWords : [],
    lastPracticed: raw.lastPracticed || null,
  };
}

function setWfStatus(id, status) {
  const cur = getWfProgress(id);
  App.progress.woordvelden[id] = { ...cur, status, lastPracticed: new Date().toISOString() };
  scheduleSaveProgress();
  renderDashboard();
  if (App.activeTab === "drill") renderVocabMeta();
}

function recordWfScore(id, scorePct) {
  const cur = getWfProgress(id);
  const pct = Math.max(0, Math.min(100, Math.round(scorePct)));
  let status = cur.status;
  if (pct >= 80) status = "beheerst";
  else if (status === "niet_gestart") status = "oefenen";
  App.progress.woordvelden[id] = {
    ...cur,
    status,
    score: pct,
    attempts: cur.attempts + 1,
    lastPracticed: new Date().toISOString(),
  };
  scheduleSaveProgress();
  renderVocabMeta();
}

function toggleHardWord(wfId, frWord) {
  const cur = getWfProgress(wfId);
  const set = new Set(cur.hardWords);
  if (set.has(frWord)) set.delete(frWord);
  else set.add(frWord);
  App.progress.woordvelden[wfId] = { ...cur, hardWords: [...set] };
  scheduleSaveProgress();
}

/* ---------- Shared Drill Utilities ---------- */

function speakFrench(text) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "fr-FR";
  utter.rate = 0.95;
  window.speechSynthesis.speak(utter);
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeFr(str) {
  return String(str || "")
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripAccents(str) {
  return normalizeFr(str)
    .replace(/œ/g, "oe")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function checkFrenchAnswer(given, expected) {
  const g = normalizeFr(given);
  const e = normalizeFr(expected);
  if (!g) return "empty";
  if (g === e) return "exact";
  if (stripAccents(g) === stripAccents(e)) return "accent";
  return "wrong";
}

function renderAccentBar() {
  return `<div class="accent-bar" aria-label="Franse accenten">${FRENCH_ACCENTS.map(
    (ch) => `<button type="button" class="accent-btn" data-accent="${ch}">${ch}</button>`
  ).join("")}</div>`;
}

function insertAtCursor(input, text) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.focus();
  input.setSelectionRange(start + text.length, start + text.length);
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
  if (tabId === "drill") renderVocabStage();
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

/* ---------- Tab 5a: Woordenschat Drill (100% offline, uitbreidbaar) ---------- */

const VOCAB_MODES = [
  { id: "lijst", label: "Woordenlijst", render: renderVocabList },
  { id: "flits", label: "Flitskaarten", render: renderVocabFlashcards },
  { id: "invul", label: "Invuloefening", render: renderVocabCloze },
  { id: "zinsbouw", label: "Zinsbouw-puzzel", render: renderVocabBuilder },
];

function getSelectedVocabFields() {
  const all = App.curriculum.woordvelden;
  if (App.vocab.scope === "__mix_all") return all;
  if (App.vocab.scope === "__mix_todo") {
    const todo = all.filter((w) => getWfProgress(w.id).status !== "beheerst");
    return todo.length ? todo : all;
  }
  const single = all.find((w) => w.id === App.vocab.scope);
  return single ? [single] : [all[0]];
}

function getVocabWordPool() {
  const fields = getSelectedVocabFields();
  return fields.flatMap((wf) =>
    wf.woorden.map((w) => ({ ...w, wfId: wf.id, wfTitel: wf.titel_nl }))
  );
}

function getVocabSentencePool() {
  const fields = getSelectedVocabFields();
  return fields.flatMap((wf) =>
    wf.voorbeelden.map((vb) => ({ ...vb, wfId: wf.id, wfTitel: wf.titel_nl }))
  );
}

function initVocabControls() {
  const select = document.getElementById("vocab-wf-select");
  const wfOpts = App.curriculum.woordvelden
    .map((wf) => `<option value="${wf.id}">${String(wf.nummer).padStart(2, "0")} · ${escapeHtml(wf.titel_nl)}</option>`)
    .join("");
  select.innerHTML = `
    <optgroup label="Slimme herhaling">
      <option value="__mix_todo">Mix · Nog niet beheerste woordvelden</option>
      <option value="__mix_all">Mix · Alle 23 woordvelden</option>
    </optgroup>
    <optgroup label="Per woordveld (23)">
      ${wfOpts}
    </optgroup>
  `;
  select.value = App.vocab.scope;

  const modeBar = document.getElementById("vocab-mode-bar");
  modeBar.innerHTML = VOCAB_MODES.map(
    (m) => `<button type="button" class="mode-btn${m.id === App.vocab.mode ? " active" : ""}" data-vocab-mode="${m.id}" role="tab">${escapeHtml(m.label)}</button>`
  ).join("");

  renderVocabMeta();
}

function renderVocabMeta() {
  const wrap = document.getElementById("vocab-wf-meta");
  if (!wrap || !App.curriculum) return;
  if (App.vocab.scope.startsWith("__mix")) {
    const fields = getSelectedVocabFields();
    wrap.innerHTML = `<span class="muted">${fields.length} woordvelden in selectie</span>`;
    return;
  }
  const wf = App.curriculum.woordvelden.find((w) => w.id === App.vocab.scope);
  if (!wf) return;
  const prog = getWfProgress(wf.id);
  const scoreTxt = prog.score !== null ? `<span class="score-badge">Laatste: ${prog.score}%</span>` : "";
  wrap.innerHTML = `
    <span class="muted" style="font-style:italic;">${escapeHtml(wf.titel_fr)}</span>
    ${scoreTxt}
    ${renderStatusSelect(prog.status, "vocab-wf-status", wf.id)}
  `;
}

function openVocabField(wfId) {
  App.vocab.scope = wfId;
  App.vocab.session = null;
  const select = document.getElementById("vocab-wf-select");
  if (select) select.value = wfId;
  switchTab("drill", "vocab");
  renderVocabMeta();
}

function setVocabMode(modeId) {
  App.vocab.mode = modeId;
  App.vocab.session = null;
  document.querySelectorAll("#vocab-mode-bar .mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.vocabMode === modeId);
  });
  renderVocabStage();
}

function renderVocabStage() {
  if (!App.curriculum) return;
  renderVocabMeta();
  const mode = VOCAB_MODES.find((m) => m.id === App.vocab.mode) || VOCAB_MODES[0];
  mode.render(document.getElementById("vocab-stage"));
}

/* Mode 1: Woordenlijst */
function renderVocabList(container) {
  const words = getVocabWordPool();
  const sentences = getVocabSentencePool();
  const hide = App.vocab.hideMode;
  const isMix = App.vocab.scope.startsWith("__mix");

  const shownWords = isMix ? words.slice(0, 40) : words;
  const hardCount = words.filter((w) => getWfProgress(w.wfId).hardWords.includes(w.fr)).length;

  container.innerHTML = `
    <div class="card">
      <div class="stage-toolbar">
        <div>
          <strong>${shownWords.length} kernwoorden</strong>
          ${isMix ? `<span class="muted"> (selectie van ${words.length})</span>` : ""}
          ${hardCount ? `<span class="muted"> · ★ ${hardCount} moeilijk gemarkeerd</span>` : ""}
        </div>
        <div class="filter-group">
          <button type="button" class="chip${hide === "none" ? " active" : ""}" data-hide="none">Toon alles</button>
          <button type="button" class="chip${hide === "fr" ? " active" : ""}" data-hide="fr">Verberg Frans</button>
          <button type="button" class="chip${hide === "nl" ? " active" : ""}" data-hide="nl">Verberg NL</button>
        </div>
      </div>
      <div class="word-table">
        ${shownWords.map((w) => {
          const isHard = getWfProgress(w.wfId).hardWords.includes(w.fr);
          return `
            <div class="word-row${isHard ? " is-hard" : ""}">
              <div class="word-pair">
                <span class="word-fr${hide === "fr" ? " word-blurred" : ""}" data-reveal="1">${escapeHtml(w.fr)}</span>
                <span class="word-nl${hide === "nl" ? " word-blurred" : ""}" data-reveal="1">${escapeHtml(w.nl)}</span>
              </div>
              <div class="word-row-actions">
                <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(w.fr)}" title="Luister uitspraak">🔊</button>
                <button type="button" class="mini-icon-btn${isHard ? " active-star" : ""}" data-hard-wf="${w.wfId}" data-hard-word="${escapeHtml(w.fr)}" title="Markeer als moeilijk">★</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
      ${!isMix && sentences.length ? `
        <h3 style="margin:1.25rem 0 0.5rem;font-size:0.98rem;">Voorbeeldzinnen in context</h3>
        <div class="examples-list">
          ${sentences.map((s) => `
            <div class="example-item">
              <div>
                <div><strong>${escapeHtml(s.fr)}</strong></div>
                <div class="muted">${escapeHtml(s.nl)}</div>
              </div>
              <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(s.fr)}" title="Luister zin">🔊</button>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

/* Mode 2: Flitskaarten */
function startFlashSession() {
  let pool = getVocabWordPool();
  if (App.vocab.flashHardOnly) {
    const hard = pool.filter((w) => getWfProgress(w.wfId).hardWords.includes(w.fr));
    if (hard.length) pool = hard;
  }
  const deck = shuffleArray(pool).slice(0, App.vocab.scope.startsWith("__mix") ? 15 : pool.length);
  App.vocab.session = {
    type: "flits",
    deck,
    idx: 0,
    flipped: false,
    known: 0,
    retry: 0,
    done: false,
  };
}

function renderVocabFlashcards(container) {
  if (!App.vocab.session || App.vocab.session.type !== "flits") startFlashSession();
  const s = App.vocab.session;
  const dir = App.vocab.flashDir;

  if (!s.deck.length) {
    container.innerHTML = `<div class="card muted">Geen woorden in deze selectie.</div>`;
    return;
  }

  if (s.done) {
    const pct = Math.round((s.known / s.deck.length) * 100);
    container.innerHTML = `
      <div class="card summary-box">
        <h3>Flitskaarten afgerond!</h3>
        <div class="summary-score">${pct}%</div>
        <p class="muted">${s.known} van ${s.deck.length} gekend · ${s.retry} gemarkeerd om nog te oefenen</p>
        <div class="btn-row" style="justify-content:center;margin-top:1rem;">
          <button type="button" class="btn btn-primary" data-flash-action="restart">Opnieuw oefenen</button>
          <button type="button" class="btn btn-secondary" data-vocab-mode="invul">Ga naar Invuloefening →</button>
        </div>
      </div>
    `;
    return;
  }

  const card = s.deck[s.idx];
  const frontLang = dir === "nl-fr" ? "Nederlands" : "Frans";
  const backLang = dir === "nl-fr" ? "Frans" : "Nederlands";
  const frontText = dir === "nl-fr" ? card.nl : card.fr;
  const backText = dir === "nl-fr" ? card.fr : card.nl;

  container.innerHTML = `
    <div class="card">
      <div class="stage-toolbar">
        <span class="muted">Kaart <strong>${s.idx + 1} / ${s.deck.length}</strong> · Gekend: ${s.known}</span>
        <div class="filter-group">
          <button type="button" class="chip${dir === "nl-fr" ? " active" : ""}" data-flash-dir="nl-fr">NL → FR</button>
          <button type="button" class="chip${dir === "fr-nl" ? " active" : ""}" data-flash-dir="fr-nl">FR → NL</button>
          <button type="button" class="chip${App.vocab.flashHardOnly ? " active" : ""}" data-flash-hard="toggle">★ Enkel moeilijk</button>
        </div>
      </div>
      <div class="flashcard-wrap">
        <div class="flashcard${s.flipped ? " flipped" : ""}" data-flash-action="flip" tabindex="0" role="button">
          <span class="flashcard-lang">${s.flipped ? backLang : frontLang}</span>
          <span class="flashcard-text">${escapeHtml(s.flipped ? backText : frontText)}</span>
          <span class="flashcard-hint">${s.flipped ? escapeHtml(frontText) : "Klik op de kaart om om te draaien"}</span>
          ${(s.flipped || dir === "fr-nl") ? `<button type="button" class="btn btn-secondary btn-sm" data-speak="${escapeHtml(card.fr)}">🔊 Luister Frans</button>` : ""}
        </div>
        <div class="flashcard-controls">
          ${s.flipped ? `
            <button type="button" class="btn btn-ghost-danger" data-flash-action="retry">↻ Nog oefenen</button>
            <button type="button" class="btn btn-primary" data-flash-action="known">✓ Ken ik</button>
          ` : `
            <button type="button" class="btn btn-primary" data-flash-action="flip">Toon antwoord</button>
          `}
        </div>
      </div>
    </div>
  `;
}

/* Mode 3: Contextuele invuloefening (Cloze) */
function startClozeSession() {
  const pool = shuffleArray(getVocabSentencePool());
  const items = App.vocab.scope.startsWith("__mix") ? pool.slice(0, 8) : pool;
  App.vocab.session = {
    type: "invul",
    items,
    idx: 0,
    points: 0,
    perWf: {},
    answered: false,
    lastResult: null,
    done: false,
  };
}

function renderVocabCloze(container) {
  if (!App.vocab.session || App.vocab.session.type !== "invul") startClozeSession();
  const s = App.vocab.session;

  if (!s.items.length) {
    container.innerHTML = `<div class="card muted">Geen voorbeeldzinnen gevonden.</div>`;
    return;
  }

  if (s.done) {
    const pct = Math.round((s.points / s.items.length) * 100);
    container.innerHTML = `
      <div class="card summary-box">
        <h3>Invuloefening klaar!</h3>
        <div class="summary-score">${pct}%</div>
        <p class="muted">Score: ${s.points} / ${s.items.length} · Voortgang automatisch bewaard</p>
        <div class="btn-row" style="justify-content:center;margin-top:1rem;">
          <button type="button" class="btn btn-primary" data-cloze-action="restart">Opnieuw oefenen</button>
          <button type="button" class="btn btn-secondary" data-vocab-mode="zinsbouw">Ga naar Zinsbouw-puzzel →</button>
        </div>
      </div>
    `;
    return;
  }

  const item = s.items[s.idx];
  const gapIdx = item.fr.indexOf(item.gat);
  const before = gapIdx >= 0 ? item.fr.slice(0, gapIdx) : "";
  const after = gapIdx >= 0 ? item.fr.slice(gapIdx + item.gat.length) : "";

  let feedbackHtml = "";
  if (s.answered && s.lastResult) {
    const r = s.lastResult;
    const cls = r.kind === "exact" ? "ok" : r.kind === "accent" ? "warn" : "error";
    const msg =
      r.kind === "exact"
        ? `<strong>Helemaal juist!</strong> ${escapeHtml(item.fr)}`
        : r.kind === "accent"
          ? `<strong>Bijna! Let op het accent/hoofdletter:</strong> <code>${escapeHtml(item.gat)}</code> (0,5 pt)<br>${escapeHtml(item.fr)}`
          : `<strong>Niet helemaal.</strong> Juiste woord: <strong>${escapeHtml(item.gat)}</strong><br>${escapeHtml(item.fr)}`;
    feedbackHtml = `
      <div class="feedback-box ${cls}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;">
          <div>${msg}</div>
          <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(item.fr)}" title="Luister zin">🔊</button>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card exercise-card">
      <div class="exercise-progress">
        <span>Zin ${s.idx + 1} van ${s.items.length}${App.vocab.scope.startsWith("__mix") ? ` · ${escapeHtml(item.wfTitel)}` : ""}</span>
        <span>Score: ${s.points} / ${s.items.length}</span>
      </div>
      <div class="muted">Vertaling (hint): <strong>${escapeHtml(item.nl)}</strong></div>
      <div class="cloze-sentence">
        ${escapeHtml(before)}<input id="cloze-answer" class="cloze-input" type="text" value="${escapeHtml(s.lastResult?.given || "")}" ${s.answered ? "disabled" : ""} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="…" />${escapeHtml(after)}
      </div>
      ${!s.answered ? renderAccentBar() : ""}
      <div class="btn-row">
        ${!s.answered ? `
          <button type="button" class="btn btn-primary" data-cloze-action="check">Controleer</button>
          <button type="button" class="btn btn-secondary" data-cloze-action="hint">Eerste letter</button>
        ` : `
          <button type="button" class="btn btn-primary" data-cloze-action="next">${s.idx + 1 < s.items.length ? "Volgende zin →" : "Bekijk resultaat"}</button>
        `}
      </div>
      ${feedbackHtml}
    </div>
  `;

  if (!s.answered) {
    const inp = document.getElementById("cloze-answer");
    if (inp) inp.focus();
  }
}

/* Mode 4: Zinsbouw-puzzel */
function splitSentenceForBuilder(fr) {
  const m = fr.trim().match(/^(.*?)([.?!])$/);
  const body = m ? m[1] : fr.trim();
  const punct = m ? m[2] : "";
  const tokens = body.split(/\s+/).filter(Boolean);
  let bank = tokens.map((word, idx) => ({ id: idx, word }));
  if (bank.length > 1) {
    for (let tries = 0; tries < 6; tries++) {
      bank = shuffleArray(bank);
      if (bank.some((t, i) => t.word !== tokens[i])) break;
    }
  }
  return { tokens, punct, bank };
}

function startBuilderSession() {
  const pool = shuffleArray(getVocabSentencePool());
  const raw = App.vocab.scope.startsWith("__mix") ? pool.slice(0, 6) : pool;
  const items = raw.map((item) => ({
    ...item,
    ...splitSentenceForBuilder(item.fr),
  }));
  App.vocab.session = {
    type: "zinsbouw",
    items,
    idx: 0,
    selected: [],
    points: 0,
    perWf: {},
    answered: false,
    wasCorrect: false,
    done: false,
  };
}

function renderVocabBuilder(container) {
  if (!App.vocab.session || App.vocab.session.type !== "zinsbouw") startBuilderSession();
  const s = App.vocab.session;

  if (!s.items.length) {
    container.innerHTML = `<div class="card muted">Geen zinnen beschikbaar.</div>`;
    return;
  }

  if (s.done) {
    const pct = Math.round((s.points / s.items.length) * 100);
    container.innerHTML = `
      <div class="card summary-box">
        <h3>Zinsbouw-puzzel voltooid!</h3>
        <div class="summary-score">${pct}%</div>
        <p class="muted">${s.points} van ${s.items.length} zinnen correct gebouwd · Voortgang automatisch bewaard</p>
        <div class="btn-row" style="justify-content:center;margin-top:1rem;">
          <button type="button" class="btn btn-primary" data-builder-action="restart">Opnieuw spelen</button>
          <button type="button" class="btn btn-secondary" data-vocab-mode="lijst">Terug naar Woordenlijst</button>
        </div>
      </div>
    `;
    return;
  }

  const item = s.items[s.idx];
  const usedIds = new Set(s.selected.map((t) => t.id));

  let feedbackHtml = "";
  if (s.answered) {
    feedbackHtml = `
      <div class="feedback-box ${s.wasCorrect ? "ok" : "error"}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;">
          <div>
            ${s.wasCorrect ? "<strong>Perfect gebouwd!</strong>" : "<strong>Nog niet de juiste volgorde.</strong> Correcte zin:"}
            <div>${escapeHtml(item.fr)}</div>
          </div>
          <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(item.fr)}" title="Luister zin">🔊</button>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card exercise-card">
      <div class="exercise-progress">
        <span>Puzzel ${s.idx + 1} van ${s.items.length}${App.vocab.scope.startsWith("__mix") ? ` · ${escapeHtml(item.wfTitel)}` : ""}</span>
        <span>Score: ${s.points} / ${s.items.length}</span>
      </div>
      <div class="muted">Bouw de Franse zin voor: <strong>${escapeHtml(item.nl)}</strong></div>
      <div class="builder-zone${s.selected.length ? " has-items" : ""}">
        ${s.selected.length
          ? s.selected.map((t, pos) => `<button type="button" class="word-tile selected" data-builder-remove="${pos}" ${s.answered ? "disabled" : ""}>${escapeHtml(t.word)}</button>`).join("")
          : `<span class="muted">Klik op de woordkaarten hieronder om de zin samen te stellen…</span>`
        }
        ${item.punct ? `<span style="font-weight:800;font-size:1.1rem;margin-left:0.2rem;">${escapeHtml(item.punct)}</span>` : ""}
      </div>
      <div class="builder-bank">
        ${item.bank.map((t) => `<button type="button" class="word-tile" data-builder-pick="${t.id}" ${usedIds.has(t.id) || s.answered ? "disabled" : ""}>${escapeHtml(t.word)}</button>`).join("")}
      </div>
      <div class="btn-row">
        ${!s.answered ? `
          <button type="button" class="btn btn-primary" data-builder-action="check" ${s.selected.length !== item.tokens.length ? "disabled" : ""}>Controleer</button>
          <button type="button" class="btn btn-secondary" data-builder-action="hint">Hint</button>
          <button type="button" class="btn btn-secondary" data-builder-action="clear">Wis</button>
        ` : `
          <button type="button" class="btn btn-primary" data-builder-action="next">${s.idx + 1 < s.items.length ? "Volgende puzzel →" : "Bekijk resultaat"}</button>
        `}
      </div>
      ${feedbackHtml}
    </div>
  `;
}

function finalizeVocabScores(perWf, fallbackPct) {
  if (!App.vocab.scope.startsWith("__mix")) {
    recordWfScore(App.vocab.scope, fallbackPct);
    return;
  }
  for (const [wfId, stat] of Object.entries(perWf)) {
    if (stat.total > 0) recordWfScore(wfId, (stat.pts / stat.total) * 100);
  }
}

function handleVocabStageClick(e) {
  const speakBtn = e.target.closest("[data-speak]");
  if (speakBtn) {
    e.stopPropagation();
    speakFrench(speakBtn.dataset.speak);
    return;
  }

  const modeJump = e.target.closest("[data-vocab-mode]");
  if (modeJump) {
    setVocabMode(modeJump.dataset.vocabMode);
    return;
  }

  // Word list actions
  const hideBtn = e.target.closest("[data-hide]");
  if (hideBtn) {
    App.vocab.hideMode = hideBtn.dataset.hide;
    renderVocabStage();
    return;
  }

  const revealEl = e.target.closest("[data-reveal]");
  if (revealEl && revealEl.classList.contains("word-blurred")) {
    revealEl.classList.toggle("revealed");
    return;
  }

  const hardBtn = e.target.closest("[data-hard-wf]");
  if (hardBtn) {
    toggleHardWord(hardBtn.dataset.hardWf, hardBtn.dataset.hardWord);
    renderVocabStage();
    return;
  }

  // Flashcards actions
  const flashDirBtn = e.target.closest("[data-flash-dir]");
  if (flashDirBtn) {
    App.vocab.flashDir = flashDirBtn.dataset.flashDir;
    startFlashSession();
    renderVocabStage();
    return;
  }

  if (e.target.closest("[data-flash-hard]")) {
    App.vocab.flashHardOnly = !App.vocab.flashHardOnly;
    startFlashSession();
    renderVocabStage();
    return;
  }

  const flashAct = e.target.closest("[data-flash-action]");
  if (flashAct && App.vocab.session?.type === "flits") {
    const s = App.vocab.session;
    const act = flashAct.dataset.flashAction;
    if (act === "restart") {
      startFlashSession();
    } else if (act === "flip") {
      s.flipped = !s.flipped;
    } else if (act === "known" || act === "retry") {
      const card = s.deck[s.idx];
      if (act === "known") {
        s.known += 1;
        if (getWfProgress(card.wfId).hardWords.includes(card.fr)) {
          toggleHardWord(card.wfId, card.fr);
        }
      } else {
        s.retry += 1;
        if (!getWfProgress(card.wfId).hardWords.includes(card.fr)) {
          toggleHardWord(card.wfId, card.fr);
        }
      }
      if (s.idx + 1 < s.deck.length) {
        s.idx += 1;
        s.flipped = false;
      } else {
        s.done = true;
        if (!App.vocab.scope.startsWith("__mix")) {
          recordWfScore(App.vocab.scope, (s.known / s.deck.length) * 100);
        }
      }
    }
    renderVocabStage();
    return;
  }

  // Accent bar
  const accBtn = e.target.closest("[data-accent]");
  if (accBtn) {
    insertAtCursor(document.getElementById("cloze-answer"), accBtn.dataset.accent);
    return;
  }

  // Cloze actions
  const clozeAct = e.target.closest("[data-cloze-action]");
  if (clozeAct && App.vocab.session?.type === "invul") {
    const s = App.vocab.session;
    const act = clozeAct.dataset.clozeAction;
    if (act === "restart") {
      startClozeSession();
      renderVocabStage();
    } else if (act === "hint") {
      const inp = document.getElementById("cloze-answer");
      const target = s.items[s.idx].gat;
      if (inp && !inp.value) {
        inp.value = target.slice(0, Math.min(2, target.length));
        inp.focus();
      }
    } else if (act === "check") {
      submitClozeAnswer();
    } else if (act === "next") {
      if (s.idx + 1 < s.items.length) {
        s.idx += 1;
        s.answered = false;
        s.lastResult = null;
      } else {
        s.done = true;
        finalizeVocabScores(s.perWf, (s.points / s.items.length) * 100);
      }
      renderVocabStage();
    }
    return;
  }

  // Sentence builder actions
  const pickBtn = e.target.closest("[data-builder-pick]");
  if (pickBtn && App.vocab.session?.type === "zinsbouw" && !App.vocab.session.answered) {
    const s = App.vocab.session;
    const id = Number(pickBtn.dataset.builderPick);
    const tok = s.items[s.idx].bank.find((t) => t.id === id);
    if (tok && !s.selected.some((x) => x.id === id)) {
      s.selected.push(tok);
      renderVocabStage();
    }
    return;
  }

  const remBtn = e.target.closest("[data-builder-remove]");
  if (remBtn && App.vocab.session?.type === "zinsbouw" && !App.vocab.session.answered) {
    const pos = Number(remBtn.dataset.builderRemove);
    App.vocab.session.selected.splice(pos, 1);
    renderVocabStage();
    return;
  }

  const builderAct = e.target.closest("[data-builder-action]");
  if (builderAct && App.vocab.session?.type === "zinsbouw") {
    const s = App.vocab.session;
    const item = s.items[s.idx];
    const act = builderAct.dataset.builderAction;
    if (act === "restart") {
      startBuilderSession();
    } else if (act === "clear") {
      s.selected = [];
    } else if (act === "hint") {
      const nextWord = item.tokens[s.selected.length];
      if (nextWord) {
        const usedIds = new Set(s.selected.map((t) => t.id));
        const match = item.bank.find((t) => !usedIds.has(t.id) && t.word === nextWord);
        if (match) s.selected.push(match);
      }
    } else if (act === "check") {
      const built = s.selected.map((t) => t.word).join(" ");
      const expected = item.tokens.join(" ");
      s.wasCorrect = normalizeFr(built) === normalizeFr(expected);
      s.answered = true;
      const pts = s.wasCorrect ? 1 : 0;
      s.points += pts;
      const st = s.perWf[item.wfId] || { pts: 0, total: 0 };
      s.perWf[item.wfId] = { pts: st.pts + pts, total: st.total + 1 };
    } else if (act === "next") {
      if (s.idx + 1 < s.items.length) {
        s.idx += 1;
        s.selected = [];
        s.answered = false;
      } else {
        s.done = true;
        finalizeVocabScores(s.perWf, (s.points / s.items.length) * 100);
      }
    }
    renderVocabStage();
  }
}

function submitClozeAnswer() {
  const s = App.vocab.session;
  if (!s || s.type !== "invul" || s.answered) return;
  const inp = document.getElementById("cloze-answer");
  const given = inp ? inp.value : "";
  const item = s.items[s.idx];
  const kind = checkFrenchAnswer(given, item.gat);
  const pts = kind === "exact" ? 1 : kind === "accent" ? 0.5 : 0;
  s.points += pts;
  const st = s.perWf[item.wfId] || { pts: 0, total: 0 };
  s.perWf[item.wfId] = { pts: st.pts + pts, total: st.total + 1 };
  s.answered = true;
  s.lastResult = { kind, given };
  renderVocabStage();
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
    if (wfBtn) openVocabField(wfBtn.dataset.openWf);
    const grBtn = e.target.closest("[data-open-gr]");
    if (grBtn) switchTab("drill", "grammar");
  });

  document.getElementById("vocab-wf-select").addEventListener("change", (e) => {
    App.vocab.scope = e.target.value;
    App.vocab.session = null;
    renderVocabStage();
  });

  document.getElementById("vocab-wf-meta").addEventListener("change", (e) => {
    const wfId = e.target.dataset.vocabWfStatus;
    if (wfId) setWfStatus(wfId, e.target.value);
  });

  document.getElementById("vocab-mode-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-vocab-mode]");
    if (btn) setVocabMode(btn.dataset.vocabMode);
  });

  document.getElementById("vocab-stage").addEventListener("click", handleVocabStageClick);
  document.getElementById("vocab-stage").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "cloze-answer") {
      e.preventDefault();
      submitClozeAnswer();
    }
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
    initVocabControls();
    renderDashboard();
  } catch (err) {
    showBanner(`Fout bij opstarten: ${err.message}`, true);
  }
}

init();
