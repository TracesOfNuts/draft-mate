/* draft-mate dashboard — vanilla JS, talks to the local API. */

const PRIORITIES = [
  { key: "Critical", color: "var(--crit)", soft: "var(--crit-soft)" },
  { key: "High", color: "var(--high)", soft: "var(--high-soft)" },
  { key: "Medium", color: "var(--med)", soft: "var(--med-soft)" },
  { key: "Low", color: "var(--low)", soft: "var(--low-soft)" },
];
const PRIORITY_COLOR = Object.fromEntries(PRIORITIES.map((p) => [p.key, p]));

const CATEGORIES = [
  ["reply_immediately", "Reply immediately"],
  ["needs_review_today", "Needs review today"],
  ["waiting_on_someone", "Waiting on someone"],
  ["informational", "Informational"],
  ["newsletter_automated", "Newsletters / automated"],
  ["low_or_spam", "Low priority / spam"],
];
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

const SCORE_DIMS = [
  ["urgency", "Urgency"],
  ["replyNeeded", "Reply needed"],
  ["senderImportance", "Sender importance"],
  ["businessImpact", "Business impact"],
  ["meetingRelevance", "Meeting relevance"],
  ["actionItems", "Action items"],
];

const state = {
  account: "demo",
  analyses: [],
  run: null,
  filter: { type: "all", value: null },
  search: "",
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

function toast(message, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  const color = kind === "err" ? "var(--crit)" : "var(--ok)";
  t.innerHTML = `<span class="t-dot" style="background:${color}"></span>${esc(message)}`;
  $("toasts").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso || "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function relative(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const days = Math.round((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}

// ---------- init ----------
async function init() {
  $("triage").addEventListener("click", runTriage);
  $("account").addEventListener("change", (e) => { state.account = e.target.value; loadInbox(); });
  $("search").addEventListener("input", (e) => { state.search = e.target.value.toLowerCase(); renderList(); });
  $("drawer-scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  await loadHealth();
  await loadInbox();
}

async function loadHealth() {
  try {
    const h = await api("/api/health");
    const sel = $("account");
    sel.innerHTML = h.accounts
      .map((a) => `<option value="${esc(a.key)}">${esc(a.key)}${a.provider !== "mock" ? ` · ${esc(a.email)}` : " · sample inbox"}</option>`)
      .join("");
    sel.value = state.account;

    const pill = $("status-pill");
    if (h.ollamaUp && h.modelPulled) {
      pill.className = "pill pill-ok";
      $("status-text").textContent = h.model;
    } else if (h.ollamaUp) {
      pill.className = "pill pill-warn";
      $("status-text").textContent = "model not pulled";
    } else {
      pill.className = "pill pill-muted";
      $("status-text").textContent = "heuristics mode";
    }
  } catch (e) {
    $("status-text").textContent = "offline";
  }
}

async function loadInbox() {
  try {
    const data = await api(`/api/inbox?account=${encodeURIComponent(state.account)}`);
    state.analyses = data.analyses || [];
    state.run = data.run || null;
    render();
  } catch (e) {
    toast(e.message, "err");
  }
}

// ---------- triage (SSE) ----------
function runTriage() {
  const unread = $("unread").checked ? "1" : "0";
  const url = `/api/triage/stream?account=${encodeURIComponent(state.account)}&unread=${unread}&limit=50&refresh=1`;
  const overlay = $("overlay");
  overlay.classList.remove("hidden");
  $("overlay-title").textContent = "Analysing inbox…";
  $("overlay-sub").textContent = "Warming up the local model…";
  $("progress-bar").style.width = "4%";

  const ev = new EventSource(url);
  ev.onmessage = (msg) => {
    const d = JSON.parse(msg.data);
    if (d.type === "progress") {
      const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
      $("progress-bar").style.width = `${Math.max(pct, 4)}%`;
      $("overlay-sub").textContent = `Analysed ${d.done} of ${d.total} · ${d.mode === "llm" ? "local model" : "heuristics"}`;
    } else if (d.type === "done") {
      state.analyses = d.analyses || [];
      state.run = d.run || null;
      $("progress-bar").style.width = "100%";
      ev.close();
      setTimeout(() => {
        overlay.classList.add("hidden");
        render();
        toast(`Ranked ${state.analyses.length} emails via ${d.source === "llm" ? "the local model" : "heuristics"}`);
      }, 280);
    } else if (d.type === "error") {
      ev.close();
      overlay.classList.add("hidden");
      toast(d.message, "err");
    }
  };
  ev.onerror = () => { ev.close(); overlay.classList.add("hidden"); toast("Triage connection lost", "err"); };
}

// ---------- render ----------
function render() {
  renderSidebar();
  renderCounts();
  renderRunMeta();
  renderList();
}

function counts() {
  const byP = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  const byC = {};
  for (const a of state.analyses) {
    byP[a.priority] = (byP[a.priority] || 0) + 1;
    byC[a.category] = (byC[a.category] || 0) + 1;
  }
  return { byP, byC };
}

function renderSidebar() {
  const { byP, byC } = counts();
  const pr = $("priority-filters");
  pr.innerHTML =
    filterItem("all", null, "All emails", state.analyses.length, "var(--accent)") +
    PRIORITIES.map((p) => filterItem("priority", p.key, p.key, byP[p.key] || 0, p.color)).join("");
  const cat = $("category-filters");
  cat.innerHTML = CATEGORIES.filter(([k]) => byC[k]).map(([k, label]) =>
    filterItem("category", k, label, byC[k] || 0, "var(--text-faint)"),
  ).join("") || `<li class="filter-item" style="color:var(--text-faint);cursor:default">—</li>`;

  for (const li of document.querySelectorAll(".filter-item[data-type]")) {
    li.addEventListener("click", () => {
      state.filter = { type: li.dataset.type, value: li.dataset.value || null };
      render();
    });
  }
}

function filterItem(type, value, name, count, color) {
  const active = state.filter.type === type && (state.filter.value || null) === (value || null);
  return `<li class="filter-item ${active ? "active" : ""}" data-type="${type}" ${value ? `data-value="${esc(value)}"` : ""}>
    <span class="fi-dot" style="background:${color}"></span>
    <span class="fi-name">${esc(name)}</span>
    <span class="fi-count">${count}</span>
  </li>`;
}

function renderCounts() {
  const { byP } = counts();
  $("counts").innerHTML = PRIORITIES.map((p) =>
    `<span class="count-chip"><span class="cc-dot" style="background:${p.color}"></span>${p.key} <span class="cc-num">${byP[p.key] || 0}</span></span>`,
  ).join("");
}

function renderRunMeta() {
  if (!state.run) { $("run-meta").textContent = ""; return; }
  const r = state.run;
  $("run-meta").innerHTML = `Last run ${relative(r.startedAt)}<br>${r.analysedCount} emails · ${esc(r.source)}${r.source === "llm" ? `<br>${esc(r.model)}` : ""}`;
}

function visibleAnalyses() {
  let out = state.analyses;
  if (state.filter.type === "priority") out = out.filter((a) => a.priority === state.filter.value);
  if (state.filter.type === "category") out = out.filter((a) => a.category === state.filter.value);
  if (state.search) {
    out = out.filter((a) =>
      (a.subject || "").toLowerCase().includes(state.search) ||
      (a.from?.email || "").toLowerCase().includes(state.search) ||
      (a.from?.name || "").toLowerCase().includes(state.search),
    );
  }
  return out;
}

function renderList() {
  const list = $("list");
  const items = visibleAnalyses();
  const empty = $("empty");
  if (state.analyses.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    $("empty-text").textContent = "No analysed emails yet.";
    return;
  }
  if (items.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    $("empty-text").textContent = "Nothing matches this filter.";
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = items.map(cardHtml).join("");
  [...list.children].forEach((node, i) => {
    node.style.animationDelay = `${Math.min(i * 22, 300)}ms`;
    node.addEventListener("click", () => openDrawer(items[i]));
  });
}

function cardHtml(a) {
  const p = PRIORITY_COLOR[a.priority] || PRIORITY_COLOR.Low;
  const sender = a.from?.name && a.from.name !== a.from?.email
    ? `<b>${esc(a.from.name)}</b> · ${esc(a.from.email)}`
    : `<b>${esc(a.from?.email || "unknown")}</b>`;
  const bars = SCORE_DIMS.map(([k]) => {
    const v = a.scores?.[k] ?? 0;
    return `<i style="height:${4 + v * 4.5}px;background:${v >= 2 ? p.color : "var(--border-strong)"}"></i>`;
  }).join("");
  const deadline = a.deadline ? `<span class="chip-inline deadline">⏷ ${esc(a.deadline)}</span>` : "";
  const replyBy = a.suggestedReplyDeadline
    ? `<div class="replyby">reply by <b>${esc(a.suggestedReplyDeadline)}</b></div>` : "";

  return `<article class="card">
    <div class="accent-rail" style="background:${p.color}"></div>
    <div class="card-body">
      <div class="card-top">
        <span class="badge" style="background:${p.soft};color:${p.color}"><span class="b-dot" style="background:${p.color}"></span>${esc(a.priority)}</span>
        <span class="sender">${sender}</span>
      </div>
      <div class="subject">${esc(a.subject || "(no subject)")}</div>
      <p class="summary">${esc(a.summary || "")}</p>
      <div class="meta-row">
        <span class="why">${esc(a.priorityReason || "")}</span>
        ${deadline}
        <span class="chip-inline">${relative(a.receivedAt)}</span>
      </div>
    </div>
    <div class="card-side">
      <div class="score-mini" title="urgency · reply · sender · business · meeting · actions">${bars}</div>
      <div class="recommended"><span class="rec-label">Next step</span>${esc(a.recommendedAction || "")}</div>
      ${replyBy}
    </div>
  </article>`;
}

// ---------- drawer ----------
let current = null;

async function openDrawer(a) {
  current = a;
  const p = PRIORITY_COLOR[a.priority] || PRIORITY_COLOR.Low;
  const drawer = $("drawer");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("drawer-scrim").classList.remove("hidden");

  const scores = SCORE_DIMS.map(([k, label]) => {
    const v = a.scores?.[k] ?? 0;
    return `<div class="score-row">
      <span class="sr-name">${label}</span>
      <span class="score-track"><span class="score-fill" style="width:${(v / 3) * 100}%"></span></span>
      <span class="sr-val">${v}</span>
    </div>`;
  }).join("");

  const actions = (a.requestedActions || []).length
    ? `<div><div class="section-title">Requested actions</div><ul class="actions-list">${a.requestedActions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
    : "";

  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <span class="badge" style="background:${p.soft};color:${p.color}"><span class="b-dot" style="background:${p.color}"></span>${esc(a.priority)}</span>
        <h2 style="margin-top:10px">${esc(a.subject || "(no subject)")}</h2>
        <div class="dh-sub">${esc(a.from?.name || a.from?.email || "")} &lt;${esc(a.from?.email || "")}&gt; · ${fmtDate(a.receivedAt)}</div>
      </div>
      <button class="icon-btn" id="drawer-close" title="Close (Esc)">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="drawer-body">
      <div>
        <div class="section-title">Summary</div>
        <p style="margin:0;color:var(--text-dim)">${esc(a.summary || "")}</p>
      </div>
      <div class="kv">
        <span class="k">Why this rank</span><span class="v">${esc(a.priorityReason || "")}</span>
        <span class="k">Recommended</span><span class="v">${esc(a.recommendedAction || "")}</span>
        ${a.deadline ? `<span class="k">Deadline</span><span class="v" style="color:var(--high)">${esc(a.deadline)}</span>` : ""}
        ${a.suggestedReplyDeadline ? `<span class="k">Reply by</span><span class="v" style="color:var(--high)">${esc(a.suggestedReplyDeadline)}</span>` : ""}
        <span class="k">Analysed via</span><span class="v">${esc(a.source)}${a.source === "llm" ? ` (${esc(a.model)})` : ""}</span>
      </div>
      ${actions}
      <div>
        <div class="section-title">Score breakdown</div>
        <div class="scores">${scores}</div>
      </div>
      <div>
        <div class="section-title">Message</div>
        <div class="body-box" id="email-body">Loading…</div>
      </div>
      <div id="draft-zone"></div>
    </div>
    <div class="drawer-foot">
      <button class="btn btn-primary" id="gen-draft">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        Generate reply draft
      </button>
      <div class="spacer"></div>
    </div>`;

  $("drawer-close").addEventListener("click", closeDrawer);
  $("gen-draft").addEventListener("click", generateDraft);

  // Lazy-load full body.
  try {
    const email = await api(`/api/email?account=${encodeURIComponent(state.account)}&id=${encodeURIComponent(a.messageId)}`);
    $("email-body").textContent = email.bodyText || email.snippet || "(no content)";
  } catch (e) {
    $("email-body").textContent = "(could not load message body)";
  }
}

function closeDrawer() {
  $("drawer").classList.remove("open");
  $("drawer").setAttribute("aria-hidden", "true");
  $("drawer-scrim").classList.add("hidden");
  current = null;
}

async function generateDraft() {
  const btn = $("gen-draft");
  btn.disabled = true; btn.style.opacity = "0.6";
  btn.innerHTML = `<span class="spinner" style="width:15px;height:15px;border-width:2px"></span> Drafting…`;
  try {
    const draft = await api("/api/draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: state.account, messageId: current.messageId }),
    });
    renderDraftEditor(draft);
    toast("Draft generated — review before saving");
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false; btn.style.opacity = "1";
    btn.innerHTML = `Regenerate draft`;
  }
}

function renderDraftEditor(draft) {
  const zone = $("draft-zone");
  const hasNeeds = /\[\[NEEDS INPUT/.test(draft.body);
  zone.innerHTML = `
    <div>
      <div class="section-title">Reply draft <span style="color:var(--text-faint);text-transform:none;letter-spacing:0">· ${esc(draft.source === "llm" ? draft.model : "template")}</span></div>
      <div class="draft-editor">
        <input class="input" id="draft-subject" value="${esc(draft.subject)}" />
        <textarea class="textarea" id="draft-body">${esc(draft.body)}</textarea>
        ${hasNeeds ? `<div class="needs-input-note">⚠ Fill in the [[NEEDS INPUT]] placeholders before sending.</div>` : ""}
      </div>
    </div>`;

  const foot = document.querySelector(".drawer-foot");
  foot.innerHTML = `
    <button class="btn btn-ghost" id="save-edits">Save edits</button>
    <div class="spacer"></div>
    <button class="btn btn-danger" id="del-draft">Delete</button>
    <button class="btn btn-primary" id="approve-save">Save to ${esc(draftProviderLabel())} Drafts</button>`;

  $("save-edits").addEventListener("click", () => saveEdits(draft.id));
  $("del-draft").addEventListener("click", () => deleteDraft(draft.id));
  $("approve-save").addEventListener("click", () => approveDraft(draft.id, true));

  // Add a safety note under the editor.
  if (!document.querySelector(".safe-note")) {
    const note = document.createElement("div");
    note.className = "safe-note";
    note.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Drafts are never sent automatically — you send from your mail client.`;
    foot.after(note);
  }
}

function draftProviderLabel() {
  const opt = $("account").selectedOptions[0]?.textContent || "";
  if (opt.includes("gmail") || state.account.includes("gmail")) return "Gmail";
  if (opt.includes("graph") || opt.includes("outlook")) return "Outlook";
  return "provider";
}

async function saveEdits(id) {
  try {
    await api(`/api/draft/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: $("draft-subject").value, body: $("draft-body").value }),
    });
    toast("Edits saved");
  } catch (e) { toast(e.message, "err"); }
}

async function approveDraft(id, save) {
  // Persist current edits first so we save exactly what's on screen.
  await saveEdits(id);
  try {
    const d = await api(`/api/draft/${encodeURIComponent(id)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ save }),
    });
    if (save && d.providerDraftId) toast("Saved to your Drafts folder — not sent");
    else if (save) toast("Approved (provider not connected — saved locally)");
    else toast("Draft approved");
  } catch (e) { toast(e.message, "err"); }
}

async function deleteDraft(id) {
  try {
    await api(`/api/draft/${encodeURIComponent(id)}`, { method: "DELETE" });
    $("draft-zone").innerHTML = "";
    document.querySelector(".safe-note")?.remove();
    const foot = document.querySelector(".drawer-foot");
    foot.innerHTML = `<button class="btn btn-primary" id="gen-draft">Generate reply draft</button><div class="spacer"></div>`;
    $("gen-draft").addEventListener("click", generateDraft);
    toast("Draft deleted");
  } catch (e) { toast(e.message, "err"); }
}

init();
