const LOCAL_FALLBACK_KEY = "frans2_progress_fallback_v1";
const FRENCH_ACCENTS = ["é", "è", "ê", "ë", "à", "â", "ç", "ù", "û", "ô", "î", "ï", "œ"];
const LEITNER_HOURS = [0, 0, 24, 72, 240]; // box 2: 1d, box 3: 3d, box 4 (beheerst): 10d
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
    view: "overview", // "overview" | "practice"
    scope: "wf01",
    group: "__all",
    mode: "toets",
    hideMode: "none",
    listSearch: "",
    listFilter: "all",
    quizCount: 10,
    sentenceSource: "auto", // "auto" (AI if key configured, else local) | "ai" | "local"
    aiBatches: {},
    aiLoading: false,
    aiError: "",
    session: null,
  },
  write: {
    mode: "schrijven", // "schrijven" | "interactie" | "examen"
    wfId: "wf02",
    doelId: "informatie",
    helperOpen: false,
    loading: false,
    evaluating: false,
    timerId: null,
    timerRunning: false,
    openArchiveId: null,
  },
  speak: {
    mode: "monoloog", // "monoloog" | "gesprek_oefen" | "gesprek_examen"
    wfId: "wf20",
    doelId: "vertellen",
    loading: false,
    busy: false,
    helperOpen: false,
    ttsEnabled: true,
    ttsRate: 0.95,
    timerId: null,
    timerRunning: false,
    recorder: null,
    recChunks: [],
    recStream: null,
    recStartMs: 0,
    recTickId: null,
    recSeconds: 0,
    recMode: null, // "monoloog" | "gesprek"
    monologue: null,
    dialogue: null,
    openArchiveId: null,
  },
  grammar: {
    view: "overview", // "overview" | "practice"
    pillar: "__all",
    topicId: "gr01",
    mode: "ai_coach", // "ai_coach" | "basis" | "leerkracht"
    ruleCollapsed: false,
    exerciseType: "mix",
    count: 5,
    loading: false,
    evaluating: false,
    activeInputId: null,
    session: null,
    offlineSession: null,
  },
};

