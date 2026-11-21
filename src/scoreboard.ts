/**
 * The one scorer. Scores every session per strategy (compare.ts --all and the results server both use it).
 * Money comes from each run's own logged totals, which are exit-marked: anything held is valued at the price we could
 * sell (long: best bid) or buy back (short: best ask) at, so the cost of exiting is in.
 * Cutoff: the last tick before the market looked decided (final period, game over, bid < 3c or ask > 97c). A bot that
 * flattens exits there itself; one that holds on (Jev, legacy, a crashed run) is judged as if it had exited there.
 *   spread       = realized round trips at the cutoff
 *   inventory    = the position held at the cutoff, marked where it could be closed
 *   netExSettle  = exit-marked net at the cutoff (spread + inventory + rewards - fees - gas - model)
 *   settlement   = luck = everything after the cutoff, through the real outcome once the market resolves
 *   net          = netExSettle + settlement
 */
import { readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { hitRate } from "./score";
import { FINAL_PERIOD } from "./trader";

/** A model swap resets the session (totals go back to 0) but appends to the same file: keep only the last session. */
export function sinceReset(events: any[]) {
  let start = 0;
  for (let i = 1; i < events.length; i++) if ((events[i].totals?.blocks ?? 0) < (events[i - 1].totals?.blocks ?? 0)) start = i;
  return events.slice(start);
}

/** Markout: where the mid went H ticks after each fill, in cents per contract, from our side. Negative = we got picked off. */
export function markout(events: any[], fills: any[], H: number) {
  const mid = new Map(events.map((e) => [e.block, e.mid]));
  let sum = 0, size = 0;
  for (const f of fills) {
    const later = mid.get(f.block + H);
    if (later === undefined) continue;
    sum += (later - f.price) * (f.side === "buy" ? 1 : -1) * f.size * 100; size += f.size;
  }
  return size ? +(sum / size).toFixed(2) : null;
}

/** Same wall-clock window for every run: from the latest start to the earliest end. */
export function window(runs: any[][]) {
  const from = Math.max(...runs.map((r) => r[0]?.ts ?? 0)), to = Math.min(...runs.map((r) => r.at(-1)?.ts ?? Infinity));
  return { from, to, runs: runs.map((r) => r.filter((e) => e.ts >= from && e.ts <= to)) };
}

export interface SessionScore { strategy: string; stamp: string; label: string; day: string; mins: number; end: number; low: number; live: boolean; net: number; netExSettle: number; spread: number; inventory: number; settlement: number; rewards: number; fees: number; model: number; fills: number; hit: { hits: number; n: number } | null; maxDrawdown: number }
export interface StrategySummary { strategy: string; sessions: number; running: number; net: number; netRange: [number, number] | null; netExSettle: number; maxDrawdown: number; spread: number; inventory: number; settlement: number; rewards: number; fees: number; model: number; worstDay: number; hit: { hits: number; n: number } | null; checklist: { label: string; ok: boolean | null }[]; explain: string }

const GAMMA = "https://gamma-api.polymarket.com", KALSHI = "https://api.elections.kalshi.com/trade-api/v2", PMUS = "https://gateway.polymarket.us/v1";

const pending = new Map<string, number>(); // marketId -> do not ask again before
/** 1 / 0 once the market resolved, else null. Resolved answers are cached in <dir>/outcomes.json. Never throws. SETTLE=0 turns it off. */
export async function settlePrice(venue: string, marketId: string, dir = "data"): Promise<0 | 1 | null> {
  if (process.env.SETTLE === "0" || !marketId) return null;
  if ((pending.get(marketId) ?? 0) > Date.now()) return null; // asked recently, not resolved yet
  const cacheFile = `${dir}/outcomes.json`, key = `${venue}:${marketId}`;
  try {
    const cache = JSON.parse(await Bun.file(cacheFile).text().catch(() => "{}"));
    if (cache[key] === 0 || cache[key] === 1) return cache[key];
    let out: 0 | 1 | null = null;
    if (venue === "polyus") {
      const r = await (await fetch(`${PMUS}/markets/${marketId}/settlement`, { signal: AbortSignal.timeout(8000) })).json() as any; // unsettled: {code: 5}
      out = r?.settlement === 1 ? 1 : r?.settlement === 0 ? 0 : null;
    } else if (venue === "kalshi") {
      const r = (await (await fetch(`${KALSHI}/markets/${marketId}`, { signal: AbortSignal.timeout(8000) })).json() as any).market?.result;
      out = r === "yes" ? 1 : r === "no" ? 0 : null;
    } else {
      const m = (await (await fetch(`${GAMMA}/markets?clob_token_ids=${marketId}&closed=true`, { signal: AbortSignal.timeout(8000) })).json() as any)?.[0];
      const p = typeof m?.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m?.outcomePrices;
      out = m?.closed && Number(p?.[0]) === 1 ? 1 : m?.closed && p?.[0] != null && Number(p[0]) === 0 ? 0 : null;
    }
    if (out !== null) await Bun.write(cacheFile, JSON.stringify({ ...cache, [key]: out }, null, 1));
    else pending.set(marketId, Date.now() + 10 * 60_000);
    return out;
  } catch { return null; }
}

const parse = (text: string) => text.trim().split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); // a live bot may be mid-write
const parsed = new Map<string, { key: string; rows: any[] }>(); // file -> rows, reused while its size and mtime are unchanged (logs reach 20+ MB)
export async function lines(f: string) {
  const st = await stat(f).catch(() => null);
  if (!st) return [];
  const key = `${st.size}:${st.mtimeMs}`, hit = parsed.get(f);
  if (hit?.key === key) return hit.rows;
  const rows = parse(await Bun.file(f).text().catch(() => ""));
  parsed.set(f, { key, rows });
  return rows;
}

