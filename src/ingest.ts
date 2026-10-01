// Turns raw Claude Code hook payloads into session state.
// Hook payload reference: https://code.claude.com/docs/en/hooks
import type { Env } from "./auth.ts";
import { applyTaskTool, applyTodoWrite, isTodoTool, type Todo } from "./todos.ts";

const MAX_BODY = 512 * 1024;
const EVENT_RETENTION_MS = 7 * 24 * 3600_000;

const clip = (v: unknown, n: number): string | null => (v == null || v === "" ? null : String(v).replace(/\s+/g, " ").trim().slice(0, n));
const base = (p: unknown) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() ?? String(p) : "");

/** Human-readable one-liner for what a tool call is doing. */
export function describeTool(tool: string, input: any): string {
  const i = input ?? {};
  switch (tool) {
    case "Read":
      return `Reading ${base(i.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${base(i.file_path)}`;
    case "Write":
      return `Writing ${base(i.file_path)}`;
    case "NotebookEdit":
      return `Editing ${base(i.notebook_path)}`;
    case "Bash":
      return i.description ? String(i.description) : `$ ${i.command ?? ""}`;
    case "Grep":
      return `Searching for "${i.pattern ?? ""}"`;
    case "Glob":
      return `Finding ${i.pattern ?? "files"}`;
    case "WebFetch":
      return `Fetching ${i.url ?? ""}`;
    case "WebSearch":
      return `Searching the web: ${i.query ?? ""}`;
    case "Task":
    case "Agent":
      return `Subagent: ${i.description ?? i.subagent_type ?? ""}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "Updating plan";
    default:
      if (tool.startsWith("mcp__")) return `${tool.split("__").slice(1).join(" › ")}`;
      return tool;
  }
}

function looksLikeError(resp: any): boolean {
  if (!resp || typeof resp !== "object") return false;
  return resp.is_error === true || resp.success === false || (typeof resp.exit_code === "number" && resp.exit_code !== 0) || resp.interrupted === true;
}

function parseUsage(h: string | null) {
  if (!h) return null;
  try {
    const u = JSON.parse(h);
    const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    return JSON.stringify({ input: num(u.input), output: num(u.output), cache_read: num(u.cache_read), cache_write: num(u.cache_write) });
  } catch {
    return null;
  }
}

export async function ingest(request: Request, env: Env): Promise<Response> {
  const len = Number(request.headers.get("Content-Length") ?? 0);
  if (len > MAX_BODY) return new Response("Payload too large", { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response("Payload too large", { status: 413 });

  let p: any;
  try {
    p = JSON.parse(text);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const sessionId = clip(p.session_id, 100);
  const event = String(p.hook_event_name ?? "");
  if (!sessionId || !event) return new Response("Missing session_id / hook_event_name", { status: 400 });

  const now = Date.now();
  const h = request.headers;
  const cwd = clip(p.cwd ?? h.get("X-Agent-Cwd"), 500);
  const meta = {
    host: clip(h.get("X-Agent-Host"), 100),
    kind: h.get("X-Agent-Remote") ? "cloud" : "local",
    cloud_url: (() => {
      const r = clip(h.get("X-Agent-Remote"), 100);
      return r && /^[\w-]+$/.test(r) ? `https://claude.ai/code/${r.replace(/^cse_/, "session_")}` : null;
    })(),
    cwd,
    project: clip(h.get("X-Agent-Project"), 100) ?? (cwd ? base(cwd) : null),
    branch: clip(h.get("X-Agent-Branch"), 200),
    model: clip(typeof p.model === "string" ? p.model : p.model?.id ?? p.model?.display_name, 100),
  };

  // Ensure the session row exists, refresh metadata.
  await env.DB.prepare(
    `INSERT INTO sessions (id, host, kind, cloud_url, cwd, project, branch, model, started_at, last_event_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
     ON CONFLICT(id) DO UPDATE SET
       host = COALESCE(?2, host), kind = ?3, cloud_url = COALESCE(?4, cloud_url), cwd = COALESCE(?5, cwd),
       project = COALESCE(?6, project), branch = COALESCE(?7, branch), model = COALESCE(?8, model),
       last_event_at = ?9`,
  )
    .bind(sessionId, meta.host, meta.kind, meta.cloud_url, meta.cwd, meta.project, meta.branch, meta.model, now)
    .run();

  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, val: unknown) => {
    args.push(val);
    sets.push(`${col} = ?${args.length}`);
  };
  const stmts: D1PreparedStatement[] = [];
  const log = (kind: string, tool: string | null, summary: string | null) =>
    stmts.push(env.DB.prepare(`INSERT INTO events (session_id, ts, kind, tool, summary) VALUES (?, ?, ?, ?, ?)`).bind(sessionId, now, kind, tool, summary));

  const tool = clip(p.tool_name, 100);

  switch (event) {
    case "SessionStart":
      set("status", "idle");
      set("ended_at", null);
      set("hidden", 0);
      log("start", null, clip(p.source ? `Session ${p.source}` : "Session started", 200));
      break;

    case "UserPromptSubmit": {
      const prompt = clip(p.prompt, 1000);
      set("status", "working");
      set("turn_started_at", now);
      set("turn_tool_calls", 0);
      set("last_prompt", prompt);
      set("current_tool", null);
      set("current_detail", "Thinking…");
      sets.push("turns = turns + 1", "title = COALESCE(title, " + `?${args.push(clip(p.prompt, 120))}` + ")");
      log("prompt", null, clip(p.prompt, 300));
      break;
    }

    case "PreToolUse":
      set("status", "working");
      set("current_tool", tool);
      set("current_detail", clip(describeTool(tool ?? "", p.tool_input), 300));
      set("tool_running", 1);
      sets.push(`turn_started_at = COALESCE(turn_started_at, ?${args.push(now)})`);
      break;

    case "PostToolUse":
    case "PostToolUseFailure": {
      const failed = event === "PostToolUseFailure" || looksLikeError(p.tool_response);
      set("status", "working");
      set("tool_running", 0);
      set("current_tool", tool);
      set("current_detail", clip(describeTool(tool ?? "", p.tool_input), 300));
      sets.push("tool_calls = tool_calls + 1", "turn_tool_calls = turn_tool_calls + 1");
      if (failed) sets.push("errors = errors + 1");
      sets.push(`turn_started_at = COALESCE(turn_started_at, ?${args.push(now)})`);
      log(failed ? "tool_error" : "tool", tool, clip(describeTool(tool ?? "", p.tool_input), 300));

      if (isTodoTool(tool ?? undefined)) {
        const row = await env.DB.prepare(`SELECT todos, todos_started_at FROM sessions WHERE id = ?`).bind(sessionId).first<{ todos: string | null; todos_started_at: number | null }>();
        let prev: Todo[] = [];
        try {
          prev = row?.todos ? JSON.parse(row.todos) : [];
        } catch {}
        const next = tool === "TodoWrite" ? applyTodoWrite(prev, p.tool_input, now) : applyTaskTool(prev, tool!, p.tool_input, p.tool_response, now);
        // A fresh plan (nothing carried over, or the previous one was all done) restarts the pace clock.
        const prevAllDone = prev.length > 0 && prev.every((t) => t.status === "completed");
        const fresh = !row?.todos_started_at || prev.length === 0 || prevAllDone;
        set("todos", JSON.stringify(next));
        if (fresh) set("todos_started_at", now);
      }
      break;
    }

    case "Notification": {
      const msg = clip(p.message, 300);
      const type = String(p.notification_type ?? "");
      const needsYou = type ? type !== "idle_prompt" : !/waiting for your input/i.test(msg ?? "");
      if (needsYou) set("status", "waiting");
      set("last_message", msg);
      log("notify", null, msg);
      break;
    }

    case "Stop": {
      const row = await env.DB.prepare(`SELECT turn_started_at, turn_tool_calls, project FROM sessions WHERE id = ?`)
        .bind(sessionId)
        .first<{ turn_started_at: number | null; turn_tool_calls: number; project: string | null }>();
      if (row?.turn_started_at) {
        stmts.push(
          env.DB.prepare(`INSERT INTO turns (session_id, project, started_at, ended_at, tool_calls) VALUES (?, ?, ?, ?, ?)`).bind(
            sessionId,
            row.project,
            row.turn_started_at,
            now,
            row.turn_tool_calls ?? 0,
          ),
        );
      }
      set("status", "idle");
      set("turn_started_at", null);
      set("tool_running", 0);
      set("current_tool", null);
      set("current_detail", null);
      const last = clip(p.last_assistant_message, 500);
      if (last) set("last_message", last);
      log("stop", null, last ? clip(last, 300) : "Turn finished");
      break;
    }

    case "SubagentStop":
      sets.push("subagents = subagents + 1");
      log("subagent", null, "Subagent finished");
      break;

    case "PreCompact":
      log("compact", null, `Compacting context (${p.trigger ?? "auto"})`);
      break;

    case "SessionEnd":
      set("status", "ended");
      set("ended_at", now);
      set("tool_running", 0);
      set("current_tool", null);
      set("current_detail", null);
      log("end", null, clip(p.reason ? `Session ended (${p.reason})` : "Session ended", 200));
      break;

    default:
      log("other", tool, clip(event, 100));
  }

  const usage = parseUsage(h.get("X-Agent-Usage"));
  if (usage) set("usage", usage);

  if (sets.length) {
    args.push(sessionId);
    stmts.unshift(env.DB.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?${args.length}`).bind(...args));
  }
  // Occasionally prune old events so the database stays small.
  if (Math.random() < 0.01) {
    stmts.push(env.DB.prepare(`DELETE FROM events WHERE ts < ?`).bind(now - EVENT_RETENTION_MS));
  }
  if (stmts.length) await env.DB.batch(stmts);

  return Response.json({ ok: true });
}