function defaultProgress() {
  return {
    version: 2,
    updatedAt: null,
    woordvelden: {},
    grammatica: {},
    customGrammar: {},
    grammaticaArchief: [],
    evaluaties: [],
    zwakkePunten: [],
    schrijfConcept: null,
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
    customGrammar: raw.customGrammar && typeof raw.customGrammar === "object" ? raw.customGrammar : {},
    grammaticaArchief: Array.isArray(raw.grammaticaArchief) ? raw.grammaticaArchief : [],
    evaluaties: Array.isArray(raw.evaluaties) ? raw.evaluaties : [],
    zwakkePunten: Array.isArray(raw.zwakkePunten) ? raw.zwakkePunten : [],
    schrijfConcept: raw.schrijfConcept && typeof raw.schrijfConcept === "object" ? raw.schrijfConcept : null,
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

async function callGemini({ prompt, systemInstruction = "", jsonMode = false, contents = null, maxOutputTokens = 1400, temperature = 0.55 }) {
  if (!App.serverMode) {
    throw new Error("Start eerst 'python server.py' om Gemini AI-calls te gebruiken.");
  }
  const body = {
    model: App.config.model,
    contents: contents || [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
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

/* ---------- Automatic Per-Word Leitner Mastery (3 spaced reps -> Beheerst) ---------- */

function ensureWfBucket(wfId) {
  if (!App.progress.woordvelden[wfId] || typeof App.progress.woordvelden[wfId] !== "object") {
    App.progress.woordvelden[wfId] = { words: {}, lastPracticed: null };
  }
  if (!App.progress.woordvelden[wfId].words || typeof App.progress.woordvelden[wfId].words !== "object") {
    App.progress.woordvelden[wfId].words = {};
  }
  return App.progress.woordvelden[wfId];
}

function getWordState(wfId, frWord) {
  const w = App.progress.woordvelden[wfId]?.words?.[frWord];
  if (!w) {
    return { box: 0, seen: 0, correct: 0, wrong: 0, streak: 0, nextReview: null, lastSeen: null };
  }
  return {
    box: Number(w.box) || 0,
    seen: Number(w.seen) || 0,
    correct: Number(w.correct) || 0,
    wrong: Number(w.wrong) || 0,
    streak: Number(w.streak) || 0,
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

function updateWordMastery(wfId, frWord, outcome) {
  const bucket = ensureWfBucket(wfId);
  const cur = getWordState(wfId, frWord);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let { box, correct, wrong, streak, nextReview } = cur;
  const seen = cur.seen + 1;

  if (outcome === "exact") {
    correct += 1;
    streak += 1;
    // Box 0/1 -> box 2 (1x foutloos, +1 dag); box 2->3 (+3 dagen) en 3->4 (beheerst, +10 dagen) enkel wanneer herhaling vervallen is
    if (box <= 1) {
      box = 2;
      nextReview = new Date(now + LEITNER_HOURS[2] * 3600 * 1000).toISOString();
    } else if (isWordDue(cur, now)) {
      box = Math.min(4, box + 1);
      nextReview = new Date(now + LEITNER_HOURS[box] * 3600 * 1000).toISOString();
    }
  } else {
    // Fout, accentfout of lidwoordfout -> terug naar box 1 (herhalen)
    wrong += 1;
    streak = 0;
    box = 1;
    nextReview = nowIso;
  }

  bucket.words[frWord] = {
    box,
    seen,
    correct,
    wrong,
    streak,
    nextReview,
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
  let mastered = 0; // box === 4 (3x foutloos verspreid over de tijd)
  let inProgress = 0; // box 2-3
  let weak = 0; // box 1
  let due = 0;
  let sumCorrect = 0;
  let sumWrong = 0;

  for (const w of wf.woorden) {
    const ws = getWordState(wf.id, w.fr);
    if (ws.seen > 0) started += 1;
    if (ws.box >= 4) mastered += 1;
    else if (ws.box >= 2) inProgress += 1;
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

  return { total, started, mastered, inProgress, masteredPct, weak, due, attempts, accuracy, status };
}

function computeGrMetrics(id) {
  const raw = App.progress.grammatica[id] || {};
  const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const offlineCount = Number(raw.offlineCount) || 0;
  const attempts = sessions.length + offlineCount;
  const goodDays = new Set(sessions.filter((s) => Number(s.scorePct) >= 75).map((s) => s.dayKey));
  const lastScore = sessions.length ? sessions[sessions.length - 1].scorePct : null;
  const weakPoints = Array.isArray(raw.weakPoints) ? raw.weakPoints : [];

  let status = "niet_gestart";
  if (attempts > 0) {
    status = goodDays.size >= 2 ? "beheerst" : "oefenen";
  }
  return {
    status,
    score: lastScore,
    attempts,
    aiSessions: sessions.length,
    goodDaysCount: goodDays.size,
    weakPoints,
  };
}

function getDomainStats(domain) {
  const list = App.progress.evaluaties.filter((e) => e.domein === domain);
  if (!list.length) {
    return { status: "niet_gestart", count: 0, goodCount: 0, lastScore: null, avgScore: null, masteredPct: 0, inProgressPct: 0 };
  }
  const scores = list.map((e) => Number(e.scorePct)).filter((n) => Number.isFinite(n));
  const goodCount = scores.filter((s) => s >= 70).length; // minstens 'Goed' (>= 70%)
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const last = scores.length ? scores[scores.length - 1] : null;
  const mastered = goodCount >= 3;
  const status = mastered ? "beheerst" : "oefenen";
  const masteredPct = mastered ? 100 : 0;
  const inProgressPct = mastered ? 0 : (goodCount > 0 ? Math.round((goodCount / 3) * 100) : 15);
  return { status, count: list.length, goodCount, lastScore: last, avgScore: avg, masteredPct, inProgressPct };
}

function computeExamWeightedProgress() {
  const w = App.curriculum.examen.weging;
  const parts = [
    { key: "schrijven", weight: w.schrijven, stats: getDomainStats("schrijven") },
    { key: "gesprek", weight: w.gesprek, stats: getDomainStats("gesprek") },
    { key: "monoloog", weight: w.monoloog, stats: getDomainStats("monoloog") },
  ];
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0); // 58 + 30 + 8 = 96
  let masteredW = 0;
  let progressW = 0;
  for (const p of parts) {
    masteredW += (p.weight * p.stats.masteredPct) / 100;
    progressW += (p.weight * p.stats.inProgressPct) / 100;
  }
  const masteredPct = Math.round((masteredW / totalWeight) * 100);
  const inProgressPct = Math.min(100 - masteredPct, Math.round((progressW / totalWeight) * 100));
  return { masteredPct, inProgressPct, totalWeight, parts };
}

function renderStackedBar(masteredPct, inProgressPct, compact = false) {
  const m = Math.max(0, Math.min(100, Math.round(masteredPct)));
  const p = Math.max(0, Math.min(100 - m, Math.round(inProgressPct)));
  return `
    <div class="stacked-bar${compact ? " compact" : ""}" role="progressbar" aria-valuenow="${m}" aria-valuemin="0" aria-valuemax="100" title="Beheerst: ${m}% · Op weg: ${p}%">
      <div class="seg-mastered" style="width:${m}%"></div>
      <div class="seg-progress" style="width:${p}%"></div>
    </div>
  `;
}

function renderBarLegend(masteredLabel, progressLabel) {
  return `
    <div class="bar-legend">
      <span><span class="legend-dot mastered"></span>${escapeHtml(masteredLabel)}</span>
      <span><span class="legend-dot progress"></span>${escapeHtml(progressLabel)}</span>
    </div>
  `;
}

/* ---------- Shared Drill & French Utilities ---------- */

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreToCategory(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return { id: "onvoldoende", label: "Onvoldoende", rank: 0 };
  if (n < 45) return { id: "onvoldoende", label: "Onvoldoende", rank: 0 };
  if (n < 55) return { id: "bijna", label: "Bijna voldoende", rank: 1 };
  if (n < 70) return { id: "voldoende", label: "Voldoende", rank: 2 };
  if (n < 85) return { id: "goed", label: "Goed", rank: 3 };
  return { id: "excellent", label: "Excellent", rank: 4 };
}

function renderCategoryBadge(pct, large = false) {
  const cat = scoreToCategory(pct);
  return `<span class="cat-badge${large ? " cat-badge-lg" : ""} cat-${cat.id}">${cat.label}</span>`;
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

function hasRequiredArticle(rawFr) {
  return expandAcceptedVariants(rawFr).some((v) => stripLeadingArticle(v) !== v);
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
    if (/\(e\)/i.test(s)) {
      add(s.replace(/\(e\)/gi, ""));
      add(s.replace(/\(e\)/gi, "e"));
    }
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
    (ch) => `<button type="button" class="accent-btn" data-accent="${ch}" data-accent-target="${targetInputId}" tabindex="-1">${ch}</button>`
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
  // 3 stappen richting Beheerst: box 2 = 1/3, box 3 = 2/3, box 4 = 3/3 (Beheerst)
  const labels = ["Nieuw", "Fout (herhalen)", "1/3 goed (herhaal +1d)", "2/3 goed (herhaal +3d)", "Beheerst (3/3)"];
  const filledSteps = box >= 2 ? box - 1 : 0;
  const dots = [1, 2, 3].map((step) => {
    let cls = "mastery-dot";
    if (box === 1 && step === 1) cls += " weak";
    else if (box >= 4) cls += " mastered";
    else if (step <= filledSteps) cls += " filled";
    return `<span class="${cls}"></span>`;
  }).join("");
  return `<span class="mastery-dots" title="${labels[box] || "Nieuw"}">${dots}</span>`;
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

function renderPrevFeedbackBar(fb) {
  if (!fb) return "";
  const cls = fb.kind === "exact" ? "ok" : (fb.kind === "accent" || fb.kind === "article") ? "warn" : "error";
  let title = "";
  if (fb.kind === "exact") {
    title = `✓ Juist: ${escapeHtml(fb.expected)}`;
  } else if (fb.kind === "accent") {
    title = `Bijna (accentfout — komt terug): `;
  } else if (fb.kind === "article") {
    title = `Bijna (lidwoord vergeten — komt terug): `;
  } else {
    title = `Fout (komt terug): `;
  }

  const wrongSnippet = fb.kind !== "exact" && fb.given
    ? `<span class="prev-wrong-strike">${escapeHtml(fb.given)}</span>→ `
    : "";

  const detailLine = fb.kind === "exact"
    ? (fb.sub ? `<span class="muted">${escapeHtml(fb.sub)}</span>` : "")
    : `<div>${wrongSnippet}<strong>${escapeHtml(fb.expected)}</strong>${fb.sub ? ` <span class="muted">(${escapeHtml(fb.sub)})</span>` : ""}</div>`;

  return `
    <div class="prev-feedback ${cls}" role="status" aria-live="polite">
      <div class="prev-feedback-detail">
        <strong>${title}</strong>
        ${detailLine}
      </div>
      <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(fb.speakText || fb.expected)}" title="Luister uitspraak" tabindex="-1">🔊</button>
    </div>
  `;
}

/* ---------- Navigation ---------- */

function switchTab(tabId) {
  App.activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${tabId}`);
  });
  if (tabId === "dashboard") renderDashboard();
  if (tabId === "vocab") renderVocabTab();
  if (tabId === "grammar") renderGrammarTab();
  if (tabId === "schrijven") renderWritingModule();
  if (tabId === "spreken") renderSpeakingModule();
}

/* ---------- Tab 1: Overzicht (enkel hoofdonderdelen) ---------- */

function renderDashboard() {
  if (!App.curriculum || !App.progress) return;
  const wfList = App.curriculum.woordvelden;
  const grAll = App.curriculum.grammatica.flatMap((p) => p.onderdelen);

  const wfStats = wfList.map((wf) => ({ wf, m: computeWfMetrics(wf) }));
  const wfMastered = wfStats.filter((x) => x.m.status === "beheerst").length;
  const totalWords = wfStats.reduce((s, x) => s + x.m.total, 0);
  const totalWordsMastered = wfStats.reduce((s, x) => s + x.m.mastered, 0);
  const totalWordsInProgress = wfStats.reduce((s, x) => s + x.m.inProgress, 0);
  const totalWordsDue = wfStats.reduce((s, x) => s + x.m.due, 0);
  const wfBarMastered = Math.round((totalWordsMastered / Math.max(1, totalWords)) * 100);
  const wfBarProgress = Math.round((totalWordsInProgress / Math.max(1, totalWords)) * 100);

  const grStats = grAll.map((g) => computeGrMetrics(g.id));
  const grMastered = grStats.filter((m) => m.status === "beheerst").length;
  const grPracticing = grStats.filter((m) => m.status === "oefenen").length;
  const grBarMastered = Math.round((grMastered / Math.max(1, grAll.length)) * 100);
  const grBarProgress = Math.round((grPracticing / Math.max(1, grAll.length)) * 100);

  document.getElementById("dashboard-base-cards").innerHTML = `
    <div class="exam-card">
      <div class="exam-card-top">
        <h3>Woordenschat (23 woordvelden)</h3>
        <span class="weight-pill">${totalWords} woorden</span>
      </div>
      ${renderStackedBar(wfBarMastered, wfBarProgress)}
      ${renderBarLegend(`Beheerst: ${totalWordsMastered} (${wfMastered}/23 velden)`, `Op weg: ${totalWordsInProgress}`)}
      <div class="exam-footer">
        <span class="muted">${totalWordsDue > 0 ? `↻ ${totalWordsDue} klaar voor herhaling` : "3× foutloos NL → FR = Beheerst"}</span>
        <button class="btn btn-primary btn-sm" type="button" data-goto-tab="vocab">Naar Woordenschat →</button>
      </div>
    </div>
    <div class="exam-card">
      <div class="exam-card-top">
        <h3>Grammatica (4 pijlers)</h3>
        <span class="weight-pill">${grAll.length} onderdelen</span>
      </div>
      ${renderStackedBar(grBarMastered, grBarProgress)}
      ${renderBarLegend(`Beheerst: ${grMastered}/${grAll.length}`, `Op weg: ${grPracticing}/${grAll.length}`)}
      <div class="exam-footer">
        <span class="muted">2 dagen niveau Goed = Beheerst</span>
        <button class="btn btn-primary btn-sm" type="button" data-goto-tab="grammar">Naar Grammatica →</button>
      </div>
    </div>
  `;

  // Gewogen algemene examenbalk (Schrijven 58% + Gesprek 30% + Monoloog 8%)
  const examProg = computeExamWeightedProgress();
  document.getElementById("dashboard-exam-overall").innerHTML = `
    <div class="stage-toolbar" style="margin-bottom:0.35rem;">
      <div>
        <strong>Algemene examenvoorbereiding</strong>
        <span class="muted"> (gewogen: Schrijven 58% · Gesprek 30% · Monoloog 8%)</span>
      </div>
      <span class="score-badge">${examProg.masteredPct}% beheerst${examProg.inProgressPct ? ` · ${examProg.inProgressPct}% op weg` : ""}</span>
    </div>
    ${renderStackedBar(examProg.masteredPct, examProg.inProgressPct)}
    ${renderBarLegend(`Beheerst (≥3× Goed): ${examProg.masteredPct}%`, `Op weg (1–2× Goed of gestart): ${examProg.inProgressPct}%`)}
  `;

  const w = App.curriculum.examen.weging;
  const domains = [
    { key: "schrijven", title: "Schrijven & Interactie", weight: `${w.schrijven}%`, desc: "29% schrijven + 29% schriftelijke interactie · 90 min (2 opdrachten)", tab: "schrijven" },
    { key: "gesprek", title: "Mondeling Gesprek", weight: `${w.gesprek}%`, desc: "15 min voorbereiding (kladblad) + 10 min examengesprek", tab: "spreken", speakMode: "gesprek_oefen" },
    { key: "monoloog", title: "Spreken — Monoloog", weight: `${w.monoloog}%`, desc: "Thuisopdracht · voorbereiding + Franse monoloog", tab: "spreken", speakMode: "monoloog" },
  ];

  document.getElementById("dashboard-exam-cards").innerHTML = domains.map((d) => {
    const st = getDomainStats(d.key);
    const scoreLine = st.count
      ? `Laatste: <strong>${scoreToCategory(st.lastScore).label}</strong> · Gem.: <strong>${scoreToCategory(st.avgScore).label}</strong> (${st.count}× geoefend)`
      : "Nog niet geoefend";
    return `
      <div class="exam-card">
        <div class="exam-card-top">
          <h3>${d.title}</h3>
          <span class="weight-pill">${d.weight}</span>
        </div>
        <div class="exam-meta">${d.desc}</div>
        ${renderStackedBar(st.masteredPct, st.inProgressPct, true)}
        <div class="wf-progress-meta">
          <span><strong>${Math.min(3, st.goodCount)} / 3</strong> keer niveau Goed</span>
          <span>${scoreLine}</span>
        </div>
        <div class="exam-footer">
          <span class="status-pill status-${st.status}">${STATUS_LABELS[st.status]}</span>
          <button class="btn btn-secondary btn-sm" type="button" data-goto-tab="${d.tab}" ${d.speakMode ? `data-goto-speak-mode="${d.speakMode}"` : ""}>Oefen →</button>
        </div>
      </div>
    `;
  }).join("");

  const historyEl = document.getElementById("dashboard-history");
  const recent = [...App.progress.evaluaties].reverse().slice(0, 8);
  if (!recent.length) {
    historyEl.innerHTML = `<p class="muted" style="margin:0;">Nog geen AI-evaluaties opgeslagen. Zodra je schrijf- of spreekopdrachten maakt, verschijnen je evaluaties hier automatisch.</p>`;
  } else {
    historyEl.innerHTML = `<div class="history-list">${recent.map((e) => {
      const catBadge = e.poging2
        ? `${renderCategoryBadge(e.poging1.scorePct)} → ${renderCategoryBadge(e.poging2.scorePct)}`
        : renderCategoryBadge(e.scorePct);
      const clickable = e.id && (e.domein === "schrijven" || e.domein === "monoloog" || e.domein === "gesprek");
      return `
      <div class="history-row${clickable ? " clickable" : ""}" ${clickable ? `data-open-eval="${escapeHtml(e.id)}" data-open-eval-domain="${escapeHtml(e.domein)}"` : ""}>
        <div>
          <strong>${escapeHtml(e.titel || e.domein)}</strong>
          <div class="muted">${new Date(e.datum).toLocaleDateString("nl-BE")} · ${escapeHtml(e.submodus || e.domein)}${e.heeftVerbetering ? " · inclusief verbeterpoging" : ""}</div>
        </div>
        <div class="btn-row" style="gap:0.35rem;">${catBadge}</div>
      </div>
    `;
    }).join("")}</div>`;
  }
}

/* ---------- Tab 5a: Woordenschat (4 strakke, uitbreidbare oefenvormen) ---------- */

const VOCAB_MODES = [
  { id: "toets", label: "Woordentoets (NL → FR)", render: renderVocabQuiz },
  { id: "invul", label: "Invuloefening (Zinnen)", render: renderVocabCloze },
  { id: "zinsbouw", label: "Zinsbouw-puzzel", render: renderVocabBuilder },
  { id: "lijst", label: "Woordenlijst", render: renderVocabList },
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
    let priority = 3;
    if (ws.box === 1) priority = 0;
    else if (isWordDue(ws, nowMs)) priority = 1;
    else if (ws.box === 0) priority = 2;
    const lastMs = ws.lastSeen ? Date.parse(ws.lastSeen) : 0;
    return { w, priority, lastMs, rand: Math.random() };
  });
  scored.sort((a, b) => a.priority - b.priority || a.lastMs - b.lastMs || a.rand - b.rand);
  return scored.slice(0, limit).map((x) => x.w);
}

function getBatchCacheKey() {
  return `${App.vocab.scope}::${App.vocab.group}`;
}

function canUseAi() {
  return App.serverMode && App.config.hasKey;
}

function shouldUseAiSentences() {
  if (App.vocab.sentenceSource === "local") return false;
  if (App.vocab.sentenceSource === "ai") return true;
  return canUseAi();
}

function getActiveSentencePool() {
  const key = getBatchCacheKey();
  if (shouldUseAiSentences() && App.vocab.aiBatches[key]?.length) {
    return App.vocab.aiBatches[key];
  }
  return getSelectedVocabFields().flatMap((wf) =>
    wf.voorbeelden.map((vb) => ({ ...vb, wfId: wf.id, wfTitel: wf.titel_nl }))
  );
}

function ensureAiBatchIfAuto() {
  const key = getBatchCacheKey();
  if (shouldUseAiSentences() && canUseAi() && !App.vocab.aiBatches[key] && !App.vocab.aiLoading && !App.vocab.aiError) {
    generateAiVocabSentences();
  }
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
    wrap.innerHTML = `<span class="muted">${pool.length} woorden</span>${due ? `<span class="due-badge">↻ ${due} te herhalen</span>` : ""}`;
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

function renderVocabOverview() {
  const wfList = App.curriculum.woordvelden;
  const wfStats = wfList.map((wf) => ({ wf, m: computeWfMetrics(wf) }));
  const totalWords = wfStats.reduce((s, x) => s + x.m.total, 0);
  const totalMastered = wfStats.reduce((s, x) => s + x.m.mastered, 0);
  const totalInProgress = wfStats.reduce((s, x) => s + x.m.inProgress, 0);
  const totalDue = wfStats.reduce((s, x) => s + x.m.due, 0);
  const fieldsMastered = wfStats.filter((x) => x.m.status === "beheerst").length;
  const mPct = Math.round((totalMastered / Math.max(1, totalWords)) * 100);
  const pPct = Math.round((totalInProgress / Math.max(1, totalWords)) * 100);

  document.getElementById("vocab-overall-card").innerHTML = `
    <div class="stage-toolbar" style="margin-bottom:0.35rem;">
      <div>
        <strong>Algemene voortgang Woordenschat</strong>
        <span class="muted"> · ${totalMastered} / ${totalWords} woorden beheerst (${fieldsMastered}/23 woordvelden)</span>
      </div>
      <div class="btn-row">
        ${totalDue > 0 ? `<button type="button" class="btn btn-primary btn-sm" data-open-wf="__mix_due">↻ Herhaal vervallen (${totalDue})</button>` : ""}
        <button type="button" class="btn btn-secondary btn-sm" data-open-wf="__mix_all">Mix · Alle 23 velden</button>
      </div>
    </div>
    ${renderStackedBar(mPct, pPct)}
    ${renderBarLegend(`Beheerst (3× foutloos): ${totalMastered}`, `Op weg (1–2× foutloos): ${totalInProgress}`)}
  `;

  document.getElementById("vocab-list-summary").textContent =
    `${fieldsMastered} beheerst · ${wfStats.filter((x) => x.m.status === "oefenen").length} bezig · klik op Oefen om te starten`;

  const q = App.wfSearch.trim().toLowerCase();
  const filtered = wfStats.filter(({ wf, m }) => {
    if (App.wfFilter !== "all" && m.status !== App.wfFilter) return false;
    if (q && !wf.titel_nl.toLowerCase().includes(q) && !wf.titel_fr.toLowerCase().includes(q)) return false;
    return true;
  });

  document.getElementById("vocab-wf-list").innerHTML = filtered.length
    ? filtered.map(({ wf, m }) => {
        const rowMPct = Math.round((m.mastered / Math.max(1, m.total)) * 100);
        const rowPPct = Math.round((m.inProgress / Math.max(1, m.total)) * 100);
        return `
          <div class="list-row">
            <div class="list-row-main">
              <span class="wf-num">${String(wf.nummer).padStart(2, "0")}</span>
              <div class="list-row-titles">
                <div class="list-row-title">${escapeHtml(wf.titel_nl)}</div>
                <div class="list-row-sub">${escapeHtml(wf.titel_fr)}</div>
              </div>
            </div>
            <div class="list-row-bar">
              ${renderStackedBar(rowMPct, rowPPct, true)}
              <div class="list-row-bar-meta">
                <span>${m.mastered}/${m.total} beheerst${m.inProgress ? ` · +${m.inProgress} op weg` : ""}</span>
                ${m.due > 0 ? `<span class="due-badge">↻ ${m.due}</span>` : ""}
              </div>
            </div>
            <div class="list-row-actions">
              <span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>
              <button class="btn btn-primary btn-sm" type="button" data-open-wf="${wf.id}">Oefen</button>
            </div>
          </div>
        `;
      }).join("")
    : `<div class="card muted">Geen woordvelden gevonden voor deze filter.</div>`;
}

function renderVocabTab() {
  if (!App.curriculum) return;
  const ov = document.getElementById("vocab-overview-view");
  const pr = document.getElementById("vocab-practice-view");
  const isPractice = App.vocab.view === "practice";
  ov.classList.toggle("hidden", isPractice);
  pr.classList.toggle("hidden", !isPractice);
  if (isPractice) {
    renderVocabStage();
  } else {
    renderVocabOverview();
  }
}

function openVocabField(wfId) {
  App.vocab.scope = wfId;
  App.vocab.group = "__all";
  App.vocab.view = "practice";
  App.vocab.session = null;
  App.vocab.aiError = "";
  const select = document.getElementById("vocab-wf-select");
  if (select) select.value = wfId;
  populateVocabGroups();
  switchTab("vocab");
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

/* ---------- Batch AI Sentence Generator (2 zinnen per woord, 1 compacte call) ---------- */

async function generateAiVocabSentences() {
  const pool = getVocabWordPool();
  if (!pool.length) return;
  const targets = selectPriorityWords(pool, Math.min(7, pool.length));
  const scopeLabel = App.vocab.scope.startsWith("__mix")
    ? "Gemengde B1 woordenschat"
    : getSelectedVocabFields()[0].titel_nl;

  App.vocab.aiLoading = true;
  App.vocab.aiError = "";
  renderVocabStage();

  try {
    const wordLines = targets.map((w) => `- ${w.fr} (${w.nl})`).join("\n");
    const prompt = [
      `Maak voor een Vlaamse leerling (Frans niveau B1, thema: ${scopeLabel}) voor elk van de ${targets.length} doelwoorden precies 2 verschillende, natuurlijke Franse voorbeeldzinnen (8-15 woorden per zin; totaal ${targets.length * 2} zinnen).`,
      `Doelwoorden:\n${wordLines}`,
      `Geef UITSLUITEND een JSON-array terug met objecten: {"targetWord":"exact Frans doelwoord uit de lijst","fr":"Franse zin","nl":"natuurlijke Nederlandse vertaling","gat":"het exacte ingevulde Franse woord/woordgroep zoals het letterlijk in fr staat"}.`,
      `Regels: "gat" moet letterlijk in "fr" voorkomen, varieer context en tijden (présent, passé composé, futur), duidelijke context zodat de leerling het woord kan afleiden.`,
    ].join("\n\n");

    const parsed = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 1800 });
    if (!Array.isArray(parsed)) throw new Error("Onverwacht antwoordformaat van Gemini.");

    const byLower = new Map(targets.map((t) => [t.fr.toLowerCase(), t]));
    const valid = [];
    for (const item of parsed) {
      if (!item || typeof item.fr !== "string" || typeof item.nl !== "string" || typeof item.gat !== "string") continue;
      if (!item.fr.includes(item.gat)) continue;
      const matched = byLower.get(String(item.targetWord || "").toLowerCase()) || targets[valid.length % targets.length];
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
  const usingAi = shouldUseAiSentences() && aiCount > 0;

  let statusText = `Lokale cursus (${localCount} voorbeeldzinnen)`;
  if (App.vocab.aiLoading) statusText = "✨ Verse AI-zinnen (2 per woord) worden opgehaald…";
  else if (usingAi) statusText = `✨ AI-batch (${aiCount} verse zinnen · 2 per woord op maat van je voortgang)`;

  return `
    <div class="ai-batch-bar">
      <div><strong>Bron zinnen:</strong> ${statusText}</div>
      <div class="btn-row">
        <button type="button" class="chip${!usingAi ? " active" : ""}" data-sent-source="local">Lokaal (${localCount})</button>
        ${aiCount > 0 ? `<button type="button" class="chip${usingAi ? " active" : ""}" data-sent-source="ai">✨ AI-batch (${aiCount})</button>` : ""}
        <button type="button" class="btn btn-primary btn-sm" data-ai-batch="generate" ${App.vocab.aiLoading || !canUseAi() ? "disabled" : ""} title="${canUseAi() ? "Haal een nieuwe batch van 2 zinnen per woord op" : "Stel eerst je Gemini API-key in bij Instellingen"}">
          ${App.vocab.aiLoading ? "Laden…" : aiCount ? "✨ Nieuwe AI-batch" : "✨ Haal AI-zinnen op"}
        </button>
      </div>
    </div>
    ${App.vocab.aiError ? `<div class="banner error">${escapeHtml(App.vocab.aiError)} (Valt terug op lokale zinnen.)</div>` : ""}
  `;
}

/* ---------- Mode 1: Snelle Woordentoets NL -> FR (instant Enter-flow, geen meerkeuze) ---------- */

function startQuizSession() {
  const pool = getVocabWordPool();
  const selected = selectPriorityWords(pool, Math.min(App.vocab.quizCount, pool.length));
  App.vocab.session = {
    type: "toets",
    queue: selected.map((word) => ({ word, isRetry: false, firstRecorded: false })),
    initialTotal: selected.length,
    firstCorrect: 0,
    firstPartial: 0,
    firstWrong: 0,
    retriesCompleted: 0,
    prevFeedback: null,
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
      <span class="muted">Actief <strong>NL → FR</strong> · typ en druk op <strong>Enter</strong> (leeg = weet ik niet)</span>
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
        ${renderPrevFeedbackBar(s.prevFeedback)}
        <div class="summary-box">
          <h3>Reeks voltooid!</h3>
          <div class="summary-score">${pct}%</div>
          <p class="muted">
            Eerste poging: <strong>${s.firstCorrect}</strong> juist · <strong>${s.firstPartial}</strong> accent/lidwoord · <strong>${s.firstWrong}</strong> fout
            ${s.retriesCompleted ? `<br>Extra ingeprent in herhalingslus: <strong>${s.retriesCompleted}×</strong>` : ""}
          </p>
          <p class="muted">Voortgang en Leitner-herhaaldata automatisch opgeslagen.</p>
          <div class="btn-row" style="justify-content:center;margin-top:1rem;">
            <button type="button" class="btn btn-primary" data-quiz-action="restart">Volgende reeks (${App.vocab.quizCount} woorden)</button>
            <button type="button" class="btn btn-secondary" data-vocab-mode="invul">Oefen nu in zinnen →</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const cur = s.queue[0];
  const ws = getWordState(cur.word.wfId, cur.word.fr);
  const needsArt = hasRequiredArticle(cur.word.fr);

  container.innerHTML = `
    <div class="card exercise-card">
      ${controlsHtml}
      ${renderPrevFeedbackBar(s.prevFeedback)}
      <div class="exercise-progress">
        <span>Nog <strong>${s.queue.length}</strong> te gaan${cur.word.groep ? ` · ${escapeHtml(cur.word.groep)}` : ""}</span>
        <span style="display:inline-flex;align-items:center;gap:0.5rem;">
          ${cur.isRetry ? `<span class="retry-badge">↻ Inprent-herhaling</span>` : ""}
          ${renderMasteryDots(ws.box)}
        </span>
      </div>
      <div class="quiz-prompt-box">
        <div class="quiz-prompt-label">Typ in het Frans</div>
        <div class="quiz-prompt-word">${escapeHtml(cur.word.nl)}</div>
        ${needsArt ? `<span class="prompt-hint-pill">met lidwoord</span>` : ""}
        ${App.vocab.scope.startsWith("__mix") ? `<div class="muted" style="margin-top:0.25rem;">${escapeHtml(cur.word.wfTitel)}</div>` : ""}
      </div>
      <input id="vocab-answer-input" class="quiz-input" type="text" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="Typ het Franse woord en druk op Enter…" />
      ${renderAccentBar("vocab-answer-input")}
      <div class="btn-row" style="justify-content:space-between;">
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-quiz-action="submit">Controleer &amp; volgende ↵</button>
          <button type="button" class="btn btn-secondary" data-quiz-action="skip" tabindex="-1">Weet ik niet</button>
        </div>
        <span class="kbd-hint">↵ Enter = controleer &amp; meteen volgende</span>
      </div>
    </div>
  `;

  const inp = document.getElementById("vocab-answer-input");
  if (inp) inp.focus();
}

function submitQuizInstant(forceSkip = false) {
  const s = App.vocab.session;
  if (!s || s.type !== "toets" || s.done || !s.queue.length) return;
  const inp = document.getElementById("vocab-answer-input");
  const given = forceSkip ? "" : (inp ? inp.value.trim() : "");
  const cur = s.queue.shift();
  const kind = !given ? "wrong" : checkVocabTypedAnswer(given, cur.word.fr);

  if (!cur.firstRecorded) {
    cur.firstRecorded = true;
    if (kind === "exact") s.firstCorrect += 1;
    else if (kind === "accent" || kind === "article") s.firstPartial += 1;
    else s.firstWrong += 1;
    updateWordMastery(cur.word.wfId, cur.word.fr, kind);
  } else if (kind === "exact") {
    s.retriesCompleted += 1;
  }

  // Fout, accentfout of lidwoordfout -> opnieuw achteraan in de wachtrij (minstens 2 plaatsen verder indien mogelijk)
  if (kind !== "exact") {
    const insertAt = Math.min(s.queue.length, Math.max(2, s.queue.length));
    s.queue.splice(insertAt, 0, { word: cur.word, isRetry: true, firstRecorded: true });
  }

  s.prevFeedback = {
    kind,
    given,
    expected: cur.word.fr,
    sub: cur.word.nl,
    speakText: cur.word.fr,
  };

  if (!s.queue.length) s.done = true;
  renderVocabStage();
}

/* ---------- Mode 2: Contextuele invuloefening (Instant Enter-flow + auto AI-batch) ---------- */

function startClozeSession() {
  const pool = shuffleArray(getActiveSentencePool());
  const items = pool.slice(0, Math.min(12, pool.length));
  App.vocab.session = {
    type: "invul",
    queue: items.map((item) => ({ item, isRetry: false, recorded: false })),
    initialTotal: items.length,
    points: 0,
    prevFeedback: null,
    done: false,
  };
}

function renderVocabCloze(container) {
  ensureAiBatchIfAuto();
  if (!App.vocab.session || App.vocab.session.type !== "invul") startClozeSession();
  const s = App.vocab.session;
  const sourceBar = renderSentenceSourceBar();

  if (App.vocab.aiLoading) {
    container.innerHTML = `${sourceBar}<div class="card empty-module"><p class="muted">Verse B1-voorbeeldzinnen (2 per woord) worden klaargezet…</p></div>`;
    return;
  }

  if (!s.queue.length && !s.done) {
    container.innerHTML = `${sourceBar}<div class="card muted">Geen voorbeeldzinnen gevonden.</div>`;
    return;
  }

  if (s.done) {
    const pct = Math.round((s.points / Math.max(1, s.initialTotal)) * 100);
    container.innerHTML = `
      ${sourceBar}
      <div class="card exercise-card">
        ${renderPrevFeedbackBar(s.prevFeedback)}
        <div class="summary-box">
          <h3>Invuloefening voltooid!</h3>
          <div class="summary-score">${pct}%</div>
          <p class="muted">Eerste poging: ${s.points} / ${s.initialTotal} · Woordvoortgang automatisch bijgewerkt</p>
          <div class="btn-row" style="justify-content:center;margin-top:1rem;">
            <button type="button" class="btn btn-primary" data-cloze-action="restart">Nieuwe reeks</button>
            <button type="button" class="btn btn-secondary" data-vocab-mode="zinsbouw">Oefen zinsbouw →</button>
          </div>
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

  container.innerHTML = `
    ${sourceBar}
    <div class="card exercise-card">
      ${renderPrevFeedbackBar(s.prevFeedback)}
      <div class="exercise-progress">
        <span>Nog <strong>${s.queue.length}</strong> zin(nen)${item.isAi ? " · ✨ AI-zin" : ""}</span>
        <span>${cur.isRetry ? `<span class="retry-badge">↻ Herhaalzin</span>` : `Score: ${s.points} / ${s.initialTotal}`}</span>
      </div>
      <div class="muted">Vertaling (hint): <strong>${escapeHtml(item.nl)}</strong></div>
      <div class="cloze-sentence">
        ${escapeHtml(before)}<input id="cloze-answer" class="cloze-input" type="text" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="…" />${escapeHtml(after)}
      </div>
      ${renderAccentBar("cloze-answer")}
      <div class="btn-row" style="justify-content:space-between;">
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-cloze-action="submit">Controleer &amp; volgende ↵</button>
          <button type="button" class="btn btn-secondary" data-cloze-action="skip" tabindex="-1">Weet ik niet</button>
        </div>
        <span class="kbd-hint">↵ Enter = controleer &amp; meteen volgende</span>
      </div>
    </div>
  `;

  const inp = document.getElementById("cloze-answer");
  if (inp) inp.focus();
}

function submitClozeInstant(forceSkip = false) {
  const s = App.vocab.session;
  if (!s || s.type !== "invul" || s.done || !s.queue.length) return;
  const inp = document.getElementById("cloze-answer");
  const given = forceSkip ? "" : (inp ? inp.value.trim() : "");
  const cur = s.queue.shift();
  const item = cur.item;
  const kind = !given ? "wrong" : checkClozeAnswer(given, item.gat);

  if (!cur.recorded) {
    cur.recorded = true;
    const pts = kind === "exact" ? 1 : kind === "accent" ? 0.5 : 0;
    s.points += pts;
    const linkedWord = item.targetWord || findMatchingWordForGat(item.wfId, item.gat);
    if (linkedWord) {
      updateWordMastery(item.wfId, linkedWord, kind);
    }
  }

  if (kind !== "exact") {
    s.queue.push({ item, isRetry: true, recorded: true });
  }

  s.prevFeedback = {
    kind,
    given,
    expected: item.gat,
    sub: item.fr,
    speakText: item.fr,
  };

  if (!s.queue.length) s.done = true;
  renderVocabStage();
}

/* ---------- Mode 3: Zinsbouw-puzzel (Auto AI-batch + lokaal) ---------- */

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
  const items = pool.slice(0, Math.min(8, pool.length)).map((item) => ({
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
  ensureAiBatchIfAuto();
  if (!App.vocab.session || App.vocab.session.type !== "zinsbouw") startBuilderSession();
  const s = App.vocab.session;
  const sourceBar = renderSentenceSourceBar();

  if (App.vocab.aiLoading) {
    container.innerHTML = `${sourceBar}<div class="card empty-module"><p class="muted">Verse B1-voorbeeldzinnen (2 per woord) worden klaargezet…</p></div>`;
    return;
  }

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
          <button type="button" class="btn btn-secondary" data-vocab-mode="toets">Terug naar Woordentoets</button>
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

/* ---------- Mode 4: Woordenlijst (studeren/opzoeken + read-only mastery) ---------- */

function renderVocabList(container) {
  const words = getVocabWordPool();
  const hide = App.vocab.hideMode;
  const q = App.vocab.listSearch.trim().toLowerCase();
  const lf = App.vocab.listFilter;

  const filtered = words.filter((w) => {
    const ws = getWordState(w.wfId, w.fr);
    if (lf === "nieuw" && ws.box !== 0) return false;
    if (lf === "herhalen" && !(ws.box === 1 || isWordDue(ws))) return false;
    if (lf === "opweg" && !(ws.box >= 2 && ws.box < 4)) return false;
    if (lf === "beheerst" && ws.box < 4) return false;
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
            <button type="button" class="chip${lf === "opweg" ? " active" : ""}" data-list-filter="opweg">Op weg</button>
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

  const accBtn = e.target.closest("[data-accent]");
  if (accBtn) {
    insertAtCursor(document.getElementById(accBtn.dataset.accentTarget), accBtn.dataset.accent);
    return;
  }

  const qCount = e.target.closest("[data-quiz-count]");
  if (qCount) {
    App.vocab.quizCount = Number(qCount.dataset.quizCount);
    startQuizSession();
    renderVocabStage();
    return;
  }

  const qAct = e.target.closest("[data-quiz-action]");
  if (qAct && App.vocab.session?.type === "toets") {
    const act = qAct.dataset.quizAction;
    if (act === "restart") {
      startQuizSession();
      renderVocabStage();
    } else if (act === "submit") {
      submitQuizInstant(false);
    } else if (act === "skip") {
      submitQuizInstant(true);
    }
    return;
  }

  const clozeAct = e.target.closest("[data-cloze-action]");
  if (clozeAct && App.vocab.session?.type === "invul") {
    const act = clozeAct.dataset.clozeAction;
    if (act === "restart") {
      startClozeSession();
      renderVocabStage();
    } else if (act === "submit") {
      submitClozeInstant(false);
    } else if (act === "skip") {
      submitClozeInstant(true);
    }
    return;
  }

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
        updateWordMastery(item.wfId, linkedWord, s.wasCorrect && !s.usedHint ? "exact" : "wrong");
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
  }
}

/* ---------- Tab 2: Schrijven & Schriftelijke Interactie (58%) ---------- */

const WRITING_MODES = [
  { id: "schrijven", label: "Schrijven (29% · 45 min)", minutes: 45, strict: false },
  { id: "interactie", label: "Schriftelijke interactie (29% · 45 min)", minutes: 45, strict: false },
  { id: "examen", label: "Strikte Examensimulatie (58% · 90 min)", minutes: 90, strict: true },
];

function getWritingModeObj(id = App.write.mode) {
  return WRITING_MODES.find((m) => m.id === id) || WRITING_MODES[0];
}

function countWords(text) {
  const cleaned = String(text || "").trim();
  return cleaned ? cleaned.split(/\s+/).length : 0;
}

function formatTimer(sec) {
  const abs = Math.max(0, Math.floor(sec));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function showWriteError(msg) {
  const el = document.getElementById("write-error");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function initWritingModule() {
  const wfSel = document.getElementById("write-wf-select");
  wfSel.innerHTML = App.curriculum.woordvelden
    .map((wf) => `<option value="${wf.id}">${String(wf.nummer).padStart(2, "0")} · ${escapeHtml(wf.titel_nl)}</option>`)
    .join("");
  wfSel.value = App.write.wfId;

  const doelSel = document.getElementById("write-doel-select");
  doelSel.innerHTML = App.curriculum.communicatieve_doelen
    .map((d) => `<option value="${d.id}">${escapeHtml(d.naam)}</option>`)
    .join("");
  doelSel.value = App.write.doelId;

  if (App.progress.schrijfConcept?.mode) {
    App.write.mode = App.progress.schrijfConcept.mode;
    if (App.progress.schrijfConcept.wfId) {
      App.write.wfId = App.progress.schrijfConcept.wfId;
      wfSel.value = App.write.wfId;
    }
    if (App.progress.schrijfConcept.doelId) {
      App.write.doelId = App.progress.schrijfConcept.doelId;
      doelSel.value = App.write.doelId;
    }
  }
  renderWritingModeBar();
}

function renderWritingModeBar() {
  const bar = document.getElementById("write-mode-bar");
  bar.innerHTML = WRITING_MODES.map(
    (m) => `<button type="button" class="mode-btn${m.id === App.write.mode ? " active" : ""}" data-write-mode="${m.id}" role="tab">${escapeHtml(m.label)}</button>`
  ).join("");
  const setupRow = document.getElementById("write-setup-row");
  const isExam = App.write.mode === "examen";
  setupRow.querySelectorAll(".drill-field").forEach((f) => f.classList.toggle("hidden", isExam));
  document.getElementById("btn-write-random").classList.toggle("hidden", isExam);
  document.getElementById("btn-write-generate").textContent = isExam
    ? "✨ Start nieuwe examensimulatie (2 opdrachten)"
    : "✨ Genereer opdracht";
}

function stopWriteTimer() {
  if (App.write.timerId) {
    clearInterval(App.write.timerId);
    App.write.timerId = null;
  }
  App.write.timerRunning = false;
}

function startWriteTimer() {
  const c = App.progress.schrijfConcept;
  if (!c) return;
  stopWriteTimer();
  App.write.timerRunning = true;
  App.write.timerId = setInterval(() => {
    const cur = App.progress.schrijfConcept;
    if (!cur) {
      stopWriteTimer();
      return;
    }
    if (cur.timerSecondsLeft > 0) {
      cur.timerSecondsLeft -= 1;
    } else {
      cur.timerOvertime = (cur.timerOvertime || 0) + 1;
    }
    const disp = document.getElementById("write-timer-display");
    if (disp) {
      const over = cur.timerSecondsLeft <= 0;
      disp.classList.toggle("overtime", over);
      disp.textContent = over
        ? `00:00 (tijd om · +${formatTimer(cur.timerOvertime || 0)})`
        : formatTimer(cur.timerSecondsLeft);
    }
    if (cur.timerSecondsLeft % 15 === 0) scheduleSaveProgress();
  }, 1000);
}

function pickRandomWritingPair() {
  const wfs = App.curriculum.woordvelden;
  const doelen = App.curriculum.communicatieve_doelen;
  const wf = wfs[Math.floor(Math.random() * wfs.length)];
  const doel = doelen[Math.floor(Math.random() * doelen.length)];
  App.write.wfId = wf.id;
  App.write.doelId = doel.id;
  document.getElementById("write-wf-select").value = wf.id;
  document.getElementById("write-doel-select").value = doel.id;
}

function buildWritingGenPrompt(mode) {
  const doelen = App.curriculum.communicatieve_doelen;
  const wfs = App.curriculum.woordvelden;

  if (mode === "examen") {
    const shuffledWf = shuffleArray(wfs);
    const shuffledDoel = shuffleArray(doelen);
    const wf1 = shuffledWf[0];
    const wf2 = shuffledWf[1];
    const d1 = shuffledDoel[0];
    const d2 = shuffledDoel[1];
    const words1 = shuffleArray(wf1.woorden).slice(0, 8).map((w) => w.fr).join(", ");
    const words2 = shuffleArray(wf2.woorden).slice(0, 8).map((w) => w.fr).join(", ");
    return [
      `Je bent examenmaker voor de Vlaamse Examencommissie 'Frans 2' (2de graad doorstroomfinaliteit, niveau B1).`,
      `Genereer een realistisch digitaal examen met EXACT 2 opdrachten (totaal 90 min):`,
      `Opdracht 1 (type "schrijven", 29%): thema "${wf1.titel_nl}" (sfeerwoorden: ${words1}), doel "${d1.naam}" (${d1.beschrijving}). Geen inkomende brontekst nodig (brontekst: "").`,
      `Opdracht 2 (type "interactie", 29%): thema "${wf2.titel_nl}" (sfeerwoorden: ${words2}), doel "${d2.naam}" (${d2.beschrijving}). Voeg een realistisch kort inkomend Frans bericht/e-mail/forumbericht (50-90 woorden) toe in "brontekst" waarop de leerling moet antwoorden.`,
      `Geef UITSLUITEND geldig JSON terug: {"opdrachten":[{"type":"schrijven|interactie","titel":"korte NL titel","thema":"...","doel":"...","context":"heldere NL opdrachtomschrijving (2-3 zinnen)","brontekst":"Frans inkomend bericht of lege string","ontvanger":"bv. gemeente / vriend(in)","register":"neutraal/formeel (vous) of informeel (tu)","vereisten":["inhoudspunt 1","inhoudspunt 2","inhoudspunt 3","inhoudspunt 4"],"richtwoorden":"120-160"}]}`,
    ].join("\n\n");
  }

  const wf = wfs.find((w) => w.id === App.write.wfId) || wfs[0];
  const doel = doelen.find((d) => d.id === App.write.doelId) || doelen[0];
  const sampleWords = shuffleArray(wf.woorden).slice(0, 8).map((w) => w.fr).join(", ");
  const isInter = mode === "interactie";

  return [
    `Je bent examenmaker voor de Vlaamse Examencommissie 'Frans 2' (2de graad doorstroomfinaliteit, niveau B1).`,
    `Maak EXACT 1 realistische ${isInter ? "opdracht Schriftelijke Interactie (reageren op een bericht)" : "Schrijfopdracht"} voor 45 minuten.`,
    `Thema: ${wf.titel_nl} (${wf.titel_fr}) · inspiratiewoorden: ${sampleWords}.`,
    `Communicatief doel: ${doel.naam} — ${doel.beschrijving}. Typische tekstsoorten: ${doel.tekstsoorten.join(", ")}.`,
    isInter
      ? `Schrijf een authentiek, kort inkomend Frans bericht (e-mail, uitnodiging of forumbericht van 55-90 woorden) in "brontekst" waarop de leerling in het Frans moet reageren.`
      : `Laat "brontekst" een lege string "".`,
    `Geef UITSLUITEND geldig JSON terug: {"opdrachten":[{"type":"${mode}","titel":"korte NL titel","thema":"${wf.titel_nl}","doel":"${doel.naam}","context":"heldere NL opdrachtomschrijving (2-3 zinnen)","brontekst":"...","ontvanger":"...","register":"neutraal/formeel (vous) of informeel (tu)","vereisten":["punt 1","punt 2","punt 3","punt 4"],"richtwoorden":"120-160"}]}`,
  ].join("\n\n");
}

async function generateWritingAssignment() {
  if (!canUseAi()) {
    showWriteError("Stel eerst je Gemini API-key in via Instellingen om examenopdrachten te genereren.");
    return;
  }
  const existing = App.progress.schrijfConcept;
  const hasUnfinishedDraft = existing && existing.texts?.some((t) => countWords(t) >= 15) && !existing.poging1;
  const hasMandatoryRevision = existing && existing.revising && !existing.strict && !existing.poging2;
  if (hasMandatoryRevision) {
    if (!confirm("Je zit nog in Stap 2 (Verbeteren & herschrijven). Wil je deze oefening echt afbreken zonder je tekst te verbeteren?")) {
      return;
    }
  } else if (hasUnfinishedDraft) {
    if (!confirm("Je hebt nog een niet-geëvalueerde tekst openstaan. Wil je die vervangen door een nieuwe opdracht?")) {
      return;
    }
  }

  stopWriteTimer();
  showWriteError("");
  App.write.loading = true;
  App.write.helperOpen = false;
  renderWritingModule();

  try {
    const mode = App.write.mode;
    const modeObj = getWritingModeObj(mode);
    const data = await callGemini({
      prompt: buildWritingGenPrompt(mode),
      jsonMode: true,
      maxOutputTokens: 1300,
    });
    const tasks = Array.isArray(data?.opdrachten) ? data.opdrachten : [];
    if (!tasks.length) throw new Error("Gemini gaf geen geldige opdracht terug. Probeer opnieuw.");

    const totalSec = modeObj.minutes * 60;
    App.progress.schrijfConcept = {
      id: `schr_${Date.now()}`,
      createdAt: new Date().toISOString(),
      mode,
      strict: modeObj.strict,
      wfId: App.write.wfId,
      doelId: App.write.doelId,
      tasks,
      texts: tasks.map(() => ""),
      scratchpads: tasks.map(() => ""),
      activeTaskIdx: 0,
      timerTotalSeconds: totalSec,
      timerSecondsLeft: totalSec,
      timerOvertime: 0,
      poging1: null,
      poging2: null,
      revising: false,
      archiveId: null,
    };
    scheduleSaveProgress();
    startWriteTimer();
  } catch (err) {
    showWriteError(err.message);
  } finally {
    App.write.loading = false;
    renderWritingModule();
  }
}

const WRITING_CRITERIA_MAX = {
  taakvoltooiing: 4,
  woordenschat: 3,
  grammatica: 4,
  tekststructuur: 3,
  register: 2,
  layout: 2,
  spelling_uitspraak: 2,
};

async function evaluateSingleTask(task, text, prevEval = null) {
  const criteriaDefs = App.curriculum.examen.beoordelingscriteria;
  const criteriaLines = criteriaDefs
    .map((c) => `- ${c.id} (${c.naam}, max ${WRITING_CRITERIA_MAX[c.id] || 2}): ${c.rubric}`)
    .join("\n");

  const prevBlock = prevEval
    ? `\nDit is een VERBETERPOGING na eerdere feedback (vorige score: ${prevEval.totaalOp20}/20). Eerdere aandachtspunten: ${(prevEval.fouten || []).map((f) => f.citaat).join("; ")}. Beoordeel streng op de NIEUWE tekst (ook als die slechter is!) en benoem kort wat beter of slechter is.`
    : "";

  const strictRules = [
    `STRENGE EXAMENCOMMISSIE-NORM (niveau B1, geen troostpunten; 10/20 = minimum om te slagen voor B1):`,
    `- Gebruik exact de opgegeven maxima (som = 20) en enkel gehele getallen van 0 t.e.m. max.`,
    `- taakvoltooiing (/4): straf duidelijk af bij te weinig woorden (<110), ontbrekende vereisten of ontwijkende antwoorden ("je sais pas").`,
    `- grammatica (/4): max 1/4 bij herhaalde basisfouten (foute vervoegingen zoals 'je boit'/'je prefer', verkeerd woordgeslacht zoals 'la cocktail', stelselmatig weglaten van 'ne' in standaardtaal, of enkel A1/A2-zinnen).`,
    `- spelling_uitspraak (/2): 2/2 enkel bij max 1-2 lichte foutjes; 1/2 bij meerdere fouten maar verzorgde tekst; 0/2 bij veelvuldige fouten tegen accenten, apostroffen ('cest','jaime','lalcohol'), hoofdletters of basisspelling ('rum','crevete','bizzare').`,
    `- register (/2): 0/2 als het register botst met de ontvanger (bv. 'Monsieur le Directeur' op een informeel forum, of 'tu' tegen een onbekende ambtenaar).`,
    `- layout (/2): 0-1/2 als aanspreking, alinea's of afsluitende groet ontbreken of niet passen bij de tekstsoort.`,
    `- Citaten in "fouten" MOETEN letterlijk gekopieerd zijn uit de tekst van de leerling (verzin geen woorden).`,
  ].join("\n");

  const prompt = [
    `Je bent een strenge, eerlijke examinator van de Vlaamse Examencommissie 'Frans 2' (2de graad doorstroomfinaliteit, niveau B1).`,
    `Opdracht (${task.type}): ${task.titel}\nContext: ${task.context}${task.brontekst ? `\nInkomend bericht: ${task.brontekst}` : ""}\nRegister: ${task.register} · Richtlengte: ${task.richtwoorden} woorden\nVereisten: ${(task.vereisten || []).join(" | ")}`,
    `Tekst van de leerling (${countWords(text)} woorden):\n"""\n${text.trim()}\n"""`,
    `Beoordelingscriteria (geef alle 7 in het Nederlands):\n${criteriaLines}\n\n${strictRules}${prevBlock}`,
    `Belangrijk: herschrijf NIET de volledige tekst; geef maximaal 3 tot 5 concrete, belangrijkste fouten/verbeterpunten zodat de leerling ze zelf kan verbeteren.`,
    `Geef UITSLUITEND geldig JSON terug: {"samenvatting":"2 korte NL zinnen","sterktes":["..."],"criteria":[{"id":"taakvoltooiing","naam":"Taakvoltooiing","score":2,"max":4,"feedback":"1 korte concrete NL zin"}],"fouten":[{"citaat":"EXACT stukje uit leerlingtekst","type":"grammatica|spelling|woordenschat|register|structuur","uitleg":"korte NL uitleg waarom fout","tip":"richtinggevende hint om zelf te verbeteren"}]}`,
  ].join("\n\n");

  const res = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 1500, temperature: 0.15 });
  const rawCriteria = Array.isArray(res.criteria) ? res.criteria : [];
  const byId = new Map(rawCriteria.map((cr) => [String(cr.id || "").toLowerCase(), cr]));

  // Deterministische sommatie over exact de 7 vaste criteria (som maxima = 20)
  const normalizedCriteria = criteriaDefs.map((def) => {
    const max = WRITING_CRITERIA_MAX[def.id] || 2;
    const found = byId.get(def.id) || rawCriteria.find((cr) => String(cr.naam || "").toLowerCase().includes(def.naam.slice(0, 6).toLowerCase()));
    const rawScore = Number(found?.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(max, Math.round(rawScore))) : 0;
    return {
      id: def.id,
      naam: def.naam,
      score,
      max,
      feedback: found?.feedback || "",
    };
  });

  const maxTotal = normalizedCriteria.reduce((s, cr) => s + cr.max, 0);
  const totaalOp20 = normalizedCriteria.reduce((s, cr) => s + cr.score, 0);
  const scorePct = Math.round((totaalOp20 / Math.max(1, maxTotal)) * 100);

  return {
    totaalOp20,
    scorePct,
    samenvatting: res.samenvatting || "",
    sterktes: Array.isArray(res.sterktes) ? res.sterktes : [],
    criteria: normalizedCriteria,
    fouten: Array.isArray(res.fouten) ? res.fouten : [],
  };
}

async function evaluateWritingSubmission() {
  const c = App.progress.schrijfConcept;
  if (!c) return;
  if (!canUseAi()) {
    showWriteError("Stel eerst je Gemini API-key in via Instellingen om je tekst te laten evalueren.");
    return;
  }

  for (let i = 0; i < c.tasks.length; i++) {
    if (countWords(c.texts[i]) < 15) {
      c.activeTaskIdx = i;
      renderWritingModule();
      showWriteError(`Schrijf minstens 15 woorden bij opdracht ${i + 1} voordat je laat evalueren.`);
      return;
    }
  }

  const isRevision = Boolean(c.poging1 && c.revising);
  if (isRevision) {
    const unchangedIdx = c.texts.findIndex(
      (t, i) => normalizeFr(t) === normalizeFr(c.poging1.teksten?.[i] || "")
    );
    if (unchangedIdx >= 0) {
      c.activeTaskIdx = unchangedIdx;
      renderWritingModule();
      showWriteError("Pas eerst minstens één verbeterpunt uit de feedback aan in je tekst voordat je opnieuw laat evalueren.");
      return;
    }
  }

  stopWriteTimer();
  showWriteError("");
  App.write.evaluating = true;
  renderWritingModule();

  try {
    const taskEvals = [];
    for (let i = 0; i < c.tasks.length; i++) {
      const prev = isRevision ? c.poging1.perOpdracht[i] : null;
      const ev = await evaluateSingleTask(c.tasks[i], c.texts[i], prev);
      taskEvals.push(ev);
    }

    const avgPct = Math.round(taskEvals.reduce((s, e) => s + e.scorePct, 0) / taskEvals.length);
    const avg20 = Math.round((taskEvals.reduce((s, e) => s + e.totaalOp20, 0) / taskEvals.length) * 10) / 10;
    const attemptSnapshot = {
      datum: new Date().toISOString(),
      scorePct: avgPct,
      totaalOp20: avg20,
      teksten: [...c.texts],
      perOpdracht: taskEvals,
    };

    if (!isRevision) {
      c.poging1 = attemptSnapshot;
      const needsRevision = !c.strict && (avgPct < 85 || taskEvals.some((ev) => (ev.fouten || []).length > 0));
      c.revising = needsRevision;
      c.revisionMandatory = needsRevision;
      const archiveId = c.id || `schr_${Date.now()}`;
      c.archiveId = archiveId;
      const subLabel = c.mode === "examen"
        ? "Strikte examensimulatie (58%)"
        : c.mode === "interactie"
          ? "Schriftelijke interactie (29%)"
          : "Schrijven (29%)";
      App.progress.evaluaties.push({
        id: archiveId,
        datum: attemptSnapshot.datum,
        domein: "schrijven",
        submodus: subLabel,
        titel: c.tasks.map((t) => t.titel).join(" + "),
        scorePct: avgPct,
        totaalOp20: avg20,
        opdrachten: c.tasks,
        poging1: attemptSnapshot,
        poging2: null,
        heeftVerbetering: false,
      });
    } else {
      c.poging2 = attemptSnapshot;
      c.revising = false;
      c.revisionMandatory = false;
      const entry = App.progress.evaluaties.find((e) => e.id === c.archiveId);
      if (entry) {
        entry.poging2 = attemptSnapshot;
        entry.heeftVerbetering = true;
        entry.verbeterdPct = avgPct;
      }
    }

    scheduleSaveProgress();
  } catch (err) {
    showWriteError(err.message);
  } finally {
    App.write.evaluating = false;
    renderWritingModule();
  }
}

function renderEvalBreakdown(evalObj, prevEval = null, titlePrefix = "") {
  const growthHtml = prevEval
    ? (() => {
        const c1 = scoreToCategory(prevEval.scorePct);
        const c2 = scoreToCategory(evalObj.scorePct);
        const improved = evalObj.scorePct > prevEval.scorePct;
        const label = c1.id !== c2.id
          ? `${c1.label} → ${c2.label}`
          : improved
            ? `Verbeterd binnen ${c2.label}`
            : `Zelfde niveau (${c2.label})`;
        return `<span class="growth-pill${improved ? " up" : ""}">${label}</span>`;
      })()
    : "";

  const critHtml = evalObj.criteria.map((cr) => {
    const crPct = Math.round(((Number(cr.score) || 0) / Math.max(1, Number(cr.max) || 4)) * 100);
    return `
    <div class="crit-card">
      <div class="crit-top">
        <span>${escapeHtml(cr.naam || cr.id)}</span>
        ${renderCategoryBadge(crPct)}
      </div>
      <p class="crit-fb">${escapeHtml(cr.feedback)}</p>
    </div>
  `;
  }).join("");

  const foutenHtml = evalObj.fouten.length
    ? `<div class="mistakes-list">${evalObj.fouten.map((f) => `
        <div class="mistake-item">
          <div><span class="mistake-quote">${escapeHtml(f.citaat)}</span> <span class="muted">(${escapeHtml(f.type)})</span></div>
          <div style="margin-top:0.25rem;">${escapeHtml(f.uitleg)}</div>
          ${f.tip ? `<div class="muted" style="margin-top:0.15rem;"><strong>Tip:</strong> ${escapeHtml(f.tip)}</div>` : ""}
        </div>
      `).join("")}</div>`
    : `<p class="muted">Geen grote taalfouten opgemerkt.</p>`;

  return `
    <div class="eval-card">
      <div class="eval-header">
        <div>
          <h3 style="margin:0;">${titlePrefix ? `${escapeHtml(titlePrefix)} · ` : ""}Beoordeling (7 examencriteria)</h3>
          <p class="muted" style="margin:0.25rem 0 0;">${escapeHtml(evalObj.samenvatting)}</p>
        </div>
        <div style="display:flex;align-items:center;gap:0.65rem;flex-wrap:wrap;">
          ${growthHtml}
          ${renderCategoryBadge(evalObj.scorePct, true)}
        </div>
      </div>
      ${evalObj.sterktes.length ? `<p style="margin:0 0 0.75rem;font-size:0.9rem;"><strong>Sterke punten:</strong> ${evalObj.sterktes.map(escapeHtml).join(" · ")}</p>` : ""}
      <div class="criteria-grid">${critHtml}</div>
      <h4 style="margin:0.5rem 0 0.35rem;font-size:0.94rem;">Belangrijkste verbeterpunten (om zelf op te lossen)</h4>
      ${foutenHtml}
    </div>
  `;
}

function renderWritingHelperPanel(concept, taskIdx) {
  const scratchHtml = `
    <div>
      <h4>Kladblad ${concept.strict ? "(enkel leeg kladblad — examenmodus)" : "/ Schrijfplan"}</h4>
      <textarea id="write-scratchpad" class="scratchpad-editor" spellcheck="false" placeholder="${concept.strict ? "Kernwoorden of structuur…" : "Inleiding:\nMidden (kernpunten):\nSlot:"}">${escapeHtml(concept.scratchpads[taskIdx] || "")}</textarea>
    </div>
  `;

  if (concept.strict) {
    return `<aside class="helper-panel">${scratchHtml}</aside>`;
  }

  const sig = App.curriculum.examen.signaalwoorden || {};
  const sigLabels = {
    chronologisch: "Volgorde",
    oorzaak_reden: "Oorzaak / reden",
    gevolg_conclusie: "Gevolg / besluit",
    tegenstelling_toegeving: "Tegenstelling",
    opsomming_toelichting: "Opsomming",
    voorwaarde_doel: "Voorwaarde / doel",
  };
  const sigHtml = Object.entries(sig).map(([k, arr]) => `
    <div class="connector-group">
      <strong>${sigLabels[k] || k}:</strong>
      <div class="connector-tags">
        ${arr.map((w) => `<button type="button" class="connector-tag" data-insert-connector="${escapeHtml(w)}">${escapeHtml(w)}</button>`).join("")}
      </div>
    </div>
  `).join("");

  const critChecklist = App.curriculum.examen.beoordelingscriteria
    .map((c) => `<li><strong>${escapeHtml(c.naam)}:</strong> ${escapeHtml(c.rubric)}</li>`)
    .join("");

  return `
    <aside class="helper-panel">
      ${scratchHtml}
      <div>
        <h4>Signaalwoorden (klik om in te voegen)</h4>
        ${sigHtml}
      </div>
      <div>
        <h4>Nalees-checklist (7 criteria)</h4>
        <ul class="req-list" style="font-size:0.8rem;color:var(--muted);">${critChecklist}</ul>
      </div>
    </aside>
  `;
}

function renderWritingArchive() {
  const wrap = document.getElementById("write-archive");
  const countEl = document.getElementById("write-archive-count");
  const items = App.progress.evaluaties.filter((e) => e.domein === "schrijven").reverse();

  countEl.textContent = `${items.length} opgeslagen schrijfopdracht(en) — uitklapbaar met volledige tekst en 7-criteria feedback`;
  if (!items.length) {
    wrap.innerHTML = `<div class="card muted">Nog geen ingediende schrijfopdrachten. Genereer bovenaan je eerste opdracht!</div>`;
    return;
  }

  wrap.innerHTML = `<div class="archive-list">${items.map((item) => {
    const isOpen = App.write.openArchiveId === item.id;
    const catHtml = item.poging2
      ? `${renderCategoryBadge(item.poging1.scorePct)} → ${renderCategoryBadge(item.poging2.scorePct)}`
      : renderCategoryBadge(item.scorePct);

    const bodyTasks = (item.opdrachten || []).map((t, i) => {
      const p1Text = item.poging1?.teksten?.[i] || "";
      const p1Eval = item.poging1?.perOpdracht?.[i];
      const p2Text = item.poging2?.teksten?.[i] || "";
      const p2Eval = item.poging2?.perOpdracht?.[i];
      return `
        <div style="margin-top:0.9rem;">
          <h4 style="margin:0 0 0.35rem;">${item.opdrachten.length > 1 ? `Opdracht ${i + 1}: ` : ""}${escapeHtml(t.titel)}</h4>
          <p class="muted" style="margin:0 0 0.45rem;">${escapeHtml(t.context)}</p>
          ${t.brontekst ? `<div class="source-message"><span class="source-message-label">Inkomend bericht</span>${escapeHtml(t.brontekst)}</div>` : ""}
          <strong>Poging 1 ${p1Eval ? renderCategoryBadge(p1Eval.scorePct) : ""}</strong>
          <div class="archive-text-box">${escapeHtml(p1Text)}</div>
          ${p1Eval ? renderEvalBreakdown(p1Eval, null, "Poging 1") : ""}
          ${p2Eval ? `
            <div style="margin-top:0.85rem;">
              <strong>Verbeterpoging ${renderCategoryBadge(p2Eval.scorePct)}</strong>
              <div class="archive-text-box">${escapeHtml(p2Text)}</div>
              ${renderEvalBreakdown(p2Eval, p1Eval, "Verbeterpoging")}
            </div>
          ` : ""}
        </div>
      `;
    }).join('<hr class="divider" />');

    return `
      <details class="archive-item" data-archive-id="${escapeHtml(item.id)}"${isOpen ? " open" : ""}>
        <summary class="archive-summary">
          <div>
            <strong>${escapeHtml(item.titel)}</strong>
            <div class="muted">${new Date(item.datum).toLocaleDateString("nl-BE")} · ${escapeHtml(item.submodus || "Schrijven")}</div>
          </div>
          <div class="btn-row" style="gap:0.35rem;">${catHtml}</div>
        </summary>
        <div class="archive-body">${bodyTasks}</div>
      </details>
    `;
  }).join("")}</div>`;
}

function renderWritingModule() {
  if (!App.curriculum) return;
  renderWritingModeBar();
  renderWritingArchive();

  const ws = document.getElementById("write-workspace");
  if (App.write.loading) {
    ws.innerHTML = `<div class="card empty-module"><p class="muted">✨ Realistische B1-examenopdracht wordt gegenereerd…</p></div>`;
    return;
  }

  const c = App.progress.schrijfConcept;
  if (!c || !c.tasks?.length) {
    ws.innerHTML = `
      <div class="card empty-module">
        <h3>Klaar om te schrijven?</h3>
        <p class="muted">Kies bovenaan een schrijfmodus (Schrijven, Schriftelijke interactie of Strikte Examensimulatie) en klik op <strong>Genereer opdracht</strong>. Je concept wordt tijdens het typen automatisch op de server bewaard.</p>
      </div>
    `;
    return;
  }

  const idx = Math.min(c.activeTaskIdx || 0, c.tasks.length - 1);
  const task = c.tasks[idx];
  const text = c.texts[idx] || "";
  const wc = countWords(text);
  const over = c.timerSecondsLeft <= 0;
  const tools = App.curriculum.examen.hulpmiddelen || [];
  const showHelper = c.strict || App.write.helperOpen;
  const activeEvalAttempt = c.poging2 || c.poging1;
  const showEditor = !activeEvalAttempt || c.revising;

  const taskTabsHtml = c.tasks.length > 1
    ? `<div class="write-task-tabs">${c.tasks.map((t, i) => `
        <button type="button" class="mode-btn${i === idx ? " active" : ""}" data-write-task-idx="${i}">
          Opdracht ${i + 1}: ${t.type === "interactie" ? "Interactie" : "Schrijven"} (${countWords(c.texts[i])} w.)
        </button>
      `).join("")}</div>`
    : "";

  const topbarHtml = `
    <div class="write-topbar">
      <div class="timer-box">
        <span id="write-timer-display" class="timer-display${over ? " overtime" : ""}">
          ${over ? `00:00 (tijd om · +${formatTimer(c.timerOvertime || 0)})` : formatTimer(c.timerSecondsLeft)}
        </span>
        <button type="button" class="btn btn-secondary btn-sm" data-write-action="toggle-timer">
          ${App.write.timerRunning ? "Pauzeer" : "Start timer"}
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-write-action="reset-timer">Reset</button>
        <span class="muted" style="font-size:0.78rem;">(indicatief)</span>
      </div>
      <div class="btn-row">
        ${c.strict
          ? `<span class="exam-strict-badge">Strikte examenmodus · geen oefenhulp</span>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-write-action="toggle-helper">${App.write.helperOpen ? "Verberg oefenhulp" : "Oefenhulp (kladblad & signaalwoorden)"}</button>`
        }
        ${tools.map((tl) => `<a class="btn btn-secondary btn-sm tool-link" href="${escapeHtml(tl.url)}" target="_blank" rel="noopener noreferrer">📖 ${escapeHtml(tl.naam)} ↗</a>`).join("")}
      </div>
    </div>
  `;

  const promptCardHtml = `
    <div class="prompt-card">
      <div class="prompt-meta">
        <span class="weight-pill">${task.type === "interactie" ? "Schriftelijke interactie (29%)" : "Schrijven (29%)"}</span>
        ${task.thema ? `<span class="chip chip-sm">${escapeHtml(task.thema)}</span>` : ""}
        ${task.register ? `<span class="chip chip-sm">Register: ${escapeHtml(task.register)}</span>` : ""}
        ${task.richtwoorden ? `<span class="chip chip-sm">Richtlengte: ${escapeHtml(task.richtwoorden)} woorden</span>` : ""}
      </div>
      <h3>${escapeHtml(task.titel)}</h3>
      <p style="margin:0 0 0.5rem;">${escapeHtml(task.context)}</p>
      ${task.ontvanger ? `<div class="muted"><strong>Ontvanger:</strong> ${escapeHtml(task.ontvanger)}</div>` : ""}
      ${task.brontekst ? `<div class="source-message"><span class="source-message-label">Inkomend bericht (om op te reageren)</span>${escapeHtml(task.brontekst)}</div>` : ""}
      ${task.vereisten?.length ? `<ul class="req-list">${task.vereisten.map((v) => `<li>${escapeHtml(v)}</li>`).join("")}</ul>` : ""}
    </div>
  `;

  const stepperHtml = !c.strict
    ? (() => {
        const step = !c.poging1 ? 1 : c.revising ? 2 : 3;
        return `
          <div class="write-stepper" aria-label="Voortgang schrijfopdracht">
            <span class="step-pill ${step > 1 ? "done" : "active"}">${step > 1 ? "✓ " : ""}1. Eerste versie schrijven</span>
            <span class="step-sep">→</span>
            <span class="step-pill ${step === 2 ? "active" : step > 2 ? "done" : ""}">${step > 2 ? "✓ " : ""}2. Verbeteren &amp; herschrijven</span>
            <span class="step-sep">→</span>
            <span class="step-pill ${step === 3 ? "done" : ""}">${step === 3 ? "✓ " : ""}3. Afgerond</span>
          </div>
        `;
      })()
    : "";

  const revisionGuideHtml = c.revising && c.poging1?.perOpdracht?.[idx]
    ? (() => {
        const p1 = c.poging1.perOpdracht[idx];
        const fouten = p1.fouten || [];
        return `
          <div class="card" style="margin-bottom:1rem;border-color:#f59e0b;background:var(--warn-soft);">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.45rem;">
              <strong>✏️ Stap 2: Verbeter je tekst op basis van de feedback</strong>
              ${renderCategoryBadge(p1.scorePct)}
            </div>
            <p class="muted" style="margin:0 0 0.55rem;color:#78350f;">Los de onderstaande aandachtspunten zelf op in je tekst hieronder en dien je verbeterde versie in om de oefening af te ronden.</p>
            ${fouten.length ? `<div class="mistakes-list" style="margin-bottom:0;">
              ${fouten.map((f) => `
                <div class="mistake-item" style="background:#fff;">
                  <span class="mistake-quote">${escapeHtml(f.citaat)}</span> — ${escapeHtml(f.uitleg)}
                  ${f.tip ? ` <span class="muted">(Tip: ${escapeHtml(f.tip)})</span>` : ""}
                </div>
              `).join("")}
            </div>` : `<p class="muted" style="margin:0;">Verfijn je zinsbouw, woordenschat of structuur op basis van de 7-criteria feedback hieronder.</p>`}
          </div>
        `;
      })()
    : "";

  const editorBlockHtml = showEditor
    ? `
      <div class="card">
        <label for="write-editor" style="display:block;font-weight:700;font-size:0.9rem;margin-bottom:0.45rem;">
          ${c.revising ? "Verbeterde Franse tekst (Stap 2)" : "Jouw Franse tekst"} <span class="muted" style="font-weight:400;">(spellingcontrole uitgeschakeld zoals op examen)</span>
        </label>
        <textarea id="write-editor" class="write-editor" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="Schrijf hier je Franse tekst…">${escapeHtml(text)}</textarea>
        ${renderAccentBar("write-editor")}
        <div class="editor-footer">
          <span id="write-word-count" class="word-counter${wc >= 110 ? " in-range" : ""}">
            ${wc} woorden${task.richtwoorden ? ` (richtlijn: ${escapeHtml(task.richtwoorden)})` : ""}
          </span>
          <div class="btn-row">
            ${c.revising && !c.revisionMandatory ? `<button type="button" class="btn btn-secondary" data-write-action="cancel-revise">Annuleer verbeteren</button>` : ""}
            <button type="button" class="btn btn-primary" data-write-action="evaluate" ${App.write.evaluating ? "disabled" : ""}>
              ${App.write.evaluating ? "Evalueren met 7 criteria…" : c.revising ? "✓ Dien verbeterde tekst in" : c.tasks.length > 1 ? "Evalueer beide opdrachten" : "Evalueer tekst (Stap 1)"}
            </button>
          </div>
        </div>
      </div>
    `
    : `
      <div class="card">
        <div class="stage-toolbar" style="margin-bottom:0.5rem;">
          <strong>${c.poging2 ? "✓ Afgeronde verbeterde tekst" : "Ingediende tekst"} (${wc} woorden)</strong>
          <div class="btn-row">
            ${!c.poging2 && c.strict ? `<button type="button" class="btn btn-secondary btn-sm" data-write-action="start-revise">✏️ Nabespreken &amp; verbeteren</button>` : ""}
            <button type="button" class="btn btn-primary btn-sm" data-write-action="clear-concept">✨ Nieuwe opdracht</button>
          </div>
        </div>
        <div class="archive-text-box" style="margin:0;">${escapeHtml(text)}</div>
      </div>
    `;

  let evalBlockHtml = "";
  if (activeEvalAttempt) {
    const curTaskEval = activeEvalAttempt.perOpdracht?.[idx];
    const prevTaskEval = c.poging2 ? c.poging1?.perOpdracht?.[idx] : null;
    if (curTaskEval) {
      evalBlockHtml = renderEvalBreakdown(curTaskEval, prevTaskEval, c.poging2 ? "Verbeterpoging" : "Poging 1");
    }
  }

  ws.innerHTML = `
    ${stepperHtml}
    ${topbarHtml}
    ${taskTabsHtml}
    <div class="write-grid${showHelper ? " with-helper" : ""}">
      <div>
        ${promptCardHtml}
        ${revisionGuideHtml}
        ${editorBlockHtml}
        ${evalBlockHtml}
      </div>
      ${showHelper ? renderWritingHelperPanel(c, idx) : ""}
    </div>
  `;
}

function handleWritingWorkspaceClick(e) {
  const c = App.progress.schrijfConcept;
  const accBtn = e.target.closest("[data-accent]");
  if (accBtn) {
    const el = document.getElementById(accBtn.dataset.accentTarget);
    insertAtCursor(el, accBtn.dataset.accent);
    if (el && el.id === "write-editor" && c) {
      c.texts[c.activeTaskIdx || 0] = el.value;
      scheduleSaveProgress();
    }
    return;
  }

  const connBtn = e.target.closest("[data-insert-connector]");
  if (connBtn && c) {
    const el = document.getElementById("write-editor");
    if (el) {
      insertAtCursor(el, `${connBtn.dataset.insertConnector} `);
      c.texts[c.activeTaskIdx || 0] = el.value;
      const wcEl = document.getElementById("write-word-count");
      if (wcEl) wcEl.textContent = `${countWords(el.value)} woorden`;
      scheduleSaveProgress();
    }
    return;
  }

  const taskBtn = e.target.closest("[data-write-task-idx]");
  if (taskBtn && c) {
    c.activeTaskIdx = Number(taskBtn.dataset.writeTaskIdx);
    renderWritingModule();
    return;
  }

  const actBtn = e.target.closest("[data-write-action]");
  if (!actBtn || !c) return;
  const act = actBtn.dataset.writeAction;
  if (act === "toggle-timer") {
    if (App.write.timerRunning) stopWriteTimer();
    else startWriteTimer();
    renderWritingModule();
  } else if (act === "reset-timer") {
    stopWriteTimer();
    c.timerSecondsLeft = c.timerTotalSeconds;
    c.timerOvertime = 0;
    scheduleSaveProgress();
    renderWritingModule();
  } else if (act === "toggle-helper") {
    App.write.helperOpen = !App.write.helperOpen;
    renderWritingModule();
  } else if (act === "evaluate") {
    evaluateWritingSubmission();
  } else if (act === "start-revise") {
    c.revising = true;
    renderWritingModule();
  } else if (act === "cancel-revise") {
    c.revising = false;
    renderWritingModule();
  } else if (act === "clear-concept") {
    stopWriteTimer();
    App.progress.schrijfConcept = null;
    scheduleSaveProgress();
    renderWritingModule();
  }
}

/* ---------- Tab 3: Spreken & Gesprek (38% · Gemini Audio + Fallback) ---------- */

const SPEAKING_MODES = [
  { id: "monoloog", label: "Monoloog (Thuisopdracht · 8%)", strict: false },
  { id: "gesprek_oefen", label: "Gesprek — Oefenmodus (30%)", strict: false },
  { id: "gesprek_examen", label: "Gesprek — Strikte Examenmodus (30%)", strict: true },
];

const ORAL_CRITERIA = [
  { id: "taakvoltooiing", naam: "Taakvoltooiing & inhoud", max: 4, rubric: "Doel bereikt, alle spreek-/gesprekspunten uitgewerkt, spontane en relevante reacties." },
  { id: "woordenschat", naam: "Woordenschat", max: 3, rubric: "Vrij brede B1-woordenschat, correcte vaste uitdrukkingen en woordcombinaties." },
  { id: "grammatica", naam: "Grammatica & zinsbouw", max: 4, rubric: "Goede beheersing van vervoegingen, tijden en zinsbouw; fouten storen begrip niet." },
  { id: "tekststructuur", naam: "Structuur, signaalwoorden & interactie", max: 3, rubric: "Herkenbare opbouw (inleiding/midden/slot) met signaalwoorden; bij gesprek: openen, gaande houden en afsluiten." },
  { id: "register", naam: "Register & beleefdheid", max: 2, rubric: "Gepast register (tu/vous, conditionnel de politesse) en beleefdheidsconventies." },
  { id: "uitspraak_vlotheid", naam: "Uitspraak, intonatie & vlotheid", max: 4, rubric: "Voldoende heldere Franse uitspraak, klanken, liaison/intonatie en vlot spreektempo ondanks korte pauzes." },
];

const DIALOGUE_HELP_PHRASES = {
  openen: ["Bonjour Madame / Monsieur, je viens pour...", "Salut ! Je voulais te parler de..."],
  herhalen: ["Excusez-moi, pourriez-vous répéter ?", "Pourriez-vous parler un peu plus lentement ?", "Je n'ai pas bien compris, que voulez-vous dire ?"],
  mening: ["À mon avis...", "Je trouve que...", "D'un côté..., mais d'un autre côté..."],
  afsluiten: ["Merci beaucoup pour votre aide !", "Au revoir et bonne journée !", "À bientôt !"],
};

function showSpeakError(msg) {
  const el = document.getElementById("speak-error");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function speakExaminer(text, rate = App.speak.ttsRate) {
  if (!("speechSynthesis" in window) || !text) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "fr-FR";
  utter.rate = rate;
  const voices = window.speechSynthesis.getVoices?.() || [];
  const frVoice = voices.find((v) => v.lang?.toLowerCase().startsWith("fr"));
  if (frVoice) utter.voice = frVoice;
  window.speechSynthesis.speak(utter);
}

function stopSpeakTimer() {
  if (App.speak.timerId) {
    clearInterval(App.speak.timerId);
    App.speak.timerId = null;
  }
  App.speak.timerRunning = false;
}

function startSpeakTimer(targetObj) {
  if (!targetObj) return;
  stopSpeakTimer();
  App.speak.timerRunning = true;
  App.speak.timerId = setInterval(() => {
    if (targetObj.timerSecondsLeft > 0) {
      targetObj.timerSecondsLeft -= 1;
    } else {
      targetObj.timerOvertime = (targetObj.timerOvertime || 0) + 1;
    }
    const disp = document.getElementById("speak-timer-display");
    if (disp) {
      const over = targetObj.timerSecondsLeft <= 0;
      disp.classList.toggle("overtime", over);
      disp.textContent = over
        ? `00:00 (tijd om · +${formatTimer(targetObj.timerOvertime || 0)})`
        : formatTimer(targetObj.timerSecondsLeft);
    }
  }, 1000);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || "");
      const idx = res.indexOf(",");
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = () => reject(new Error("Kon audio niet inlezen."));
    reader.readAsDataURL(blob);
  });
}

function pickAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const prefs = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return prefs.find((m) => MediaRecorder.isTypeSupported?.(m)) || "";
}

function cleanupRecorder() {
  if (App.speak.recTickId) {
    clearInterval(App.speak.recTickId);
    App.speak.recTickId = null;
  }
  if (App.speak.recStream) {
    App.speak.recStream.getTracks().forEach((t) => t.stop());
    App.speak.recStream = null;
  }
  App.speak.recorder = null;
  App.speak.recMode = null;
}

async function startAudioRecording(mode) {
  if (App.speak.recorder || App.speak.busy) return;
  showSpeakError("");
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showSpeakError("Microfoonopname wordt op deze pagina/browser niet ondersteund (mogelijk door HTTP zonder HTTPS). Gebruik 'Audio uploaden' of de tekstinvoer hieronder.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickAudioMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    App.speak.recStream = stream;
    App.speak.recorder = recorder;
    App.speak.recChunks = [];
    App.speak.recMode = mode;
    App.speak.recStartMs = Date.now();
    App.speak.recSeconds = 0;

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) App.speak.recChunks.push(ev.data);
    };

    recorder.onstop = async () => {
      const rawMime = (recorder.mimeType || mimeType || "audio/webm").split(";")[0];
      const blob = new Blob(App.speak.recChunks, { type: rawMime });
      const durationSec = Math.max(1, Math.round((Date.now() - App.speak.recStartMs) / 1000));
      const finishedMode = App.speak.recMode;
      cleanupRecorder();

      if (blob.size < 400) {
        showSpeakError("De opname was te kort of stil. Probeer opnieuw te spreken.");
        renderSpeakingModule();
        return;
      }

      try {
        const base64 = await blobToBase64(blob);
        if (finishedMode === "monoloog" && App.speak.monologue) {
          if (App.speak.monologue.audioUrl) URL.revokeObjectURL(App.speak.monologue.audioUrl);
          App.speak.monologue.audioBase64 = base64;
          App.speak.monologue.audioMime = rawMime;
          App.speak.monologue.audioUrl = URL.createObjectURL(blob);
          App.speak.monologue.audioSec = durationSec;
          App.speak.monologue.audioDirty = true;
          renderSpeakingModule();
        } else if (finishedMode === "gesprek" && App.speak.dialogue) {
          await sendDialogueTurn({ audioBase64: base64, audioMime: rawMime });
        }
      } catch (err) {
        showSpeakError(err.message);
        renderSpeakingModule();
      }
    };

    recorder.start(250);
    const maxSec = mode === "monoloog" ? 180 : 90;
    App.speak.recTickId = setInterval(() => {
      App.speak.recSeconds = Math.floor((Date.now() - App.speak.recStartMs) / 1000);
      const el = document.getElementById("speak-rec-timer");
      if (el) el.textContent = `${formatTimer(App.speak.recSeconds)} / ${formatTimer(maxSec)}`;
      if (App.speak.recSeconds >= maxSec) stopAudioRecording();
    }, 500);
    renderSpeakingModule();
  } catch (err) {
    cleanupRecorder();
    showSpeakError(`Geen toegang tot microfoon (${err.name || "geweigerd"}). Gebruik 'Audio uploaden' of de tekstinvoer.`);
    renderSpeakingModule();
  }
}

function stopAudioRecording() {
  if (App.speak.recorder && App.speak.recorder.state !== "inactive") {
    App.speak.recorder.stop();
  }
}

async function handleAudioFileUpload(file, mode) {
  if (!file) return;
  showSpeakError("");
  if (file.size > 9 * 1024 * 1024) {
    showSpeakError("Audiobestand is te groot (max. 9 MB).");
    return;
  }
  const mime = (file.type || "audio/mp4").split(";")[0];
  try {
    const base64 = await blobToBase64(file);
    if (mode === "monoloog" && App.speak.monologue) {
      if (App.speak.monologue.audioUrl) URL.revokeObjectURL(App.speak.monologue.audioUrl);
      App.speak.monologue.audioBase64 = base64;
      App.speak.monologue.audioMime = mime;
      App.speak.monologue.audioUrl = URL.createObjectURL(file);
      App.speak.monologue.audioSec = null;
      App.speak.monologue.audioDirty = true;
      renderSpeakingModule();
    } else if (mode === "gesprek" && App.speak.dialogue) {
      await sendDialogueTurn({ audioBase64: base64, audioMime: mime });
    }
  } catch (err) {
    showSpeakError(err.message);
  }
}

function initSpeakingModule() {
  const wfSel = document.getElementById("speak-wf-select");
  wfSel.innerHTML = App.curriculum.woordvelden
    .map((wf) => `<option value="${wf.id}">${String(wf.nummer).padStart(2, "0")} · ${escapeHtml(wf.titel_nl)}</option>`)
    .join("");
  wfSel.value = App.speak.wfId;

  const doelSel = document.getElementById("speak-doel-select");
  doelSel.innerHTML = App.curriculum.communicatieve_doelen
    .map((d) => `<option value="${d.id}">${escapeHtml(d.naam)}</option>`)
    .join("");
  doelSel.value = App.speak.doelId;

  renderSpeakingModeBar();
}

function renderSpeakingModeBar() {
  const bar = document.getElementById("speak-mode-bar");
  bar.innerHTML = SPEAKING_MODES.map(
    (m) => `<button type="button" class="mode-btn${m.id === App.speak.mode ? " active" : ""}" data-speak-mode="${m.id}" role="tab">${escapeHtml(m.label)}</button>`
  ).join("");
  const isStrictExam = App.speak.mode === "gesprek_examen";
  document.querySelectorAll("#speak-setup-row .drill-field").forEach((f) => f.classList.toggle("hidden", isStrictExam));
  document.getElementById("btn-speak-random").classList.toggle("hidden", isStrictExam);
  document.getElementById("btn-speak-generate").textContent =
    App.speak.mode === "monoloog"
      ? "✨ Genereer spreekopdracht (Monoloog)"
      : isStrictExam
        ? "✨ Start strikt examengesprek"
        : "✨ Genereer gesprekscasus";
}

function pickRandomSpeakingPair() {
  const wfs = App.curriculum.woordvelden;
  const doelen = App.curriculum.communicatieve_doelen;
  App.speak.wfId = wfs[Math.floor(Math.random() * wfs.length)].id;
  App.speak.doelId = doelen[Math.floor(Math.random() * doelen.length)].id;
  document.getElementById("speak-wf-select").value = App.speak.wfId;
  document.getElementById("speak-doel-select").value = App.speak.doelId;
}

async function generateSpeakingAssignment() {
  if (!canUseAi()) {
    showSpeakError("Stel eerst je Gemini API-key in via Instellingen.");
    return;
  }
  stopSpeakTimer();
  stopAudioRecording();
  showSpeakError("");
  App.speak.loading = true;
  App.speak.helperOpen = false;
  renderSpeakingModule();

  try {
    const isStrictExam = App.speak.mode === "gesprek_examen";
    const wfs = App.curriculum.woordvelden;
    const doelen = App.curriculum.communicatieve_doelen;
    const wf = isStrictExam
      ? wfs[Math.floor(Math.random() * wfs.length)]
      : (wfs.find((w) => w.id === App.speak.wfId) || wfs[0]);
    const doel = isStrictExam
      ? doelen[Math.floor(Math.random() * doelen.length)]
      : (doelen.find((d) => d.id === App.speak.doelId) || doelen[0]);
    const sampleWords = shuffleArray(wf.woorden).slice(0, 8).map((w) => w.fr).join(", ");

    if (App.speak.mode === "monoloog") {
      const prompt = [
        `Je bent examenmaker voor Vlaamse Examencommissie 'Frans 2' (2de graad, B1).`,
        `Maak 1 realistische spreekopdracht (Monoloog thuisopdracht, 8%, ca. 2-3 minuten spreken).`,
        `Thema: ${wf.titel_nl} (sfeerwoorden: ${sampleWords}). Doel: ${doel.naam} (${doel.beschrijving}).`,
        `Geef UITSLUITEND geldig JSON terug: {"titel":"korte NL titel","thema":"${wf.titel_nl}","doel":"${doel.naam}","context":"heldere NL opdrachtomschrijving (2-3 zinnen)","register":"neutraal/formeel (vous) of informeel (tu)","richtduur":"2-3 minuten","spreekpunten":["punt 1","punt 2","punt 3","punt 4"]}`,
      ].join("\n\n");
      const task = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 700, temperature: 0.65 });
      App.speak.monologue = {
        id: `mono_${Date.now()}`,
        task,
        plan: "",
        timerTotalSeconds: 600,
        timerSecondsLeft: 600,
        timerOvertime: 0,
        audioBase64: null,
        audioMime: null,
        audioUrl: null,
        audioSec: null,
        audioDirty: false,
        textFallback: "",
        poging1: null,
        poging2: null,
        revising: false,
        revisionMandatory: false,
        archiveId: null,
      };
      startSpeakTimer(App.speak.monologue);
    } else {
      const prompt = [
        `Je bent examenmaker voor Vlaamse Examencommissie 'Frans 2' (2de graad, B1).`,
        `Maak 1 realistische casus voor het Mondeling Gesprek (30%, 15 min voorbereiding + 10 min rollenspel met examinator).`,
        `Thema: ${wf.titel_nl} (sfeerwoorden: ${sampleWords}). Doel: ${doel.naam} (${doel.beschrijving}).`,
        `Geef UITSLUITEND geldig JSON terug: {"titel":"korte NL titel","thema":"${wf.titel_nl}","doel":"${doel.naam}","rol_leerling":"wie de leerling speelt (NL)","rol_examinator":"wie de examinator speelt (NL)","register":"neutraal/formeel (vous) of informeel (tu)","context":"heldere NL situatie (2-3 zinnen)","gesprekspunten":["punt 1","punt 2","punt 3","punt 4"],"openingszin_examinator":"korte, natuurlijke Franse openingszin waarmee de examinator het gesprek start"}`,
      ].join("\n\n");
      const casus = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 800, temperature: 0.65 });
      App.speak.dialogue = {
        id: `gespr_${Date.now()}`,
        strict: isStrictExam,
        casus,
        phase: "prep", // "prep" | "dialogue" | "evaluated"
        scratchpad: "",
        timerTotalSeconds: 900, // 15 min prep
        timerSecondsLeft: 900,
        timerOvertime: 0,
        turns: [], // [{ role: "examiner"|"student", text, pronNote? }]
        evaluation: null,
      };
      startSpeakTimer(App.speak.dialogue);
    }
  } catch (err) {
    showSpeakError(err.message);
  } finally {
    App.speak.loading = false;
    renderSpeakingModule();
  }
}

function normalizeOralEval(res) {
  const rawCriteria = Array.isArray(res.criteria) ? res.criteria : [];
  const byId = new Map(rawCriteria.map((cr) => [String(cr.id || "").toLowerCase(), cr]));
  const normalized = ORAL_CRITERIA.map((def) => {
    const found = byId.get(def.id) || rawCriteria.find((cr) => String(cr.naam || "").toLowerCase().includes(def.naam.slice(0, 6).toLowerCase()));
    const rawScore = Number(found?.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(def.max, Math.round(rawScore))) : 0;
    return { id: def.id, naam: def.naam, score, max: def.max, feedback: found?.feedback || "" };
  });
  const maxTotal = normalized.reduce((s, cr) => s + cr.max, 0);
  const totaalOp20 = normalized.reduce((s, cr) => s + cr.score, 0);
  const scorePct = Math.round((totaalOp20 / Math.max(1, maxTotal)) * 100);
  return {
    totaalOp20,
    scorePct,
    transcript: res.transcript || "",
    samenvatting: res.samenvatting || "",
    uitspraakFeedback: res.uitspraakFeedback || "",
    sterktes: Array.isArray(res.sterktes) ? res.sterktes : [],
    criteria: normalized,
    fouten: Array.isArray(res.fouten) ? res.fouten : [],
  };
}

async function evaluateMonologue() {
  const m = App.speak.monologue;
  if (!m || !canUseAi()) return;

  const hasAudio = Boolean(m.audioBase64 && m.audioDirty);
  const hasText = countWords(m.textFallback) >= 15;
  if (!hasAudio && !hasText) {
    showSpeakError(m.revising ? "Neem eerst een nieuwe verbeterde audio-opname op (of vul de tekst-fallback aan)." : "Neem eerst je Franse monoloog op (of upload een audio-opname).");
    return;
  }

  const isRevision = Boolean(m.poging1 && m.revising);
  stopSpeakTimer();
  showSpeakError("");
  App.speak.busy = true;
  renderSpeakingModule();

  try {
    const critLines = ORAL_CRITERIA.map((c) => `- ${c.id} (${c.naam}, max ${c.max}): ${c.rubric}`).join("\n");
    const prevBlock = isRevision
      ? `\nDit is een VERBETER-OPNAME (vorige score: ${m.poging1.totaalOp20}/20). Vorige verbeterpunten: ${(m.poging1.fouten || []).map((f) => f.uitleg).join("; ")}. Beoordeel streng op deze nieuwe opname en benoem concreet wat verbeterd is.`
      : "";

    const promptText = [
      `Je bent een strenge, eerlijke examinator van de Vlaamse Examencommissie 'Frans 2' (2de graad, niveau B1).`,
      `Beoordeel deze gesproken Franse Monoloog (thuisopdracht, 8%).`,
      `Opdracht: ${m.task.titel}\nContext: ${m.task.context}\nRegister: ${m.task.register} · Spreekpunten: ${(m.task.spreekpunten || []).join(" | ")}`,
      hasAudio
        ? `Luister aandachtig naar de bijgevoegde audio-opname. Transcribeer EERST letterlijk wat de leerling in het Frans zegt (inclusief eventuele spreekfouten, aarzelingen of verkeerde vormen) en beoordeel daarna ook echt de uitspraak, klanken, liaison, intonatie en vlotheid.`
        : `Tekst-fallback (geen audio beschikbaar, beoordeel uitspraak_vlotheid conservatief op max 2/4 met melding):\n"""\n${m.textFallback.trim()}\n"""`,
      `Criteria (som maxima = 20; 10/20 = minimum om te slagen voor B1, geen troostpunten):\n${critLines}${prevBlock}`,
      `Geef UITSLUITEND geldig JSON terug: {"transcript":"letterlijke Franse transcriptie","samenvatting":"2 korte NL zinnen","uitspraakFeedback":"concrete NL feedback over Franse klanken, liaison, intonatie en tempo","sterktes":["..."],"criteria":[{"id":"taakvoltooiing","naam":"Taakvoltooiing & inhoud","score":3,"max":4,"feedback":"1 korte NL zin"}],"fouten":[{"citaat":"letterlijk uit transcript","type":"uitspraak|grammatica|woordenschat|structuur|register","uitleg":"korte NL uitleg","tip":"concrete oefentip"}]}`,
    ].join("\n\n");

    const parts = [{ text: promptText }];
    if (hasAudio) {
      parts.push({ inlineData: { mimeType: m.audioMime, data: m.audioBase64 } });
    }

    const res = await callGemini({
      contents: [{ role: "user", parts }],
      jsonMode: true,
      maxOutputTokens: 1600,
      temperature: 0.15,
    });
    const ev = normalizeOralEval(res);
    ev.datum = new Date().toISOString();
    m.audioDirty = false;

    if (!isRevision) {
      m.poging1 = ev;
      const needsRev = ev.scorePct < 85 || ev.fouten.length > 0;
      m.revising = needsRev;
      m.revisionMandatory = needsRev;
      m.archiveId = m.id;
      App.progress.evaluaties.push({
        id: m.id,
        datum: ev.datum,
        domein: "monoloog",
        submodus: "Monoloog (thuisopdracht · 8%)",
        titel: m.task.titel,
        scorePct: ev.scorePct,
        totaalOp20: ev.totaalOp20,
        opdracht: m.task,
        poging1: ev,
        poging2: null,
        heeftVerbetering: false,
      });
    } else {
      m.poging2 = ev;
      m.revising = false;
      m.revisionMandatory = false;
      const entry = App.progress.evaluaties.find((e) => e.id === m.archiveId);
      if (entry) {
        entry.poging2 = ev;
        entry.heeftVerbetering = true;
        entry.verbeterdPct = ev.scorePct;
      }
    }
    scheduleSaveProgress();
  } catch (err) {
    showSpeakError(err.message);
  } finally {
    App.speak.busy = false;
    renderSpeakingModule();
  }
}

/* ---------- Dialogue (30% · 15 min prep + 10 min interactive examiner) ---------- */

function startDialoguePhase() {
  const d = App.speak.dialogue;
  if (!d) return;
  d.phase = "dialogue";
  d.timerTotalSeconds = 600; // 10 min gesprek
  d.timerSecondsLeft = 600;
  d.timerOvertime = 0;
  const opening = d.casus.openingszin_examinator || "Bonjour ! Installez-vous. Je vous écoute.";
  d.turns = [{ role: "examiner", text: opening }];
  startSpeakTimer(d);
  renderSpeakingModule();
  if (App.speak.ttsEnabled) speakExaminer(opening);
}

async function sendDialogueTurn({ audioBase64 = null, audioMime = null, typedText = "" }) {
  const d = App.speak.dialogue;
  if (!d || d.phase !== "dialogue" || App.speak.busy) return;
  if (!audioBase64 && !typedText.trim()) return;

  showSpeakError("");
  App.speak.busy = true;
  renderSpeakingModule();

  try {
    const recentHistory = d.turns.slice(-8)
      .map((t) => `${t.role === "examiner" ? "Examinator" : "Leerling"}: ${t.text}`)
      .join("\n");

    const promptText = [
      `Je bent de Franstalige examinator tijdens een 10-minutengesprek voor Vlaamse Examencommissie 'Frans 2' (niveau B1).`,
      `Casus: ${d.casus.titel} (${d.casus.context})\nJouw rol: ${d.casus.rol_examinator} · Rol leerling: ${d.casus.rol_leerling} · Register: ${d.casus.register}\nGesprekspunten die aan bod moeten komen: ${(d.casus.gesprekspunten || []).join(" | ")}`,
      `Gesprek tot nu toe:\n${recentHistory}`,
      audioBase64
        ? `De leerling antwoordde zojuist met de bijgevoegde Franse audio. Transcribeer kort en letterlijk wat ze zei, maak 1 zeer korte interne uitspraaknotitie (max 12 woorden), en antwoord daarna natuurlijk als examinator in het Frans (2-4 zinnen, B1-niveau, blijf in je rol, stel een logische of subtiel spontane vervolgvraag).`
        : `De leerling antwoordde (tekst-fallback): "${typedText.trim()}". Antwoord natuurlijk als examinator in het Frans (2-4 zinnen, B1-niveau, blijf in je rol, stel een logische of subtiel spontane vervolgvraag).`,
      `Geef UITSLUITEND geldig JSON terug: {"leerlingTranscript":"letterlijke Franse tekst van leerling","uitspraakNotitie":"korte NL notitie over uitspraak/vlotheid of lege string","examinatorAntwoord":"jouw Franse antwoord als examinator"}`,
    ].join("\n\n");

    const parts = [{ text: promptText }];
    if (audioBase64) {
      parts.push({ inlineData: { mimeType: audioMime, data: audioBase64 } });
    }

    const res = await callGemini({
      contents: [{ role: "user", parts }],
      jsonMode: true,
      maxOutputTokens: 700,
      temperature: 0.5,
    });

    const studentText = (res.leerlingTranscript || typedText || "(onverstaanbare audio)").trim();
    const reply = (res.examinatorAntwoord || "Très bien, pouvez-vous m'en dire un peu plus ?").trim();
    d.turns.push({ role: "student", text: studentText, pronNote: res.uitspraakNotitie || "" });
    d.turns.push({ role: "examiner", text: reply });

    renderSpeakingModule();
    if (App.speak.ttsEnabled) speakExaminer(reply);
  } catch (err) {
    showSpeakError(err.message);
  } finally {
    App.speak.busy = false;
    renderSpeakingModule();
    const log = document.getElementById("dialogue-log");
    if (log) log.scrollTop = log.scrollHeight;
  }
}

async function evaluateDialogueSession() {
  const d = App.speak.dialogue;
  if (!d || App.speak.busy) return;
  const studentTurns = d.turns.filter((t) => t.role === "student");
  if (studentTurns.length < 2) {
    showSpeakError("Voer eerst minstens 2 spreekbeurten in het gesprek voordat je laat evalueren.");
    return;
  }

  stopSpeakTimer();
  stopAudioRecording();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  showSpeakError("");
  App.speak.busy = true;
  renderSpeakingModule();

  try {
    const critLines = ORAL_CRITERIA.map((c) => `- ${c.id} (${c.naam}, max ${c.max}): ${c.rubric}`).join("\n");
    const transcriptLines = d.turns
      .map((t, i) => `${i + 1}. ${t.role === "examiner" ? "Examinator" : "Leerling"}: ${t.text}${t.pronNote ? ` [uitspraak: ${t.pronNote}]` : ""}`)
      .join("\n");

    const prompt = [
      `Je bent een strenge, eerlijke examinator van de Vlaamse Examencommissie 'Frans 2' (2de graad, niveau B1).`,
      `Beoordeel dit Mondeling Gesprek (30%) op basis van het volledige transcript en de uitspraaknotities.`,
      `Casus: ${d.casus.titel} · Context: ${d.casus.context} · Register: ${d.casus.register}\nGesprekspunten: ${(d.casus.gesprekspunten || []).join(" | ")}`,
      `Volledig gesprek:\n${transcriptLines}`,
      `Criteria (som maxima = 20; 10/20 = minimum om te slagen voor B1, geen troostpunten; let bij gesprek extra op interactie, spontaan reageren, register en uitspraak):\n${critLines}`,
      `Geef UITSLUITEND geldig JSON terug: {"samenvatting":"2 korte NL zinnen","uitspraakFeedback":"concrete NL feedback over uitspraak, vlotheid en interactie","sterktes":["..."],"criteria":[{"id":"taakvoltooiing","naam":"Taakvoltooiing & inhoud","score":3,"max":4,"feedback":"1 korte NL zin"}],"fouten":[{"citaat":"letterlijk uit leerlingbeurt","type":"uitspraak|grammatica|woordenschat|interactie|register","uitleg":"korte NL uitleg","tip":"concrete verbeteringstip"}]}`,
    ].join("\n\n");

    const res = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 1500, temperature: 0.15 });
    const ev = normalizeOralEval(res);
    ev.datum = new Date().toISOString();
    d.evaluation = ev;
    d.phase = "evaluated";

    App.progress.evaluaties.push({
      id: d.id,
      datum: ev.datum,
      domein: "gesprek",
      submodus: d.strict ? "Gesprek — Strikte Examenmodus (30%)" : "Gesprek — Oefenmodus (30%)",
      titel: d.casus.titel,
      scorePct: ev.scorePct,
      totaalOp20: ev.totaalOp20,
      casus: d.casus,
      turns: d.turns,
      evaluatie: ev,
    });
    scheduleSaveProgress();
  } catch (err) {
    showSpeakError(err.message);
  } finally {
    App.speak.busy = false;
    renderSpeakingModule();
  }
}

/* ---------- Speaking Renderers ---------- */

function renderOralEvalCard(ev, prevEv = null, titlePrefix = "") {
  const baseCard = renderEvalBreakdown(ev, prevEv, titlePrefix);
  const extraParts = [];
  if (ev.uitspraakFeedback) {
    extraParts.push(`<div class="pron-box"><strong>🎙️ Uitspraak, intonatie &amp; vlotheid:</strong> ${escapeHtml(ev.uitspraakFeedback)}</div>`);
  }
  if (ev.transcript) {
    extraParts.push(`<details style="margin-bottom:0.85rem;"><summary style="cursor:pointer;font-weight:600;font-size:0.88rem;">Toon jouw Franse transcriptie</summary><div class="archive-text-box" style="margin-top:0.45rem;">${escapeHtml(ev.transcript)}</div></details>`);
  }
  if (!extraParts.length) return baseCard;
  return baseCard.replace(`<div class="criteria-grid">`, `${extraParts.join("")}<div class="criteria-grid">`);
}

function renderMonologueWorkspace(ws) {
  const m = App.speak.monologue;
  if (!m) {
    ws.innerHTML = `
      <div class="card empty-module">
        <h3>Monoloog (thuisopdracht · 8%)</h3>
        <p class="muted">Kies een thema en communicatief doel en klik op <strong>Genereer spreekopdracht</strong>. Je bereidt kort je kernwoorden voor, spreekt je Franse monoloog in (direct beoordeeld op uitspraak, structuur en woordenschat) en verbetert je opname in Stap 2.</p>
      </div>
    `;
    return;
  }

  const isRec = Boolean(App.speak.recorder && App.speak.recMode === "monoloog");
  const over = m.timerSecondsLeft <= 0;
  const step = !m.poging1 ? 1 : m.revising ? 2 : 3;
  const showRecorder = !m.poging1 || m.revising;
  const activeEval = m.poging2 || m.poging1;

  const stepperHtml = `
    <div class="write-stepper" aria-label="Voortgang monoloog">
      <span class="step-pill ${step > 1 ? "done" : "active"}">${step > 1 ? "✓ " : ""}1. Voorbereiden &amp; opnemen</span>
      <span class="step-sep">→</span>
      <span class="step-pill ${step === 2 ? "active" : step > 2 ? "done" : ""}">${step > 2 ? "✓ " : ""}2. Verbeter-opname</span>
      <span class="step-sep">→</span>
      <span class="step-pill ${step === 3 ? "done" : ""}">${step === 3 ? "✓ " : ""}3. Afgerond</span>
    </div>
  `;

  const topbarHtml = `
    <div class="write-topbar">
      <div class="timer-box">
        <span id="speak-timer-display" class="timer-display${over ? " overtime" : ""}">
          ${over ? `00:00 (tijd om · +${formatTimer(m.timerOvertime || 0)})` : formatTimer(m.timerSecondsLeft)}
        </span>
        <button type="button" class="btn btn-secondary btn-sm" data-speak-action="toggle-timer">${App.speak.timerRunning ? "Pauzeer" : "Start timer"}</button>
        <button type="button" class="btn btn-secondary btn-sm" data-speak-action="reset-timer">Reset</button>
        <span class="muted" style="font-size:0.78rem;">Voorbereidingstimer (indicatief)</span>
      </div>
      <span class="weight-pill">Monoloog · 8%</span>
    </div>
  `;

  const promptHtml = `
    <div class="prompt-card">
      <div class="prompt-meta">
        <span class="chip chip-sm">${escapeHtml(m.task.thema)}</span>
        <span class="chip chip-sm">Register: ${escapeHtml(m.task.register)}</span>
        <span class="chip chip-sm">Richtduur: ${escapeHtml(m.task.richtduur || "2-3 min")}</span>
      </div>
      <h3>${escapeHtml(m.task.titel)}</h3>
      <p style="margin:0 0 0.5rem;">${escapeHtml(m.task.context)}</p>
      <ul class="req-list">${(m.task.spreekpunten || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
    </div>
  `;

  const revisionGuideHtml = m.revising && m.poging1
    ? `
      <div class="card" style="margin-bottom:1rem;border-color:#f59e0b;background:var(--warn-soft);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.45rem;">
          <strong>🎙️ Stap 2: Neem een verbeterde versie op</strong>
          ${renderCategoryBadge(m.poging1.scorePct)}
        </div>
        ${m.poging1.uitspraakFeedback ? `<p style="margin:0 0 0.45rem;font-size:0.88rem;"><strong>Uitspraak:</strong> ${escapeHtml(m.poging1.uitspraakFeedback)}</p>` : ""}
        ${m.poging1.fouten.length ? `<div class="mistakes-list" style="margin-bottom:0;">
          ${m.poging1.fouten.map((f) => `<div class="mistake-item" style="background:#fff;"><span class="mistake-quote">${escapeHtml(f.citaat)}</span> — ${escapeHtml(f.uitleg)} ${f.tip ? `<span class="muted">(Tip: ${escapeHtml(f.tip)})</span>` : ""}</div>`).join("")}
        </div>` : ""}
      </div>
    `
    : "";

  const recorderBlockHtml = showRecorder
    ? `
      <div class="card">
        <div class="recorder-box${isRec ? " recording" : ""}">
          <button type="button" class="btn btn-record${isRec ? " is-recording" : ""}" data-speak-action="${isRec ? "stop-rec" : "start-rec-mono"}" ${App.speak.busy ? "disabled" : ""}>
            ${isRec ? "⏹ Stop opname" : m.audioUrl && m.audioDirty ? "🎙️ Opnieuw opnemen" : "🎙️ Start audio-opname"}
          </button>
          ${isRec ? `<div id="speak-rec-timer" class="rec-timer">${formatTimer(App.speak.recSeconds)} / 03:00</div>` : ""}
          ${m.audioUrl && m.audioDirty && !isRec ? `
            <audio class="audio-preview" controls src="${m.audioUrl}"></audio>
            <span class="muted">Beluister je opname of dien haar direct in voor uitspraak- en taalevaluatie.</span>
          ` : `<span class="muted">Spreek rustig in het Frans (max. 3 min). Gemini beoordeelt zowel inhoud als uitspraak &amp; vlotheid.</span>`}
          <div class="fallback-bar">
            <label class="btn btn-secondary btn-sm file-label">
              📎 Audio uploaden
              <input id="mono-audio-upload" type="file" accept="audio/*" capture="microphone" hidden />
            </label>
            <button type="button" class="btn btn-primary" data-speak-action="eval-mono" ${App.speak.busy || isRec || (!m.audioDirty && countWords(m.textFallback) < 15) ? "disabled" : ""}>
              ${App.speak.busy ? "Audio analyseren & beoordelen…" : m.revising ? "✓ Dien verbeterde opname in" : "Evalueer spreekopname (Stap 1)"}
            </button>
          </div>
        </div>
        <details style="margin-top:0.8rem;">
          <summary class="muted" style="cursor:pointer;font-size:0.84rem;">Geen microfoon beschikbaar? Gebruik tekst-fallback</summary>
          <textarea id="mono-text-fallback" class="scratchpad-editor" style="margin-top:0.5rem;" spellcheck="false" placeholder="Typ hier enkel als je geen microfoon kunt gebruiken…">${escapeHtml(m.textFallback)}</textarea>
        </details>
      </div>
    `
    : `
      <div class="card">
        <div class="stage-toolbar" style="margin-bottom:0;">
          <strong>✓ Monoloog afgerond!</strong>
          <button type="button" class="btn btn-primary btn-sm" data-speak-action="clear-mono">✨ Nieuwe spreekopdracht</button>
        </div>
      </div>
    `;

  const planPanelHtml = `
    <aside class="helper-panel">
      <div>
        <h4>Spreekplan (kernwoorden — blijft zichtbaar)</h4>
        <textarea id="mono-plan" class="scratchpad-editor" style="min-height:200px;" spellcheck="false" placeholder="Inleiding (groet + thema):\n- ...\n\nMidden (kernwoorden + signaalwoorden):\n- D'abord...\n- Ensuite...\n\nSlot:\n- En conclusion...">${escapeHtml(m.plan)}</textarea>
      </div>
      <div>
        <h4>Handige signaalwoorden</h4>
        <p class="muted" style="margin:0;font-size:0.82rem;">d'abord · ensuite · de plus · par exemple · cependant · parce que · donc · en conclusion</p>
      </div>
    </aside>
  `;

  ws.innerHTML = `
    ${stepperHtml}
    ${topbarHtml}
    <div class="write-grid with-helper">
      <div>
        ${promptHtml}
        ${revisionGuideHtml}
        ${recorderBlockHtml}
        ${activeEval ? renderOralEvalCard(activeEval, m.poging2 ? m.poging1 : null, m.poging2 ? "Verbeter-opname" : "Poging 1") : ""}
      </div>
      ${planPanelHtml}
    </div>
  `;
}

function renderDialogueWorkspace(ws) {
  const d = App.speak.dialogue;
  if (!d) {
    ws.innerHTML = `
      <div class="card empty-module">
        <h3>Mondeling Gesprek (30%)</h3>
        <p class="muted">Klik bovenaan op <strong>Genereer gesprekscasus</strong>. Je krijgt eerst een indicatieve voorbereidingstimer van 15 minuten voor je kladblad (sleutelwoorden) en voert daarna een interactief Frans gesprek van 10 minuten met de AI-examinator.</p>
      </div>
    `;
    return;
  }

  const over = d.timerSecondsLeft <= 0;
  const isRec = Boolean(App.speak.recorder && App.speak.recMode === "gesprek");
  const lastExaminerTurn = [...d.turns].reverse().find((t) => t.role === "examiner");
  const studentTurnCount = d.turns.filter((t) => t.role === "student").length;
  const step = d.phase === "prep" ? 1 : d.phase === "dialogue" ? 2 : 3;

  const stepperHtml = `
    <div class="write-stepper">
      <span class="step-pill ${step > 1 ? "done" : "active"}">${step > 1 ? "✓ " : ""}1. Voorbereiding (15 min)</span>
      <span class="step-sep">→</span>
      <span class="step-pill ${step === 2 ? "active" : step > 2 ? "done" : ""}">${step > 2 ? "✓ " : ""}2. Examengesprek (10 min)</span>
      <span class="step-sep">→</span>
      <span class="step-pill ${step === 3 ? "done" : ""}">${step === 3 ? "✓ " : ""}3. Evaluatie</span>
    </div>
  `;

  const topbarHtml = `
    <div class="write-topbar">
      <div class="timer-box">
        <span id="speak-timer-display" class="timer-display${over ? " overtime" : ""}">
          ${over ? `00:00 (tijd om · +${formatTimer(d.timerOvertime || 0)})` : formatTimer(d.timerSecondsLeft)}
        </span>
        <button type="button" class="btn btn-secondary btn-sm" data-speak-action="toggle-timer">${App.speak.timerRunning ? "Pauzeer" : "Start timer"}</button>
        <span class="muted" style="font-size:0.78rem;">${d.phase === "prep" ? "Voorbereiding (15 min)" : "Gesprek (10 min)"} · indicatief</span>
      </div>
      <div class="btn-row">
        ${d.strict
          ? `<span class="exam-strict-badge">Strikte examenmodus · enkel audio</span>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-speak-action="toggle-helper">${App.speak.helperOpen ? "Verberg spreekhulp" : "Spreekhulp (zinnen)"}</button>`
        }
        <button type="button" class="btn btn-secondary btn-sm" data-speak-action="toggle-tts">${App.speak.ttsEnabled ? "🔊 Stem aan" : "🔇 Stem uit"}</button>
      </div>
    </div>
  `;

  const casusHtml = `
    <div class="prompt-card">
      <div class="prompt-meta">
        <span class="weight-pill">Mondeling Gesprek (30%)</span>
        <span class="chip chip-sm">${escapeHtml(d.casus.thema)}</span>
        <span class="chip chip-sm">Register: ${escapeHtml(d.casus.register)}</span>
      </div>
      <h3>${escapeHtml(d.casus.titel)}</h3>
      <p style="margin:0 0 0.4rem;">${escapeHtml(d.casus.context)}</p>
      <div class="muted"><strong>Jouw rol:</strong> ${escapeHtml(d.casus.rol_leerling)} · <strong>Examinator:</strong> ${escapeHtml(d.casus.rol_examinator)}</div>
      <ul class="req-list">${(d.casus.gesprekspunten || []).map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
    </div>
  `;

  let mainBodyHtml = "";
  if (d.phase === "prep") {
    mainBodyHtml = `
      <div class="card">
        <h3 style="margin:0 0 0.45rem;">Kladblad — noteer enkel sleutelwoorden</h3>
        <p class="muted" style="margin:0 0 0.65rem;">Op het examen mag je je kladblad met sleutelwoorden meenemen in de cockpit. Het blijft hiernaast zichtbaar tijdens het hele gesprek.</p>
        <textarea id="dialogue-scratchpad" class="scratchpad-editor" style="min-height:170px;" spellcheck="false" placeholder="Kernwoorden per gesprekspunt:\n- Opening:\n- Punt 1:\n- Punt 2:\n- Vraag aan examinator:\n- Afsluiting:">${escapeHtml(d.scratchpad)}</textarea>
        <div class="btn-row" style="margin-top:0.85rem;justify-content:flex-end;">
          <button type="button" class="btn btn-primary" data-speak-action="start-dialogue">🎙️ Start examengesprek (10 min) →</button>
        </div>
      </div>
    `;
  } else if (d.phase === "dialogue") {
    const examinerDisplayHtml = d.strict
      ? `
        <div class="audio-only-examiner">
          <div>
            <strong>🎧 Examinator (beurt ${d.turns.filter((t) => t.role === "examiner").length})</strong>
            <div class="muted">Tekst is verborgen in Strikte Examenmodus — luister goed of vraag <em>"Pourriez-vous répéter ?"</em></div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-sm" data-speak-action="replay-normal" ${!lastExaminerTurn ? "disabled" : ""}>🔊 Herhaal</button>
            <button type="button" class="btn btn-secondary btn-sm" data-speak-action="replay-slow" ${!lastExaminerTurn ? "disabled" : ""}>🐢 Trager</button>
          </div>
        </div>
      `
      : `
        <div class="dialogue-log" id="dialogue-log">
          ${d.turns.map((t) => `
            <div class="bubble ${t.role === "examiner" ? "bubble-examiner" : "bubble-student"}">
              <div class="bubble-role">
                <span>${t.role === "examiner" ? "Examinator" : "Jij"}</span>
                ${t.role === "examiner" ? `<button type="button" class="mini-icon-btn" data-speak-examiner="${escapeHtml(t.text)}" title="Herhaal">🔊</button>` : ""}
              </div>
              <div>${escapeHtml(t.text)}</div>
            </div>
          `).join("")}
        </div>
      `;

    mainBodyHtml = `
      <div class="card">
        ${examinerDisplayHtml}
        <div class="recorder-box${isRec ? " recording" : ""}">
          <button type="button" class="btn btn-record${isRec ? " is-recording" : ""}" data-speak-action="${isRec ? "stop-rec" : "start-rec-dial"}" ${App.speak.busy ? "disabled" : ""}>
            ${App.speak.busy ? "⏳ Examinator denkt na…" : isRec ? "⏹ Stop & verstuur antwoord" : "🎙️ Spreek antwoord in (of druk Spatie)"}
          </button>
          ${isRec ? `<div id="speak-rec-timer" class="rec-timer">${formatTimer(App.speak.recSeconds)} / 01:30</div>` : `<span class="muted">Beurten gesproken: ${studentTurnCount} · Klik om te starten, klik opnieuw om direct te verzenden.</span>`}
          <div class="fallback-bar">
            <label class="btn btn-secondary btn-sm file-label">
              📎 Audio-beurt uploaden
              <input id="dial-audio-upload" type="file" accept="audio/*" capture="microphone" hidden />
            </label>
            <button type="button" class="btn btn-primary btn-sm" data-speak-action="eval-dial" ${App.speak.busy || isRec || studentTurnCount < 2 ? "disabled" : ""}>
              ✓ Beëindig &amp; evalueer gesprek
            </button>
          </div>
          <div class="chat-fallback-row">
            <input id="dialogue-chat-input" class="input" type="text" spellcheck="false" placeholder="Chat-fallback: typ een Franse reactie en druk op Enter…" ${App.speak.busy ? "disabled" : ""} />
            <button type="button" class="btn btn-secondary" data-speak-action="send-chat" ${App.speak.busy ? "disabled" : ""}>Verzend</button>
          </div>
        </div>
      </div>
    `;
  } else {
    mainBodyHtml = `
      <div class="card" style="margin-bottom:1rem;">
        <div class="stage-toolbar" style="margin-bottom:0.5rem;">
          <strong>✓ Volledig gesprekstranscript (${studentTurnCount} leerlingbeurten)</strong>
          <button type="button" class="btn btn-primary btn-sm" data-speak-action="clear-dial">✨ Nieuwe gesprekscasus</button>
        </div>
        <div class="dialogue-log" style="max-height:320px;margin-bottom:0;">
          ${d.turns.map((t) => `
            <div class="bubble ${t.role === "examiner" ? "bubble-examiner" : "bubble-student"}">
              <div class="bubble-role"><span>${t.role === "examiner" ? "Examinator" : "Jij"}</span></div>
              <div>${escapeHtml(t.text)}</div>
            </div>
          `).join("")}
        </div>
      </div>
      ${d.evaluation ? renderOralEvalCard(d.evaluation, null, "Examengesprek") : ""}
    `;
  }

  const showSidePanel = d.phase === "dialogue" || (!d.strict && App.speak.helperOpen);
  const sidePanelHtml = showSidePanel
    ? `
      <aside class="helper-panel">
        ${d.phase === "dialogue" ? `
          <div>
            <h4>Jouw kladblad (sleutelwoorden)</h4>
            <textarea id="dialogue-scratchpad" class="scratchpad-editor" style="min-height:170px;" spellcheck="false" placeholder="Sleutelwoorden…">${escapeHtml(d.scratchpad)}</textarea>
          </div>
        ` : ""}
        ${!d.strict && App.speak.helperOpen ? `
          <div>
            <h4>Spreekhulp (gesprekszinnen)</h4>
            ${Object.entries(DIALOGUE_HELP_PHRASES).map(([k, arr]) => `
              <div class="connector-group">
                <strong style="text-transform:capitalize;">${k}:</strong>
                <ul class="req-list" style="margin-top:0.2rem;font-size:0.82rem;">${arr.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
              </div>
            `).join("")}
          </div>
        ` : ""}
      </aside>
    `
    : "";

  ws.innerHTML = `
    ${stepperHtml}
    ${topbarHtml}
    <div class="write-grid${showSidePanel ? " with-helper" : ""}">
      <div>
        ${casusHtml}
        ${mainBodyHtml}
      </div>
      ${sidePanelHtml}
    </div>
  `;
}

function renderSpeakingArchive() {
  const wrap = document.getElementById("speak-archive");
  const countEl = document.getElementById("speak-archive-count");
  const items = App.progress.evaluaties.filter((e) => e.domein === "monoloog" || e.domein === "gesprek").reverse();
  countEl.textContent = `${items.length} opgeslagen spreekoefening(en) — met transcript en 5-categorieën feedback`;
  if (!items.length) {
    wrap.innerHTML = `<div class="card muted">Nog geen opgeslagen monologen of gesprekken.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="archive-list">${items.map((item) => {
    const isOpen = App.speak.openArchiveId === item.id;
    const catHtml = item.poging2
      ? `${renderCategoryBadge(item.poging1.scorePct)} → ${renderCategoryBadge(item.poging2.scorePct)}`
      : renderCategoryBadge(item.scorePct);

    let bodyHtml = "";
    if (item.domein === "monoloog") {
      bodyHtml = `
        <p class="muted" style="margin:0.75rem 0 0.5rem;">${escapeHtml(item.opdracht?.context || "")}</p>
        ${item.poging1 ? renderOralEvalCard(item.poging1, null, "Poging 1") : ""}
        ${item.poging2 ? renderOralEvalCard(item.poging2, item.poging1, "Verbeter-opname") : ""}
      `;
    } else {
      const turnsHtml = (item.turns || []).map((t) => `
        <div class="bubble ${t.role === "examiner" ? "bubble-examiner" : "bubble-student"}">
          <div class="bubble-role"><span>${t.role === "examiner" ? "Examinator" : "Jij"}</span></div>
          <div>${escapeHtml(t.text)}</div>
        </div>
      `).join("");
      bodyHtml = `
        <p class="muted" style="margin:0.75rem 0 0.5rem;">${escapeHtml(item.casus?.context || "")}</p>
        <div class="dialogue-log" style="max-height:260px;">${turnsHtml}</div>
        ${item.evaluatie ? renderOralEvalCard(item.evaluatie, null, "Examengesprek") : ""}
      `;
    }

    return `
      <details class="archive-item" data-archive-id="${escapeHtml(item.id)}"${isOpen ? " open" : ""}>
        <summary class="archive-summary">
          <div>
            <strong>${escapeHtml(item.titel)}</strong>
            <div class="muted">${new Date(item.datum).toLocaleDateString("nl-BE")} · ${escapeHtml(item.submodus || item.domein)}</div>
          </div>
          <div class="btn-row" style="gap:0.35rem;">${catHtml}</div>
        </summary>
        <div class="archive-body">${bodyHtml}</div>
      </details>
    `;
  }).join("")}</div>`;
}

function renderSpeakingModule() {
  if (!App.curriculum) return;
  renderSpeakingModeBar();
  renderSpeakingArchive();
  const ws = document.getElementById("speak-workspace");
  if (App.speak.loading) {
    ws.innerHTML = `<div class="card empty-module"><p class="muted">✨ Realistische B1-spreekopdracht wordt gegenereerd…</p></div>`;
    return;
  }
  if (App.speak.mode === "monoloog") {
    renderMonologueWorkspace(ws);
  } else {
    renderDialogueWorkspace(ws);
  }
}

function handleSpeakingWorkspaceClick(e) {
  const speakEx = e.target.closest("[data-speak-examiner]");
  if (speakEx) {
    speakExaminer(speakEx.dataset.speakExaminer);
    return;
  }

  const actBtn = e.target.closest("[data-speak-action]");
  if (!actBtn) return;
  const act = actBtn.dataset.speakAction;
  const activeObj = App.speak.mode === "monoloog" ? App.speak.monologue : App.speak.dialogue;

  if (act === "toggle-timer" && activeObj) {
    if (App.speak.timerRunning) stopSpeakTimer();
    else startSpeakTimer(activeObj);
    renderSpeakingModule();
  } else if (act === "reset-timer" && activeObj) {
    stopSpeakTimer();
    activeObj.timerSecondsLeft = activeObj.timerTotalSeconds;
    activeObj.timerOvertime = 0;
    renderSpeakingModule();
  } else if (act === "toggle-helper") {
    App.speak.helperOpen = !App.speak.helperOpen;
    renderSpeakingModule();
  } else if (act === "toggle-tts") {
    App.speak.ttsEnabled = !App.speak.ttsEnabled;
    if (!App.speak.ttsEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
    renderSpeakingModule();
  } else if (act === "start-rec-mono") {
    startAudioRecording("monoloog");
  } else if (act === "start-rec-dial") {
    startAudioRecording("gesprek");
  } else if (act === "stop-rec") {
    stopAudioRecording();
  } else if (act === "eval-mono") {
    evaluateMonologue();
  } else if (act === "clear-mono") {
    stopSpeakTimer();
    App.speak.monologue = null;
    renderSpeakingModule();
  } else if (act === "start-dialogue") {
    startDialoguePhase();
  } else if (act === "replay-normal" || act === "replay-slow") {
    const lastEx = [...(App.speak.dialogue?.turns || [])].reverse().find((t) => t.role === "examiner");
    if (lastEx) speakExaminer(lastEx.text, act === "replay-slow" ? 0.8 : 0.98);
  } else if (act === "send-chat") {
    const inp = document.getElementById("dialogue-chat-input");
    if (inp && inp.value.trim()) {
      const txt = inp.value.trim();
      inp.value = "";
      sendDialogueTurn({ typedText: txt });
    }
  } else if (act === "eval-dial") {
    evaluateDialogueSession();
  } else if (act === "clear-dial") {
    stopSpeakTimer();
    App.speak.dialogue = null;
    renderSpeakingModule();
  }
}

/* ---------- Tab 5b: Grammatica Coach (Uitbreidbaar · Hybride AI + Leerkracht-paneel) ---------- */

// Declaratieve tabel met B1-oefentypes — nieuw type van de thuisleerkracht toevoegen = 1 object bijplaatsen
const GRAMMAR_EXERCISE_TYPES = [
  {
    id: "mix",
    label: "Slimme mix",
    desc: "Combineert de meest relevante B1-oefentypes voor dit onderdeel + herhaalt zwakke punten.",
    promptSpec: "Varieer slim tussen invuloefening, zinstransformatie, foutenjacht, zinnen combineren, micro-vertaling en mini-productie (passend bij dit grammatica-onderdeel).",
  },
  {
    id: "invul",
    label: "Invuloefening",
    desc: "Kies de juiste vorm, tijd, lidwoord, voorzetsel of congruentie in context.",
    promptSpec: "Maak contextuele invulzinnen met een gat (____) en geef tussen haakjes het basiswoord/werkwoord in de infinitief.",
  },
  {
    id: "transformatie",
    label: "Zinstransformatie",
    desc: "Herschrijf de zin (tijd omzetten, ontkenning, voornaamwoorden COD/COI/y/en, beleefdheid).",
    promptSpec: "Geef een Franse zin met een concrete herschrijfopdracht (bv. zet in passé composé, vervang het onderstreepte deel door een voornaamwoord, maak ontkennend of beleefd).",
  },
  {
    id: "foutenjacht",
    label: "Foutenjacht",
    desc: "Spoor een typische Examencommissie-fout op (bv. aller/allez/allé, accord met être) en verbeter.",
    promptSpec: "Geef telkens 1 Franse B1-zin met precies 1 of 2 typische Vlaamse Examencommissie-fouten op dit grammaticapunt; de leerling moet de volledige zin foutloos herschrijven.",
  },
  {
    id: "combineren",
    label: "Zinnen combineren",
    desc: "Voeg twee korte zinnen samen met qui/que/dont/où, si-zinnen of signaalwoorden.",
    promptSpec: "Geef twee korte Franse zinnen die de leerling moet combineren tot één vlotte samengestelde B1-zin met de doelstructuur.",
  },
  {
    id: "vertaling",
    label: "Micro-vertaling (NL → FR)",
    desc: "Vertaal 1 gerichte zin om typische Nederlandse interferentie te doorbreken.",
    promptSpec: "Geef telkens 1 korte Nederlandse zin (8-14 woorden) die typische NL→FR valkuilen op dit grammaticapunt test.",
  },
  {
    id: "productie",
    label: "Mini-productie",
    desc: "Schrijf zelf 1-2 korte Franse zinnen met een gerichte grammaticale dwangregel.",
    promptSpec: "Geef een concrete mini-schrijfopdracht (1-2 eigen Franse zinnen) waarin de leerling de regel verplicht actief moet toepassen.",
  },
];

const GRAMMAR_MODES = [
  { id: "ai_coach", label: "AI Grammatica-coach", render: renderGrammarAiCoach },
  { id: "basis", label: "Snelle offline dril (0 API)", render: renderGrammarOffline },
  { id: "leerkracht", label: "Leerkracht-paneel (eigen oefeningen)", render: renderGrammarTeacherPanel },
];

function getAllGrammarTopics() {
  return App.curriculum.grammatica.flatMap((p) =>
    p.onderdelen.map((o) => ({ ...o, pijler: p.pijler, pijlerTitel: p.titel }))
  );
}

function getCurrentGrammarTopic() {
  const all = getAllGrammarTopics();
  return all.find((t) => t.id === App.grammar.topicId) || all[0];
}

function getCustomGrammarBucket(topicId) {
  if (!App.progress.customGrammar || typeof App.progress.customGrammar !== "object") {
    App.progress.customGrammar = {};
  }
  const cur = App.progress.customGrammar[topicId] || {};
  return {
    focus: typeof cur.focus === "string" ? cur.focus : "",
    exercises: Array.isArray(cur.exercises) ? cur.exercises : [],
  };
}

function ensureGrammarProgressBucket(topicId) {
  if (!App.progress.grammatica[topicId] || typeof App.progress.grammatica[topicId] !== "object") {
    App.progress.grammatica[topicId] = { sessions: [], weakPoints: [], offlineCount: 0 };
  }
  const b = App.progress.grammatica[topicId];
  if (!Array.isArray(b.sessions)) b.sessions = [];
  if (!Array.isArray(b.weakPoints)) b.weakPoints = [];
  return b;
}

function showGrammarError(msg) {
  const el = document.getElementById("gr-error");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function initGrammarModule() {
  populateGrammarTopics();
  renderGrammarModeBar();
  renderGrammarMeta();
}

function populateGrammarTopics() {
  const tSel = document.getElementById("gr-topic-select");
  if (!tSel) return;
  tSel.innerHTML = App.curriculum.grammatica.map((p) => {
    const opts = p.onderdelen.map((t) => {
      const customCount = getCustomGrammarBucket(t.id).exercises.length;
      const tag = customCount ? ` · +${customCount} leerkracht` : "";
      return `<option value="${t.id}">${escapeHtml(t.naam)}${tag}</option>`;
    }).join("");
    return `<optgroup label="${escapeHtml(p.titel)}">${opts}</optgroup>`;
  }).join("");
  tSel.value = App.grammar.topicId;
}

function renderGrammarModeBar() {
  const bar = document.getElementById("gr-mode-bar");
  const customCnt = getCustomGrammarBucket(App.grammar.topicId).exercises.length;
  bar.innerHTML = GRAMMAR_MODES.map((m) => {
    const extra = m.id === "leerkracht" && customCnt ? ` (${customCnt})` : "";
    return `<button type="button" class="mode-btn${m.id === App.grammar.mode ? " active" : ""}" data-gr-mode="${m.id}" role="tab">${escapeHtml(m.label)}${extra}</button>`;
  }).join("");
}

function renderGrammarMeta() {
  const wrap = document.getElementById("gr-meta");
  if (!wrap || !App.curriculum) return;
  const topic = getCurrentGrammarTopic();
  const m = computeGrMetrics(topic.id);
  wrap.innerHTML = `
    <span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>
    ${m.score !== null ? renderCategoryBadge(m.score) : ""}
    <span class="muted" style="font-size:0.8rem;">${m.goodDaysCount}/2 dagen Goed</span>
  `;
}

function renderGrammarRuleCard() {
  const card = document.getElementById("gr-rule-card");
  if (!card) return;
  const topic = getCurrentGrammarTopic();
  const custom = getCustomGrammarBucket(topic.id);
  const collapsed = App.grammar.ruleCollapsed;

  card.innerHTML = `
    <div class="rule-always-head">
      <div>
        <span class="weight-pill">${escapeHtml(topic.pijlerTitel)}</span>
        <strong style="margin-left:0.45rem;font-size:1rem;">${escapeHtml(topic.naam)}</strong>
      </div>
      <button type="button" class="btn btn-secondary btn-sm" data-gr-toggle-rule="1">
        ${collapsed ? "Toon regel & voorbeelden" : "Verberg regel"}
      </button>
    </div>
    ${!collapsed ? `
      <p style="margin:0.65rem 0 0;font-size:0.94rem;line-height:1.6;">${escapeHtml(topic.uitleg)}</p>
      ${custom.focus ? `<div class="teacher-focus-banner" style="margin:0.65rem 0 0;"><strong>👩‍🏫 Focus van de leerkracht:</strong> ${escapeHtml(custom.focus)}</div>` : ""}
      <div class="rule-examples-inline">
        ${topic.voorbeelden.map((v) => `
          <div class="example-item">
            <div>
              <div><strong>${escapeHtml(v.fr)}</strong></div>
              <div class="muted" style="font-size:0.84rem;">${escapeHtml(v.nl)}</div>
            </div>
            <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(v.fr)}" title="Luister zin">🔊</button>
          </div>
        `).join("")}
      </div>
    ` : ""}
  `;
}

function renderGrammarOverview() {
  const grAll = getAllGrammarTopics();
  const grMetrics = grAll.map((t) => ({ t, m: computeGrMetrics(t.id) }));
  const masteredCnt = grMetrics.filter((x) => x.m.status === "beheerst").length;
  const practicingCnt = grMetrics.filter((x) => x.m.status === "oefenen").length;
  const mPct = Math.round((masteredCnt / Math.max(1, grAll.length)) * 100);
  const pPct = Math.round((practicingCnt / Math.max(1, grAll.length)) * 100);

  document.getElementById("gr-overall-card").innerHTML = `
    <div class="stage-toolbar" style="margin-bottom:0.35rem;">
      <div>
        <strong>Algemene voortgang Grammatica</strong>
        <span class="muted"> · ${masteredCnt} / ${grAll.length} onderdelen beheerst (2 dagen niveau Goed)</span>
      </div>
    </div>
    ${renderStackedBar(mPct, pPct)}
    ${renderBarLegend(`Beheerst (2/2 dagen Goed): ${masteredCnt}`, `Op weg: ${practicingCnt}`)}
  `;

  document.getElementById("gr-list-summary").textContent =
    `${masteredCnt} beheerst · ${practicingCnt} bezig · kies een onderdeel om de regel te zien en te oefenen`;

  const pf = document.getElementById("gr-pillar-filters");
  pf.innerHTML = `<button type="button" class="chip${App.grammar.pillar === "__all" ? " active" : ""}" data-gr-pillar="__all">Alle (${grAll.length})</button>` +
    App.curriculum.grammatica.map((p) =>
      `<button type="button" class="chip${App.grammar.pillar === p.pijler ? " active" : ""}" data-gr-pillar="${p.pijler}">${escapeHtml(p.titel)}</button>`
    ).join("");

  const pillars = App.grammar.pillar === "__all"
    ? App.curriculum.grammatica
    : App.curriculum.grammatica.filter((p) => p.pijler === App.grammar.pillar);

  document.getElementById("gr-topic-list").innerHTML = pillars.map((p) => {
    const done = p.onderdelen.filter((o) => computeGrMetrics(o.id).status === "beheerst").length;
    const rows = p.onderdelen.map((o) => {
      const m = computeGrMetrics(o.id);
      const customCnt = getCustomGrammarBucket(o.id).exercises.length;
      const rowM = m.status === "beheerst" ? 100 : 0;
      const rowP = m.status === "beheerst" ? 0 : (m.goodDaysCount === 1 ? 50 : m.attempts > 0 ? 20 : 0);
      return `
        <div class="list-row">
          <div class="list-row-main">
            <div class="list-row-titles">
              <div class="list-row-title">${escapeHtml(o.naam)}</div>
              ${customCnt ? `<div class="list-row-sub">👩‍🏫 ${customCnt} eigen leerkracht-oefening(en)</div>` : ""}
            </div>
          </div>
          <div class="list-row-bar">
            ${renderStackedBar(rowM, rowP, true)}
            <div class="list-row-bar-meta">
              <span>${m.goodDaysCount}/2 dagen Goed</span>
              ${m.weakPoints.length ? `<span>${m.weakPoints.length} aandachtspunt(en)</span>` : ""}
            </div>
          </div>
          <div class="list-row-actions">
            ${m.score !== null ? renderCategoryBadge(m.score) : `<span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>`}
            <button class="btn btn-primary btn-sm" type="button" data-open-gr="${o.id}">Oefen</button>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="list-group-title">
        <span>${escapeHtml(p.titel)}</span>
        <span class="muted">${done}/${p.onderdelen.length} beheerst</span>
      </div>
      <div class="compact-list">${rows}</div>
    `;
  }).join("");
}

function renderGrammarTab() {
  if (!App.curriculum) return;
  const ov = document.getElementById("gr-overview-view");
  const pr = document.getElementById("gr-practice-view");
  const isPractice = App.grammar.view === "practice";
  ov.classList.toggle("hidden", isPractice);
  pr.classList.toggle("hidden", !isPractice);
  if (isPractice) {
    renderGrammarStage();
  } else {
    renderGrammarOverview();
  }
}

function openGrammarTopic(topicId) {
  App.grammar.topicId = topicId;
  App.grammar.view = "practice";
  App.grammar.ruleCollapsed = false;
  App.grammar.session = null;
  App.grammar.offlineSession = null;
  showGrammarError("");
  populateGrammarTopics();
  switchTab("grammar");
}

function setGrammarMode(modeId) {
  App.grammar.mode = modeId;
  showGrammarError("");
  renderGrammarModeBar();
  renderGrammarStage();
}

function renderGrammarStage() {
  if (!App.curriculum) return;
  renderGrammarModeBar();
  renderGrammarMeta();
  renderGrammarRuleCard();
  renderGrammarArchive();
  const mode = GRAMMAR_MODES.find((m) => m.id === App.grammar.mode) || GRAMMAR_MODES[0];
  mode.render(document.getElementById("gr-stage"));
}

/* ---------- AI Grammatica-coach (Batch genereren + Batch evalueren + Herstelstap) ---------- */

function getExTypeLabel(id) {
  return GRAMMAR_EXERCISE_TYPES.find((t) => t.id === id)?.label || id;
}

async function generateGrammarAiSet(useTeacherCustomOnly = false) {
  const topic = getCurrentGrammarTopic();
  const custom = getCustomGrammarBucket(topic.id);

  if (useTeacherCustomOnly) {
    if (!custom.exercises.length) {
      showGrammarError("Voeg eerst minstens 1 eigen oefening toe in het Leerkracht-paneel.");
      return;
    }
    const questions = custom.exercises.map((ex, idx) => ({
      nr: idx + 1,
      type: ex.type || "transformatie",
      opdracht_nl: ex.opdracht_nl,
      context_fr: ex.context_fr || "",
      hint: ex.hint || "",
      doelregel: ex.uitleg || topic.naam,
      refSolution: ex.oplossing || "",
      isTeacher: true,
    }));
    App.grammar.mode = "ai_coach";
    App.grammar.session = {
      topicId: topic.id,
      topicNaam: topic.naam,
      exerciseType: "leerkracht",
      questions,
      answers: questions.map(() => ""),
      prevAnswers: null,
      results: null,
      poging1Pct: null,
      revising: false,
      done: false,
      archiveId: null,
    };
    renderGrammarStage();
    return;
  }

  if (!canUseAi()) {
    showGrammarError("Stel eerst je Gemini API-key in via Instellingen (of gebruik de Snelle offline dril).");
    return;
  }

  showGrammarError("");
  App.grammar.loading = true;
  renderGrammarStage();

  try {
    const typeObj = GRAMMAR_EXERCISE_TYPES.find((t) => t.id === App.grammar.exerciseType) || GRAMMAR_EXERCISE_TYPES[0];
    const count = App.grammar.count;
    const metrics = computeGrMetrics(topic.id);
    const exLines = topic.voorbeelden.map((v) => `- ${v.fr} (${v.nl})`).join("\n");
    const weakBlock = metrics.weakPoints.length
      ? `\nEerdere zwakke punten van deze leerling (extra op focussen!): ${metrics.weakPoints.join(", ")}.`
      : "";
    const focusBlock = custom.focus
      ? `\nSpecifieke focus / instructie van de thuisleerkracht (BELANGRIJK, neem mee!): ${custom.focus}`
      : "";

    const prompt = [
      `Je bent een ervaren docent Frans (Vlaamse Examencommissie Frans 2, 2de graad doorstroomfinaliteit, niveau B1).`,
      `Onderdeel: ${topic.naam} (${topic.pijlerTitel})\nRegel: ${topic.uitleg}\nVoorbeelden:\n${exLines}${weakBlock}${focusBlock}`,
      `Maak precies ${count} gevarieerde, concrete B1-grammatica-oefeningen (type: ${typeObj.label}).\nInstructie oefentype: ${typeObj.promptSpec}`,
      `Geef UITSLUITEND een JSON-array met exact ${count} objecten: [{"type":"invul|transformatie|foutenjacht|combineren|vertaling|productie","opdracht_nl":"heldere korte NL opdracht","context_fr":"Franse opgavezin (of lege string bij vertaling/productie)","hint":"optionele korte NL hint of lege string","doelregel":"korte tag van het geteste deelaspect"}]`,
    ].join("\n\n");

    const parsed = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 1600, temperature: 0.6 });
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("Geen geldige oefeningen ontvangen. Probeer opnieuw.");

    const questions = parsed.slice(0, count).map((q, idx) => ({
      nr: idx + 1,
      type: q.type || (typeObj.id === "mix" ? "invul" : typeObj.id),
      opdracht_nl: q.opdracht_nl || "Vul aan of herschrijf in correct Frans.",
      context_fr: q.context_fr || "",
      hint: q.hint || "",
      doelregel: q.doelregel || topic.naam,
    }));

    App.grammar.session = {
      topicId: topic.id,
      topicNaam: topic.naam,
      exerciseType: typeObj.id,
      questions,
      answers: questions.map(() => ""),
      prevAnswers: null,
      results: null,
      poging1Pct: null,
      revising: false,
      done: false,
      archiveId: null,
    };
  } catch (err) {
    showGrammarError(err.message);
  } finally {
    App.grammar.loading = false;
    renderGrammarStage();
  }
}

async function evaluateGrammarSession() {
  const s = App.grammar.session;
  if (!s || !canUseAi() || App.grammar.evaluating) return;

  const isRevision = Boolean(s.revising && s.results);
  const targetIndices = isRevision
    ? s.questions.map((_, i) => i).filter((i) => s.results[i]?.oordeel !== "juist")
    : s.questions.map((_, i) => i);

  for (const i of targetIndices) {
    if (!String(s.answers[i] || "").trim()) {
      showGrammarError(`Vul eerst vraag ${i + 1} in voordat je controleert.`);
      return;
    }
    if (isRevision && normalizeFr(s.answers[i]) === normalizeFr(s.prevAnswers?.[i] || "")) {
      showGrammarError(`Pas je antwoord bij vraag ${i + 1} eerst aan op basis van de uitleg.`);
      return;
    }
  }

  showGrammarError("");
  App.grammar.evaluating = true;
  renderGrammarStage();

  try {
    const topic = getAllGrammarTopics().find((t) => t.id === s.topicId) || getCurrentGrammarTopic();
    const qaLines = targetIndices.map((i) => {
      const q = s.questions[i];
      const ref = q.refSolution ? ` | Richtoplossing leerkracht: ${q.refSolution}` : "";
      return `Vraag ${i + 1} [${q.type}]: ${q.opdracht_nl}${q.context_fr ? ` | Opgave: ${q.context_fr}` : ""}${ref}\nAntwoord leerling: "${s.answers[i].trim()}"`;
    }).join("\n\n");

    const prompt = [
      `Je bent een strenge, didactisch sterke docent Frans (Vlaamse Examencommissie B1).`,
      `Grammatica-onderdeel: ${topic.naam} — ${topic.uitleg}`,
      `Beoordeel deze ${targetIndices.length} leerlingantwoorden eerlijk en streng op het gevraagde grammaticapunt (let op vervoeging, accord, lidwoorden, accenten en zinsbouw; accepteer geldige alternatieve Franse formuleringen als ze grammaticaal 100% correct zijn).`,
      qaLines,
      `Geef UITSLUITEND een JSON-array met exact ${targetIndices.length} objecten in dezelfde volgorde: [{"vraagNr":1,"oordeel":"juist|bijna|fout","uitleg":"1-2 korte concrete NL zinnen","modeloplossing":"beste correcte Franse zin","fouttype":"korte NL tag (bv. accord met être, accent) of lege string bij juist"}]`,
    ].join("\n\n");

    const parsed = await callGemini({ prompt, jsonMode: true, maxOutputTokens: 1600, temperature: 0.15 });
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("Kon evaluatie niet uitlezen. Probeer opnieuw.");

    const nextResults = s.results ? [...s.results] : s.questions.map(() => null);
    targetIndices.forEach((qIdx, pos) => {
      const item = parsed[pos] || parsed.find((x) => Number(x.vraagNr) === qIdx + 1) || {};
      const ord = ["juist", "bijna", "fout"].includes(String(item.oordeel || "").toLowerCase())
        ? String(item.oordeel).toLowerCase()
        : "fout";
      nextResults[qIdx] = {
        oordeel: ord,
        uitleg: item.uitleg || "",
        modeloplossing: item.modeloplossing || "",
        fouttype: ord === "juist" ? "" : (item.fouttype || s.questions[qIdx].doelregel || ""),
      };
    });

    s.results = nextResults;
    const pts = nextResults.reduce((acc, r) => acc + (r?.oordeel === "juist" ? 2 : r?.oordeel === "bijna" ? 1 : 0), 0);
    const pct = Math.round((pts / Math.max(1, nextResults.length * 2)) * 100);
    const hasMistakes = nextResults.some((r) => r?.oordeel !== "juist");

    const bucket = ensureGrammarProgressBucket(s.topicId);
    const nowIso = new Date().toISOString();
    const dayKey = nowIso.slice(0, 10);

    if (!isRevision) {
      s.poging1Pct = pct;
      s.prevAnswers = [...s.answers];
      s.revising = hasMistakes;
      s.done = !hasMistakes;

      // Update weak points from mistakes
      const newWeaks = nextResults.map((r) => r?.fouttype).filter(Boolean);
      if (newWeaks.length) {
        bucket.weakPoints = [...new Set([...newWeaks, ...bucket.weakPoints])].slice(0, 6);
      } else if (pct >= 85) {
        bucket.weakPoints = bucket.weakPoints.slice(1);
      }

      bucket.sessions.push({ datum: nowIso, dayKey, scorePct: pct, count: s.questions.length });
      s.archiveId = `gr_${Date.now()}`;
      App.progress.grammaticaArchief.push({
        id: s.archiveId,
        datum: nowIso,
        topicId: s.topicId,
        topicNaam: s.topicNaam,
        exerciseType: s.exerciseType,
        scorePct: pct,
        verbeterdPct: null,
        items: s.questions.map((q, i) => ({
          type: q.type,
          opdracht_nl: q.opdracht_nl,
          context_fr: q.context_fr,
          antwoord1: s.answers[i],
          resultaat1: nextResults[i],
          antwoord2: null,
          resultaat2: null,
        })),
      });
      if (App.progress.grammaticaArchief.length > 40) {
        App.progress.grammaticaArchief = App.progress.grammaticaArchief.slice(-40);
      }
    } else {
      s.revising = false;
      s.done = true;
      s.poging2Pct = pct;
      const arch = App.progress.grammaticaArchief.find((a) => a.id === s.archiveId);
      if (arch) {
        arch.verbeterdPct = pct;
        targetIndices.forEach((i) => {
          if (arch.items[i]) {
            arch.items[i].antwoord2 = s.answers[i];
            arch.items[i].resultaat2 = nextResults[i];
          }
        });
      }
    }

    scheduleSaveProgress();
  } catch (err) {
    showGrammarError(err.message);
  } finally {
    App.grammar.evaluating = false;
    renderGrammarStage();
  }
}

function renderGrammarAiCoach(container) {
  const topic = getCurrentGrammarTopic();
  const custom = getCustomGrammarBucket(topic.id);
  const metrics = computeGrMetrics(topic.id);
  const s = App.grammar.session?.topicId === topic.id ? App.grammar.session : null;

  const typeChips = GRAMMAR_EXERCISE_TYPES.map((t) =>
    `<button type="button" class="chip${App.grammar.exerciseType === t.id ? " active" : ""}" data-gr-extype="${t.id}" title="${escapeHtml(t.desc)}">${escapeHtml(t.label)}</button>`
  ).join("");

  const countChips = [5, 8, 10].map((n) =>
    `<button type="button" class="chip${App.grammar.count === n ? " active" : ""}" data-gr-count="${n}">${n} vragen</button>`
  ).join("");

  const setupCard = `
    <div class="card">
      <div class="stage-toolbar" style="margin-bottom:0.6rem;">
        <div class="filter-group">${typeChips}</div>
        <div class="filter-group">${countChips}</div>
      </div>
      ${custom.focus ? `<div class="teacher-focus-banner"><strong>👩‍🏫 Focus van de leerkracht:</strong> ${escapeHtml(custom.focus)}</div>` : ""}
      ${metrics.weakPoints.length ? `<div style="margin-bottom:0.75rem;font-size:0.84rem;"><span class="muted">Zwakke punten (komen extra terug):</span><div class="weak-tags">${metrics.weakPoints.map((w) => `<span class="weak-tag">${escapeHtml(w)}</span>`).join("")}</div></div>` : ""}
      <div class="btn-row" style="justify-content:space-between;">
        <span class="muted">${escapeHtml((GRAMMAR_EXERCISE_TYPES.find((t) => t.id === App.grammar.exerciseType) || GRAMMAR_EXERCISE_TYPES[0]).desc)}</span>
        <div class="btn-row">
          ${custom.exercises.length ? `<button type="button" class="btn btn-secondary btn-sm" data-gr-action="start-teacher-set">👩‍🏫 Oefen leerkracht-vragen (${custom.exercises.length})</button>` : ""}
          <button type="button" class="btn btn-primary" data-gr-action="generate" ${App.grammar.loading ? "disabled" : ""}>
            ${App.grammar.loading ? "Oefeningen maken…" : `✨ Genereer ${App.grammar.count} oefeningen`}
          </button>
        </div>
      </div>
    </div>
  `;

  if (App.grammar.loading) {
    container.innerHTML = `${setupCard}<div class="card empty-module"><p class="muted">✨ ${App.grammar.count} gevarieerde B1-oefeningen worden gegenereerd…</p></div>`;
    return;
  }

  if (!s) {
    container.innerHTML = `${setupCard}`;
    return;
  }

  const step = !s.results ? 1 : s.revising ? 2 : 3;
  const stepperHtml = `
    <div class="write-stepper">
      <span class="step-pill ${step > 1 ? "done" : "active"}">${step > 1 ? "✓ " : ""}1. Reeks invullen (${s.questions.length})</span>
      <span class="step-sep">→</span>
      <span class="step-pill ${step === 2 ? "active" : step > 2 ? "done" : ""}">${step > 2 ? "✓ " : ""}2. Fouten verbeteren</span>
      <span class="step-sep">→</span>
      <span class="step-pill ${step === 3 ? "done" : ""}">${step === 3 ? "✓ " : ""}3. Afgerond</span>
    </div>
  `;

  const bannerHtml = s.revising
    ? `<div class="card" style="border-color:#f59e0b;background:var(--warn-soft);display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <div><strong>✏️ Stap 2: Verbeter enkel de gemarkeerde vragen</strong><div class="muted" style="color:#78350f;">Je juiste antwoorden blijven staan. Pas de andere aan op basis van de uitleg en controleer opnieuw.</div></div>
        ${renderCategoryBadge(s.poging1Pct, true)}
      </div>`
    : s.done
      ? `<div class="card" style="border-color:#a7f3d0;background:var(--ok-soft);display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;">
          <div>
            <strong>✓ Oefenreeks afgerond!</strong>
            <div class="muted">Resultaat automatisch opgeslagen voor gespreide beheersing (${computeGrMetrics(topic.id).goodDaysCount}/2 dagen Goed).</div>
          </div>
          <div class="btn-row">
            ${s.poging2Pct !== undefined && s.poging2Pct !== null
              ? `${renderCategoryBadge(s.poging1Pct)} → ${renderCategoryBadge(s.poging2Pct, true)}`
              : renderCategoryBadge(s.poging1Pct, true)}
            <button type="button" class="btn btn-primary btn-sm" data-gr-action="generate">✨ Nieuwe reeks</button>
          </div>
        </div>`
      : "";

  const questionsHtml = s.questions.map((q, i) => {
    const r = s.results?.[i];
    const isLocked = s.done || (s.revising && r?.oordeel === "juist");
    const verdictCls = r ? ` verdict-${r.oordeel}` : "";
    const verdictLabel = r
      ? (r.oordeel === "juist" ? `<span class="cat-badge cat-excellent">✓ Juist</span>` : r.oordeel === "bijna" ? `<span class="cat-badge cat-bijna">Bijna</span>` : `<span class="cat-badge cat-onvoldoende">Verbeter</span>`)
      : "";
    const isLong = q.type === "productie" || q.type === "combineren";
    const inputId = `gr-ans-${i}`;
    const inputEl = isLong
      ? `<textarea id="${inputId}" class="scratchpad-editor" style="min-height:74px;background:#fff;" data-gr-ans="${i}" spellcheck="false" autocomplete="off" ${isLocked ? "disabled" : ""} placeholder="Typ je Franse zin(nen)…">${escapeHtml(s.answers[i])}</textarea>`
      : `<input id="${inputId}" class="input" type="text" data-gr-ans="${i}" value="${escapeHtml(s.answers[i])}" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" ${isLocked ? "disabled" : ""} placeholder="Typ je Franse antwoord…" />`;

    return `
      <div class="gr-q-card${verdictCls}">
        <div class="gr-q-top">
          <span class="gr-type-tag">${i + 1}. ${escapeHtml(getExTypeLabel(q.type))}${q.isTeacher ? " · 👩‍🏫 Leerkracht" : ""}</span>
          ${verdictLabel}
        </div>
        <p class="gr-q-prompt">${escapeHtml(q.opdracht_nl)}</p>
        ${q.context_fr ? `<div class="gr-q-context">${escapeHtml(q.context_fr)}</div>` : ""}
        ${q.hint && !isLocked ? `<div class="muted" style="font-size:0.82rem;margin-bottom:0.45rem;">Hint: ${escapeHtml(q.hint)}</div>` : ""}
        ${inputEl}
        ${r ? `
          <div class="gr-q-feedback">
            <div>${escapeHtml(r.uitleg)}</div>
            ${(r.modeloplossing && (s.done || r.oordeel === "juist")) ? `<div style="margin-top:0.3rem;"><strong>Model:</strong> ${escapeHtml(r.modeloplossing)} <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(r.modeloplossing)}" title="Luister">🔊</button></div>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }).join("");

  const actionBar = !s.done
    ? `
      <div class="card">
        <div class="muted" style="margin-bottom:0.35rem;font-size:0.82rem;">Klik in een invoerveld en gebruik de Franse accenten:</div>
        ${renderAccentBar("__gr_active")}
        <div class="btn-row" style="justify-content:flex-end;">
          <button type="button" class="btn btn-primary" data-gr-action="evaluate" ${App.grammar.evaluating ? "disabled" : ""}>
            ${App.grammar.evaluating ? "Antwoorden nakijken…" : s.revising ? "✓ Controleer verbeterde antwoorden" : `✓ Controleer mijn ${s.questions.length} antwoorden`}
          </button>
        </div>
      </div>
    `
    : "";

  container.innerHTML = `
    ${setupCard}
    ${stepperHtml}
    ${bannerHtml}
    <div class="gr-question-list">${questionsHtml}</div>
    ${actionBar}
  `;
}

/* ---------- Mode 2: Snelle offline grammaticadril (0 API-calls · Enter-flow) ---------- */

function startGrammarOfflineSession() {
  const topic = getCurrentGrammarTopic();
  const allTopics = App.grammar.pillar === "__all"
    ? getAllGrammarTopics()
    : getAllGrammarTopics().filter((t) => t.pijler === App.grammar.pillar);
  const basePool = [
    ...topic.voorbeelden.map((vb) => ({ ...vb, topicId: topic.id, topicNaam: topic.naam })),
    ...shuffleArray(allTopics.filter((t) => t.id !== topic.id).flatMap((t) => t.voorbeelden.map((vb) => ({ ...vb, topicId: t.id, topicNaam: t.naam })))).slice(0, 6),
  ];
  App.grammar.offlineSession = {
    topicId: topic.id,
    queue: basePool.map((item) => ({ item, isRetry: false, recorded: false })),
    initialTotal: basePool.length,
    points: 0,
    prevFeedback: null,
    done: false,
  };
}

function renderGrammarOffline(container) {
  const topic = getCurrentGrammarTopic();
  if (!App.grammar.offlineSession || App.grammar.offlineSession.topicId !== topic.id) {
    startGrammarOfflineSession();
  }
  const s = App.grammar.offlineSession;

  if (s.done) {
    const pct = Math.round((s.points / Math.max(1, s.initialTotal)) * 100);
    container.innerHTML = `
      <div class="card exercise-card">
        ${renderPrevFeedbackBar(s.prevFeedback)}
        <div class="summary-box">
          <h3>Offline basisdril klaar!</h3>
          <div style="margin:0.65rem 0;">${renderCategoryBadge(pct, true)}</div>
          <p class="muted">Eerste poging: ${s.points} / ${s.initialTotal} juist · Klaar voor de AI Grammatica-coach?</p>
          <div class="btn-row" style="justify-content:center;margin-top:1rem;">
            <button type="button" class="btn btn-primary" data-gr-mode="ai_coach">Naar AI Grammatica-coach →</button>
            <button type="button" class="btn btn-secondary" data-gr-offline="restart">Opnieuw</button>
          </div>
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

  container.innerHTML = `
    <div class="card exercise-card">
      ${renderPrevFeedbackBar(s.prevFeedback)}
      <div class="exercise-progress">
        <span>Nog <strong>${s.queue.length}</strong> zin(nen) · ${escapeHtml(item.topicNaam)}</span>
        <span>${cur.isRetry ? `<span class="retry-badge">↻ Herhaalzin</span>` : "0 API-calls · Enter = volgende"}</span>
      </div>
      <div class="muted">Vertaling (hint): <strong>${escapeHtml(item.nl)}</strong></div>
      <div class="cloze-sentence">
        ${escapeHtml(before)}<input id="gr-offline-input" class="cloze-input" type="text" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="…" />${escapeHtml(after)}
      </div>
      ${renderAccentBar("gr-offline-input")}
      <div class="btn-row" style="justify-content:space-between;">
        <div class="btn-row">
          <button type="button" class="btn btn-primary" data-gr-offline="submit">Controleer &amp; volgende ↵</button>
          <button type="button" class="btn btn-secondary" data-gr-offline="skip" tabindex="-1">Weet ik niet</button>
        </div>
        <span class="kbd-hint">↵ Enter = controleer &amp; meteen volgende</span>
      </div>
    </div>
  `;

  const inp = document.getElementById("gr-offline-input");
  if (inp) inp.focus();
}

function submitGrammarOfflineInstant(forceSkip = false) {
  const s = App.grammar.offlineSession;
  if (!s || s.done || !s.queue.length) return;
  const inp = document.getElementById("gr-offline-input");
  const given = forceSkip ? "" : (inp ? inp.value.trim() : "");
  const cur = s.queue.shift();
  const item = cur.item;
  const kind = !given ? "wrong" : checkClozeAnswer(given, item.gat);

  if (!cur.recorded) {
    cur.recorded = true;
    s.points += kind === "exact" ? 1 : kind === "accent" ? 0.5 : 0;
  }
  if (kind !== "exact") {
    s.queue.push({ item, isRetry: true, recorded: true });
  }
  s.prevFeedback = { kind, given, expected: item.gat, sub: item.fr, speakText: item.fr };
  if (!s.queue.length) {
    s.done = true;
    const b = ensureGrammarProgressBucket(s.topicId);
    b.offlineCount = (b.offlineCount || 0) + 1;
    scheduleSaveProgress();
  }
  renderGrammarStage();
}

/* ---------- Mode 3: Regelkaart & voorbeelden ---------- */

function renderGrammarTheory(container) {
  const topic = getCurrentGrammarTopic();
  const metrics = computeGrMetrics(topic.id);
  const custom = getCustomGrammarBucket(topic.id);

  container.innerHTML = `
    <div class="card">
      <div class="stage-toolbar">
        <div>
          <span class="weight-pill">${escapeHtml(topic.pijlerTitel)}</span>
          <h3 style="margin:0.45rem 0 0;">${escapeHtml(topic.naam)}</h3>
        </div>
        <button type="button" class="btn btn-primary btn-sm" data-gr-mode="ai_coach">Oefen deze regel →</button>
      </div>
      <p style="font-size:0.98rem;line-height:1.65;">${escapeHtml(topic.uitleg)}</p>
      ${custom.focus ? `<div class="teacher-focus-banner"><strong>👩‍🏫 Extra tip van de leerkracht:</strong> ${escapeHtml(custom.focus)}</div>` : ""}
      <h4 style="margin:1rem 0 0.45rem;font-size:0.94rem;">Voorbeeldzinnen</h4>
      <div class="examples-list" style="margin-top:0;">
        ${topic.voorbeelden.map((v) => `
          <div class="example-item">
            <div>
              <div><strong>${escapeHtml(v.fr)}</strong></div>
              <div class="muted">${escapeHtml(v.nl)}</div>
            </div>
            <button type="button" class="mini-icon-btn" data-speak="${escapeHtml(v.fr)}" title="Luister zin">🔊</button>
          </div>
        `).join("")}
      </div>
      ${metrics.weakPoints.length ? `
        <h4 style="margin:1.1rem 0 0.35rem;font-size:0.94rem;">Jouw recente aandachtspunten bij dit onderdeel</h4>
        <div class="weak-tags">${metrics.weakPoints.map((w) => `<span class="weak-tag">${escapeHtml(w)}</span>`).join("")}</div>
      ` : ""}
    </div>
  `;
}

/* ---------- Mode 4: Leerkracht-paneel (eigen focus & vaste oefeningen op server) ---------- */

function renderGrammarTeacherPanel(container) {
  const topic = getCurrentGrammarTopic();
  const custom = getCustomGrammarBucket(topic.id);
  const typeOpts = GRAMMAR_EXERCISE_TYPES.filter((t) => t.id !== "mix")
    .map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`)
    .join("");

  const listHtml = custom.exercises.length
    ? `<div class="gr-question-list" style="margin-top:0.85rem;">${custom.exercises.map((ex, idx) => `
        <div class="custom-ex-row">
          <div>
            <span class="gr-type-tag">${escapeHtml(getExTypeLabel(ex.type))}</span>
            <div style="font-weight:600;margin-top:0.3rem;">${escapeHtml(ex.opdracht_nl)}</div>
            ${ex.context_fr ? `<div class="muted">${escapeHtml(ex.context_fr)}</div>` : ""}
            ${ex.oplossing ? `<div class="muted" style="font-size:0.84rem;"><strong>Oplossing:</strong> ${escapeHtml(ex.oplossing)}</div>` : ""}
            ${ex.uitleg ? `<div class="muted" style="font-size:0.82rem;"><strong>Uitleg:</strong> ${escapeHtml(ex.uitleg)}</div>` : ""}
          </div>
          <button type="button" class="btn btn-ghost-danger btn-sm" data-gr-del-custom="${idx}">Verwijder</button>
        </div>
      `).join("")}</div>`
    : `<p class="muted" style="margin:0.65rem 0 0;">Nog geen eigen oefeningen toegevoegd voor dit onderdeel.</p>`;

  container.innerHTML = `
    <div class="card">
      <h3 style="margin:0 0 0.35rem;">👩‍🏫 AI-focus / instructie van de leerkracht</h3>
      <p class="muted" style="margin:0 0 0.6rem;">Vul hier advies van de thuisleerkracht in voor <strong>${escapeHtml(topic.naam)}</strong>. De AI Grammatica-coach neemt deze focus automatisch mee in elke nieuwe oefenreeks.</p>
      <textarea id="gr-teacher-focus" class="scratchpad-editor" style="min-height:80px;" placeholder="Bv. Extra oefenen op het onderscheid imparfait vs. passé composé in verhalen, of veel aandacht voor wederkerende werkwoorden met être…">${escapeHtml(custom.focus)}</textarea>
      <div class="btn-row" style="margin-top:0.6rem;justify-content:flex-end;">
        <button type="button" class="btn btn-primary btn-sm" data-gr-action="save-focus">Bewaar focus op server</button>
      </div>
    </div>

    <div class="card">
      <div class="stage-toolbar" style="margin-bottom:0.5rem;">
        <h3 style="margin:0;">Eigen vaste oefening toevoegen</h3>
        ${custom.exercises.length ? `<button type="button" class="btn btn-primary btn-sm" data-gr-action="start-teacher-set">Oefen deze ${custom.exercises.length} vragen →</button>` : ""}
      </div>
      <div class="form-grid-2">
        <div class="form-group">
          <label for="gr-new-type">Oefentype</label>
          <select id="gr-new-type" class="input">${typeOpts}</select>
        </div>
        <div class="form-group">
          <label for="gr-new-prompt">Opdracht (NL) *</label>
          <input id="gr-new-prompt" class="input" type="text" placeholder="Bv. Zet in de passé composé (let op accord)" />
        </div>
        <div class="form-group">
          <label for="gr-new-context">Franse opgavezin (optioneel)</label>
          <input id="gr-new-context" class="input" type="text" placeholder="Bv. Elle (se lever) à sept heures." />
        </div>
        <div class="form-group">
          <label for="gr-new-solution">Gewenste oplossing (FR, optioneel)</label>
          <input id="gr-new-solution" class="input" type="text" placeholder="Bv. Elle s'est levée à sept heures." />
        </div>
      </div>
      <div class="form-group">
        <label for="gr-new-uitleg">Korte uitleg / regel (optioneel)</label>
        <input id="gr-new-uitleg" class="input" type="text" placeholder="Bv. Wederkerende werkwoorden vervoegen altijd met être." />
      </div>
      <button type="button" class="btn btn-primary btn-sm" data-gr-action="add-custom">+ Voeg oefening toe</button>
      ${listHtml}
    </div>
  `;
}

function renderGrammarArchive() {
  const wrap = document.getElementById("gr-archive");
  const countEl = document.getElementById("gr-archive-count");
  if (!wrap || !countEl) return;
  const items = [...(App.progress.grammaticaArchief || [])].reverse().slice(0, 12);
  countEl.textContent = `${items.length} recente grammatica-reeksen — met leerlingantwoorden en AI-uitleg`;
  if (!items.length) {
    wrap.innerHTML = `<div class="card muted">Nog geen afgeronde grammatica-reeksen.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="archive-list">${items.map((a) => {
    const badge = a.verbeterdPct !== null && a.verbeterdPct !== undefined
      ? `${renderCategoryBadge(a.scorePct)} → ${renderCategoryBadge(a.verbeterdPct)}`
      : renderCategoryBadge(a.scorePct);
    const body = (a.items || []).map((it, i) => `
      <div class="gr-q-feedback" style="margin-top:0.55rem;">
        <strong>${i + 1}. ${escapeHtml(it.opdracht_nl)}</strong> ${it.context_fr ? `<span class="muted">(${escapeHtml(it.context_fr)})</span>` : ""}
        <div><strong>Antwoord:</strong> ${escapeHtml(it.antwoord1)} ${it.resultaat1 ? `— <em>${escapeHtml(it.resultaat1.oordeel)}</em>` : ""}</div>
        ${it.antwoord2 ? `<div><strong>Verbeterd:</strong> ${escapeHtml(it.antwoord2)} ${it.resultaat2 ? `— <em>${escapeHtml(it.resultaat2.oordeel)}</em>` : ""}</div>` : ""}
        ${it.resultaat1?.uitleg ? `<div class="muted">${escapeHtml(it.resultaat1.uitleg)}</div>` : ""}
      </div>
    `).join("");
    return `
      <details class="archive-item">
        <summary class="archive-summary">
          <div>
            <strong>${escapeHtml(a.topicNaam)}</strong>
            <div class="muted">${new Date(a.datum).toLocaleDateString("nl-BE")} · ${escapeHtml(getExTypeLabel(a.exerciseType))} (${(a.items || []).length} vragen)</div>
          </div>
          <div class="btn-row" style="gap:0.35rem;">${badge}</div>
        </summary>
        <div class="archive-body">${body}</div>
      </details>
    `;
  }).join("")}</div>`;
}

function handleGrammarStageClick(e) {
  const speakBtn = e.target.closest("[data-speak]");
  if (speakBtn) {
    speakFrench(speakBtn.dataset.speak);
    return;
  }

  const modeBtn = e.target.closest("[data-gr-mode]");
  if (modeBtn) {
    setGrammarMode(modeBtn.dataset.grMode);
    return;
  }

  const accBtn = e.target.closest("[data-accent]");
  if (accBtn) {
    const targetId = accBtn.dataset.accentTarget === "__gr_active"
      ? (App.grammar.activeInputId || "gr-ans-0")
      : accBtn.dataset.accentTarget;
    const inp = document.getElementById(targetId);
    insertAtCursor(inp, accBtn.dataset.accent);
    if (inp && inp.dataset.grAns !== undefined && App.grammar.session) {
      App.grammar.session.answers[Number(inp.dataset.grAns)] = inp.value;
    }
    return;
  }

  const exBtn = e.target.closest("[data-gr-extype]");
  if (exBtn) {
    App.grammar.exerciseType = exBtn.dataset.grExtype;
    renderGrammarStage();
    return;
  }

  const cntBtn = e.target.closest("[data-gr-count]");
  if (cntBtn) {
    App.grammar.count = Number(cntBtn.dataset.grCount);
    renderGrammarStage();
    return;
  }

  const offBtn = e.target.closest("[data-gr-offline]");
  if (offBtn) {
    const act = offBtn.dataset.grOffline;
    if (act === "restart") {
      startGrammarOfflineSession();
      renderGrammarStage();
    } else if (act === "submit") {
      submitGrammarOfflineInstant(false);
    } else if (act === "skip") {
      submitGrammarOfflineInstant(true);
    }
    return;
  }

  const delBtn = e.target.closest("[data-gr-del-custom]");
  if (delBtn) {
    const topic = getCurrentGrammarTopic();
    const cur = getCustomGrammarBucket(topic.id);
    cur.exercises.splice(Number(delBtn.dataset.grDelCustom), 1);
    App.progress.customGrammar[topic.id] = cur;
    scheduleSaveProgress();
    renderGrammarStage();
    return;
  }

  const actBtn = e.target.closest("[data-gr-action]");
  if (!actBtn) return;
  const act = actBtn.dataset.grAction;
  const topic = getCurrentGrammarTopic();

  if (act === "generate") {
    generateGrammarAiSet(false);
  } else if (act === "start-teacher-set") {
    generateGrammarAiSet(true);
  } else if (act === "evaluate") {
    evaluateGrammarSession();
  } else if (act === "save-focus") {
    const val = document.getElementById("gr-teacher-focus")?.value.trim() || "";
    const cur = getCustomGrammarBucket(topic.id);
    App.progress.customGrammar[topic.id] = { ...cur, focus: val };
    scheduleSaveProgress();
    renderGrammarStage();
  } else if (act === "add-custom") {
    const promptNl = document.getElementById("gr-new-prompt")?.value.trim() || "";
    if (!promptNl) {
      showGrammarError("Vul minstens een opdracht (NL) in.");
      return;
    }
    showGrammarError("");
    const cur = getCustomGrammarBucket(topic.id);
    cur.exercises.push({
      type: document.getElementById("gr-new-type")?.value || "transformatie",
      opdracht_nl: promptNl,
      context_fr: document.getElementById("gr-new-context")?.value.trim() || "",
      oplossing: document.getElementById("gr-new-solution")?.value.trim() || "",
      uitleg: document.getElementById("gr-new-uitleg")?.value.trim() || "",
    });
    App.progress.customGrammar[topic.id] = cur;
    scheduleSaveProgress();
    renderGrammarStage();
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
    if (App.activeTab === "vocab") renderVocabTab();
    if (App.activeTab === "grammar") renderGrammarTab();
    showConfigFeedback("Voortgang succesvol geïmporteerd en opgeslagen.");
  } catch {
    showConfigFeedback("Ongeldig JSON-bestand.", true);
  }
}

/* ---------- Events & Init ---------- */

function bindEvents() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      if (target === "vocab" && App.activeTab === "vocab") {
        App.vocab.view = "overview";
      } else if (target === "grammar" && App.activeTab === "grammar") {
        App.grammar.view = "overview";
      }
      switchTab(target);
    });
  });

  document.getElementById("wf-filters").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    App.wfFilter = chip.dataset.filter;
    document.querySelectorAll("#wf-filters .chip").forEach((c) => c.classList.toggle("active", c === chip));
    renderVocabOverview();
  });

  document.getElementById("wf-search").addEventListener("input", (e) => {
    App.wfSearch = e.target.value;
    renderVocabOverview();
  });

  document.getElementById("vocab-overview-view").addEventListener("click", (e) => {
    const wfBtn = e.target.closest("[data-open-wf]");
    if (wfBtn) openVocabField(wfBtn.dataset.openWf);
  });

  document.getElementById("btn-vocab-back").addEventListener("click", () => {
    App.vocab.view = "overview";
    renderVocabTab();
  });

  document.getElementById("gr-overview-view").addEventListener("click", (e) => {
    const pfBtn = e.target.closest("[data-gr-pillar]");
    if (pfBtn) {
      App.grammar.pillar = pfBtn.dataset.grPillar;
      renderGrammarOverview();
      return;
    }
    const grBtn = e.target.closest("[data-open-gr]");
    if (grBtn) openGrammarTopic(grBtn.dataset.openGr);
  });

  document.getElementById("btn-gr-back").addEventListener("click", () => {
    App.grammar.view = "overview";
    renderGrammarTab();
  });

  document.getElementById("gr-rule-card").addEventListener("click", (e) => {
    const speakBtn = e.target.closest("[data-speak]");
    if (speakBtn) {
      speakFrench(speakBtn.dataset.speak);
      return;
    }
    if (e.target.closest("[data-gr-toggle-rule]")) {
      App.grammar.ruleCollapsed = !App.grammar.ruleCollapsed;
      renderGrammarRuleCard();
    }
  });

  document.getElementById("tab-dashboard").addEventListener("click", (e) => {
    const tabBtn = e.target.closest("[data-goto-tab]");
    if (tabBtn) {
      if (tabBtn.dataset.gotoSpeakMode) App.speak.mode = tabBtn.dataset.gotoSpeakMode;
      if (tabBtn.dataset.gotoTab === "vocab") App.vocab.view = "overview";
      if (tabBtn.dataset.gotoTab === "grammar") App.grammar.view = "overview";
      switchTab(tabBtn.dataset.gotoTab);
    }
    const evalRow = e.target.closest("[data-open-eval]");
    if (evalRow) {
      const id = evalRow.dataset.openEval;
      const dom = evalRow.dataset.openEvalDomain || "schrijven";
      if (dom === "monoloog" || dom === "gesprek") {
        App.speak.openArchiveId = id;
        switchTab("spreken");
      } else {
        App.write.openArchiveId = id;
        switchTab("schrijven");
      }
      const target = document.querySelector(`[data-archive-id="${CSS.escape(id)}"]`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  document.getElementById("speak-mode-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-speak-mode]");
    if (!btn) return;
    stopSpeakTimer();
    stopAudioRecording();
    App.speak.mode = btn.dataset.speakMode;
    renderSpeakingModule();
  });

  document.getElementById("speak-wf-select").addEventListener("change", (e) => {
    App.speak.wfId = e.target.value;
  });

  document.getElementById("speak-doel-select").addEventListener("change", (e) => {
    App.speak.doelId = e.target.value;
  });

  document.getElementById("btn-speak-random").addEventListener("click", pickRandomSpeakingPair);
  document.getElementById("btn-speak-generate").addEventListener("click", generateSpeakingAssignment);

  const speakWs = document.getElementById("speak-workspace");
  speakWs.addEventListener("click", handleSpeakingWorkspaceClick);
  speakWs.addEventListener("input", (e) => {
    if (e.target.id === "mono-plan" && App.speak.monologue) {
      App.speak.monologue.plan = e.target.value;
    } else if (e.target.id === "mono-text-fallback" && App.speak.monologue) {
      App.speak.monologue.textFallback = e.target.value;
      const evalBtn = speakWs.querySelector('[data-speak-action="eval-mono"]');
      if (evalBtn) evalBtn.disabled = App.speak.busy || (!App.speak.monologue.audioDirty && countWords(e.target.value) < 15);
    } else if (e.target.id === "dialogue-scratchpad" && App.speak.dialogue) {
      App.speak.dialogue.scratchpad = e.target.value;
    }
  });
  speakWs.addEventListener("change", (e) => {
    if (e.target.id === "mono-audio-upload" && e.target.files?.[0]) {
      handleAudioFileUpload(e.target.files[0], "monoloog");
      e.target.value = "";
    } else if (e.target.id === "dial-audio-upload" && e.target.files?.[0]) {
      handleAudioFileUpload(e.target.files[0], "gesprek");
      e.target.value = "";
    }
  });
  speakWs.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "dialogue-chat-input") {
      e.preventDefault();
      const txt = e.target.value.trim();
      if (txt) {
        e.target.value = "";
        sendDialogueTurn({ typedText: txt });
      }
    }
  });

  // Spatiebalk Start/Stop spreekknop tijdens actief Gesprek (wanneer geen invoerveld gefocust is)
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.repeat) return;
    if (App.activeTab !== "spreken" || App.speak.mode === "monoloog") return;
    if (!App.speak.dialogue || App.speak.dialogue.phase !== "dialogue" || App.speak.busy) return;
    const tag = (document.activeElement?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
    e.preventDefault();
    if (App.speak.recorder) stopAudioRecording();
    else startAudioRecording("gesprek");
  });

  document.getElementById("write-mode-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-write-mode]");
    if (!btn) return;
    App.write.mode = btn.dataset.writeMode;
    renderWritingModeBar();
  });

  document.getElementById("write-wf-select").addEventListener("change", (e) => {
    App.write.wfId = e.target.value;
  });

  document.getElementById("write-doel-select").addEventListener("change", (e) => {
    App.write.doelId = e.target.value;
  });

  document.getElementById("btn-write-random").addEventListener("click", pickRandomWritingPair);
  document.getElementById("btn-write-generate").addEventListener("click", generateWritingAssignment);

  const writeWs = document.getElementById("write-workspace");
  writeWs.addEventListener("click", handleWritingWorkspaceClick);
  writeWs.addEventListener("input", (e) => {
    const c = App.progress.schrijfConcept;
    if (!c) return;
    const idx = c.activeTaskIdx || 0;
    if (e.target.id === "write-editor") {
      c.texts[idx] = e.target.value;
      const wc = countWords(e.target.value);
      const wcEl = document.getElementById("write-word-count");
      if (wcEl) {
        const richt = c.tasks[idx]?.richtwoorden;
        wcEl.textContent = `${wc} woorden${richt ? ` (richtlijn: ${richt})` : ""}`;
        wcEl.classList.toggle("in-range", wc >= 110);
      }
      scheduleSaveProgress();
    } else if (e.target.id === "write-scratchpad") {
      c.scratchpads[idx] = e.target.value;
      scheduleSaveProgress();
    }
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

  document.getElementById("gr-topic-select").addEventListener("change", (e) => {
    App.grammar.topicId = e.target.value;
    App.grammar.ruleCollapsed = false;
    App.grammar.session = null;
    App.grammar.offlineSession = null;
    showGrammarError("");
    renderGrammarStage();
  });

  document.getElementById("gr-mode-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gr-mode]");
    if (btn) setGrammarMode(btn.dataset.grMode);
  });

  const grStage = document.getElementById("gr-stage");
  grStage.addEventListener("click", handleGrammarStageClick);
  grStage.addEventListener("focusin", (e) => {
    if (e.target.dataset?.grAns !== undefined) {
      App.grammar.activeInputId = e.target.id;
    }
  });
  grStage.addEventListener("input", (e) => {
    if (e.target.dataset?.grAns !== undefined && App.grammar.session) {
      App.grammar.session.answers[Number(e.target.dataset.grAns)] = e.target.value;
    }
  });
  grStage.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "gr-offline-input") {
      e.preventDefault();
      submitGrammarOfflineInstant(false);
    }
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
      submitQuizInstant(false);
    } else if (e.target.id === "cloze-answer" && App.vocab.session?.type === "invul") {
      e.preventDefault();
      submitClozeInstant(false);
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
    stopWriteTimer();
    stopSpeakTimer();
    stopAudioRecording();
    App.progress = defaultProgress();
    App.vocab.session = null;
    App.grammar.session = null;
    App.grammar.offlineSession = null;
    App.speak.monologue = null;
    App.speak.dialogue = null;
    scheduleSaveProgress();
    renderDashboard();
    if (App.activeTab === "vocab") renderVocabTab();
    if (App.activeTab === "grammar") renderGrammarTab();
    if (App.activeTab === "schrijven") renderWritingModule();
    if (App.activeTab === "spreken") renderSpeakingModule();
    showConfigFeedback("Voortgang gewist.");
  });
}

async function init() {
  bindEvents();
  try {
    await loadInitialData();
    initVocabControls();
    initGrammarModule();
    initWritingModule();
    initSpeakingModule();
    renderDashboard();
  } catch (err) {
    showBanner(`Fout bij opstarten: ${err.message}`, true);
  }
}

init();
