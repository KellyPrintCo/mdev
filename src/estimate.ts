// Time-left estimation. Two strategies:
//  1. Plan-based: if the agent wrote a todo list, measure its pace through the
//     list (time per completed item) and project the remaining items.
//  2. History-based: otherwise, compare how long this turn has run against the
//     distribution of past turn durations (same project first, then global).
import type { Todo } from "./todos.ts";

export interface Estimate {
  progress: number | null; // 0..1
  eta_ms: number | null; // best guess remaining
  low_ms: number | null;
  high_ms: number | null;
  confidence: "high" | "medium" | "low" | null;
  basis: string;
  overdue: boolean;
}

export interface EstimateInput {
  status: string;
  turn_started_at: number | null;
  todos: Todo[];
  todos_started_at: number | null;
  history_ms: number[]; // durations of recent completed turns, most relevant first
}

const DEFAULT_TURN_MS = 4 * 60_000;
const DEFAULT_ITEM_MS = 90_000;

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const none = (basis: string, progress: number | null = null): Estimate => ({
  progress,
  eta_ms: null,
  low_ms: null,
  high_ms: null,
  confidence: null,
  basis,
  overdue: false,
});

export function estimate(s: EstimateInput, now: number): Estimate {
  const todos = s.todos ?? [];
  const n = todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  const planOpen = n > 0 && done < n;

  if (s.status === "ended") return none("Session ended", n ? done / n : 1);
  if (s.status === "idle") return none("Finished its turn", n ? done / n : 1);

  if (planOpen) return planEstimate(s, todos, now);
  return historyEstimate(s, now);
}

function planEstimate(s: EstimateInput, todos: Todo[], now: number): Estimate {
  const n = todos.length;
  const completed = todos.filter((t) => t.status === "completed");
  const active = todos.filter((t) => t.status === "in_progress");
  const pending = n - completed.length - active.length;

  const starts = todos.map((t) => t.started_at).filter((x): x is number => !!x);
  const planStart = Math.min(s.todos_started_at ?? now, s.turn_started_at ?? now, ...starts);
  const lastDone = Math.max(planStart, ...completed.map((t) => t.completed_at ?? planStart));

  let perItem: number;
  let confidence: Estimate["confidence"];
  if (completed.length > 0 && lastDone > planStart) {
    perItem = (lastDone - planStart) / completed.length;
    confidence = completed.length >= 3 ? "high" : "medium";
  } else {
    const hist = [...s.history_ms].sort((a, b) => a - b);
    const typicalTurn = hist.length >= 3 ? quantile(hist, 0.5) : DEFAULT_TURN_MS;
    perItem = Math.max(20_000, typicalTurn / Math.max(n, 1));
    if (!hist.length) perItem = DEFAULT_ITEM_MS;
    confidence = "low";
  }

  // Remaining time on the item(s) currently in progress.
  let activeRemaining = 0;
  let activeFraction = 0;
  for (const t of active) {
    const elapsed = now - (t.started_at ?? lastDone);
    activeRemaining += Math.max(perItem - elapsed, perItem * 0.15);
    activeFraction += Math.min(elapsed / perItem, 0.9);
  }
  const eta = activeRemaining + pending * perItem;
  const spread = confidence === "high" ? [0.75, 1.35] : confidence === "medium" ? [0.6, 1.7] : [0.4, 2.5];
  const progress = Math.min(0.99, (completed.length + activeFraction) / n);
  const overdue = active.some((t) => now - (t.started_at ?? lastDone) > perItem * 2);

  if (s.status === "waiting") {
    return { ...none("Paused — waiting on you", progress), eta_ms: eta, low_ms: eta * spread[0], high_ms: eta * spread[1], confidence };
  }
  return {
    progress,
    eta_ms: eta,
    low_ms: eta * spread[0],
    high_ms: eta * spread[1],
    confidence,
    basis: `${completed.length}/${n} plan items done, ~${fmt(perItem)} per item`,
    overdue,
  };
}

function historyEstimate(s: EstimateInput, now: number): Estimate {
  if (s.turn_started_at == null) return none("Working");
  const elapsed = now - s.turn_started_at;
  const hist = [...s.history_ms].filter((x) => x > 0).sort((a, b) => a - b);
  const enough = hist.length >= 3;
  const p25 = enough ? quantile(hist, 0.25) : DEFAULT_TURN_MS * 0.4;
  const p50 = enough ? quantile(hist, 0.5) : DEFAULT_TURN_MS;
  const p80 = enough ? quantile(hist, 0.8) : DEFAULT_TURN_MS * 2.5;

  let eta: number, low: number, high: number, overdue = false;
  if (elapsed < p50) {
    eta = p50 - elapsed;
    low = Math.max(0, p25 - elapsed);
    high = p80 - elapsed;
  } else if (elapsed < p80) {
    eta = (p80 - elapsed) * 0.6;
    low = 0;
    high = p80 - elapsed + (p80 - p50);
  } else {
    // Past the 80th percentile: long turns tend to keep going (Lindy-style guess).
    overdue = true;
    eta = elapsed * 0.35;
    low = elapsed * 0.1;
    high = elapsed;
  }
  const basis = enough ? `Typical turn ~${fmt(p50)} (from ${hist.length} past turns)` : "Rough guess — not much history yet";
  if (s.status === "waiting") {
    return { ...none("Paused — waiting on you", elapsed / (elapsed + eta)), eta_ms: eta, low_ms: low, high_ms: high, confidence: "low" };
  }
  return { progress: elapsed / (elapsed + eta), eta_ms: eta, low_ms: low, high_ms: high, confidence: "low", basis, overdue };
}

export function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
