/**
 * Score runs.
 *   bun run compare.ts data/a.jsonl data/b.jsonl [horizon]   two runs, same wall-clock window
 *   bun run compare.ts --all [horizon]                        every duo session in data/, plus all sessions pooled
 *
 * Hit rate counts one call per horizon window (see src/score.ts) and shows a 95% range. If the
 * ranges for mock and Jev overlap, the gap between them could be luck.
 * Net $ = realized + position marked at the price you could actually exit at - fees - model cost.
 */
import { hitRate, wilson } from "./src/score";
import { markout, scoreAll, sinceReset, summarize, window } from "./src/scoreboard";

const args = process.argv.slice(2);
const horizon = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.HORIZON_BLOCKS ?? 30);
const minEdge = Number(process.env.MIN_EDGE ?? 0.1);
const files = args.filter((a) => !/^\d+$/.test(a) && !a.startsWith("--"));

export { sinceReset, markout, window };

export function stats(events: any[], H: number, mock: boolean, fills: any[] = []) {
  let lat = 0, n = 0;
  for (const e of events) if (e.decision && !e.decision.late && !e.decision.reused) { n++; lat += e.decision.latencyMs; }
  const all = hitRate(events, H), sure = hitRate(events, H, minEdge);
  const t = events.at(-1)?.totals ?? {};
  // older logs have no netUsd: fall back to mid-marked P&L minus model cost
  const net = t.netUsd ?? (t.pnlUsd ?? 0) - (mock ? 0 : t.jevUsd ?? 0);
  return {
    decisions: n, late: t.lateBlocks ?? 0, ms: n ? Math.round(lat / n) : 0, fills: t.fills ?? 0,
    net$: +net.toFixed(2), model$: +(mock ? 0 : t.jevUsd ?? 0).toFixed(3), rewards$: +(t.rewardsUsd ?? 0).toFixed(2),
    "markout¢": markout(events, fills.filter((f) => f.block >= (events[0]?.block ?? 0) && f.block <= (events.at(-1)?.block ?? 0)), H),
    hit: fmtHit(all.hits, all.n), [`hit p>${0.5 + minEdge}`]: fmtHit(sure.hits, sure.n),
    _hits: all.hits, _n: all.n, _net: net,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
function fmtHit(k: number, n: number) {
  const ci = wilson(k, n);
  return ci ? `${pct(k / n)} (${pct(ci[0])}-${pct(ci[1])}) n=${n}` : "n=0";
}
const lines = async (f: string) => (await Bun.file(f).text().catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const load = async (f: string) => sinceReset(await lines(f));
const fillsOf = (f: string) => lines(f.replace(/\.jsonl$/, ".fills.jsonl"));
const show = (rows: Record<string, any>) => console.table(Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([c]) => !c.startsWith("_")))])));

if (import.meta.main) {
  if (args.includes("--all")) {
    const scores = await scoreAll("data", horizon);
    if (!scores.length) { console.log("no sessions of 5+ min in data/ yet: run `bun run duo`"); process.exit(0); }
    console.log(`strategy summary (settlement via outcomes where resolved, else exit mark; horizon ${horizon} ticks):`);
    console.table(summarize(scores).map(({ checklist, explain, netRange, hit, ...r }) => ({ ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" && k !== "sessions" ? +v.toFixed(2) : v])), netRange: netRange ? netRange.map((x) => +x.toFixed(2)).join(" to ") : "n/a", hit: hit ? fmtHit(hit.hits, hit.n) : "n/a" })));
    console.log("\nper session:");
    console.table(scores.map((s) => ({ ...s, hit: s.hit ? fmtHit(s.hit.hits, s.hit.n) : "n/a", net: +s.net.toFixed(2), netExSettle: +s.netExSettle.toFixed(2), spread: +s.spread.toFixed(2), settlement: +s.settlement.toFixed(2), rewards: +s.rewards.toFixed(2), maxDrawdown: +s.maxDrawdown.toFixed(2), label: s.label.split(" · ")[1]?.slice(0, 28) ?? "" })));
  } else if (files.length) {
    const w = window(await Promise.all(files.map(load)));
    console.log(`window ${new Date(w.from).toLocaleTimeString()} to ${new Date(w.to).toLocaleTimeString()} (${Math.round((w.to - w.from) / 60000)} min)`);
    const rows: Record<string, any> = {};
    for (const [i, f] of files.entries()) rows[f] = stats(w.runs[i]!, horizon, /mock/.test(f), await fillsOf(f));
    show(rows);
  } else {
    const ev = (block: number, mid: number, buy: number) => ({ block, ts: block, mid, decision: { late: false, latencyMs: 10, probabilities: { buy } }, totals: { blocks: block } });
    console.assert(sinceReset([{ totals: { blocks: 5 } }, { totals: { blocks: 6 } }, { totals: { blocks: 1 } }, { totals: { blocks: 2 } }]).length === 2, "sinceReset");
    const s = stats([ev(1, 0.5, 0.9), ev(2, 0.6, 0.9), ev(3, 0.4, 0.1)], 1, true);
    console.assert(s._n === 2 && s._hits === 1 && s.net$ === 0, "stats", s);
    console.assert(markout([ev(1, 0.5, 0.5), ev(2, 0.53, 0.5)], [{ block: 1, side: "buy", size: 10, price: 0.49 }], 1) === 4, "markout: bought 49c, mid 53c later = +4c");
    console.log("compare self-check ok · usage: bun run compare.ts --all | data/a.jsonl data/b.jsonl [horizon]");
  }
}
