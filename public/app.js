"use strict";

const POLL_MS = 4000;
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATUS = {
  waiting: { label: "Needs you", rank: 0 },
  working: { label: "Working", rank: 1 },
  long_tool: { label: "Long-running tool", rank: 2 },
  stalled: { label: "Quiet — stalled?", rank: 2 },
  idle: { label: "Idle", rank: 3 },
  offline: { label: "Offline", rank: 4 },
  ended: { label: "Ended", rank: 5 },
};
const FILTERS = [
  ["all", "All", () => true],
  ["active", "Active", (a) => ["working", "waiting", "stalled", "long_tool"].includes(a.status)],
  ["waiting", "Needs you", (a) => a.status === "waiting"],
  ["idle", "Idle", (a) => a.status === "idle"],
  ["done", "Ended / offline", (a) => a.status === "ended" || a.status === "offline"],
];
const TOOL_ICON = {
  Read: "📖", Edit: "✏️", MultiEdit: "✏️", Write: "📝", Bash: "›_", Grep: "🔎", Glob: "🗂", WebFetch: "🌐", WebSearch: "🌐",
  Task: "🤖", Agent: "🤖", TodoWrite: "☑", TaskCreate: "☑", TaskUpdate: "☑", NotebookEdit: "📓",
};

const store = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {}
  return null;
};

const state = {
  data: null,
  fetchedAt: 0,
  filter: store("filter") || "active",
  search: "",
  days: store("days") || "3",
  openId: null,
  detail: null,
  prevStatus: new Map(),
  notify: store("notify") === "1",
  failures: 0,
};

