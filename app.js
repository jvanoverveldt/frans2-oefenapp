const LOCAL_FALLBACK_KEY = "frans2_progress_fallback_v1";
const FRENCH_ACCENTS = ["é", "è", "ê", "ë", "à", "â", "ç", "ù", "û", "ô", "î", "ï", "œ"];
const LEITNER_HOURS = [0, 0, 24, 72, 240];
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
    group: "__all",
    mode: "toets",
    hideMode: "none",
    listSearch: "",
    listFilter: "all",
    quizStyle: "adaptief",
    quizCount: 10,
    flashDir: "nl-fr",
    sentenceSource: "local",
    aiBatches: {},
    aiLoading: false,
    aiError: "",
    session: null,
  },
};

function defaultProgress() {
  return {
    version: 2,
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
    version: 2,
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
      temperature: 0.5,
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

/* ---------- Automatic Per-Word Mastery & Spaced Repetition ---------- */

function ensureWfBucket(wfId) {
  if (!App.progress.woordvelden[wfId] || typeof App.progress.woordvelden[wfId] !== "object") {
    App.progress.woordvelden[wfId] = { words: {}, sessions: 0, lastPracticed: null };
  }
  if (!App.progress.woordvelden[wfId].words || typeof App.progress.woordvelden[wfId].words !== "object") {
    App.progress.woordvelden[wfId].words = {};
  }
  return App.progress.woordvelden[wfId];
}

function getWordState(wfId, frWord) {
  const w = App.progress.woordvelden[wfId]?.words?.[frWord];
  if (!w) {
    return { box: 0, seen: 0, correct: 0, wrong: 0, streak: 0, typedCorrect: 0, nextReview: null, lastSeen: null };
  }
  return {
    box: Number(w.box) || 0,
    seen: Number(w.seen) || 0,
    correct: Number(w.correct) || 0,
    wrong: Number(w.wrong) || 0,
    streak: Number(w.streak) || 0,
    typedCorrect: Number(w.typedCorrect) || 0,
    nextReview: w.nextReview || null,
    lastSeen: w.lastSeen || null,
  };
}

function isWordDue(ws, nowMs = Date.now()) {
  if (ws.box <= 0) return false;
  if (ws.box === 1) return true;
  if (!ws.nextReview) return true;
  return Date.parse(ws.nextReview) <= nowMs;
}

function updateWordMastery(wfId, frWord, outcome, isActiveProduction = true) {
  const bucket = ensureWfBucket(wfId);
  const cur = getWordState(wfId, frWord);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  if (outcome === "warmup") {
    bucket.words[frWord] = { ...cur, seen: cur.seen + 1, lastSeen: nowIso };
    bucket.lastPracticed = nowIso;
    scheduleSaveProgress();
    return bucket.words[frWord];
  }

  let { box, correct, wrong, streak, typedCorrect } = cur;
  const seen = cur.seen + 1;

  if (outcome === "exact") {
    correct += 1;
    streak += 1;
    if (isActiveProduction) {
      typedCorrect += 1;
      box = box === 0 ? 2 : Math.min(4, box + 1);
    } else {
      // Meerkeuze kan opwarmen tot max. box 2; beheersing (box 3-4) vereist actief schrijven
      box = Math.min(2, Math.max(box, box + 1));
    }
  } else if (outcome === "accent" || outcome === "article") {
    wrong += 1;
    streak = 0;
    box = Math.max(1, Math.min(box, 2));
  } else {
    wrong += 1;
    streak = 0;
    box = 1;
  }

  const nextMs = now + (LEITNER_HOURS[box] || 0) * 3600 * 1000;
  bucket.words[frWord] = {
    box,
    seen,
    correct,
    wrong,
    streak,
    typedCorrect,
    nextReview: new Date(nextMs).toISOString(),
    lastSeen: nowIso,
  };
  bucket.lastPracticed = nowIso;
  scheduleSaveProgress();
  return bucket.words[frWord];
}

function computeWfMetrics(wf) {
  const nowMs = Date.now();
  const total = wf.woorden.length;
  let started = 0;
  let mastered = 0;
  let weak = 0;
  let due = 0;
  let sumCorrect = 0;
  let sumWrong = 0;

  for (const w of wf.woorden) {
    const ws = getWordState(wf.id, w.fr);
    if (ws.seen > 0) started += 1;
    if (ws.box >= 3) mastered += 1;
    if (ws.box === 1) weak += 1;
    if (isWordDue(ws, nowMs)) due += 1;
    sumCorrect += ws.correct;
    sumWrong += ws.wrong;
  }

  const attempts = sumCorrect + sumWrong;
  const accuracy = attempts > 0 ? Math.round((sumCorrect / attempts) * 100) : null;
  const masteredPct = total > 0 ? Math.round((mastered / total) * 100) : 0;

  let status = "niet_gestart";
  if (started > 0 || attempts > 0) {
    status = masteredPct >= 80 && (accuracy === null || accuracy >= 80) ? "beheerst" : "oefenen";
  }

  return { total, started, mastered, masteredPct, weak, due, attempts, accuracy, status };
}

function computeGrMetrics(id) {
  const raw = App.progress.grammatica[id] || {};
  const attempts = Number(raw.attempts) || 0;
  const score = raw.score ?? null;
  let status = "niet_gestart";
  if (attempts > 0) {
    status = score !== null && score >= 80 && attempts >= 2 ? "beheerst" : "oefenen";
  }
  return { status, score, attempts };
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

/* ---------- Shared Drill & French Utilities ---------- */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function stripLeadingArticle(str) {
  return normalizeFr(str).replace(/^(?:une|un|des|les|le|la|l')\s*/i, "").trim();
}

function expandAcceptedVariants(rawFr) {
  const cleaned = String(rawFr || "")
    .replace(/\((?:Frankrijk|België|Zwitserland|m|f|pl|mv|ev|informeel|formeel|ook [^)]+|bijv\.? [^)]+)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const variants = new Set();
  const add = (v) => {
    const n = normalizeFr(v);
    if (n) variants.add(n);
  };

  for (const seg of cleaned.split(/\s*\/\s*/)) {
    const s = seg.trim();
    if (!s) continue;
    add(s);
    // e.g. "un(e) docteur" or "ensoleillé(e)"
    if (/\(e\)/i.test(s)) {
      add(s.replace(/\(e\)/gi, ""));
      add(s.replace(/\(e\)/gi, "e"));
    }
    // e.g. "blanc (blanche)" or "un avocat (une avocate)"
    const paren = s.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
    if (paren) {
      add(paren[1]);
      add(paren[2]);
    }
    add(s.replace(/\([^)]*\)/g, ""));
  }
  return [...variants];
}

function checkVocabTypedAnswer(given, expectedFr) {
  const g = normalizeFr(given);
  if (!g) return "empty";
  const variants = expandAcceptedVariants(expectedFr);
  for (const v of variants) {
    if (g === v) return "exact";
  }
  const gNoAcc = stripAccents(g);
  for (const v of variants) {
    if (gNoAcc === stripAccents(v)) return "accent";
  }
  // Check if learner wrote the right noun but omitted the required French article
  for (const v of variants) {
    const bare = stripLeadingArticle(v);
    if (bare && bare !== v) {
      if (g === bare || gNoAcc === stripAccents(bare)) return "article";
    }
  }
  return "wrong";
}

function checkClozeAnswer(given, expected) {
  const g = normalizeFr(given);
  const e = normalizeFr(expected);
  if (!g) return "empty";
  if (g === e) return "exact";
  if (stripAccents(g) === stripAccents(e)) return "accent";
  return "wrong";
}

function renderAccentBar(targetInputId = "vocab-answer-input") {
  return `<div class="accent-bar" aria-label="Franse accenten">${FRENCH_ACCENTS.map(
    (ch) => `<button type="button" class="accent-btn" data-accent="${ch}" data-accent-target="${targetInputId}">${ch}</button>`
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

function renderMasteryDots(box) {
  const labels = ["Nieuw", "Herhalen", "Op weg", "Goed", "Beheerst"];
  const dots = [1, 2, 3, 4].map((lvl) => {
    let cls = "mastery-dot";
    if (box === 1 && lvl === 1) cls += " weak";
    else if (box >= 3 && lvl <= box) cls += " mastered";
    else if (lvl <= box) cls += " filled";
    return `<span class="${cls}"></span>`;
  }).join("");
  return `<span class="mastery-dots" title="Niveau: ${labels[box] || "Nieuw"} (${box}/4)">${dots}</span>`;
}

function findMatchingWordForGat(wfId, gat) {
  const wf = App.curriculum.woordvelden.find((w) => w.id === wfId);
  if (!wf || !gat) return null;
  const g = stripAccents(gat);
  for (const w of wf.woorden) {
    for (const v of expandAcceptedVariants(w.fr)) {
      const bare = stripAccents(stripLeadingArticle(v));
      if (bare === g || stripAccents(v) === g) return w.fr;
    }
  }
  return null;
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

/* ---------- Tab 1: Dashboard (100% automatisch berekend) ---------- */

function renderDashboard() {
  if (!App.curriculum || !App.progress) return;
  const wfList = App.curriculum.woordvelden;
  const grAll = App.curriculum.grammatica.flatMap((p) => p.onderdelen);

  const wfStats = wfList.map((wf) => ({ wf, m: computeWfMetrics(wf) }));
  const wfMastered = wfStats.filter((x) => x.m.status === "beheerst").length;
  const wfPracticing = wfStats.filter((x) => x.m.status === "oefenen").length;
  const totalWords = wfStats.reduce((s, x) => s + x.m.total, 0);
  const totalWordsMastered = wfStats.reduce((s, x) => s + x.m.mastered, 0);
  const totalWordsDue = wfStats.reduce((s, x) => s + x.m.due, 0);

  const grMastered = grAll.filter((g) => computeGrMetrics(g.id).status === "beheerst").length;
  const grPracticing = grAll.filter((g) => computeGrMetrics(g.id).status === "oefenen").length;
  const readiness = computeWeightedReadiness();

  const nextTip = totalWordsDue > 0
    ? `Je hebt ${totalWordsDue} woord(en) klaar voor gespreide herhaling.`
    : !App.config.hasKey
      ? "Stel je Gemini API-key in bij Instellingen voor AI-zinnen en examenevaluatie."
      : totalWordsMastered < 50
        ? "Start een reeks 'Toets & Inprenten' om je eerste woorden actief te beheersen."
        : "Wissel woordenschat af met schrijven, spreken en grammatica.";

  document.getElementById("dashboard-kpis").innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Examengereedheid (gewogen)</div>
      <div class="kpi-value">${readiness.totalPct}%</div>
      <div class="progress-bar"><div class="progress-fill" style="width:${readiness.totalPct}%"></div></div>
      <div class="kpi-sub">${readiness.coveredWeight}% van de examendomeinen geoefend</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Woordenschat (${totalWords} woorden)</div>
      <div class="kpi-value">${totalWordsMastered} / ${totalWords}</div>
      <div class="progress-bar"><div class="progress-fill ok" style="width:${Math.round((totalWordsMastered / Math.max(1, totalWords)) * 100)}%"></div></div>
      <div class="kpi-sub">${wfMastered}/23 velden beheerst · ${totalWordsDue} te herhalen</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Grammatica (4 pijlers)</div>
      <div class="kpi-value">${grMastered} / ${grAll.length}</div>
      <div class="progress-bar"><div class="progress-fill ok" style="width:${Math.round((grMastered / grAll.length) * 100)}%"></div></div>
      <div class="kpi-sub">${grPracticing} bezig met oefenen · ${grAll.length - grMastered - grPracticing} niet gestart</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Aanbevolen volgende stap</div>
      <div class="kpi-value" style="font-size:1rem;line-height:1.35;margin-top:0.45rem;">${escapeHtml(nextTip)}</div>
      <div class="kpi-sub">Status wordt automatisch bepaald uit je resultaten</div>
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

  // 23 Woordvelden (read-only status derived strictly from results)
  document.getElementById("wf-summary-text").textContent =
    `${wfMastered} beheerst · ${wfPracticing} aan het oefenen · ${totalWords} woorden (beheerst vanaf 80% actief gekend)`;

  const q = App.wfSearch.trim().toLowerCase();
  const filteredWf = wfStats.filter(({ wf, m }) => {
    if (App.wfFilter !== "all" && m.status !== App.wfFilter) return false;
    if (q && !wf.titel_nl.toLowerCase().includes(q) && !wf.titel_fr.toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById("dashboard-wf-grid").innerHTML = filteredWf.length
    ? filteredWf.map(({ wf, m }) => `
        <div class="wf-card">
          <div class="wf-head">
            <span class="wf-num">${String(wf.nummer).padStart(2, "0")}</span>
            <span class="wf-title">${escapeHtml(wf.titel_nl)}</span>
          </div>
          <div class="wf-fr">${escapeHtml(wf.titel_fr)}</div>
          <div class="progress-bar" style="margin:0.15rem 0;"><div class="progress-fill ok" style="width:${m.masteredPct}%"></div></div>
          <div class="wf-progress-meta">
            <span>${m.mastered} / ${m.total} beheerst${m.accuracy !== null ? ` · ${m.accuracy}%` : ""}</span>
            ${m.due > 0 ? `<span class="due-badge">↻ ${m.due}</span>` : ""}
          </div>
          <div class="wf-actions">
            <span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>
            <button class="btn btn-secondary btn-sm" type="button" data-open-wf="${wf.id}">Oefen</button>
          </div>
        </div>
      `).join("")
    : `<div class="card muted">Geen woordvelden gevonden voor deze filter.</div>`;

  // Grammatica (read-only status derived from results)
  document.getElementById("gr-summary-text").textContent =
    `${grMastered} van ${grAll.length} onderdelen beheerst (automatisch op basis van oefenresultaten)`;

  document.getElementById("dashboard-gr-pillars").innerHTML = App.curriculum.grammatica.map((p) => {
    const doneCount = p.onderdelen.filter((o) => computeGrMetrics(o.id).status === "beheerst").length;
    const items = p.onderdelen.map((o) => {
      const m = computeGrMetrics(o.id);
      const scoreTxt = m.score !== null ? ` (${m.score}%)` : "";
      return `
        <li class="gr-item">
          <div class="gr-item-name">${escapeHtml(o.naam)}${scoreTxt}</div>
          <div class="gr-item-bar">
            <span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>
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

/* ---------- Tab 5a: Woordenschat (Uitbreidbaar VOCAB_MODES register) ---------- */

const VOCAB_MODES = [
  { id: "toets", label: "Toets & Inprenten", render: renderVocabQuiz },
  { id: "invul", label: "Invuloefening (Zinnen)", render: renderVocabCloze },
  { id: "zinsbouw", label: "Zinsbouw-puzzel", render: renderVocabBuilder },
  { id: "lijst", label: "Woordenlijst", render: renderVocabList },
  { id: "flits", label: "Flitskaarten (Opwarming)", render: renderVocabFlashcards },
];

function getSelectedVocabFields() {
  const all = App.curriculum.woordvelden;
  if (App.vocab.scope === "__mix_all") return all;
  if (App.vocab.scope === "__mix_due") {
    const withDue = all.filter((wf) => computeWfMetrics(wf).due > 0);
    return withDue.length ? withDue : all;
  }
  if (App.vocab.scope === "__mix_todo") {
    const todo = all.filter((wf) => computeWfMetrics(wf).status !== "beheerst");
    return todo.length ? todo : all;
  }
  const single = all.find((w) => w.id === App.vocab.scope);
  return single ? [single] : [all[0]];
}

function getVocabGroupsForScope() {
  if (App.vocab.scope.startsWith("__mix")) return [];
  const wf = getSelectedVocabFields()[0];
  const groups = [];
  const seen = new Set();
  for (const w of wf.woorden) {
    if (w.groep && !seen.has(w.groep)) {
      seen.add(w.groep);
      groups.push(w.groep);
    }
  }
  return groups;
}

function getVocabWordPool() {
  const fields = getSelectedVocabFields();
  let pool = fields.flatMap((wf) =>
    wf.woorden.map((w) => ({ ...w, wfId: wf.id, wfTitel: wf.titel_nl }))
  );
  if (!App.vocab.scope.startsWith("__mix") && App.vocab.group !== "__all") {
    const sub = pool.filter((w) => w.groep === App.vocab.group);
    if (sub.length) pool = sub;
  }
  return pool;
}

function selectPriorityWords(pool, limit) {
  const nowMs = Date.now();
  const scored = pool.map((w) => {
    const ws = getWordState(w.wfId, w.fr);
    let priority = 3; // already practiced, not due yet
    if (ws.box === 1) priority = 0; // fout geweest -> hoogste prioriteit
    else if (isWordDue(ws, nowMs)) priority = 1; // gespreide herhaling vervallen
    else if (ws.box === 0) priority = 2; // nieuw woord
    const lastMs = ws.lastSeen ? Date.parse(ws.lastSeen) : 0;
    return { w, priority, lastMs, rand: Math.random() };
  });
  scored.sort((a, b) => a.priority - b.priority || a.lastMs - b.lastMs || a.rand - b.rand);
  return scored.slice(0, limit).map((x) => x.w);
}

function getBatchCacheKey() {
  return `${App.vocab.scope}::${App.vocab.group}`;
}

function getActiveSentencePool() {
  const key = getBatchCacheKey();
  if (App.vocab.sentenceSource === "ai" && App.vocab.aiBatches[key]?.length) {
    return App.vocab.aiBatches[key];
  }
  return getSelectedVocabFields().flatMap((wf) =>
    wf.voorbeelden.map((vb) => ({ ...vb, wfId: wf.id, wfTitel: wf.titel_nl }))
  );
}

function initVocabControls() {
  const select = document.getElementById("vocab-wf-select");
  const wfOpts = App.curriculum.woordvelden
    .map((wf) => `<option value="${wf.id}">${String(wf.nummer).padStart(2, "0")} · ${escapeHtml(wf.titel_nl)} (${wf.woorden.length})</option>`)
    .join("");
  select.innerHTML = `
    <optgroup label="Slimme herhaling">
      <option value="__mix_due">Herhaal · Vervallen &amp; moeilijke woorden</option>
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

  populateVocabGroups();
  renderVocabMeta();
}

function populateVocabGroups() {
  const wrap = document.getElementById("vocab-group-wrap");
  const sel = document.getElementById("vocab-group-select");
  const groups = getVocabGroupsForScope();
  if (!groups.length) {
    wrap.classList.add("hidden");
    App.vocab.group = "__all";
    return;
  }
  wrap.classList.remove("hidden");
  const wf = getSelectedVocabFields()[0];
  sel.innerHTML = `<option value="__all">Alle deelthema's (${wf.woorden.length})</option>` +
    groups.map((g) => {
      const cnt = wf.woorden.filter((w) => w.groep === g).length;
      return `<option value="${escapeHtml(g)}">${escapeHtml(g)} (${cnt})</option>`;
    }).join("");
  if (!groups.includes(App.vocab.group)) App.vocab.group = "__all";
  sel.value = App.vocab.group;
}

function renderVocabMeta() {
  const wrap = document.getElementById("vocab-wf-meta");
  if (!wrap || !App.curriculum) return;
  if (App.vocab.scope.startsWith("__mix")) {
    const pool = getVocabWordPool();
    const due = pool.filter((w) => isWordDue(getWordState(w.wfId, w.fr))).length;
    wrap.innerHTML = `<span class="muted">${pool.length} woorden in selectie</span>${due ? `<span class="due-badge">↻ ${due} te herhalen</span>` : ""}`;
    return;
  }
  const wf = App.curriculum.woordvelden.find((w) => w.id === App.vocab.scope);
  if (!wf) return;
  const m = computeWfMetrics(wf);
  wrap.innerHTML = `
    <span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>
    <span class="score-badge">${m.mastered}/${m.total} beheerst</span>
    ${m.due > 0 ? `<span class="due-badge">↻ ${m.due} te herhalen</span>` : ""}
  `;
}

function openVocabField(wfId) {
  App.vocab.scope = wfId;
  App.vocab.group = "__all";
  App.vocab.session = null;
  App.vocab.aiError = "";
  const select = document.getElementById("vocab-wf-select");
  if (select) select.value = wfId;
  populateVocabGroups();
  switchTab("drill", "vocab");
  renderVocabMeta();
}

function setVocabMode(modeId) {
  App.vocab.mode = modeId;
  App.vocab.session = null;
  App.vocab.aiError = "";
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

/* ---------- Batch AI Sentence Generator (compact <= 1500 tokens) ---------- */

async function generateAiVocabSentences() {
  const pool = getVocabWordPool();
  if (!pool.length) return;
  const targets = selectPriorityWords(pool, 8);
  const scopeLabel = App.vocab.scope.startsWith("__mix")
    ? "Gemengde B1 woordenschat"
    : getSelectedVocabFields()[0].titel_nl;

  App.vocab.aiLoading = true;
  App.vocab.aiError = "";
  renderVocabStage();

  try {
    const wordLines = targets.map((w) => `- ${w.fr} (${w.nl})`).join("\n");
    const prompt = [
      `Maak voor een Vlaamse leerling (Frans niveau B1, thema: ${scopeLabel}) precies ${targets.length} gevarieerde, natuurlijke Franse voorbeeldzinnen (8-15 woorden per zin): één zin per doelwoord.`,
      `Doelwoorden:\n${wordLines}`,
      `Geef UITSLUITEND een JSON-array terug met objecten: {"targetWord":"exact Frans doelwoord uit de lijst","fr":"Franse zin","nl":"natuurlijke Nederlandse vertaling","gat":"het exacte ingevulde Franse woord/woordgroep zoals het letterlijk in fr staat"}.`,
      `Regels: "gat" moet letterlijk in "fr" voorkomen, geen lidwoorden/spaties fout, duidelijke context.`,
    ].join("\n\n");

    const parsed = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 1100 });
    if (!Array.isArray(parsed)) throw new Error("Onverwacht antwoordformaat van Gemini.");

    const byLower = new Map(targets.map((t) => [t.fr.toLowerCase(), t]));
    const valid = [];
    for (const item of parsed) {
      if (!item || typeof item.fr !== "string" || typeof item.nl !== "string" || typeof item.gat !== "string") continue;
      if (!item.fr.includes(item.gat)) continue;
      const matched = byLower.get(String(item.targetWord || "").toLowerCase()) || targets[valid.length] || targets[0];
      valid.push({
        fr: item.fr.trim(),
        nl: item.nl.trim(),
        gat: item.gat.trim(),
        wfId: matched.wfId,
        wfTitel: matched.wfTitel,
        targetWord: matched.fr,
        isAi: true,
      });
    }
    if (!valid.length) throw new Error("Geen geldige zinnen ontvangen. Probeer opnieuw.");

    App.vocab.aiBatches[getBatchCacheKey()] = valid;
    App.vocab.sentenceSource = "ai";
    App.vocab.session = null;
  } catch (err) {
    App.vocab.aiError = err.message;
  } finally {
    App.vocab.aiLoading = false;
    renderVocabStage();
  }
}

function renderSentenceSourceBar() {
  const key = getBatchCacheKey();
  const aiCount = App.vocab.aiBatches[key]?.length || 0;
  const localCount = getSelectedVocabFields().reduce((s, wf) => s + wf.voorbeelden.length, 0);
  const usingAi = App.vocab.sentenceSource === "ai" && aiCount > 0;
  return `
    <div class="ai-batch-bar">
      <div>
        <strong>Bron zinnen:</strong>
        ${usingAi ? `✨ AI-batch (${aiCount} verse zinnen op maat van zwakke woorden)` : `Lokale cursus (${localCount} voorbeeldzinnen)`}
      </div>
      <div class="btn-row">
        <button type="button" class="chip${!usingAi ? " active" : ""}" data-sent-source="local">Lokaal (${localCount})</button>
        ${aiCount > 0 ? `<button type="button" class="chip${usingAi ? " active" : ""}" data-sent-source="ai">✨ AI-batch (${aiCount})</button>` : ""}
        <button type="button" class="btn btn-primary btn-sm" data-ai-batch="generate" ${App.vocab.aiLoading ? "disabled" : ""}>
          ${App.vocab.aiLoading ? "Zinnen genereren…" : aiCount ? "✨ Nieuwe AI-zinnen" : "✨ Genereer AI-zinnen (batch)"}
        </button>
      </div>
    </div>
    ${App.vocab.aiError ? `<div class="banner error">${escapeHtml(App.vocab.aiError)}</div>` : ""}
  `;
}

/* ---------- Mode 1: Toets & Inprenten (eerlijke toetsing + herhalingslus) ---------- */

function buildMcOptions(target, fullPool) {
  const distractors = shuffleArray(fullPool.filter((w) => w.fr !== target.fr)).slice(0, 3);
  return shuffleArray([target, ...distractors]).map((w) => w.fr);
}

function startQuizSession() {
  const pool = getVocabWordPool();
  const selected = selectPriorityWords(pool, Math.min(App.vocab.quizCount, pool.length));
  const queue = selected.map((w) => {
    const ws = getWordState(w.wfId, w.fr);
    let askMode = "type";
    if (App.vocab.quizStyle === "mc") askMode = "mc";
    else if (App.vocab.quizStyle === "adaptief" && ws.box === 0 && pool.length >= 4) askMode = "mc";
    return {
      word: w,
      askMode,
      options: askMode === "mc" ? buildMcOptions(w, pool) : null,
      isRetry: false,
      firstAttemptRecorded: false,
    };
  });
  App.vocab.session = {
    type: "toets",
    queue,
    initialTotal: queue.length,
    firstCorrect: 0,
    firstPartial: 0,
    firstWrong: 0,
    retriesCompleted: 0,
    answered: false,
    lastResult: null,
    done: false,
  };
}

function renderVocabQuiz(container) {
  if (!App.vocab.session || App.vocab.session.type !== "toets") startQuizSession();
  const s = App.vocab.session;

  if (!s.queue.length && !s.done) {
    container.innerHTML = `<div class="card muted">Geen woorden beschikbaar in deze selectie.</div>`;
    return;
  }

  const controlsHtml = `
    <div class="stage-toolbar">
      <div class="filter-group">
        <button type="button" class="chip${App.vocab.quizStyle === "adaptief" ? " active" : ""}" data-quiz-style="adaptief">Adaptief (aanbevolen)</button>
        <button type="button" class="chip${App.vocab.quizStyle === "type" ? " active" : ""}" data-quiz-style="type">Enkel schrijven (streng)</button>
        <button type="button" class="chip${App.vocab.quizStyle === "mc" ? " active" : ""}" data-quiz-style="mc">Meerkeuze (opwarming)</button>
      </div>
      <div class="filter-group">
        ${[10, 15, 20].map((n) => `<button type="button" class="chip${App.vocab.quizCount === n ? " active" : ""}" data-quiz-count="${n}">${n} woorden</button>`).join("")}
      </div>
    </div>
  `;

  if (s.done) {
    const pct = Math.round(((s.firstCorrect + s.firstPartial * 0.5) / Math.max(1, s.initialTotal)) * 100);
    container.innerHTML = `
      <div class="card exercise-card">
        ${controlsHtml}
        <div class="summary-box">
          <h3>Toets &amp; Inprenten afgerond!</h3>
          <div class="summary-score">${pct}%</div>
          <p class="muted">
            Eerste poging: <strong>${s.firstCorrect}</strong> juist · <strong>${s.firstPartial}</strong> bijna (accent/lidwoord) · <strong>${s.firstWrong}</strong> fout
            ${s.retriesCompleted ? `<br>Extra ingeprent in herhaalronde: <strong>${s.retriesCompleted}×</strong>` : ""}
          </p>
          <p class="muted">Je per-woord voortgang en herhaaldata zijn automatisch opgeslagen.</p>
          <div class="btn-row" style="justify-content:center;margin-top:1rem;">
            <button type="button" class="btn btn-primary" data-quiz-action="restart">Volgende reeks (${App.vocab.quizCount} woorden)</button>
            <button type="button" class="btn btn-secondary" data-vocab-mode="invul">Oefen in zinnen →</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const cur = s.queue[0];
  const ws = getWordState(cur.word.wfId, cur.word.fr);
  const remaining = s.queue.length;

  let inputAreaHtml = "";
  if (cur.askMode === "mc") {
    inputAreaHtml = `
      <div class="mc-grid">
        ${cur.options.map((opt, idx) => {
          let cls = "mc-option";
          if (s.answered) {
            if (opt === cur.word.fr) cls += " is-correct";
            else if (opt === s.lastResult?.given) cls += " is-wrong";
          }
          return `<button type="button" class="${cls}" data-quiz-mc="${idx}" ${s.answered ? "disabled" : ""}>${escapeHtml(opt)}</button>`;
        }).join("")}
      </div>
    `;
  } else {
    inputAreaHtml = `
      <input id="vocab-answer-input" class="quiz-input" type="text" value="${escapeHtml(s.lastResult?.given || "")}" ${s.answered ? "disabled" : ""} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="Typ het Franse woord (inclusief lidwoord indien van toepassing)…" />
      ${!s.answered ? renderAccentBar("vocab-answer-input") : ""}
      <div class="btn-row" style="margin-top:0.6rem;">
        ${!s.answered ? `
          <button type="button" class="btn btn-primary" data-quiz-action="check">Controleer</button>
          <button type="button" class="btn btn-secondary" data-quiz-action="reveal">Ik weet het niet</button>
        ` : ""}
      </div>
    `;
  }

  let feedbackHtml = "";
  if (s.answered && s.lastResult) {
    const r = s.lastResult;
    const cls = r.kind === "exact" ? "ok" : (r.kind === "accent" || r.kind === "article") ? "warn" : "error";
    const headline =
      r.kind === "exact"
        ? (cur.askMode === "mc" ? "Juist herkend! (Komt later nog terug als schrijfoefening)" : "Helemaal juist!")
        : r.kind === "accent"
          ? "Bijna! Let op het accent — dit woord komt zo meteen nog eens terug om in te prenten."
          : r.kind === "article"
            ? "Juiste stam, maar vergeet het lidwoord niet — komt zo meteen nog eens terug."
            : "Nog niet gekend — dit woord komt achteraan in deze reeks opnieuw terug als schrijfoefening.";

    feedbackHtml = `
      <div class="feedback-box ${cls}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;">
          <div>
            <strong>${headline}</strong>
            <div style="margin-top:0.25rem;font-size:1.05rem;"><strong>${escapeHtml(cur.word.fr)}</strong> — ${escapeHtml(cur.word.nl)}</div>
          </div>
          <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(cur.word.fr)}" title="Luister uitspraak">🔊</button>
        </div>
      </div>
      <div class="btn-row" style="margin-top:0.8rem;">
        <button type="button" class="btn btn-primary" id="btn-quiz-next" data-quiz-action="next">Volgende →</button>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="card exercise-card">
      ${controlsHtml}
      <div class="exercise-progress">
        <span>Nog <strong>${remaining}</strong> te gaan in deze reeks${cur.word.groep ? ` · ${escapeHtml(cur.word.groep)}` : ""}</span>
        <span style="display:inline-flex;align-items:center;gap:0.5rem;">
          ${cur.isRetry ? `<span class="retry-badge">↻ Inprent-herhaling</span>` : ""}
          ${renderMasteryDots(ws.box)}
        </span>
      </div>
      <div class="quiz-prompt-box">
        <div class="quiz-prompt-label">${cur.askMode === "mc" ? "Kies het juiste Franse woord (opwarming)" : "Vertaal naar het Frans (actief schrijven)"}</div>
        <div class="quiz-prompt-word">${escapeHtml(cur.word.nl)}</div>
        ${App.vocab.scope.startsWith("__mix") ? `<div class="muted">${escapeHtml(cur.word.wfTitel)}</div>` : ""}
      </div>
      ${inputAreaHtml}
      ${feedbackHtml}
    </div>
  `;

  if (!s.answered && cur.askMode === "type") {
    const inp = document.getElementById("vocab-answer-input");
    if (inp) inp.focus();
  }
}

function evaluateQuizAttempt(kind, given) {
  const s = App.vocab.session;
  if (!s || s.type !== "toets" || s.answered) return;
  const cur = s.queue[0];

  if (!cur.firstAttemptRecorded) {
    cur.firstAttemptRecorded = true;
    if (kind === "exact") s.firstCorrect += 1;
    else if (kind === "accent" || kind === "article") s.firstPartial += 1;
    else s.firstWrong += 1;
    updateWordMastery(cur.word.wfId, cur.word.fr, kind, cur.askMode === "type");
  } else if (kind === "exact") {
    s.retriesCompleted += 1;
  }

  s.answered = true;
  s.lastResult = { kind, given };
  renderVocabStage();
}

function advanceQuizQueue() {
  const s = App.vocab.session;
  if (!s || s.type !== "toets" || !s.answered) return;
  const cur = s.queue.shift();
  const kind = s.lastResult?.kind;

  // Fout, accentfout of lidwoordfout -> opnieuw achteraan als actieve schrijfoefening om in te prenten!
  if (kind !== "exact") {
    s.queue.push({
      word: cur.word,
      askMode: "type",
      options: null,
      isRetry: true,
      firstAttemptRecorded: true,
    });
  }

  s.answered = false;
  s.lastResult = null;
  if (!s.queue.length) {
    s.done = true;
  }
  renderVocabStage();
}

/* ---------- Mode 2: Contextuele invuloefening (Zinnen + AI-batch) ---------- */

function startClozeSession() {
  const pool = shuffleArray(getActiveSentencePool());
  const items = pool.slice(0, Math.min(8, pool.length));
  App.vocab.session = {
    type: "invul",
    queue: items.map((item) => ({ item, isRetry: false, recorded: false })),
    initialTotal: items.length,
    points: 0,
    answered: false,
    lastResult: null,
    done: false,
  };
}

function renderVocabCloze(container) {
  if (!App.vocab.session || App.vocab.session.type !== "invul") startClozeSession();
  const s = App.vocab.session;
  const sourceBar = renderSentenceSourceBar();

  if (!s.queue.length && !s.done) {
    container.innerHTML = `${sourceBar}<div class="card muted">Geen voorbeeldzinnen gevonden.</div>`;
    return;
  }

  if (s.done) {
    const pct = Math.round((s.points / Math.max(1, s.initialTotal)) * 100);
    container.innerHTML = `
      ${sourceBar}
      <div class="card summary-box">
        <h3>Invuloefening klaar!</h3>
        <div class="summary-score">${pct}%</div>
        <p class="muted">Eerste poging: ${s.points} / ${s.initialTotal} · Per-woord voortgang bijgewerkt</p>
        <div class="btn-row" style="justify-content:center;margin-top:1rem;">
          <button type="button" class="btn btn-primary" data-cloze-action="restart">Nieuwe reeks zinnen</button>
          <button type="button" class="btn btn-secondary" data-vocab-mode="zinsbouw">Ga naar Zinsbouw-puzzel →</button>
        </div>
      </div>
    `;
    return;
  }

  const cur = s.queue[0];
  const item = cur.item;
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
          ? `<strong>Bijna! Let op het accent:</strong> <code>${escapeHtml(item.gat)}</code> (komt nog eens terug)<br>${escapeHtml(item.fr)}`
          : `<strong>Niet helemaal.</strong> Juiste woord: <strong>${escapeHtml(item.gat)}</strong> (komt achteraan opnieuw terug)<br>${escapeHtml(item.fr)}`;
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
    ${sourceBar}
    <div class="card exercise-card">
      <div class="exercise-progress">
        <span>Nog <strong>${s.queue.length}</strong> zin(nen) in deze reeks${item.isAi ? " · ✨ AI-zin" : ""}</span>
        <span>${cur.isRetry ? `<span class="retry-badge">↻ Herhaalzin</span>` : `Score: ${s.points} / ${s.initialTotal}`}</span>
      </div>
      <div class="muted">Vertaling (hint): <strong>${escapeHtml(item.nl)}</strong></div>
      <div class="cloze-sentence">
        ${escapeHtml(before)}<input id="cloze-answer" class="cloze-input" type="text" value="${escapeHtml(s.lastResult?.given || "")}" ${s.answered ? "disabled" : ""} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="…" />${escapeHtml(after)}
      </div>
      ${!s.answered ? renderAccentBar("cloze-answer") : ""}
      <div class="btn-row">
        ${!s.answered ? `
          <button type="button" class="btn btn-primary" data-cloze-action="check">Controleer</button>
          <button type="button" class="btn btn-secondary" data-cloze-action="reveal">Toon antwoord</button>
        ` : `
          <button type="button" class="btn btn-primary" data-cloze-action="next">Volgende →</button>
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

function submitClozeAnswer(forceWrong = false) {
  const s = App.vocab.session;
  if (!s || s.type !== "invul" || s.answered) return;
  const inp = document.getElementById("cloze-answer");
  const given = forceWrong ? "" : (inp ? inp.value : "");
  const cur = s.queue[0];
  const item = cur.item;
  const kind = forceWrong ? "wrong" : checkClozeAnswer(given, item.gat);

  if (!cur.recorded) {
    cur.recorded = true;
    const pts = kind === "exact" ? 1 : kind === "accent" ? 0.5 : 0;
    s.points += pts;
    const linkedWord = item.targetWord || findMatchingWordForGat(item.wfId, item.gat);
    if (linkedWord) {
      updateWordMastery(item.wfId, linkedWord, kind, true);
    }
  }
  s.answered = true;
  s.lastResult = { kind, given };
  renderVocabStage();
}

/* ---------- Mode 3: Zinsbouw-puzzel (Lokaal + AI-batch) ---------- */

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
  const pool = shuffleArray(getActiveSentencePool());
  const items = pool.slice(0, Math.min(6, pool.length)).map((item) => ({
    ...item,
    ...splitSentenceForBuilder(item.fr),
  }));
  App.vocab.session = {
    type: "zinsbouw",
    items,
    idx: 0,
    selected: [],
    points: 0,
    usedHint: false,
    answered: false,
    wasCorrect: false,
    done: false,
  };
}

function renderVocabBuilder(container) {
  if (!App.vocab.session || App.vocab.session.type !== "zinsbouw") startBuilderSession();
  const s = App.vocab.session;
  const sourceBar = renderSentenceSourceBar();

  if (!s.items.length) {
    container.innerHTML = `${sourceBar}<div class="card muted">Geen zinnen beschikbaar.</div>`;
    return;
  }

  if (s.done) {
    const pct = Math.round((s.points / Math.max(1, s.items.length)) * 100);
    container.innerHTML = `
      ${sourceBar}
      <div class="card summary-box">
        <h3>Zinsbouw-puzzel voltooid!</h3>
        <div class="summary-score">${pct}%</div>
        <p class="muted">${s.points} van ${s.items.length} zinnen zelfstandig correct gebouwd</p>
        <div class="btn-row" style="justify-content:center;margin-top:1rem;">
          <button type="button" class="btn btn-primary" data-builder-action="restart">Nieuwe puzzels</button>
          <button type="button" class="btn btn-secondary" data-vocab-mode="toets">Terug naar Toets &amp; Inprenten</button>
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
    ${sourceBar}
    <div class="card exercise-card">
      <div class="exercise-progress">
        <span>Puzzel ${s.idx + 1} van ${s.items.length}${item.isAi ? " · ✨ AI-zin" : ""}</span>
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

/* ---------- Mode 4: Woordenlijst (met automatische mastery-stipjes) ---------- */

function renderVocabList(container) {
  const words = getVocabWordPool();
  const hide = App.vocab.hideMode;
  const q = App.vocab.listSearch.trim().toLowerCase();
  const lf = App.vocab.listFilter;

  const filtered = words.filter((w) => {
    const ws = getWordState(w.wfId, w.fr);
    if (lf === "nieuw" && ws.box !== 0) return false;
    if (lf === "herhalen" && !(ws.box === 1 || isWordDue(ws))) return false;
    if (lf === "beheerst" && ws.box < 3) return false;
    if (q && !w.fr.toLowerCase().includes(q) && !w.nl.toLowerCase().includes(q)) return false;
    return true;
  });

  const shown = filtered.slice(0, 150);

  container.innerHTML = `
    <div class="card">
      <div class="stage-toolbar">
        <div class="toolbar">
          <input id="vocab-list-search" class="input input-sm" type="search" value="${escapeHtml(App.vocab.listSearch)}" placeholder="Zoek woord…" />
          <div class="filter-group">
            <button type="button" class="chip${lf === "all" ? " active" : ""}" data-list-filter="all">Alle (${words.length})</button>
            <button type="button" class="chip${lf === "nieuw" ? " active" : ""}" data-list-filter="nieuw">Nieuw</button>
            <button type="button" class="chip${lf === "herhalen" ? " active" : ""}" data-list-filter="herhalen">Herhalen</button>
            <button type="button" class="chip${lf === "beheerst" ? " active" : ""}" data-list-filter="beheerst">Beheerst</button>
          </div>
        </div>
        <div class="filter-group">
          <button type="button" class="chip${hide === "none" ? " active" : ""}" data-hide="none">Toon alles</button>
          <button type="button" class="chip${hide === "fr" ? " active" : ""}" data-hide="fr">Verberg Frans</button>
          <button type="button" class="chip${hide === "nl" ? " active" : ""}" data-hide="nl">Verberg NL</button>
        </div>
      </div>
      <div class="word-table">
        ${shown.length ? shown.map((w) => {
          const ws = getWordState(w.wfId, w.fr);
          return `
            <div class="word-row${ws.box === 1 ? " is-hard" : ""}">
              <div class="word-pair">
                <span class="word-fr${hide === "fr" ? " word-blurred" : ""}" data-reveal="1">${escapeHtml(w.fr)}</span>
                <span class="word-nl${hide === "nl" ? " word-blurred" : ""}" data-reveal="1">${escapeHtml(w.nl)}</span>
              </div>
              <div class="word-row-actions">
                ${renderMasteryDots(ws.box)}
                <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(w.fr)}" title="Luister uitspraak">🔊</button>
              </div>
            </div>
          `;
        }).join("") : `<p class="muted">Geen woorden gevonden voor deze filter.</p>`}
      </div>
      ${filtered.length > shown.length ? `<p class="muted" style="margin-top:0.75rem;">Eerste ${shown.length} van ${filtered.length} woorden getoond. Gebruik het deelthema- of zoekfilter om te verfijnen.</p>` : ""}
    </div>
  `;
}

/* ---------- Mode 5: Flitskaarten (enkel opwarming, telt niet als beheersing) ---------- */

function startFlashSession() {
  const pool = getVocabWordPool();
  const deck = selectPriorityWords(pool, Math.min(15, pool.length));
  App.vocab.session = { type: "flits", deck, idx: 0, flipped: false, done: false };
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
    container.innerHTML = `
      <div class="card summary-box">
        <h3>Opwarming afgerond!</h3>
        <p class="muted">Klaar voor de echte test? Start <strong>Toets &amp; Inprenten</strong> om je officiële voortgang op te bouwen.</p>
        <div class="btn-row" style="justify-content:center;margin-top:1rem;">
          <button type="button" class="btn btn-primary" data-vocab-mode="toets">Start Toets &amp; Inprenten →</button>
          <button type="button" class="btn btn-secondary" data-flash-action="restart">Nog een opwarmreeks</button>
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
        <span class="muted">Opwarming · Kaart <strong>${s.idx + 1} / ${s.deck.length}</strong> (telt niet als beheerst)</span>
        <div class="filter-group">
          <button type="button" class="chip${dir === "nl-fr" ? " active" : ""}" data-flash-dir="nl-fr">NL → FR</button>
          <button type="button" class="chip${dir === "fr-nl" ? " active" : ""}" data-flash-dir="fr-nl">FR → NL</button>
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
            <button type="button" class="btn btn-primary" data-flash-action="next">Volgende kaart →</button>
          ` : `
            <button type="button" class="btn btn-primary" data-flash-action="flip">Toon vertaling</button>
          `}
        </div>
      </div>
    </div>
  `;
}

/* ---------- Vocab Stage Event Delegation ---------- */

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

  // AI batch sentences controls
  const srcBtn = e.target.closest("[data-sent-source]");
  if (srcBtn) {
    App.vocab.sentenceSource = srcBtn.dataset.sentSource;
    App.vocab.session = null;
    renderVocabStage();
    return;
  }

  if (e.target.closest("[data-ai-batch]")) {
    generateAiVocabSentences();
    return;
  }

  // Accent buttons
  const accBtn = e.target.closest("[data-accent]");
  if (accBtn) {
    insertAtCursor(document.getElementById(accBtn.dataset.accentTarget), accBtn.dataset.accent);
    return;
  }

  // Quiz controls & actions
  const qStyle = e.target.closest("[data-quiz-style]");
  if (qStyle) {
    App.vocab.quizStyle = qStyle.dataset.quizStyle;
    startQuizSession();
    renderVocabStage();
    return;
  }

  const qCount = e.target.closest("[data-quiz-count]");
  if (qCount) {
    App.vocab.quizCount = Number(qCount.dataset.quizCount);
    startQuizSession();
    renderVocabStage();
    return;
  }

  const mcBtn = e.target.closest("[data-quiz-mc]");
  if (mcBtn && App.vocab.session?.type === "toets" && !App.vocab.session.answered) {
    const cur = App.vocab.session.queue[0];
    const picked = cur.options[Number(mcBtn.dataset.quizMc)];
    evaluateQuizAttempt(picked === cur.word.fr ? "exact" : "wrong", picked);
    return;
  }

  const qAct = e.target.closest("[data-quiz-action]");
  if (qAct && App.vocab.session?.type === "toets") {
    const act = qAct.dataset.quizAction;
    if (act === "restart") {
      startQuizSession();
      renderVocabStage();
    } else if (act === "check") {
      const inp = document.getElementById("vocab-answer-input");
      const given = inp ? inp.value : "";
      const kind = checkVocabTypedAnswer(given, App.vocab.session.queue[0].word.fr);
      if (kind !== "empty") evaluateQuizAttempt(kind, given);
    } else if (act === "reveal") {
      evaluateQuizAttempt("wrong", "");
    } else if (act === "next") {
      advanceQuizQueue();
    }
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
    } else if (act === "check") {
      submitClozeAnswer(false);
    } else if (act === "reveal") {
      submitClozeAnswer(true);
    } else if (act === "next") {
      const cur = s.queue.shift();
      if (s.lastResult?.kind !== "exact") {
        s.queue.push({ item: cur.item, isRetry: true, recorded: true });
      }
      s.answered = false;
      s.lastResult = null;
      if (!s.queue.length) s.done = true;
      renderVocabStage();
    }
    return;
  }

  // Builder actions
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
    App.vocab.session.selected.splice(Number(remBtn.dataset.builderRemove), 1);
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
      s.usedHint = true;
      const nextWord = item.tokens[s.selected.length];
      if (nextWord) {
        const usedIds = new Set(s.selected.map((t) => t.id));
        const match = item.bank.find((t) => !usedIds.has(t.id) && t.word === nextWord);
        if (match) s.selected.push(match);
      }
    } else if (act === "check") {
      const built = s.selected.map((t) => t.word).join(" ");
      s.wasCorrect = normalizeFr(built) === normalizeFr(item.tokens.join(" "));
      s.answered = true;
      if (s.wasCorrect && !s.usedHint) s.points += 1;
      const linkedWord = item.targetWord || findMatchingWordForGat(item.wfId, item.gat);
      if (linkedWord) {
        updateWordMastery(item.wfId, linkedWord, s.wasCorrect && !s.usedHint ? "exact" : "wrong", true);
      }
    } else if (act === "next") {
      if (s.idx + 1 < s.items.length) {
        s.idx += 1;
        s.selected = [];
        s.usedHint = false;
        s.answered = false;
      } else {
        s.done = true;
      }
    }
    renderVocabStage();
    return;
  }

  // Word list controls
  const hideBtn = e.target.closest("[data-hide]");
  if (hideBtn) {
    App.vocab.hideMode = hideBtn.dataset.hide;
    renderVocabStage();
    return;
  }

  const lfBtn = e.target.closest("[data-list-filter]");
  if (lfBtn) {
    App.vocab.listFilter = lfBtn.dataset.listFilter;
    renderVocabStage();
    return;
  }

  const revealEl = e.target.closest("[data-reveal]");
  if (revealEl && revealEl.classList.contains("word-blurred")) {
    revealEl.classList.toggle("revealed");
    return;
  }

  // Flashcards (warmup only)
  const flashDirBtn = e.target.closest("[data-flash-dir]");
  if (flashDirBtn) {
    App.vocab.flashDir = flashDirBtn.dataset.flashDir;
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
    } else if (act === "next") {
      const card = s.deck[s.idx];
      updateWordMastery(card.wfId, card.fr, "warmup", false);
      if (s.idx + 1 < s.deck.length) {
        s.idx += 1;
        s.flipped = false;
      } else {
        s.done = true;
      }
    }
    renderVocabStage();
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
    App.vocab.session = null;
    scheduleSaveProgress();
    renderDashboard();
    if (App.activeTab === "drill") renderVocabStage();
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
    App.vocab.group = "__all";
    App.vocab.session = null;
    App.vocab.aiError = "";
    populateVocabGroups();
    renderVocabStage();
  });

  document.getElementById("vocab-group-select").addEventListener("change", (e) => {
    App.vocab.group = e.target.value;
    App.vocab.session = null;
    App.vocab.aiError = "";
    renderVocabStage();
  });

  document.getElementById("vocab-mode-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-vocab-mode]");
    if (btn) setVocabMode(btn.dataset.vocabMode);
  });

  const stage = document.getElementById("vocab-stage");
  stage.addEventListener("click", handleVocabStageClick);
  stage.addEventListener("input", (e) => {
    if (e.target.id === "vocab-list-search") {
      App.vocab.listSearch = e.target.value;
      const pos = e.target.selectionStart;
      renderVocabStage();
      const el = document.getElementById("vocab-list-search");
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    }
  });
  stage.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.target.id === "vocab-answer-input" && App.vocab.session?.type === "toets") {
      e.preventDefault();
      if (!App.vocab.session.answered) {
        const kind = checkVocabTypedAnswer(e.target.value, App.vocab.session.queue[0].word.fr);
        if (kind !== "empty") evaluateQuizAttempt(kind, e.target.value);
      }
    } else if (e.target.id === "cloze-answer" && App.vocab.session?.type === "invul") {
      e.preventDefault();
      if (!App.vocab.session.answered) submitClozeAnswer(false);
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
    App.vocab.session = null;
    scheduleSaveProgress();
    renderDashboard();
    if (App.activeTab === "drill") renderVocabStage();
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
