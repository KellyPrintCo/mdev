// Read side: session list + detail with derived status, estimates and activity.
import type { Env } from "./auth.ts";
import { estimate } from "./estimate.ts";
import type { Todo } from "./todos.ts";

export const STALL_MS = 5 * 60_000; // working but silent this long → "stalled?"
export const OFFLINE_MS = 3 * 3600_000; // idle with no events this long → offline (terminal probably closed)
const SPARK_MINUTES = 30;

interface Row {
  id: string;
  host: string | null;
  kind: string | null;
  cloud_url: string | null;
  cwd: string | null;
  project: string | null;
  branch: string | null;
  model: string | null;
  title: string | null;
  status: string;
  current_tool: string | null;
  current_detail: string | null;
  tool_running: number;
  last_prompt: string | null;
  last_message: string | null;
  started_at: number;
  last_event_at: number;
  turn_started_at: number | null;
  turn_tool_calls: number;
  ended_at: number | null;
  turns: number;
  tool_calls: number;
  errors: number;
  subagents: number;
  todos: string | null;
  todos_started_at: number | null;
  usage: string | null;
  hidden: number;
}

function parse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Status as shown on the dashboard, accounting for silence. */
export function displayStatus(r: Pick<Row, "status" | "last_event_at" | "tool_running">, now: number): string {
  const quiet = now - r.last_event_at;
  if (r.status === "ended") return "ended";
  if (r.status === "working" && quiet > STALL_MS) return r.tool_running ? "long_tool" : "stalled";
  if (r.status === "idle" && quiet > OFFLINE_MS) return "offline";
  return r.status;
}

async function history(env: Env, now: number): Promise<{ byProject: Map<string, number[]>; global: number[] }> {
  const { results } = await env.DB.prepare(
    `SELECT project, ended_at - started_at AS d FROM turns WHERE ended_at > ? ORDER BY ended_at DESC LIMIT 500`,
  )
    .bind(now - 30 * 24 * 3600_000)
    .all<{ project: string | null; d: number }>();
  const byProject = new Map<string, number[]>();
  const global: number[] = [];
  for (const r of results) {
    global.push(r.d);
    const k = r.project ?? "";
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(r.d);
  }
  return { byProject, global };
}

function shape(r: Row, now: number, hist: { byProject: Map<string, number[]>; global: number[] }) {
  const todos = parse<Todo[]>(r.todos, []);
  const status = displayStatus(r, now);
  const projHist = hist.byProject.get(r.project ?? "") ?? [];
  const est = estimate(
    {
      status: status === "stalled" || status === "long_tool" ? "working" : status === "offline" ? "idle" : status,
      turn_started_at: r.turn_started_at,
      todos,
      todos_started_at: r.todos_started_at,
      history_ms: projHist.length >= 5 ? projHist : hist.global,
    },
    now,
  );
  return {
    id: r.id,
    title: r.title,
    host: r.host,
    kind: r.kind,
    cloud_url: r.cloud_url,
    cwd: r.cwd,
    project: r.project,
    branch: r.branch,
    model: r.model,
    status,
    current_tool: r.current_tool,
    current_detail: r.current_detail,
    last_prompt: r.last_prompt,
    last_message: r.last_message,
    started_at: r.started_at,
    last_event_at: r.last_event_at,
    turn_started_at: r.turn_started_at,
    turn_tool_calls: r.turn_tool_calls,
    ended_at: r.ended_at,
    turns: r.turns,
    tool_calls: r.tool_calls,
    errors: r.errors,
    subagents: r.subagents,
    todos,
    usage: parse(r.usage, null),
    hidden: !!r.hidden,
    estimate: est,
  };
}

export async function listAgents(env: Env, url: URL): Promise<Response> {
  const now = Date.now();
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days") ?? 3)));
  const includeHidden = url.searchParams.get("hidden") === "1";
  const since = now - days * 24 * 3600_000;

  const [{ results: rows }, hist, { results: sparkRows }, today] = await Promise.all([
    env.DB.prepare(`SELECT * FROM sessions WHERE last_event_at > ? ${includeHidden ? "" : "AND hidden = 0"} ORDER BY last_event_at DESC LIMIT 200`)
      .bind(since)
      .all<Row>(),
    history(env, now),
    env.DB.prepare(`SELECT session_id, CAST((? - ts) / 60000 AS INTEGER) AS ago, COUNT(*) AS c FROM events WHERE ts > ? GROUP BY session_id, ago`)
      .bind(now, now - SPARK_MINUTES * 60_000)
      .all<{ session_id: string; ago: number; c: number }>(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM events WHERE ts > ?1 AND kind IN ('tool','tool_error')) AS tool_calls,
         (SELECT COUNT(*) FROM turns WHERE ended_at > ?1) AS turns,
         (SELECT COALESCE(SUM(ended_at - started_at), 0) FROM turns WHERE ended_at > ?1) AS busy_ms`,
    )
      .bind(now - 24 * 3600_000)
      .first<{ tool_calls: number; turns: number; busy_ms: number }>(),
  ]);

  const spark = new Map<string, number[]>();
  for (const s of sparkRows) {
    if (!spark.has(s.session_id)) spark.set(s.session_id, new Array(SPARK_MINUTES).fill(0));
    const arr = spark.get(s.session_id)!;
    const idx = SPARK_MINUTES - 1 - s.ago;
    if (idx >= 0 && idx < SPARK_MINUTES) arr[idx] = s.c;
  }

  const agents = rows.map((r) => ({ ...shape(r, now, hist), activity: spark.get(r.id) ?? new Array(SPARK_MINUTES).fill(0) }));
  const sortedHist = [...hist.global].sort((a, b) => a - b);
  return Response.json(
    {
      now,
      agents,
      stats: {
        last24h: today,
        typical_turn_ms: sortedHist.length ? sortedHist[Math.floor(sortedHist.length / 2)] : null,
        history_turns: sortedHist.length,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function agentDetail(env: Env, id: string): Promise<Response> {
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT * FROM sessions WHERE id = ?`).bind(id).first<Row>();
  if (!row) return new Response("Not found", { status: 404 });
  const [hist, { results: events }, { results: tools }, { results: turns }] = await Promise.all([
    history(env, now),
    env.DB.prepare(`SELECT ts, kind, tool, summary FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 300`).bind(id).all(),
    env.DB.prepare(`SELECT tool, COUNT(*) AS c FROM events WHERE session_id = ? AND tool IS NOT NULL GROUP BY tool ORDER BY c DESC`).bind(id).all(),
    env.DB.prepare(`SELECT started_at, ended_at, tool_calls FROM turns WHERE session_id = ? ORDER BY ended_at DESC LIMIT 50`).bind(id).all(),
  ]);
  return Response.json({ agent: shape(row, now, hist), events, tools, turns, now }, { headers: { "Cache-Control": "no-store" } });
}

export async function updateAgent(env: Env, id: string, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { hidden?: boolean; title?: string };
  if (typeof body.hidden === "boolean") await env.DB.prepare(`UPDATE sessions SET hidden = ? WHERE id = ?`).bind(body.hidden ? 1 : 0, id).run();
  if (typeof body.title === "string") await env.DB.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).bind(body.title.slice(0, 120) || null, id).run();
  return Response.json({ ok: true });
}

export async function deleteAgent(env: Env, id: string): Promise<Response> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM events WHERE session_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id),
  ]);
  return Response.json({ ok: true });
}