interface Run { strategy: string; file: string; venue: string; marketId: string; label: string; startedAt?: number; model?: string }

/** Session stamp (UTC) from which Polymarket fills come from the live websocket feed. */
export const FILLS_FIXED = "20261115191000";
/** Strategies that run the flat model (no calls, so no hit rate). */
const FLAT = new Set(["farmer", "longdated", "odds", "odds-unmatched", "kalshi", "lip", "polyus"]);

/**
 * One run's score. `events` = its own full session (money, drawdown); `windowed` = the slice shared with its siblings (hit rate only).
 * `outcome` = 1 / 0 once the market resolved, else null.
 */
/** The market looks decided on this tick. */
const decided = (e: any) => e.game?.ended === true || FINAL_PERIOD.test(String(e.game?.period ?? "").trim()) || e.bestBid < 0.03 || e.bestAsk > 0.97;

export function scoreRun(r: Run, events: any[], windowed: any[], stamp: string, horizon: number, outcome: 0 | 1 | null, now = Date.now()): SessionScore {
  const last = events.at(-1) ?? {};
  // Odds-anchored that never got a sportsbook price traded with no anchor: scored on its own, not as Odds-anchored
  const strategy = r.strategy === "odds" && !events.some((e) => e.fairSource === "odds") ? "odds-unmatched" : r.strategy;
  const flat = FLAT.has(strategy) || r.model === "flat";
  // A bot that flattened made its own exit (its cost is the strategy's); otherwise cut at the last tick before the market looked decided.
  const d = events.some((e) => e.flattened) ? -1 : events.findIndex(decided);
  const cut = d > 0 ? events[d - 1] : last;
  const money = (e: any) => {
    const t = e.totals ?? {}, p = e.position;
    const signed = p?.side === "long" ? p.size : p?.side === "short" ? -p.size : 0;
    const exit = p?.side === "long" ? e.bestBid : e.bestAsk;
    const inventory = signed ? signed * (exit - p.entryPrice) : 0, spread = t.realizedUsd ?? 0, jev = t.jevUsd ?? 0;
    const model = flat || strategy === "legacy-mock" ? 0 : jev; // model cost is ours to decide (legacy mock is free)
    // the logged exit-marked net; old logs without it are rebuilt the same way
    const marked = (t.netUsd ?? spread + inventory + (t.rewardsUsd ?? 0) - (t.feesUsd ?? 0) - (t.gasUsd ?? 0) - jev) + jev - model;
    return { signed, exit, inventory, spread, model, marked };
  };
  const end = money(last), at = money(cut), t = last.totals ?? {};
  const net = end.marked + (end.signed && outcome !== null ? end.signed * (outcome - end.exit) : 0);
  let peak = 0, maxDrawdown = 0, low = 0;
  for (const e of events) { const n = e.totals?.netUsd ?? 0; peak = Math.max(peak, n); low = Math.min(low, n); maxDrawdown = Math.max(maxDrawdown, peak - n); }
  const h = hitRate(windowed, horizon);
  return {
    strategy, stamp, label: r.label, day: new Date(r.startedAt ?? events[0]?.ts ?? 0).toLocaleDateString("sv"), mins: Math.round(((last.ts ?? 0) - (events[0]?.ts ?? 0)) / 60000),
    end: last.ts ?? 0, low, live: now - (last.ts ?? 0) < 180_000, // still logging = still running
    net, netExSettle: at.marked, spread: at.spread, inventory: at.inventory, settlement: net - at.marked, rewards: t.rewardsUsd ?? 0, fees: t.feesUsd ?? 0, model: end.model, fills: t.fills ?? 0,
    hit: flat ? null : { hits: h.hits, n: h.n }, maxDrawdown,
  };
}

