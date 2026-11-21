/**
 * How a run is scored. Shared by compare.ts; web/src/lib/stats.ts keeps a copy of hitRate (separate package).
 *
 * Hit rate: one call per horizon window. Calls one tick apart ask about almost the same 30 s, so
 * scoring every tick counts one outcome ~30 times and makes the sample look 30x bigger than it is.
 */

/** Wilson 95% interval for k hits out of n: the range the true hit rate probably sits in. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

interface Ev { block: number; mid: number; decision: { late: boolean; probabilities: { buy: number } } | null }

/** `minEdge` > 0 scores only confident calls (|p(buy) - 0.5| >= minEdge). Flat outcomes are skipped. */
export function hitRate(events: Ev[], H: number, minEdge = 0) {
  const byBlock = new Map(events.map((e) => [e.block, e]));
  let hits = 0, n = 0, flat = 0, next = -Infinity;
  for (const e of events) {
    const d = e.decision;
    if (!d || d.late || e.block < next || Math.abs(d.probabilities.buy - 0.5) < minEdge) continue;
    const later = byBlock.get(e.block + H);
    if (!later) continue;
    next = e.block + H; // the next scored call starts after this window closes
    const move = later.mid - e.mid;
    if (move === 0) { flat++; continue; }
    n++;
    if (move > 0 === d.probabilities.buy >= 0.5) hits++;
  }
  return { hits, n, flat, rate: n ? hits / n : null, ci: wilson(hits, n) };
}

if (import.meta.main) {
  const ev = (block: number, mid: number, buy: number) => ({ block, mid, decision: { late: false, probabilities: { buy } } });
  // windows of 2: calls at 1 (up, right) and 3 (down, wrong) are scored; 2 and 4 overlap and are skipped
  const s = hitRate([ev(1, 0.5, 0.9), ev(2, 0.5, 0.9), ev(3, 0.6, 0.9), ev(4, 0.6, 0.1), ev(5, 0.4, 0.5)], 2);
  console.assert(s.n === 2 && s.hits === 1 && s.flat === 0, "non-overlapping", s);
  console.assert(hitRate([ev(1, 0.5, 0.55), ev(2, 0.6, 0.5)], 1, 0.1).n === 0, "minEdge filters weak calls");
  const ci = wilson(50, 100)!;
  console.assert(ci[0] > 0.40 && ci[0] < 0.41 && ci[1] > 0.59 && ci[1] < 0.60, "wilson", ci);
  console.log("score self-check ok");
}
