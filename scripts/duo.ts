/**
 * bun run duo: runs every enabled strategy, game after game, until Ctrl-C.
 * Per game slot i, strategy k of GAME_STRATEGIES: port 3001 + 10*i + k. Long-dated slots :3051/:3053/:3055 (LONG_SLOTS, default 2),
 * Kalshi MM :3052 (own loop, never on a game slot; it stays in GAME_STRATEGIES only to keep port indices stable), Kalshi LIP slots
 * :3061-:3062 (LIP_SLOTS, default 2), Polymarket US slots :3071-:3072 (US_SLOTS, default 2), gaps :3090, results :3099, dashboard :3000.
 * Loss budgets: each long-dated bot LONG_BUDGET ($8), each LIP bot LIP_BUDGET ($4.50) of jump-to-resolution loss, so the slots
 * together stay inside the $25 day (2 x 8 + 2 x 4.50). Many small independent risks, not one big one.
 * Which strategies run: data/strategies.json (created with defaults, re-read before every pick) or STRATEGIES=farmer,odds,gaps.
 * A game slot ends when its anchor (the farmer, else the first enabled strategy) exits; the rest are killed and the slot re-picks.
 * Toggling a strategy off never kills a running bot, it just isn't spawned on the next pick.
 * No live game: the slot waits 5 min and looks again. GAMES=2 (default) game slots at once.
 * Daily loss limit (DAILY_LOSS_USD, default $25) is TOTAL across every bot: duo sums each bot's trading P&L (net without
 * estimated rewards) for the day, finished sessions included. Past the limit it halts every bot (they exit their positions)
 * and starts nothing new until local midnight.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { VenueMarket } from "../src/venues";
import { sportKey } from "../src/odds";

export const GAME_STRATEGIES = ["farmer", "odds", "kalshi", "jev"] as const;
export const port = (i: number, k: number) => 3001 + 10 * i + k;
const KALSHI_PORT = 3052;
export const longPort = (j: number) => 3051 + 2 * j, lipPort = (j: number) => 3061 + j, usPort = (j: number) => 3071 + j;
const LONG_SLOTS = Number(process.env.LONG_SLOTS ?? 2), LIP_SLOTS = Number(process.env.LIP_SLOTS ?? 2), US_SLOTS = Number(process.env.US_SLOTS ?? 2);
const LONG_BUDGET = Number(process.env.LONG_BUDGET ?? 8), LIP_BUDGET = Number(process.env.LIP_BUDGET ?? 4.5), US_BUDGET = Number(process.env.US_BUDGET ?? 4.5);
const REWARD_DEPTH = process.env.REWARD_DEPTH ?? "0.5";
// Games are off by default: their reward pools need 1,000 shares, which no $25 day can carry (see profit-ideas.md).
// Kalshi LIP off by default (2026-11-21): its sessions spread pennies over many markets and Kalshi pays nothing under $1 a market; polyus takes its budget.
const DEFAULTS: Record<string, boolean> = { farmer: false, odds: false, kalshi: false, jev: false, longdated: true, lip: false, polyus: true, gaps: true };

/** Enabled strategies. Missing file is created with the defaults; STRATEGIES env wins. */
function enabled(): Record<string, boolean> {
  if (process.env.STRATEGIES) { const on = process.env.STRATEGIES.split(","); return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, on.includes(k)])); }
  if (!existsSync("data/strategies.json")) writeFileSync("data/strategies.json", JSON.stringify(DEFAULTS, null, 2) + "\n");
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync("data/strategies.json", "utf8")) }; } catch { return DEFAULTS; }
}