/** Slices of one market on one day (long-dated 6 h sessions, a re-picked game) are one session: they are not independent draws. */
export function mergeSlices(ss: SessionScore[]): SessionScore[] {
  const by = new Map<string, SessionScore>();
  const add = ["mins", "net", "netExSettle", "spread", "inventory", "settlement", "rewards", "fees", "model", "fills"] as const;
  for (const s of [...ss].sort((a, b) => a.end - b.end)) {
    const k = `${s.strategy}|${s.label}|${s.day}`, m = by.get(k);
    if (!m) { by.set(k, { ...s, hit: s.hit && { ...s.hit } }); continue; }
    for (const f of add) m[f] += s[f];
    m.low = Math.min(m.low, m.net - s.net + s.low); // the later slice's low, on top of what came before
    m.maxDrawdown = Math.max(m.maxDrawdown, s.maxDrawdown); m.end = s.end; m.live ||= s.live;
    if (m.hit && s.hit) { m.hit.hits += s.hit.hits; m.hit.n += s.hit.n; }
  }
  return [...by.values()];
}

/** Every run of 5+ min, slices of one market-day merged. Money is each run's own; only the hit rate uses the window shared with its siblings. */
export async function scoreAll(dataDir = "data", horizon = 30): Promise<SessionScore[]> {
  const rows = (await lines(`${dataDir}/sessions.jsonl`)) as any[];
  const groups = new Map<string, Run[]>();
  for (const s of rows) {
    if (!s.strategies) continue;
    groups.set(s.stamp, s.strategies.map((x: any) => ({ strategy: x.strategy, file: `${dataDir}/${x.runName}.jsonl`, venue: x.venue, marketId: x.marketId, label: s.label, startedAt: s.startedAt, model: x.model })));
  }
  const legacy = new Map<string, Record<string, string>>(); // "<venue> <stamp>" -> mock|jev -> file
  for (const f of readdirSync(dataDir)) {
    const m = f.match(/^(\w+)-(mock|jev)-(\d+)\.jsonl$/);
    if (m && !groups.has(m[3]!)) legacy.set(`${m[1]} ${m[3]}`, { ...legacy.get(`${m[1]} ${m[3]}`), [m[2]!]: `${dataDir}/${f}` });
  }
  for (const [key, pair] of legacy) {
    if (!pair.mock || !pair.jev) continue; // legacy needs both files
    const [venue, stamp] = key.split(" ") as [string, string], row = rows.find((s) => s.stamp === stamp && !s.strategies);
    const base = { venue, marketId: row?.marketId ?? "", label: row?.label ?? "", startedAt: row?.startedAt };
    groups.set(stamp, [{ ...base, strategy: "legacy-mock", file: pair.mock }, { ...base, strategy: "legacy-jev", file: pair.jev }]);
  }
  const out: SessionScore[] = [];
  for (const [stamp, runs] of [...groups].sort()) {
    const loaded = await Promise.all(runs.map(async (r) => sinceReset(await lines(r.file))));
    const live = runs.map((r, i) => ({ r, ev: loaded[i]! })).filter((x) => x.ev.length);
    if (!live.length) continue;
    const w = window(live.map((x) => x.ev));
    for (const [i, x] of live.entries()) {
      const s = scoreRun(x.r, x.ev, w.runs[i]!, stamp, horizon, await settlePrice(x.r.venue, x.r.marketId, dataDir));
      // Polymarket fills before the live trade feed matched 5-min-stale prints: shown apart, never counted toward go-live
      if (x.r.venue === "polymarket" && stamp < FILLS_FIXED && !s.strategy.startsWith("legacy")) s.strategy = `legacy-${s.strategy}`;
      if (s.mins >= 5) out.push(s); // short runs still count: dropping them hid $446 of legacy losses
    }
  }
  return payoutMinimum(mergeSlices(out));
}

