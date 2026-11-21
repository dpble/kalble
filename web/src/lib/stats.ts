import type { BlockEvent } from "./types";

export interface LaneStats {
  decisions: number;
  fills: number;
  pnlUsd: number; // position marked at mid
  costUsd: number; // model inference cost estimate
  netUsd: number; // position marked where it could be closed, after fees and model cost
  avgLatencyMs: number;
  late: number;
  /** one call per horizon window (calls inside the same window are not independent) */
  hitRate: number | null;
  /** 95% range for the hit rate */
  ci: [number, number] | null;
  scored: number;
}

/** Same scoring as src/score.ts in the bot repo. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

/** `free`: the mock costs nothing to run, so it is not charged the Jev token estimate. */
export function laneStats(events: BlockEvent[], horizon: number, free = false): LaneStats {
  const byBlock = new Map(events.map((e) => [e.block, e]));
  let hits = 0, scored = 0, lat = 0, n = 0, next = -Infinity;
  for (const e of events) {
    const d = e.decision;
    if (!d || d.late) continue;
    if (!d.reused) { n++; lat += d.latencyMs; } // reused = the model was not asked this tick
    if (e.block < next) continue;
    const later = byBlock.get(e.block + horizon);
    if (!later) continue;
    next = e.block + horizon;
    if (later.mid === e.mid) continue;
    scored++;
    if ((later.mid > e.mid) === (d.probabilities.buy >= 0.5)) hits++;
  }
  const t = events.at(-1)?.totals;
  const pnlUsd = t?.pnlUsd ?? 0, costUsd = free ? 0 : (t?.jevUsd ?? 0);
  return {
    decisions: n, fills: t?.fills ?? 0, pnlUsd, costUsd, netUsd: t?.netUsd ?? pnlUsd - costUsd,
    avgLatencyMs: n ? Math.round(lat / n) : 0, late: t?.lateBlocks ?? 0,
    hitRate: scored ? hits / scored : null, ci: wilson(hits, scored), scored,
  };
}