/* ---------- formatting ---------- */
function dur(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  ms = Math.max(0, ms);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function roughDur(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  const m = Math.max(0, ms) / 60000;
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}
function ago(ts, now = serverNow()) {
  const d = now - ts;
  if (d < 5000) return "just now";
  return `${roughDur(d)} ago`;
}
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function tokens(n) {
  if (!n) return "0";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
const totalTokens = (u) => (u ? (u.input || 0) + (u.output || 0) + (u.cache_read || 0) + (u.cache_write || 0) : 0);
/** Server time, advanced locally between polls so timers tick smoothly. */
const serverNow = () => (state.data ? state.data.now + (Date.now() - state.fetchedAt) : Date.now());
const elapsedSinceFetch = () => Date.now() - state.fetchedAt;

/* ---------- data ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "X-Requested-With": "dashboard", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    credentials: "same-origin",
  });
  if (res.status === 401 || res.status === 403) {
    location.reload(); // Access session expired; let Access re-authenticate.
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function poll() {
  try {
    const data = await api(`/api/agents?days=${state.days}`);
    state.data = data;
    state.fetchedAt = Date.now();
    state.failures = 0;
    detectTransitions(data.agents);
    render();
    if (state.openId) loadDetail(state.openId, true);
  } catch (e) {
    state.failures++;
    renderLive();
  }
}

function detectTransitions(agents) {
  for (const a of agents) {
    const prev = state.prevStatus.get(a.id);
    if (prev && prev !== a.status) {
      const name = a.project || "Agent";
      if (a.status === "waiting") notify(`${name} needs you`, a.last_message || "Waiting for permission or input", a.id);
      else if (a.status === "idle" && ["working", "stalled", "long_tool"].includes(prev)) notify(`${name} finished`, a.last_message || a.title || "Turn complete", a.id);
      else if (a.status === "stalled") notify(`${name} has gone quiet`, "No activity for 5+ minutes", a.id);
    }
    state.prevStatus.set(a.id, a.status);
  }
}

function notify(title, body, id) {
  if (!state.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body: String(body).slice(0, 180), tag: `${id}:${title}` });
    n.onclick = () => {
      window.focus();
      openDrawer(id);
    };
  } catch {}
}

/* ---------- render: header + tiles ---------- */
function renderLive() {
  const dot = $("#liveDot");
  const up = $("#updated");
  if (state.failures > 1) {
    dot.className = "live-dot err";
    up.textContent = `Connection problem — retrying (last update ${state.fetchedAt ? ago(state.fetchedAt, Date.now()) : "never"})`;
  } else if (state.fetchedAt) {
    dot.className = "live-dot on";
    up.textContent = `Live · updated ${Math.round(elapsedSinceFetch() / 1000)}s ago`;
  }
}

function renderTiles(agents, stats) {
  const count = (fn) => agents.filter(fn).length;
  const working = count((a) => ["working", "stalled", "long_tool"].includes(a.status));
  const waiting = count((a) => a.status === "waiting");
  const idle = count((a) => a.status === "idle");
  const etas = agents.filter((a) => a.status === "working" && a.estimate.eta_ms != null).map((a) => a.estimate.eta_ms - elapsedSinceFetch());
  const allDone = etas.length ? Math.max(0, ...etas) : null;
  const tok = agents.reduce((s, a) => s + totalTokens(a.usage), 0);
  const tiles = [
    ["Working", working, working ? `${count((a) => a.status === "stalled")} quiet` : "nothing running", "🟢"],
    ["Needs you", waiting, waiting ? "waiting on permission / input" : "all clear", waiting ? "🟡" : "✅"],
    ["Idle", idle, `${agents.length} sessions in range`, "⏸"],
    ["All done in", allDone == null ? "—" : `~${roughDur(allDone)}`, allDone == null ? "no estimates running" : `around ${clock(serverNow() + allDone)}`, "⏱"],
    ["Tool calls · 24h", (stats.last24h?.tool_calls ?? 0).toLocaleString(), `${stats.last24h?.turns ?? 0} turns · ${roughDur(stats.last24h?.busy_ms)} busy`, "🛠"],
    ["Typical turn", stats.typical_turn_ms ? roughDur(stats.typical_turn_ms) : "—", `from ${stats.history_turns} turns${tok ? ` · ${tokens(tok)} tokens` : ""}`, "📈"],
  ];
  $("#tiles").innerHTML = tiles
    .map(
      ([label, value, sub, icon]) =>
        `<div class="tile"><div class="label"><span aria-hidden="true">${icon}</span>${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`,
    )
    .join("");
  document.title = waiting ? `(${waiting}) Agents — needs you` : working ? `(${working}) Agents working` : "Agents";
  setFavicon(waiting ? "#fab219" : working ? "#0ca30c" : "#898781");
}

let lastFavicon = "";
function setFavicon(color) {
  if (color === lastFavicon) return;
  lastFavicon = color;
  $("#favicon").href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='12' fill='${color}'/></svg>`)}`;
}

function renderChips(agents) {
  $("#chips").innerHTML = FILTERS.map(
    ([key, label, fn]) =>
      `<button class="chip" role="tab" data-filter="${key}" aria-selected="${state.filter === key}">${esc(label)}<span class="count">${agents.filter(fn).length}</span></button>`,
  ).join("");
}

/* ---------- render: cards ---------- */
function visibleAgents() {
  const agents = state.data?.agents ?? [];
  const fn = (FILTERS.find((f) => f[0] === state.filter) ?? FILTERS[0])[2];
  const q = state.search.trim().toLowerCase();
  return agents
    .filter(fn)
    .filter((a) => !q || [a.title, a.project, a.branch, a.host, a.last_prompt, a.current_detail, a.model].some((v) => v && v.toLowerCase().includes(q)))
    .sort((a, b) => {
      const r = (STATUS[a.status]?.rank ?? 9) - (STATUS[b.status]?.rank ?? 9);
      if (r) return r;
      if (a.status === "working" && a.estimate.eta_ms != null && b.estimate.eta_ms != null) return a.estimate.eta_ms - b.estimate.eta_ms;
      return b.last_event_at - a.last_event_at;
    });
}

function statusPill(status) {
  const s = STATUS[status] ?? { label: status };
  return `<span class="status ${esc(status)}"><span class="dot" aria-hidden="true"></span>${esc(s.label)}</span>`;
}

function progressBlock(a) {
  const e = a.estimate;
  const active = ["working", "stalled", "long_tool", "waiting"].includes(a.status);
  if (!active) {
    if (!a.todos.length) return "";
    const done = a.todos.filter((t) => t.status === "completed").length;
    return `<div class="progress"><div class="bar"><div class="fill" data-w="${(done / a.todos.length) * 100}"></div></div>
      <div class="eta-row muted"><span>${done}/${a.todos.length} plan items done</span></div></div>`;
  }
  const remaining = e.eta_ms == null ? null : Math.max(0, e.eta_ms - (a.status === "waiting" ? 0 : elapsedSinceFetch()));
  const pct = e.progress == null ? null : Math.min(99, e.progress * 100);
  const fill = pct == null ? `<div class="fill indeterminate"></div>` : `<div class="fill" data-w="${pct}"></div>`;
  let main;
  if (a.status === "waiting") main = `<span class="eta">Paused — waiting on you</span>`;
  else if (remaining == null) main = `<span class="eta">Working…</span>`;
  else if (e.overdue) main = `<span class="eta overdue" data-eta="${a.id}">Running long · maybe ~${roughDur(remaining)} more</span>`;
  else main = `<span class="eta" data-eta="${a.id}">~${roughDur(remaining)} left</span>`;
  const range = e.low_ms != null && a.status !== "waiting" ? ` <span class="muted small">(${roughDur(e.low_ms)}–${roughDur(e.high_ms)})</span>` : "";
  const conf = e.confidence && a.status !== "waiting" ? `<span class="conf" title="${esc(e.basis)}">${esc(e.confidence)} confidence</span>` : "";
  const finish = remaining != null && a.status !== "waiting" ? `<span class="muted">done ≈ ${clock(serverNow() + remaining)}</span>` : "";
  return `<div class="progress" title="${esc(e.basis)}"><div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${pct == null ? "" : `aria-valuenow="${Math.round(pct)}"`}>${fill}</div>
    <div class="eta-row"><span>${main}${range}${conf}</span>${finish}</div></div>`;
}

function todosBlock(todos, limit = 5) {
  if (!todos.length) return "";
  // Show the active item and its neighbours rather than always the top of the list.
  let start = 0;
  const activeIdx = todos.findIndex((t) => t.status === "in_progress");
  const firstOpen = todos.findIndex((t) => t.status !== "completed");
  const focus = activeIdx >= 0 ? activeIdx : firstOpen >= 0 ? firstOpen : 0;
  if (todos.length > limit) start = Math.max(0, Math.min(focus - 1, todos.length - limit));
  const slice = todos.slice(start, start + limit);
  const mark = { completed: "✓", in_progress: "▸", pending: "○" };
  const more = todos.length - slice.length;
  return `<ul class="todos">${slice
    .map((t) => `<li class="${esc(t.status)}"><span class="tick" aria-hidden="true">${mark[t.status]}</span><span>${esc(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content)}</span></li>`)
    .join("")}${more > 0 ? `<li class="muted small"><span class="tick"></span><span>+${more} more</span></li>` : ""}</ul>`;
}

function sparkline(values, id) {
  const w = 300, h = 34, n = values.length;
  const max = Math.max(1, ...values);
  const bw = w / n;
  let bars = "", hits = "";
  values.forEach((v, i) => {
    const bh = v ? Math.max(2, (v / max) * (h - 2)) : 0;
    const minsAgo = n - 1 - i;
    const label = `${v} event${v === 1 ? "" : "s"} · ${minsAgo === 0 ? "this minute" : `${minsAgo}m ago`}`;
    if (bh) bars += `<rect x="${(i * bw + 1).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"/>`;
    hits += `<rect class="hit" x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${h}" data-tip="${esc(label)}"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Activity over the last 30 minutes for ${esc(id)}"><line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}"/>${bars}${hits}</svg>`;
}

function card(a) {
  const now = serverNow();
  const icon = TOOL_ICON[a.current_tool] ?? (a.current_tool?.startsWith("mcp__") ? "🔌" : "💭");
  let activity = "";
  if (a.status === "waiting") {
    activity = `<div class="callout">🟡 ${esc(a.last_message || "Waiting for your permission or input")}</div>`;
  } else if (a.status === "stalled") {
    activity = `<div class="callout serious">⚠️ No activity for ${roughDur(now - a.last_event_at)} — last: ${esc(a.current_detail || "thinking")}</div>`;
  } else if (["working", "long_tool"].includes(a.status)) {
    activity = `<div class="activity"><span class="icon" aria-hidden="true">${icon}</span><span class="what">${esc(a.current_detail || "Thinking…")}</span></div>`;
  } else if (a.last_message) {
    activity = `<div class="activity"><span class="icon" aria-hidden="true">💬</span><span class="what">${esc(a.last_message)}</span></div>`;
  }
  const turnLine = a.turn_started_at ? `<span>turn <b data-since="${a.turn_started_at}">${dur(now - a.turn_started_at)}</b></span>` : "";
  const busy = a.activity.reduce((s, v) => s + v, 0);
  return `<article class="card ${esc(a.status)}" data-id="${esc(a.id)}">
    <div class="card-head">
      <div class="minw0">
        <div class="card-title" data-open="${esc(a.id)}">${esc(a.title || a.last_prompt || "New session")}</div>
        <div class="meta">
          ${a.project ? `<span class="tag" title="${esc(a.cwd)}">📁 ${esc(a.project)}</span>` : ""}
          ${a.branch && a.branch !== "HEAD" ? `<span class="tag" title="${esc(a.branch)}">⑂ ${esc(a.branch)}</span>` : ""}
          ${a.kind === "cloud" ? `<span class="tag cloud">☁ cloud</span>` : a.host ? `<span class="tag">💻 ${esc(a.host)}</span>` : ""}
          ${a.model ? `<span class="tag">${esc(a.model)}</span>` : ""}
        </div>
      </div>
      ${statusPill(a.status)}
    </div>
    ${activity}
    ${progressBlock(a)}
    ${todosBlock(a.todos)}
    <div class="spark-wrap">${sparkline(a.activity, a.project || a.id)}<span class="spark-label">${busy} events<br/>last 30m</span></div>
    <div class="stats">
      ${turnLine}
      <span>turns <b>${a.turns}</b></span>
      <span>tools <b>${a.tool_calls}</b></span>
      ${a.errors ? `<span class="err">errors <b>${a.errors}</b></span>` : ""}
      ${a.subagents ? `<span>subagents <b>${a.subagents}</b></span>` : ""}
      ${a.usage ? `<span>tokens <b>${tokens(totalTokens(a.usage))}</b></span>` : ""}
      <span>seen <b data-ago="${a.last_event_at}">${ago(a.last_event_at, now)}</b></span>
    </div>
    <div class="card-actions">
      <button class="btn" data-open="${esc(a.id)}" type="button">Details</button>
      ${a.cloud_url ? `<a class="btn" href="${esc(a.cloud_url)}" target="_blank" rel="noopener">Open session ↗</a>` : ""}
      <button class="btn ghost" data-hide="${esc(a.id)}" type="button" title="Hide from the dashboard">Hide</button>
    </div>
  </article>`;
}

// Inline style attributes are blocked by the CSP, so bar widths are set through the CSSOM.
function applyWidths(root) {
  root.querySelectorAll("[data-w]").forEach((el) => (el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`));
}

function render() {
  if (!state.data) return;
  const { agents, stats } = state.data;
  renderLive();
  renderTiles(agents, stats);
  renderChips(agents);
  const list = visibleAgents();
  const grid = $("#grid");
  grid.innerHTML = list.map(card).join("");
  applyWidths(grid);
  $("#empty").hidden = agents.length > 0;
  if (agents.length && !list.length) grid.innerHTML = `<p class="muted">No agents match this filter.</p>`;
}

/** Cheap per-second update of clocks without re-rendering cards. */
function tick() {
  if (!state.data) return;
  renderLive();
  const now = serverNow();
  document.querySelectorAll("[data-since]").forEach((el) => (el.textContent = dur(now - Number(el.dataset.since))));
  document.querySelectorAll("[data-ago]").forEach((el) => (el.textContent = ago(Number(el.dataset.ago), now)));
  document.querySelectorAll("[data-eta]").forEach((el) => {
    const a = state.data.agents.find((x) => x.id === el.dataset.eta);
    if (!a || a.estimate.eta_ms == null) return;
    const left = Math.max(0, a.estimate.eta_ms - elapsedSinceFetch());
    el.textContent = a.estimate.overdue ? `Running long · maybe ~${roughDur(left)} more` : `~${roughDur(left)} left`;
  });
}

/* ---------- drawer ---------- */
async function loadDetail(id, quiet = false) {
  try {
    const d = await api(`/api/agents/${encodeURIComponent(id)}`);
    if (state.openId !== id) return;
    state.detail = d;
    renderDrawer();
  } catch (e) {
    if (!quiet) $("#drawerBody").innerHTML = `<p class="muted">Couldn't load details.</p>`;
  }
}

function openDrawer(id) {
  state.openId = id;
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
  $("#drawerBody").innerHTML = `<p class="muted">Loading…</p>`;
  loadDetail(id);
}
function closeDrawer() {
  state.openId = null;
  state.detail = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
}

function turnsChart(turns) {
  if (!turns.length) return `<p class="muted small">No completed turns yet.</p>`;
  const list = [...turns].reverse();
  const w = 500, h = 90, n = list.length;
  const durs = list.map((t) => t.ended_at - t.started_at);
  const max = Math.max(...durs, 1);
  const bw = w / Math.max(n, 12);
  let out = "";
  list.forEach((t, i) => {
    const bh = Math.max(2, (durs[i] / max) * (h - 6));
    const x = i * bw;
    out += `<rect class="b" x="${(x + 1).toFixed(1)}" y="${(h - 1 - bh).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${bh.toFixed(1)}" rx="3"/>`;
    out += `<rect class="hit" x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${h}" data-tip="${esc(`${clock(t.started_at)} · ${dur(durs[i])} · ${t.tool_calls} tool calls`)}"/>`;
  });
  return `<svg class="turns-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Duration of recent turns">${out}<line x1="0" x2="${w}" y1="${h - 0.5}" y2="${h - 0.5}"/></svg>
    <p class="muted small">Longest ${dur(max)} · median ${dur([...durs].sort((a, b) => a - b)[Math.floor(n / 2)])} · ${n} turns</p>`;
}

function renderDrawer() {
  const d = state.detail;
  if (!d) return;
  const a = d.agent;
  const now = d.now;
  const maxTool = Math.max(1, ...d.tools.map((t) => t.c));
  const icons = { prompt: "💬", tool: "·", tool_error: "✕", notify: "🟡", stop: "■", start: "▶", end: "⏹", subagent: "🤖", compact: "🗜", other: "·" };
  const u = a.usage;
  $("#drawerBody").innerHTML = `
    <div class="drawer-head">
      <div class="minw0"><h2>${esc(a.title || "Session")}</h2><div class="meta">${statusPill(a.status)} <span class="tag">${esc(a.project || "")}</span></div></div>
      <button class="btn" id="closeDrawer" type="button" aria-label="Close">✕</button>
    </div>
    ${progressBlock(a)}
    ${a.todos.length ? `<section><h3>Plan</h3>${todosBlock(a.todos, 100)}</section>` : ""}
    <section><h3>Estimate</h3><p class="small">${esc(a.estimate.basis)}${a.estimate.confidence ? ` · ${esc(a.estimate.confidence)} confidence` : ""}</p></section>
    ${a.last_prompt ? `<section><h3>Last prompt</h3><div class="quote">${esc(a.last_prompt)}</div></section>` : ""}
    ${a.last_message ? `<section><h3>Last message</h3><div class="quote">${esc(a.last_message)}</div></section>` : ""}
    <section><h3>Turn durations</h3>${turnsChart(d.turns)}</section>
    ${d.tools.length ? `<section><h3>Tools used</h3><div class="hbars">${d.tools
      .slice(0, 12)
      .map((t) => `<div class="hbar"><span class="name" title="${esc(t.tool)}">${esc(t.tool)}</span><div class="track"><div data-w="${(t.c / maxTool) * 100}"></div></div><span class="v">${t.c}</span></div>`)
      .join("")}</div></section>` : ""}
    <section><h3>Session</h3><dl class="kv">
      <dt>Started</dt><dd>${new Date(a.started_at).toLocaleString()} (${roughDur(now - a.started_at)} ago)</dd>
      <dt>Last event</dt><dd>${ago(a.last_event_at, now)}</dd>
      ${a.host ? `<dt>Host</dt><dd>${esc(a.host)}</dd>` : ""}
      ${a.cwd ? `<dt>Directory</dt><dd>${esc(a.cwd)}</dd>` : ""}
      ${a.branch ? `<dt>Branch</dt><dd>${esc(a.branch)}</dd>` : ""}
      ${a.model ? `<dt>Model</dt><dd>${esc(a.model)}</dd>` : ""}
      ${u ? `<dt>Tokens</dt><dd>${tokens(u.input)} in · ${tokens(u.output)} out · ${tokens(u.cache_read)} cache read · ${tokens(u.cache_write)} cache write</dd>` : ""}
      <dt>Session ID</dt><dd class="small">${esc(a.id)}</dd>
      ${a.cloud_url ? `<dt>Cloud</dt><dd><a href="${esc(a.cloud_url)}" target="_blank" rel="noopener">Open in claude.ai ↗</a></dd>` : ""}
    </dl></section>
    <section><h3>Timeline</h3><ul class="timeline">${d.events
      .map((e) => `<li class="${esc(e.kind)}"><span class="t" title="${new Date(e.ts).toLocaleString()}">${clock(e.ts)}</span><span aria-hidden="true">${icons[e.kind] ?? "·"}</span><span class="s">${esc(e.summary || e.tool || e.kind)}</span></li>`)
      .join("")}</ul></section>
    <section class="card-actions">
      <button class="btn" data-rename="${esc(a.id)}" type="button">Rename</button>
      <button class="btn" data-hide="${esc(a.id)}" data-unhide="${a.hidden ? 1 : ""}" type="button">${a.hidden ? "Unhide" : "Hide"}</button>
      <button class="btn danger" data-delete="${esc(a.id)}" type="button">Delete history</button>
    </section>`;
  const body = $("#drawerBody");
  applyWidths(body);
}

/* ---------- events ---------- */
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-open],[data-hide],[data-delete],[data-rename],[data-filter],#closeDrawer,#scrim");
  if (!t) return;
  if (t.id === "closeDrawer" || t.id === "scrim") return closeDrawer();
  if (t.dataset.filter) {
    state.filter = t.dataset.filter;
    store("filter", state.filter);
    return render();
  }
  if (t.dataset.open) return openDrawer(t.dataset.open);
  if (t.dataset.hide) {
    await api(`/api/agents/${encodeURIComponent(t.dataset.hide)}`, { method: "PATCH", body: JSON.stringify({ hidden: !t.dataset.unhide }) });
    if (state.openId === t.dataset.hide) closeDrawer();
    return poll();
  }
  if (t.dataset.rename) {
    const name = prompt("Name this session", state.detail?.agent.title || "");
    if (name == null) return;
    await api(`/api/agents/${encodeURIComponent(t.dataset.rename)}`, { method: "PATCH", body: JSON.stringify({ title: name }) });
    loadDetail(t.dataset.rename);
    return poll();
  }
  if (t.dataset.delete) {
    if (!confirm("Delete this session and its history from the dashboard?")) return;
    await api(`/api/agents/${encodeURIComponent(t.dataset.delete)}`, { method: "DELETE" });
    closeDrawer();
    return poll();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.openId) closeDrawer();
});

// Tooltips for chart marks.
const tip = $("#tip");
document.addEventListener("pointermove", (e) => {
  const el = e.target.closest?.("[data-tip]");
  if (!el) return (tip.hidden = true);
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
});

$("#search").addEventListener("input", (e) => {
  state.search = e.target.value;
  render();
});
$("#range").value = state.days;
$("#range").addEventListener("change", (e) => {
  state.days = e.target.value;
  store("days", state.days);
  poll();
});

function renderNotifyBtn() {
  $("#notifyBtn").textContent = state.notify ? "🔔 Alerts on" : "🔕 Alerts off";
}
$("#notifyBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) return alert("This browser doesn't support notifications.");
  if (!state.notify && Notification.permission !== "granted") {
    const p = await Notification.requestPermission();
    if (p !== "granted") return;
  }
  state.notify = !state.notify;
  store("notify", state.notify ? "1" : "0");
  renderNotifyBtn();
});

const savedTheme = store("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("#themeBtn").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  store("theme", document.documentElement.dataset.theme);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});

api("/api/me").then((m) => ($("#who").textContent = m.email)).catch(() => {});
renderNotifyBtn();
poll();
setInterval(() => {
  if (!document.hidden || state.notify) poll();
}, POLL_MS);
setInterval(tick, 1000);
