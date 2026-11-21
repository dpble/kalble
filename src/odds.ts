/**
 * Sportsbook fair price for the Odds-anchored strategy (FAIR_SOURCE=odds): the-odds-api.com h2h odds,
 * devigged and averaged over bookmakers. One file cache per sport (data/odds-<sport>.json) shared by every
 * bot process, refreshed at most every 30 min, so the free quota lasts. The key never leaves the server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const TTL_MS = 30 * 60_000, PROBE_MS = 24 * 3600_000, MIN_REMAINING = 50;
const SPORTS: Record<string, string> = { nfl: "americanfootball_nfl", cfb: "americanfootball_ncaaf", nba: "basketball_nba", cbb: "basketball_ncaab", nhl: "icehockey_nhl", mlb: "baseball_mlb" };

export interface OddsEvent { home_team: string; away_team: string; commence_time?: string; bookmakers: { markets: { key: string; outcomes: { name: string; price: number }[] }[] }[] }
interface Cache { at: number; remaining: number | null; events: OddsEvent[] }

export const sportKey = (slug: string) => SPORTS[slug.split("-")[0]!] ?? null;

/** Decimal odds -> implied probabilities that sum to 1. */
export function devig(prices: number[]): number[] {
  const q = prices.map((p) => 1 / p), s = q.reduce((a, b) => a + b, 0);
  return q.map((x) => x / s);
}