/** Per-strategy bot env. */
function childEnv(s: string, stamp: string, p: number, marketId?: string): Record<string, string> {
  const venue = s === "kalshi" || s === "lip" ? "kalshi" : s === "polyus" ? "polyus" : "polymarket";
  const e: Record<string, string> = { ...(process.env as Record<string, string>), VENUE: venue, MODEL: "flat", STRATEGY: s, PORT: String(p), RUN_NAME: `${venue}-${s}-${stamp}`, REQUIRE_LIVE: "1" };
  for (const k of ["FAIR_SOURCE", "FAIR_WEIGHT", "RECORD", "REWARD_SIZING"]) delete e[k];
  delete e.MARKET_KIND; delete e.MARKET_ID; delete e.REQUIRE_REWARDS; delete e.EXCLUDE_IDS; delete e.SESSION_MS; delete e.MAX_LOSS_USD; delete e.REWARD_DEPTH;
  delete e.PRIVATE_KEY; e.DRY_RUN = "true"; // never a live bot from here
  e.FAIR_WEIGHT = "0"; // only Odds-anchored leans toward a fair price; the rest must not quietly lean toward Kalshi
  if (venue === "polymarket") { e.REQUIRE_REWARDS = "1"; e.REWARD_SIZING = "1"; }
  if (s === "farmer") e.RECORD = `data/rec-${stamp}.jsonl`;
  if (s === "odds") { e.FAIR_SOURCE = "odds"; e.FAIR_WEIGHT = "0.5"; }
  if (s === "jev") e.MODEL = "jev";
  if (s === "longdated") { e.MARKET_KIND = "long"; e.SESSION_MS = "21600000"; e.MAX_LOSS_USD = String(LONG_BUDGET); e.REWARD_DEPTH = REWARD_DEPTH; }
  // Kalshi LIP: join the touch (full credit), as many contracts as the budget allows, makers pay no fee on the series the picker takes
  if (s === "lip") { e.MARKET_KIND = "lip"; e.SESSION_MS = "21600000"; e.MAX_LOSS_USD = String(LIP_BUDGET); e.TRADE_SIZE_MON = "1000"; e.QUOTE_INSIDE_TICKS = "0"; e.MAKER_FEE_RATE = "0"; }
  // Polymarket US: LIP sizing, one tick inside the touch (see rewardPerHour); the session ends at the day's pool end (ET midnight), set by the venue
  if (s === "polyus") { e.MAX_LOSS_USD = String(US_BUDGET); e.TRADE_SIZE_MON = "1000"; e.QUOTE_INSIDE_TICKS = "1"; e.MAKER_FEE_RATE = "0"; }
  if (marketId) e.MARKET_ID = marketId;
  return e;
}

/** Strategies to spawn on this game: Odds-anchored only where the odds feed covers the sport. */
const gameStrategies = (on: string[], slug: string) => on.filter((s) => s !== "odds" || sportKey(slug) !== null);

