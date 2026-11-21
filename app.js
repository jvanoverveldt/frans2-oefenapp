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
};

function defaultProgress() {
  return {
    version: 2,
    updatedAt: null,
    woordvelden: {},
    grammatica: {},
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
  if (tabId === "schrijven") renderWritingModule();
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
  const totalWordsInProgress = wfStats.reduce((s, x) => s + x.m.inProgress, 0);
  const totalWordsDue = wfStats.reduce((s, x) => s + x.m.due, 0);

  const grMastered = grAll.filter((g) => computeGrMetrics(g.id).status === "beheerst").length;
  const grPracticing = grAll.filter((g) => computeGrMetrics(g.id).status === "oefenen").length;
  const readiness = computeWeightedReadiness();

  const nextTip = totalWordsDue > 0
    ? `${totalWordsDue} woord(en) staan klaar voor gespreide herhaling.`
    : !App.config.hasKey
      ? "Stel je Gemini API-key in bij Instellingen voor AI-zinnen en examenevaluatie."
      : totalWordsMastered < 50
        ? "Start een reeks Woordentoets (NL → FR) om je woordenschat actief in te prenten."
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
      <div class="kpi-sub">${totalWordsInProgress} op weg · ${totalWordsDue} te herhalen · ${wfMastered}/23 velden klaar</div>
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
      <div class="kpi-sub">Beheerst = 3× foutloos NL → FR verspreid over dagen</div>
    </div>
  `;

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

  document.getElementById("wf-summary-text").textContent =
    `${wfMastered} beheerst · ${wfPracticing} aan het oefenen · ${totalWords} woorden (beheerst bij ≥80% op niveau 3/3)`;

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
            <span>${m.mastered} / ${m.total} beheerst${m.inProgress ? ` (+${m.inProgress} op weg)` : ""}${m.accuracy !== null ? ` · ${m.accuracy}%` : ""}</span>
            ${m.due > 0 ? `<span class="due-badge">↻ ${m.due}</span>` : ""}
          </div>
          <div class="wf-actions">
            <span class="status-pill status-${m.status}">${STATUS_LABELS[m.status]}</span>
            <button class="btn btn-secondary btn-sm" type="button" data-open-wf="${wf.id}">Oefen</button>
          </div>
        </div>
      `).join("")
    : `<div class="card muted">Geen woordvelden gevonden voor deze filter.</div>`;

  document.getElementById("gr-summary-text").textContent =
    `${grMastered} van ${grAll.length} onderdelen beheerst (automatisch bepaald op basis van resultaten)`;

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

  const historyEl = document.getElementById("dashboard-history");
  const recent = [...App.progress.evaluaties].reverse().slice(0, 8);
  if (!recent.length) {
    historyEl.innerHTML = `<p class="muted" style="margin:0;">Nog geen AI-evaluaties opgeslagen. Zodra je schrijf-, spreek- of literatuuropdrachten maakt, verschijnen je scores en feedback hier automatisch.</p>`;
  } else {
    historyEl.innerHTML = `<div class="history-list">${recent.map((e) => `
      <div class="history-row${e.domein === "schrijven" && e.id ? " clickable" : ""}" ${e.domein === "schrijven" && e.id ? `data-open-eval="${escapeHtml(e.id)}"` : ""}>
        <div>
          <strong>${escapeHtml(e.titel || e.domein)}</strong>
          <div class="muted">${new Date(e.datum).toLocaleDateString("nl-BE")} · ${escapeHtml(e.submodus || e.domein)}${e.heeftVerbetering ? " · inclusief verbeterpoging" : ""}</div>
        </div>
        <span class="score-badge">${escapeHtml(e.scorePct)}%</span>
      </div>
    `).join("")}</div>`;
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
        const diff = evalObj.scorePct - prevEval.scorePct;
        const sign = diff >= 0 ? "+" : "";
        return `<span class="growth-pill">Groei: ${prevEval.totaalOp20}/20 → ${evalObj.totaalOp20}/20 (${sign}${diff}%)</span>`;
      })()
    : "";

  const critHtml = evalObj.criteria.map((cr) => `
    <div class="crit-card">
      <div class="crit-top">
        <span>${escapeHtml(cr.naam || cr.id)}</span>
        <span class="score-badge">${escapeHtml(cr.score)}/${escapeHtml(cr.max || 4)}</span>
      </div>
      <p class="crit-fb">${escapeHtml(cr.feedback)}</p>
    </div>
  `).join("");

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
          <span class="eval-score-big">${evalObj.totaalOp20}/20 <span style="font-size:1rem;color:var(--muted);">(${evalObj.scorePct}%)</span></span>
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
    const scoreTxt = item.poging2
      ? `${item.poging1.scorePct}% → ${item.poging2.scorePct}%`
      : `${item.scorePct}%`;

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
          <strong>Poging 1 (${p1Eval ? `${p1Eval.totaalOp20}/20 · ${p1Eval.scorePct}%` : ""})</strong>
          <div class="archive-text-box">${escapeHtml(p1Text)}</div>
          ${p1Eval ? renderEvalBreakdown(p1Eval, null, "Poging 1") : ""}
          ${p2Eval ? `
            <div style="margin-top:0.85rem;">
              <strong>Verbeterpoging (${p2Eval.totaalOp20}/20 · ${p2Eval.scorePct}%)</strong>
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
          <span class="score-badge">${escapeHtml(scoreTxt)}</span>
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
              <strong>✏️ Stap 2: Verbeter je tekst op basis van de feedback (Poging 1: ${p1.totaalOp20}/20 · ${p1.scorePct}%)</strong>
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
    const evalRow = e.target.closest("[data-open-eval]");
    if (evalRow) {
      App.write.openArchiveId = evalRow.dataset.openEval;
      switchTab("schrijven");
      const target = document.querySelector(`[data-archive-id="${CSS.escape(App.write.openArchiveId)}"]`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
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
    App.progress = defaultProgress();
    App.vocab.session = null;
    scheduleSaveProgress();
    renderDashboard();
    if (App.activeTab === "schrijven") renderWritingModule();
    if (App.activeTab === "drill") renderVocabStage();
    showConfigFeedback("Voortgang gewist.");
  });
}

async function init() {
  bindEvents();
  try {
    await loadInitialData();
    initVocabControls();
    initWritingModule();
    renderDashboard();
  } catch (err) {
    showBanner(`Fout bij opstarten: ${err.message}`, true);
  }
}

init();