/** Mean over bookmakers of the devigged h2h probability for `outcome`: the exact name, else the one name that contains it (either direction). */
export function consensus(event: OddsEvent, outcome: string): number | null {
  const ps: number[] = [];
  for (const b of event.bookmakers) {
    const outs = b.markets.find((m) => m.key === "h2h")?.outcomes;
    if (!outs?.length) continue;
    const p = devig(outs.map((x) => x.price));
    const exact = outs.findIndex((x) => nameMatch(x.name, outcome) === 2), near = outs.flatMap((x, j) => (nameMatch(x.name, outcome) === 1 ? [j] : []));
    const i = exact >= 0 ? exact : near.length === 1 ? near[0]! : -1;
    if (i >= 0) ps.push(p[i]!);
  }
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
/** 2 = same name, 1 = one contains the other, 0 = different teams. */
const nameMatch = (team: string, outcome: string) => { const t = norm(team), o = norm(outcome); return t === o ? 2 : t && o && (t.includes(o) || o.includes(t)) ? 1 : 0; };

/**
 * The one event that is this game: its two teams map one-to-one onto the two outcomes and it starts within a day of the slug date.
 * Returns the event and the event team paired with outcome `a`. Exact name matches win over contains matches; if more than
 * one event still fits, null (never guess a game). When one outcome name contains the other (Texas / Texas Tech), only exact
 * names count, so a lookalike game cannot stand in for the real one.
 */
export function pickEvent(events: OddsEvent[], a: string, b: string, slug: string): { e: OddsEvent; team: string } | null {
  const day = slug.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
  const want = day ? Date.parse(`${day}T12:00:00Z`) : NaN;
  const min = nameMatch(a, b) ? 2 : 1;
  const fits: { e: OddsEvent; team: string; score: number }[] = [];
  for (const e of events) {
    const t = Date.parse(e.commence_time ?? "");
    if (!Number.isFinite(want) || !Number.isFinite(t) || Math.abs(t - want) > 86_400_000) continue;
    const ah = Math.min(nameMatch(e.home_team, a), nameMatch(e.away_team, b)), aa = Math.min(nameMatch(e.home_team, b), nameMatch(e.away_team, a));
    if (ah === aa || Math.max(ah, aa) < min) continue; // both pairings fit equally: cannot tell which team is ours
    fits.push({ e, team: ah > aa ? e.home_team : e.away_team, score: Math.max(ah, aa) });
  }
  const best = fits.filter((f) => f.score === Math.max(0, ...fits.map((x) => x.score)));
  return best.length === 1 ? { e: best[0]!.e, team: best[0]!.team } : null;
}

/** Overridable in the self-check so no test touches the network. */
export const io = { fetch: globalThis.fetch as typeof fetch, dir: "data" };

const envFile = () => process.env.ODDS_ENV_FILE ?? ".env";
/** process.env first, then .env on each call, so a key saved from another bot's panel works without a restart. */
function apiKey(): string | null {
  const k = process.env.ODDS_API_KEY?.trim();
  if (k) return k;
  try { return readFileSync(envFile(), "utf8").match(/^ODDS_API_KEY=(.+)$/m)?.[1]?.trim() || null; } catch { return null; }
}

const cachePath = (sport: string) => `${io.dir}/odds-${sport}.json`;
const readCache = (sport: string): Cache | null => { try { return JSON.parse(readFileSync(cachePath(sport), "utf8")); } catch { return null; } };
const writeCache = (sport: string, c: Cache) => { if (!existsSync(io.dir)) mkdirSync(io.dir, { recursive: true }); writeFileSync(cachePath(sport), JSON.stringify(c)); };

const inflight = new Map<string, Promise<Cache | null>>();
function load(sport: string): Promise<Cache | null> | Cache | null {
  return inflight.get(sport) ?? fetchIfStale(sport);
}
async function fetchIfStale(sport: string): Promise<Cache | null> {
  const c = readCache(sport);
  if (c && Date.now() - c.at < TTL_MS) return c;
  const key = apiKey();
  // quota low: probe at most once a day, so a monthly reset is noticed
  if (!key || (c?.remaining != null && c.remaining < MIN_REMAINING && Date.now() - c.at < PROBE_MS)) return null;
  // ponytail: two processes can both fetch if their caches expire in the same second; costs one extra call
  const run = (async (): Promise<Cache> => {
    try {
      const r = await io.fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds?regions=us&markets=h2h&oddsFormat=decimal&apiKey=${key}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const rem = Number(r.headers.get("x-requests-remaining"));
      const next: Cache = { at: Date.now(), remaining: Number.isFinite(rem) && r.headers.has("x-requests-remaining") ? rem : c?.remaining ?? null, events: (await r.json()) as OddsEvent[] };
      writeCache(sport, next);
      return next;
    } catch {
      const back: Cache = { at: Date.now(), remaining: c?.remaining ?? null, events: c?.events ?? [] }; // back off 30 min, keep the last good odds; the error text can carry the key, so it is dropped
      writeCache(sport, back);
      return back;
    }
  })().finally(() => inflight.delete(sport));
  inflight.set(sport, run);
  return run;
}

/**
 * Consensus sportsbook probability `p` that `outcome` (one of the game's two outcomes) wins the game in `slug`, and `at` = when
 * those odds were fetched (ms epoch). Null: no key, quota low, no unambiguous match, error.
 */
export async function oddsFair(slug: string, outcome: string, other: string): Promise<{ p: number; at: number } | null> {
  const sport = sportKey(slug);
  if (!sport) return null;
  const c = await load(sport);
  const pick = c && pickEvent(c.events, outcome, other, slug);
  if (!pick) return null;
  const p = consensus(pick.e, pick.team); // the event's own spelling of the paired team, so it cannot land on the opponent
  return p === null ? null : { p, at: c.at };
}

if (import.meta.main) {
  console.assert(sportKey("cfb-tex-lsu-2026-11-14") === "americanfootball_ncaaf" && sportKey("lol-a-b-2026-11-14") === null, "sport keys");
  const p = devig([1.8, 2.1]); console.assert(Math.abs(p[0]! + p[1]! - 1) < 1e-9 && p[0]! > p[1]!, "devig");
  const ev = { home_team: "Texas Longhorns", away_team: "LSU Tigers", bookmakers: [{ markets: [{ key: "h2h", outcomes: [{ name: "Texas Longhorns", price: 1.5 }, { name: "LSU Tigers", price: 2.8 }] }] }] };
  console.assert(Math.abs(consensus(ev as any, "Texas")! - (1 / 1.5) / (1 / 1.5 + 1 / 2.8)) < 1e-9, "consensus matches on contains");
  console.assert(consensus(ev as any, "Alabama") === null, "no match: null");
  // RF2: no key = null, no network
  delete process.env.ODDS_API_KEY; console.assert((await oddsFair("cfb-tex-lsu-2026-11-14", "Texas", "LSU")) === null, "no key: null");
  // right game only: Texas A&M / Texas Tech lookalikes, ambiguity, date
  const mk = (home: string, away: string, t: string): OddsEvent => ({ home_team: home, away_team: away, commence_time: t, bookmakers: [{ markets: [{ key: "h2h", outcomes: [{ name: home, price: 1.5 }, { name: away, price: 2.8 }] }] }] });
  const slug = "cfb-tex-ttu-2026-11-14", d = "2026-11-14T20:00:00Z";
  const evs = [mk("Texas A&M Aggies", "LSU Tigers", d), mk("Texas Longhorns", "Texas Tech Red Raiders", d)];
  console.assert(pickEvent(evs, "Texas", "Texas Tech", slug) === null, "names contain each other: contains matches are not enough");
  console.assert(pickEvent([mk("Texas Tech", "Texas A&M", d)], "Texas", "Texas Tech", slug) === null, "only Texas Tech vs Texas A&M: null");
  console.assert(pickEvent([mk("Texas A&M Aggies", "Texas Tech Red Raiders", d), mk("Texas", "Texas Tech", d)], "Texas", "Texas Tech", slug)?.e.home_team === "Texas", "exact beats contains");
  console.assert(pickEvent([mk("Texas Tech", "Texas", d)], "Texas", "Texas Tech", slug)?.team === "Texas", "pairing: team for outcome a");
  const tl = [mk("Texas Longhorns", "LSU Tigers", d)];
  console.assert(pickEvent(tl, "LSU", "Texas", "cfb-lsu-tex-2026-11-14")?.team === "LSU Tigers", "unrelated names: contains still matches");
  console.assert(pickEvent(tl, "LSU", "Texas", "cfb-lsu-tex-2026-11-21") === null, "date mismatch: null");
  console.assert(pickEvent([mk("Texas Longhorns", "LSU Tigers", d)], "Texas", "Texas Tech", slug) === null, "other team must match too");
  // quota: low + young = no call, low + old = one probe (stubbed fetch, temp cache dir)
  io.dir = `${process.env.TMPDIR ?? "/tmp"}/odds-check-${Date.now()}`; process.env.ODDS_API_KEY = "test-key";
  let calls = 0;
  io.fetch = (async () => { calls++; return new Response("[]", { headers: { "x-requests-remaining": "20" } }); }) as unknown as typeof fetch;
  mkdirSync(io.dir, { recursive: true });
  const lowAt = (ageMs: number) => writeCache("americanfootball_ncaaf", { at: Date.now() - ageMs, remaining: 10, events: [] });
  lowAt(2 * 3600_000); await oddsFair(slug, "Texas", "Texas Tech"); console.assert(calls === 0, "low quota, under 24h: no call");
  lowAt(25 * 3600_000); await oddsFair(slug, "Texas", "Texas Tech"); console.assert(calls === 1, "low quota, over 24h: one probe", calls);
  await oddsFair(slug, "Texas", "Texas Tech"); console.assert(calls === 1, "fresh cache after probe: no call");
  // I1: same-name rivalry, Michigan at 1.25: Michigan's chance, not Michigan State's
  const mi: OddsEvent = { home_team: "Michigan State", away_team: "Michigan", commence_time: d, bookmakers: [{ markets: [{ key: "h2h", outcomes: [{ name: "Michigan State", price: 4 }, { name: "Michigan", price: 1.25 }] }] }] };
  const at = Date.now() - 60_000; writeCache("americanfootball_ncaaf", { at, remaining: 400, events: [mi] });
  const f = await oddsFair("cfb-mich-msu-2026-11-14", "Michigan", "Michigan State");
  console.assert(f !== null && Math.abs(f.p - 0.8 / 1.05) < 1e-9 && f.at === at, "Michigan gets Michigan's probability (~0.76) and the cache time", f);
  // D1: a failed refresh keeps the last good odds
  writeCache("americanfootball_ncaaf", { at: Date.now() - TTL_MS - 1, remaining: 400, events: [mi] });
  io.fetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  const kept = await oddsFair("cfb-mich-msu-2026-11-14", "Michigan", "Michigan State");
  console.assert(kept !== null && readCache("americanfootball_ncaaf")!.events.length === 1, "fetch error keeps the cached events", kept);
  console.log("odds self-check ok");
}