if (process.argv.includes("--check")) {
  console.assert(port(0, 0) === 3001 && port(1, 3) === 3014 && longPort(0) === 3051 && longPort(1) === 3053 && KALSHI_PORT === 3052 && lipPort(0) === 3061, "ports");
  const l = childEnv("lip", "x", 3061, "T1");
  console.assert(l.VENUE === "kalshi" && l.MARKET_KIND === "lip" && l.MAX_LOSS_USD === "4.5" && l.QUOTE_INSIDE_TICKS === "0" && l.MAKER_FEE_RATE === "0" && l.RUN_NAME === "kalshi-lip-x" && !l.REQUIRE_REWARDS, "lip env", l);
  console.assert(childEnv("longdated", "x", 3051).MAX_LOSS_USD === "8" && childEnv("longdated", "x", 3051).REWARD_DEPTH === "0.5" && !childEnv("farmer", "x", 3001).MAX_LOSS_USD, "budgets per strategy");
  console.assert(LONG_SLOTS * LONG_BUDGET + US_SLOTS * US_BUDGET <= 25, "default slot budgets fit the $25 day (LIP is off by default; the daily guard caps the total anyway)");
  const u = childEnv("polyus", "x", 3071);
  console.assert(u.VENUE === "polyus" && u.MAX_LOSS_USD === "4.5" && u.QUOTE_INSIDE_TICKS === "1" && u.RUN_NAME === "polyus-polyus-x" && !u.REQUIRE_REWARDS && !u.SESSION_MS && usPort(0) === 3071, "polyus env", u);
  const e = childEnv("odds", "x", 3002, "m1");
  console.assert(e.STRATEGY === "odds" && e.FAIR_SOURCE === "odds" && e.MARKET_ID === "m1" && e.RUN_NAME === "polymarket-odds-x" && e.REQUIRE_REWARDS === "1", "odds env", e);
  const k = childEnv("kalshi", "x", 3003);
  console.assert(k.VENUE === "kalshi" && !k.MARKET_ID && !k.REQUIRE_REWARDS && !k.REWARD_SIZING, "kalshi env", k);
  console.assert(childEnv("longdated", "x", 3051).SESSION_MS === "21600000" && childEnv("jev", "x", 1).MODEL === "jev", "long/jev env");
  process.env.PRIVATE_KEY = "0xdead"; process.env.FAIR_WEIGHT = "0.9";
  for (const s of ["farmer", "odds", "kalshi", "jev", "longdated", "lip", "polyus"]) {
    const c = childEnv(s, "x", 1);
    console.assert(c.FAIR_WEIGHT === (s === "odds" ? "0.5" : "0"), "FAIR_WEIGHT 0 except odds", s, c.FAIR_WEIGHT);
    console.assert(!("PRIVATE_KEY" in c) && c.DRY_RUN === "true", "no key, dry run", s);
  }
  delete process.env.PRIVATE_KEY; delete process.env.FAIR_WEIGHT;
  console.assert(dayTotal(-20, [3, -9]) === -26 && dayTotal(0, []) === 0, "daily total sums finished and running bots");
  console.assert(gameStrategies(["farmer", "odds"], "cfb-mich-msu-2026-11-14").join() === "farmer,odds" && gameStrategies(["farmer", "odds"], "lol-blg-gen-2026-11-14").join() === "farmer", "odds only on games the odds feed covers");
  console.log("duo self-check ok");
  process.exit(0);
}

const fixed = process.env.MARKET_ID; // set = play just that market once
const games = fixed ? 1 : Math.max(1, Number(process.env.GAMES ?? 2));
const played: string[] = [], kalshiPlayed: string[] = []; // game markets played or being played: no two slots on the same game
const inUse: string[] = []; // long-dated / LIP markets (and Kalshi events) running now: no two slots on the same one
mkdirSync("data", { recursive: true });
enabled(); // writes the defaults file on first run

