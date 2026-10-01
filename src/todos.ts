// Tracks an agent's plan (TodoWrite, or the newer TaskCreate/TaskUpdate tools)
// with per-item timestamps so the estimator can measure how long items take.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  id?: string;
  content: string;
  activeForm?: string;
  status: TodoStatus;
  started_at?: number;
  completed_at?: number;
}

function normStatus(s: unknown): TodoStatus {
  return s === "in_progress" || s === "completed" ? s : "pending";
}

function stamp(t: Todo, now: number): Todo {
  if (t.status === "in_progress" && !t.started_at) t.started_at = now;
  if (t.status === "completed" && !t.completed_at) {
    t.completed_at = now;
    // Items can jump straight from pending to completed; treat that as instant.
    if (!t.started_at) t.started_at = now;
  }
  if (t.status !== "completed") delete t.completed_at;
  return t;
}

/** Full-list replacement, as sent by TodoWrite. Keeps timestamps for items that persist. */
export function applyTodoWrite(prev: Todo[], input: any, now: number): Todo[] {
  const incoming: any[] = Array.isArray(input?.todos) ? input.todos : [];
  const byContent = new Map(prev.map((t) => [t.content, t]));
  return incoming.slice(0, 100).map((raw) => {
    const content = String(raw?.content ?? raw?.subject ?? "").slice(0, 300);
    const old = byContent.get(content);
    const t: Todo = {
      content,
      activeForm: raw?.activeForm ? String(raw.activeForm).slice(0, 300) : undefined,
      status: normStatus(raw?.status),
      started_at: old?.started_at,
      completed_at: old?.completed_at,
    };
    return stamp(t, now);
  });
}

/** Incremental task tools. Unknown shapes are ignored rather than guessed at. */
export function applyTaskTool(prev: Todo[], tool: string, input: any, response: any, now: number): Todo[] {
  const list = prev.map((t) => ({ ...t }));
  if (tool === "TaskCreate") {
    const respText = typeof response === "string" ? response : JSON.stringify(response ?? "");
    const id =
      response?.task?.id ?? response?.id ?? respText.match(/#(\d+)/)?.[1] ?? respText.match(/"id"\s*:\s*"?(\w+)/)?.[1] ?? String(list.length + 1);
    list.push(
      stamp(
        {
          id: String(id),
          content: String(input?.subject ?? input?.content ?? input?.description ?? "Task").slice(0, 300),
          activeForm: input?.activeForm ? String(input.activeForm).slice(0, 300) : undefined,
          status: normStatus(input?.status),
        },
        now,
      ),
    );
    return list.slice(-100);
  }
  if (tool === "TaskUpdate") {
    const id = String(input?.taskId ?? input?.id ?? "");
    const t = list.find((x) => x.id === id);
    if (!t) return list;
    if (input?.status === "deleted") return list.filter((x) => x !== t);
    if (input?.status) t.status = normStatus(input.status);
    if (input?.subject) t.content = String(input.subject).slice(0, 300);
    if (input?.activeForm) t.activeForm = String(input.activeForm).slice(0, 300);
    stamp(t, now);
    return list;
  }
  return list;
}

export function isTodoTool(tool: string | undefined): boolean {
  return tool === "TodoWrite" || tool === "TaskCreate" || tool === "TaskUpdate";
}