/**
 * Reward programs pay nothing under $1, per market and period: Polymarket US per market per ET day (one merged session),
 * Kalshi LIP per market over its whole program (all its sessions together). A finished group under $1 earns $0 in rewards.
 * A group with a session still running is left alone: it may still get there. ponytail: Kalshi programs are grouped by
 * market only, so two programs on one market would be summed together.
 */
export function payoutMinimum(ss: SessionScore[]): SessionScore[] {
  const key = (s: SessionScore) => (s.strategy === "polyus" ? `${s.label}|${s.day}` : s.strategy === "lip" ? s.label : null);
  const groups = new Map<string, SessionScore[]>();
  for (const s of ss) { const k = key(s); if (k) groups.set(`${s.strategy}|${k}`, [...(groups.get(`${s.strategy}|${k}`) ?? []), s]); }
  for (const g of groups.values()) {
    if (g.some((s) => s.live) || g.reduce((a, s) => a + s.rewards, 0) >= 1) continue;
    for (const s of g) { s.net -= s.rewards; s.netExSettle -= s.rewards; s.low = Math.min(s.low, s.net); s.rewards = 0; }
  }
  return ss;
}

const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];

/** 95% t-interval for the mean of per-session nets. Null with fewer than 2 sessions. */
export function tInterval(xs: number[]): [number, number] | null {
  const n = xs.length;
  if (n < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const h = (T95[n - 2] ?? 1.96) * sd / Math.sqrt(n);
  return [mean - h, mean + h];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;

/**
 * Worst point of any day: sessions in end order, each one's lowest net during the run added to what the day had made before it.
 * A live bot would have been stopped at that point, so a later win cannot hide it.
 */
export function worstDay(ss: SessionScore[]) {
  const days = new Map<string, SessionScore[]>();
  for (const s of ss) days.set(s.day, [...(days.get(s.day) ?? []), s]);
  let worst = 0;
  for (const d of days.values()) {
    let cum = 0;
    for (const s of d.sort((a, b) => a.end - b.end)) { worst = Math.min(worst, cum + s.low, cum + s.net); cum += s.net; }
  }
  return worst;
}

export function summarize(all: SessionScore[], dailyLossUsd = 25): StrategySummary[] {
  const by = new Map<string, SessionScore[]>();
  for (const s of all) by.set(s.strategy, [...(by.get(s.strategy) ?? []), s]);
  return [...by].map(([strategy, both]) => {
    const ss = both.filter((s) => !s.live), running = both.length - ss.length; // a session counts once it has finished
    const f = (k: "net" | "netExSettle" | "spread" | "inventory" | "settlement" | "rewards" | "fees" | "model") => sum(ss.map((s) => s[k]));
    const worst = worstDay(ss);
    const netRange = tInterval(ss.map((s) => s.netExSettle)); // the go-live test: settlement luck does not count
    const hs = ss.filter((s) => s.hit), hit = hs.length ? { hits: sum(hs.map((s) => s.hit!.hits)), n: sum(hs.map((s) => s.hit!.n)) } : null;
    const proven = !!netRange && netRange[0] > 0;
    const explain = `Made ${usd(f("net"))} over ${ss.length} finished sessions${running ? ` (${running} still running, not counted)` : ""}: ${usd(f("rewards"))} from rewards, ${usd(f("spread"))} from round-trip spread, ${usd(f("inventory"))} from inventory moves, ${usd(-f("fees"))} fees, ${usd(f("settlement"))} from luck after the market was decided. ` +
      `Without that luck: ${usd(f("netExSettle"))}. ` +
      (netRange ? `The 95% range without luck is ${usd(netRange[0])} to ${usd(netRange[1])} per session, so it is ${proven ? "" : "not yet "}proven. ` : "Too few sessions for a 95% range yet. ") + `Worst point of any day: ${usd(worst)}.`;
    return {
      strategy, sessions: ss.length, running, net: f("net"), netRange, netExSettle: f("netExSettle"), maxDrawdown: Math.max(0, ...ss.map((s) => s.maxDrawdown)), spread: f("spread"), inventory: f("inventory"), settlement: f("settlement"), rewards: f("rewards"), fees: f("fees"), model: f("model"), worstDay: worst, hit,
      checklist: [
        { label: "At least 10 sessions", ok: ss.length >= 10 },
        { label: "Net $ ex-settlement above 0", ok: ss.length ? f("netExSettle") > 0 : null },
        { label: "Low end of 95% range above 0", ok: proven },
        { label: `Worst point of a day no worse than -$${dailyLossUsd}`, ok: ss.length ? worst >= -dailyLossUsd : null },
        { label: "Venue access confirmed by you", ok: null },
      ],
      explain,
    };
  });
}

if (import.meta.main) {
  const ci = tInterval([1, 2, 3])!; console.assert(Math.abs(ci[0] - (2 - 4.303 / Math.sqrt(3))) < 1e-3, "t-interval df=2", ci);
  console.assert(tInterval([5]) === null, "one session: no range");
  let n = 0;
  const s = (strategy: string, day: string, net: number, settlement = 0, low = Math.min(0, net)) => ({ strategy, stamp: day, label: String(n++), day, mins: 60, end: n, low, live: false, net, netExSettle: net - settlement, spread: 0, inventory: 0, settlement, rewards: net - settlement, fees: 0, model: 0, fills: 1, hit: null, maxDrawdown: 0 });
  const [f] = summarize([s("farmer", "2026-11-14", 10), s("farmer", "2026-11-14", -30), s("farmer", "2026-11-15", 4)]);
  console.assert(f!.worstDay === -20 && f!.checklist[3]!.ok === true, "worst day: +10 then -30 bottoms at -20, within -25", f);
  // I10: -162 then +197 the same day: the day ends up, but it went 162 under first
  const [g] = summarize([s("farmer", "2026-11-15", -162.61), s("farmer", "2026-11-15", 196.77)]);
  console.assert(Math.abs(g!.worstDay - -162.61) < 1e-9 && g!.checklist[3]!.ok === false, "a later win does not hide a -$162 session", g);
  // a session that dipped to -40 inside the run and ended at +5 still breaks the limit
  console.assert(worstDay([s("farmer", "d", 5, 0, -40)]) === -40, "intra-session low counts");
  // still running: not counted
  const [r] = summarize([{ ...s("farmer", "d", 50), live: true }, s("farmer", "d", 1)]);
  console.assert(r!.sessions === 1 && r!.running === 1 && r!.net === 1, "running session excluded", r);
  // long-dated slices of one market-day merge into one session
  const m = mergeSlices([{ ...s("longdated", "d", 2), label: "X", end: 1 }, { ...s("longdated", "d", -3), label: "X", end: 2 }, { ...s("longdated", "d", 1), label: "Y" }]);
  console.assert(m.length === 2 && m.find((x) => x.label === "X")!.net === -1, "slices merged", m);
  console.assert(f!.checklist[0]!.ok === false && f!.checklist[4]!.ok === null, "3 sessions < 10; access is manual");
  const [j] = summarize([s("jev", "2026-11-15", 640, 640), s("jev", "2026-11-15", -5)]);
  console.assert(j!.checklist[1]!.ok === false, "a lucky settlement does not pass net ex-settlement");
  // I2: ends long 1000 @ 0.34, exit bid 0.30, resolves YES: the -40 exit-mark loss stays in netExSettle, settlement is the +700 luck
  const run = { strategy: "farmer", file: "", venue: "polymarket", marketId: "m", label: "" };
  const evs = [
    { ts: 0, block: 1, mid: 0.35, bestBid: 0.34, bestAsk: 0.36, decision: null, totals: { netUsd: 0, realizedUsd: 0 } },
    { ts: 600_000, block: 2, mid: 0.31, bestBid: 0.3, bestAsk: 0.32, decision: null, position: { side: "long", size: 1000, entryPrice: 0.34 }, totals: { netUsd: -40 + 2, realizedUsd: 0, rewardsUsd: 2, feesUsd: 0, fills: 1 } },
  ];
  const won = scoreRun(run, evs, evs, "x", 30, 1);
  console.assert(Math.abs(won.netExSettle - -38) < 1e-9 && Math.abs(won.settlement - 700) < 1e-9 && Math.abs(won.net - 662) < 1e-9 && Math.abs(won.inventory - -40) < 1e-9 && won.spread === 0 && won.hit === null && won.mins === 10, "exit-mark loss kept, settlement = luck", won);
  // I8: a run that held into the decided part: everything after the last undecided tick is luck, not strategy
  const held = [...evs, { ts: 1_200_000, block: 3, mid: 0.985, bestBid: 0.98, bestAsk: 0.99, decision: null, game: { period: "Q4" }, position: { side: "long", size: 1000, entryPrice: 0.34 }, totals: { netUsd: 640 + 2, realizedUsd: 0, rewardsUsd: 2, feesUsd: 0, fills: 1 } }];
  const h = scoreRun(run, held, held, "x", 30, 1);
  console.assert(Math.abs(h.netExSettle - -38) < 1e-9 && Math.abs(h.net - 662) < 1e-9 && Math.abs(h.settlement - 700) < 1e-9, "luck after the cutoff is settlement", h);
  const open = scoreRun(run, evs, evs, "x", 30, null);
  console.assert(open.settlement === 0 && Math.abs(open.net - -38) < 1e-9, "unresolved: no settlement", open);
  console.assert(scoreRun({ ...run, strategy: "odds" }, evs, evs, "x", 30, null).strategy === "odds-unmatched", "odds with no sportsbook price is odds-unmatched");
  console.assert(scoreRun({ ...run, strategy: "odds" }, [{ ...evs[0], fairSource: "odds" }, evs[1]], evs, "x", 30, null).strategy === "odds", "matched odds stays odds");
  // checklist item 3 uses per-session netExSettle: big luck cannot prove a strategy
  const lucky = summarize([1, 2, 3].map((i) => s("odds", `2026-11-1${i}`, 300, 305)));
  console.assert(lucky[0]!.checklist[2]!.ok === false && lucky[0]!.netRange![1] < 0, "t-interval on netExSettle", lucky[0]);
  // $1 payout minimum: two US slices of one market-day at $0.40 each pay nothing; a $1.20 day keeps its rewards; a running LIP group is left alone
  const row = (strategy: string, label: string, day: string, rewards: number, live = false) => ({ ...s(strategy, day, rewards), label, live });
  const pm = payoutMinimum([row("polyus", "A", "d1", 0.4), row("polyus", "A", "d1", 0.4), row("polyus", "B", "d1", 1.2), row("lip", "C", "d1", 0.3, true), row("lip", "D", "d1", 0.3), row("lip", "D", "d2", 0.3)]);
  console.assert(pm[0]!.rewards === 0 && pm[0]!.net === 0 && pm[1]!.rewards === 0, "US day under $1: $0", pm[0]);
  console.assert(pm[2]!.rewards === 1.2 && pm[3]!.rewards === 0.3, "US $1.20 day paid; running LIP untouched");
  console.assert(pm[4]!.rewards === 0 && pm[5]!.rewards === 0, "LIP market at $0.60 across days: $0");
  // RF4: legacy rows load without throwing and stay separate
  const all = await scoreAll(process.env.SCORE_DIR ?? "data");
  console.assert(all.every((x) => !x.strategy.startsWith("legacy") || x.stamp < "20261116"), "legacy separate");
  await Bun.write("/tmp/claude-501/torn.jsonl", '{"a":1}\n{"a":');
  console.assert((await lines("/tmp/claude-501/torn.jsonl")).length === 1, "truncated last line is skipped");
  console.log("scoreboard self-check ok");
}