const spawn = (cmd: string[], opts: Record<string, unknown> = {}) => Bun.spawn(cmd, { stdout: "ignore", stderr: "inherit", ...opts });
const web = spawn(["bun", "run", "dev", "--port", "3000"], { cwd: "web" });
const bots = new Set<ReturnType<typeof Bun.spawn>>();
const stop = () => { for (const p of [...bots, web]) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
setInterval(() => guard().catch(() => {}), 10_000);
const results = spawn(["bun", "run", "scripts/results.ts"], { env: { ...process.env, PORT: "3099" } }); bots.add(results);
if (enabled().gaps) bots.add(spawn(["bun", "run", "scripts/gaps.ts"], { env: { ...process.env, PORT: "3090" } }));
console.log(`dashboard http://localhost:3000 · ${games} game(s) at once · strategies ${JSON.stringify(enabled())}`);

// Picking is one at a time, so two slots never grab the same game and stamps never collide.
let picking: Promise<unknown> = Promise.resolve();
let lastStamp = "";
const now = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
function pick(kind: "game" | "long" | "kalshi" | "lip" | "polyus" = "game"): Promise<{ m: VenueMarket; stamp: string } | null> {
  const next = picking.then(async () => {
    const long = kind === "long";
    Object.assign(process.env, { VENUE: kind === "kalshi" || kind === "lip" ? "kalshi" : kind === "polyus" ? "polyus" : "polymarket", EXCLUDE_IDS: (kind === "game" ? played : kind === "kalshi" ? kalshiPlayed : inUse).join(",") });
    delete process.env.MAX_LOSS_USD; delete process.env.REWARD_DEPTH; // the picker sizes with the budget of the slot it picks for
    if (kind === "kalshi") { delete process.env.MARKET_KIND; delete process.env.REQUIRE_REWARDS; process.env.REQUIRE_LIVE = "1"; }
    else if (kind === "lip") { process.env.MARKET_KIND = "lip"; process.env.MAX_LOSS_USD = String(LIP_BUDGET); delete process.env.REQUIRE_LIVE; delete process.env.REQUIRE_REWARDS; }
    else if (kind === "polyus") { delete process.env.MARKET_KIND; process.env.MAX_LOSS_USD = String(US_BUDGET); delete process.env.REQUIRE_LIVE; delete process.env.REQUIRE_REWARDS; }
    else if (long) { process.env.MARKET_KIND = "long"; process.env.MAX_LOSS_USD = String(LONG_BUDGET); process.env.REWARD_DEPTH = REWARD_DEPTH; delete process.env.REQUIRE_LIVE; delete process.env.REQUIRE_REWARDS; }
    else { delete process.env.MARKET_KIND; process.env.REQUIRE_LIVE = "1"; process.env.REQUIRE_REWARDS = "1"; }
    const m = new VenueMarket();
    try { await m.init(); } catch (e) { console.log(`no ${{ game: "live game", long: "long-dated market", kalshi: "Kalshi game", lip: "Kalshi LIP market", polyus: "Polymarket US reward market" }[kind]} (${(e as Error).message.split(";")[0]})`); return null; }
    if (kind === "game") played.push(m.marketId); // a long-dated market may be picked again (not added)
    if (kind === "kalshi") kalshiPlayed.push(m.marketId, ...(m.event ? [m.event] : [])); // kalshi() excludes by ticker or event_ticker
    let stamp = now();
    while (stamp <= lastStamp) { await Bun.sleep(1000); stamp = now(); }
    lastStamp = stamp;
    return { m, stamp };
  });
  picking = next;
  return next;
}

// --- Daily total loss guard ---
const DAILY = Number(process.env.DAILY_LOSS_USD ?? 25);
const today = () => new Date().toLocaleDateString("sv");
let day = today(), dayDone = 0, stoppedDay = "";
const lastNet = new Map<number, number>(); // port -> that bot's trading P&L so far (net minus estimated rewards)
/** Day total = finished sessions + running bots. Pure, for the self-check. */
export function dayTotal(done: number, running: Iterable<number>) { return [...running].reduce((a, b) => a + b, done); }
const stoppedToday = () => stoppedDay === today();
async function guard() {
  if (today() !== day) { day = today(); dayDone = 0; }
  await Promise.all([...lastNet.keys()].map(async (p) => {
    const t = (await fetch(`http://localhost:${p}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null) as any)?.latest?.totals;
    if (t) lastNet.set(p, (t.netUsd ?? 0) - (t.rewardsUsd ?? 0));
  }));
  const total = dayTotal(dayDone, lastNet.values());
  if (total < -DAILY && !stoppedToday()) {
    stoppedDay = today();
    console.log(`daily loss limit: $${total.toFixed(2)} today is past -$${DAILY}; halting every bot (positions exit) and starting nothing new until midnight`);
    appendFileSync("data/duo.log", `${new Date().toISOString()} daily loss limit hit: ${total.toFixed(2)}\n`);
  }
  if (stoppedToday()) for (const p of lastNet.keys()) fetch(`http://localhost:${p}/settings`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ halt: true }) }).catch(() => {});
}

async function run(s: string, stamp: string, p: number, marketId?: string) {
  const b = spawn(["bun", "run", "src/index.ts"], { env: childEnv(s, stamp, p, marketId) });
  bots.add(b);
  lastNet.set(p, 0);
  b.exited.then(() => { dayDone += lastNet.get(p) ?? 0; lastNet.delete(p); }); // ponytail: a session that spans midnight counts on the day it ends
  return b;
}

async function slot(i: number) {
  while (true) {
    if (stoppedToday()) { await Bun.sleep(60_000); continue; }
    const on = GAME_STRATEGIES.filter((s) => s !== "kalshi" && enabled()[s]);
    if (!on.length) { await Bun.sleep(30_000); continue; }
    const got = await pick();
    if (!got) { await Bun.sleep(300_000); continue; }
    const { m, stamp } = got;
    const here = gameStrategies(on, m.slug);
    if (!here.length) continue; // only Odds-anchored is on and the odds feed has no such sport; this game is now in `played`, so the next pick moves on
    const entries = here.map((s) => ({ strategy: s, runName: `polymarket-${s}-${stamp}`, venue: "polymarket", marketId: m.marketId, model: s === "jev" ? "jev" : "flat" }));
    appendFileSync("data/sessions.jsonl", JSON.stringify({ stamp, venue: "polymarket", marketId: m.marketId, label: m.label, startedAt: Date.now(), game: i + 1, strategies: entries }) + "\n");
    console.log(`game ${i + 1} · session ${stamp} · ${m.label} · ${here.join(",")}`);
    const procs = await Promise.all(here.map((s) => run(s, stamp, port(i, GAME_STRATEGIES.indexOf(s)), m.marketId)));
    const code = await procs[0]!.exited; // anchor: farmer, else the first enabled
    for (const p of procs) p.kill();
    await Promise.all(procs.map((p) => p.exited)); // free the ports before the next pick
    for (const p of procs) bots.delete(p);
    console.log(`game ${i + 1} · session ${stamp} ended (exit ${code})`);
    if (fixed) stop();
    if (code !== 10) await Bun.sleep(30_000); // crashed rather than finished: back off, then try another game
  }
}

/** One single-market slot (long-dated, Kalshi MM or Kalshi LIP): play a session, then pick again. */
async function marketLoop(kind: "long" | "kalshi" | "lip" | "polyus", s: string, p: number) {
  const venue = kind === "long" ? "polymarket" : kind === "polyus" ? "polyus" : "kalshi", name = { long: "long-dated", kalshi: "kalshi", lip: "kalshi lip", polyus: "polymarket us" }[kind];
  while (true) {
    if (stoppedToday()) { await Bun.sleep(60_000); continue; }
    if (!enabled()[s]) { await Bun.sleep(30_000); continue; }
    const got = await pick(kind);
    if (!got) { await Bun.sleep(kind === "lip" ? 1_800_000 : kind === "polyus" ? 600_000 : 300_000); continue; } // a LIP scan reads ~110 pages: not every 5 min
    const { m, stamp } = got;
    const ids = kind === "kalshi" ? [] : [m.marketId, ...(m.event ? [m.event] : [])]; // Kalshi MM keeps its own played list
    inUse.push(...ids);
    appendFileSync("data/sessions.jsonl", JSON.stringify({ stamp, venue, marketId: m.marketId, label: m.label, startedAt: Date.now(), game: 0, strategies: [{ strategy: s, runName: `${venue}-${s}-${stamp}`, venue, marketId: m.marketId }] }) + "\n");
    console.log(`${name} :${p} · session ${stamp} · ${m.label}`);
    const b = await run(s, stamp, p, m.marketId);
    const code = await b.exited;
    bots.delete(b);
    for (const id of ids) inUse.splice(inUse.indexOf(id), 1);
    console.log(`${name} :${p} · session ${stamp} ended (exit ${code})`);
    if (code !== 10) await Bun.sleep(30_000);
  }
}

await Promise.all([
  ...Array.from({ length: games }, (_, i) => slot(i)),
  ...(fixed ? [] : [
    ...Array.from({ length: LONG_SLOTS }, (_, j) => marketLoop("long", "longdated", longPort(j))),
    marketLoop("kalshi", "kalshi", KALSHI_PORT),
    ...Array.from({ length: LIP_SLOTS }, (_, j) => marketLoop("lip", "lip", lipPort(j))),
    ...Array.from({ length: US_SLOTS }, (_, j) => marketLoop("polyus", "polyus", usPort(j))),
  ]),
]);
