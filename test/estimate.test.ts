import { test } from "node:test";
import assert from "node:assert/strict";
import { estimate } from "../src/estimate.ts";
import { applyTodoWrite, applyTaskTool } from "../src/todos.ts";

const M = 60_000;

test("plan-based: projects remaining items from pace", () => {
  const t0 = 1_000_000;
  const todos = [
    { content: "a", status: "completed" as const, started_at: t0, completed_at: t0 + 2 * M },
    { content: "b", status: "completed" as const, started_at: t0 + 2 * M, completed_at: t0 + 4 * M },
    { content: "c", status: "in_progress" as const, started_at: t0 + 4 * M },
    { content: "d", status: "pending" as const },
  ];
  const e = estimate({ status: "working", turn_started_at: t0, todos, todos_started_at: t0, history_ms: [] }, t0 + 5 * M);
  // 2 min/item: 1 min left on c + 2 min for d
  assert.equal(Math.round(e.eta_ms! / M), 3);
  assert.equal(e.confidence, "medium");
  assert.ok(e.progress! > 0.5 && e.progress! < 0.75);
  assert.equal(e.overdue, false);
});

test("history-based: uses median of past turns", () => {
  const e = estimate({ status: "working", turn_started_at: 0, todos: [], todos_started_at: null, history_ms: [2 * M, 4 * M, 6 * M, 8 * M, 10 * M] }, 1 * M);
  assert.equal(Math.round(e.eta_ms! / M), 5);
  assert.equal(e.overdue, false);
});

test("history-based: flags overdue past p80", () => {
  const e = estimate({ status: "working", turn_started_at: 0, todos: [], todos_started_at: null, history_ms: [M, M, M, M, M] }, 20 * M);
  assert.equal(e.overdue, true);
  assert.ok(e.eta_ms! > 0);
});

test("idle sessions have no ETA", () => {
  const e = estimate({ status: "idle", turn_started_at: null, todos: [], todos_started_at: null, history_ms: [] }, 0);
  assert.equal(e.eta_ms, null);
});

test("TodoWrite keeps timestamps across rewrites", () => {
  let list = applyTodoWrite([], { todos: [{ content: "x", status: "in_progress" }, { content: "y", status: "pending" }] }, 100);
  list = applyTodoWrite(list, { todos: [{ content: "x", status: "completed" }, { content: "y", status: "in_progress" }] }, 200);
  assert.equal(list[0].started_at, 100);
  assert.equal(list[0].completed_at, 200);
  assert.equal(list[1].started_at, 200);
});

test("TaskCreate/TaskUpdate", () => {
  let list = applyTaskTool([], "TaskCreate", { subject: "do it" }, "Task #7 created successfully", 10);
  assert.equal(list[0].id, "7");
  list = applyTaskTool(list, "TaskUpdate", { taskId: "7", status: "completed" }, null, 20);
  assert.equal(list[0].status, "completed");
  assert.equal(list[0].completed_at, 20);
});
