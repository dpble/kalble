# Strategy tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run five dry-run strategies (Reward farmer, Long-dated, Odds-anchored, Kalshi MM, Jev) plus a non-trading Gap logger side by side, show each in its own dashboard tab, and score them all in a Results tab that includes a go-live checklist.

**Architecture:**
- Every trading strategy is a `STRATEGY` value running on the existing engine (`src/trader.ts`), with one bot process per strategy per game.
- `scripts/duo.ts` runs every enabled strategy on the same picked game. It also starts the gap logger (`scripts/gaps.ts`, port 3090) and a results server (`scripts/results.ts`, port 3099).
- The results server serves numbers from `src/scoreboard.ts`, the single scorer that `compare.ts` also uses.

**Tech Stack:** Bun + TypeScript bot, Next 16 dashboard (`web/`), Tauri 2 shell (`app/`). The tests are Bun self-check scripts, the existing `if (import.meta.main)` + `console.assert` pattern.

**Spec:** `docs/superpowers/specs/2026-11-15-strategy-tabs-design.md`

## Global Constraints

- Dry run only. No code path may post a real order or read `PRIVATE_KEY` for the venues. Polymarket and Kalshi stay public-data only.
- **No git commits.** This is the owner's rule, so the usual commit steps are left out.
- Never use em dashes in UI copy or comments.
- Ponytail: reuse the engine, add no new dependencies (Tauri may use `serde_json`, which it already depends on).
- Daily loss limit `DAILY_LOSS_USD` = 25 (total across bots). The per-session kill switch `MAX_LOSS_USD` stays as it is.
- Go-live checklist thresholds:
  - at least 10 sessions
  - net $ ex-settlement > 0
  - low end of the 95% t-interval on per-session net > 0
  - worst calendar day ≥ -25
  - venue access confirmed by the owner (manual)
- Flatten `FLATTEN_BEFORE_MS` = 1_200_000 (20 min). Sport durations from gameStartTime:
  - football 3.5 h
  - basketball and hockey 2.5 h
  - baseball 3 h
  - soccer 2 h
  - other 2 h
- Long-dated: endDate ≥ now + 7 d, `SESSION_MS` = 21_600_000 (6 h), flatten point = endDate - 1 d.
- Odds API: poll each sport at most every 30 min, with a shared file cache across processes. Stop calling when the `x-requests-remaining` header drops below 50. The key is `ODDS_API_KEY` in `.env` and never reaches the web bundle.
- Kalshi fees: maker `MAKER_FEE_RATE` (0.0175), taker `TAKER_FEE_RATE` (Kalshi 0.07, Polymarket 0), both × p·(1-p) per contract.
- Default enabled strategies: farmer, longdated, gaps. Off: odds, kalshi, jev.
- Typecheck commands:
  - root: `bun web/node_modules/typescript/bin/tsc --noEmit -p .`
  - web: `cd web && bun node_modules/typescript/bin/tsc --noEmit -p .`
  - PATH needs `/opt/homebrew/bin`
- Pass criterion for self-checks: the script prints its `... self-check ok` line and **no** `Assertion failed`.

## Clarifications of the spec (decided while planning)

- **Baseline:** the spec mentions each tab's "paired mock baseline". There is no separate mock bot any more. The Reward farmer on the same game is the baseline for Odds-anchored and Jev. Long-dated and Kalshi MM have no baseline and show a single lane.
- **P&L split:**
  - spread $ = realizedUsd (closed round trips).
  - settlement $ = final position × (settle price - entry), where settle = the resolved outcome (0/1) when known, otherwise the exit mark.
  - net = spread + settlement + rewards - fees - model cost.
  - net ex-settlement = net - settlement.
  - This replaces the spec's "spread = realized - settlement" wording.
- **Results server:** the Results tab fetches from a bot-side Bun server on :3099 instead of a Next route handler. Importing `../src` across the Next package boundary is fragile under Turbopack. "One scorer" still holds.
- **Hit rate** is shown as `n/a` for the flat model, which makes no calls.

## Ports

| what | port |
|---|---|
| game slot i (0-based), strategy k in `GAME_STRATEGIES = ["farmer","odds","kalshi","jev"]` | `3001 + 10*i + k` |
| long-dated bot | 3051 |
| gap logger | 3090 |
| results server | 3099 |
| dashboard | 3000 |

## Review Focus

1. **No live game and no long-dated market at the same time** (for example 4 am): every tab should show "Waiting for a game", Results should still load, and duo must not spin.
2. **Odds API key missing or quota exhausted:** the Odds-anchored bot must run as a plain farmer and be tagged `fairSource: "none"`, never crash or busy-loop on 401/429.
3. **A strategy toggled off mid-game:** its bot keeps running until the game ends, and no new session starts for it. Toggling it back on applies at the next pick.
4. **Old data files** (legacy sessions rows without `strategies`, and `polymarket-mock-*`/`polymarket-jev-*` files): the scorer must load them as Legacy without throwing, and must not mix them into the new strategies.
5. **Flatten when the book is one-sided or empty at the flatten moment:** no exit fill at price 0/1 and no exception. It retries next tick.

Each line has a test in the task that owns it (marked **RF1** to **RF5**).

---

### Task 1: Strategy config, flat model, flatten-before-end

**Files:**
- Modify: `src/config.ts` (new knobs)
- Modify: `src/model.ts` (FlatModel, `createModel` kinds)
- Modify: `src/venues.ts` (`VenueMarket.expectedEnd`, `slug`, sport duration)
- Modify: `src/trader.ts` (flatten branch in `onBlock`/`twoSided`, taker exit fill)
- Modify: `src/index.ts` (pass `STRATEGY` into meta, `SESSION_MS` exit)
- Test: `scripts/quote-check.ts` (append checks), `src/venues.ts` self-check

**Interfaces:**
- Produces:
  - `config.strategy: "farmer" | "longdated" | "odds" | "kalshi" | "jev" | "legacy"` (env `STRATEGY`, default `"legacy"`, which keeps today's behaviour).
  - `config.flatten: boolean` (true for farmer/longdated/odds/kalshi).
  - `config.flattenBeforeMs`, `config.takerFeeRate`, `config.sessionMs: number | null`, `config.dailyLossUsd = 25`.
  - `createModel(kind: "mock" | "jev" | "flat")`.
  - `class FlatModel implements Model { name = "flat" }` returns `probabilities {buy: 0.5, sell: 0.5, hold: 0}`, `inputTokens: 0`, with no sleep.
  - `VenueMarket.expectedEnd: number | null` (ms epoch).
  - `VenueMarket.slug: string` (Polymarket event slug, "" elsewhere).
  - `export function sportHours(slug: string): number`.
  - `Meta.strategy: string`.
  - `BlockEvent.flattened?: true`.
  - The exit fill is logged to `.fills.jsonl` with `taker: true`.

- [ ] **Step 1: Write failing checks** (append to `scripts/quote-check.ts`; set `process.env.TAKER_FEE_RATE = "0.07"` and `process.env.STRATEGY = "farmer"` at the top before the import):
```ts
// flatten: past expectedEnd - flattenBeforeMs, no quotes, and the position exits at the touch as a taker
market.expectedEnd = Date.now() + 60_000; // inside the 20 min window
t.position = { mon: 20, costUsd: 9.6 }; t.mids = [0.5, 0.5]; t.cooldownUntil = 0;
eq(t.twoSided(30, book, 0.5).length, 0, "flatten window: no quotes");
t.flattenTick(30, book);
eq(t.position.mon, 0, "long 20 sold at the bid");
eq(+t.totals.realizedUsd.toFixed(4), 0, "bought 48c avg, sold at 48c bid");
eq(+t.totals.feesUsd.toFixed(4), +(0.07 * 20 * 0.48 * 0.52).toFixed(4), "taker fee charged on the exit");
// RF5: empty side at the flatten moment = no exit, no throw
t.position = { mon: 20, costUsd: 9.6 };
t.flattenTick(31, { bid: 0, ask: 0.52, mid: 0.26 });
eq(t.position.mon, 20, "no bid: hold and retry next tick");
market.expectedEnd = null;
```
and in the `src/venues.ts` self-check:
```ts
console.assert(sportHours("cfb-nw-ohiost-2026-11-14") === 3.5 && sportHours("nba-dal-cle-2026-11-14") === 2.5 && sportHours("lol-blg-gen-2026-11-14") === 2, "sport hours");
```

- [ ] **Step 2: Run them to verify they fail.** Run `bun run scripts/quote-check.ts; bun run src/venues.ts`. Expected: TypeError `t.flattenTick is not a function` / `sportHours is not defined`.

- [ ] **Step 3: Implement.**
  - `sportHours` uses the slug prefix: `nfl|cfb` → 3.5, `nba|cbb|wnba|nhl` → 2.5, `mlb` → 3, `epl|ucl|mls|lal|sea|bun|fl1|uel` → 2, else 2.
  - `expectedEnd`:
    - Polymarket game = Date.parse(gameStartTime) + sportHours(slug)·3.6e6.
    - Polymarket long-dated = Date.parse(endDate) - 86_400_000.
    - Kalshi = Date.parse(expected_expiration_time).
    - Replay = null.
  - Trader:
    - in `onBlock`, for venues: if `config.flatten && vm.expectedEnd && Date.now() > vm.expectedEnd - config.flattenBeforeMs`, call `flattenTick(block, book)` and quote nothing (`quotes = []`), and emit with `flattened: true`.
    - `flattenTick` exits the full position at `book.bid` (long) / `book.ask` (short) when that price is in (0, 1). It goes through `applyFill`, then adds a taker fee of `config.takerFeeRate·size·p·(1-p)` (`applyFill` already adds the maker fee, so subtract that first or pass a flag).
  - `index.ts`: if `config.sessionMs`, `setTimeout(() => process.exit(10), config.sessionMs)`.
  - `createModel`: `"flat"` → FlatModel. The strategy → model mapping lives in duo (Task 5), not here.

- [ ] **Step 4: Run to verify pass.** Run `bun run scripts/quote-check.ts && bun run src/venues.ts && bun run src/score.ts`, then the root typecheck. Expected: `quote-check ok` (or its existing final line), `venues self-check ok`, and no `Assertion failed`.

### Task 2: Long-dated picker

**Files:**
- Modify: `src/venues.ts` (`polymarket()` picker, extract ranking)
- Test: `src/venues.ts` self-check

**Interfaces:**
- Consumes: `rewardPerHour`, `rewardsOf` (existing).
- Produces:
  - `export function isLongDated(m: any, now: number): boolean`: no `gameStartTime` and no `sportsMarketType`, `acceptingOrders`, not decided (`open`), `rewardsOf(m)` non-null, `Date.parse(m.endDate) >= now + 7·86_400_000`.
  - `async function rankByRewardPerHour(cands: any[]): Promise<{ x: any; h: number }[]>` (extracted from the existing picker body).
  - `MARKET_KIND=long` env selects long-dated candidates instead of live games. REQUIRE_LIVE is ignored for it.

- [ ] **Step 1: Write the failing check:**
```ts
const now = Date.parse("2026-11-15T00:00:00Z");
const base = { acceptingOrders: true, bestBid: "0.4", bestAsk: "0.42", rewardsMinSize: 50, rewardsMaxSpread: 3, clobRewards: [{ rewardsDailyRate: 10 }] };
console.assert(isLongDated({ ...base, endDate: "2026-12-31T00:00:00Z" }, now), "long-dated with rewards");
console.assert(!isLongDated({ ...base, endDate: "2026-11-18T00:00:00Z" }, now), "ends in 3 days: no");
console.assert(!isLongDated({ ...base, endDate: "2026-12-31T00:00:00Z", sportsMarketType: "moneyline" }, now), "a game: no");
console.assert(!isLongDated({ ...base, endDate: "2026-12-31T00:00:00Z", clobRewards: [] }, now), "no pool: no");
```
- [ ] **Step 2:** `bun run src/venues.ts`. Expected: fail with `isLongDated is not defined`.
- [ ] **Step 3:** Implement as in Interfaces. With `MARKET_KIND=long`, fetch Gamma `markets?active=true&closed=false&order=volume24hr&ascending=false&limit=500`, keep `isLongDated`, take the top 10 by pool, rank with `rankByRewardPerHour`, and pick the first that isn't `excluded`. The label gets the prefix `polymarket · long · `.
- [ ] **Step 4:** Run `bun run src/venues.ts`, then a live smoke: `MARKET_KIND=long VENUE=polymarket bun -e 'const {VenueMarket}=await import("./src/venues"); const m=new VenueMarket(); await m.init(); console.log(m.label, new Date(m.expectedEnd!))'`. Expected: the self-check is ok, and the smoke prints a non-sports market with an end date at least 6 days out (or the error "no ... market found" if none exists, which is acceptable).

### Task 3: Sportsbook fair price (Odds-anchored)

**Files:**
- Create: `src/odds.ts`
- Modify: `src/venues.ts` (polymarket adapter `fair()` picks its source from `FAIR_SOURCE`)
- Modify: `src/server.ts` + `src/index.ts` (`SettingsUpdate.oddsKey`, saved via the existing `saveEnv("ODDS_API_KEY", …)`)
- Modify: `web/src/components/KeyPanel/KeyPanel.tsx` (second field "Odds API key", posts `{ oddsKey }`)
- Test: `src/odds.ts` self-check

**Interfaces:**
- Produces:
  - `export function sportKey(slug: string): string | null` maps:
    - `nfl` → `americanfootball_nfl`
    - `cfb` → `americanfootball_ncaaf`
    - `nba` → `basketball_nba`
    - `cbb` → `basketball_ncaab`
    - `nhl` → `icehockey_nhl`
    - `mlb` → `baseball_mlb`
    - anything else → null
  - `export function devig(prices: number[]): number[]`: decimal odds → implied probabilities normalized to sum 1.
  - `export function consensus(event: OddsEvent, outcome: string): number | null`: the mean over bookmakers of the devigged h2h probability for the team whose name contains `outcome` (case-insensitive, either direction of contains), or null.
  - `export async function oddsFair(slug: string, outcome: string): Promise<number | null>` reads `data/odds-<sport>.json` if it's younger than 30 min. Otherwise it fetches `https://api.the-odds-api.com/v4/sports/<sport>/odds?regions=us&markets=h2h&oddsFormat=decimal&apiKey=…` and writes the cache plus `remaining` from the `x-requests-remaining` header. If the key is missing or `remaining < 50`, it returns null without calling. Any HTTP error returns null and backs off 30 min (write the cache with `events: []`).
  - The key is read from `process.env.ODDS_API_KEY`, falling back to parsing `.env` on each fetch, so a key saved from another bot's panel works without a restart.
  - `FAIR_SOURCE=odds` in the polymarket adapter makes `fair()` call `oddsFair(slug, outcome)` instead of Kalshi. The Meta/sessions row records `fairSource: "odds" | "none"`, where "none" means every call returned null.

- [ ] **Step 1: Write the failing check:**
```ts
console.assert(sportKey("cfb-tex-lsu-2026-11-14") === "americanfootball_ncaaf" && sportKey("lol-a-b-2026-11-14") === null, "sport keys");
const p = devig([1.8, 2.1]); console.assert(Math.abs(p[0]! + p[1]! - 1) < 1e-9 && p[0]! > p[1]!, "devig");
const ev = { home_team: "Texas Longhorns", away_team: "LSU Tigers", bookmakers: [{ markets: [{ key: "h2h", outcomes: [{ name: "Texas Longhorns", price: 1.5 }, { name: "LSU Tigers", price: 2.8 }] }] }] };
console.assert(Math.abs(consensus(ev as any, "Texas")! - (1 / 1.5) / (1 / 1.5 + 1 / 2.8)) < 1e-9, "consensus matches on contains");
console.assert(consensus(ev as any, "Alabama") === null, "no match: null");
// RF2: no key = null, no network
delete process.env.ODDS_API_KEY; console.assert((await oddsFair("cfb-tex-lsu-2026-11-14", "Texas")) === null, "no key: null");
console.log("odds self-check ok");
```
(Run with `ODDS_ENV_FILE=/dev/null` so the `.env` fallback can't find a real key. `oddsFair` reads `process.env.ODDS_ENV_FILE ?? ".env"`.)
- [ ] **Step 2:** `ODDS_ENV_FILE=/dev/null bun run src/odds.ts`. Expected: fails on import (the file doesn't exist).
- [ ] **Step 3:** Implement per Interfaces. KeyPanel shows "saved" and never echoes the key, the same as the TypeSafe field.
- [ ] **Step 4:** Run `ODDS_ENV_FILE=/dev/null bun run src/odds.ts`, then both typechecks. Expected: `odds self-check ok`, and both typechecks are clean.

### Task 4: Gap logger

**Files:**
- Create: `scripts/gaps.ts`
- Modify: `src/venues.ts` (export `liveGames(): Promise<any[]>`, the started moneyline filter the picker already uses, without reward filtering)

**Interfaces:**
- Consumes: `kalshiTickers`, Gamma and the Kalshi endpoints already in `src/venues.ts`.
- Produces:
  - `export function gapAfterFees(poly: { bid: number; ask: number }, kal: { bid: number; ask: number }, polyTaker: number, kalTaker: number): { gap: number; edge: number; dir: "buyPoly" | "buyKalshi" | null }`.
    - `gap` = |polyMid - kalMid|.
    - `edge` = the best of (kal.bid - poly.ask - fees) and (poly.bid - kal.ask - fees), where fees = the sum of each leg's `rate·p·(1-p)`.
    - `dir` is set only when edge > 0.
  - The process loops every 60 s:
    - one row per matched game to `data/gaps-<stamp>.jsonl`: `{ ts, label, polyBid, polyAsk, kalBid, kalAsk, gap, edge, dir }`.
    - `Bun.serve` on `PORT` (default 3090) answers `GET /` with `{ rows: last 200, summary: { games, rowsLogged, feeBeating, medianEdge } }` and CORS `*`.
  - With no matched games, it logs nothing and serves an empty summary.

- [ ] **Step 1: Write the failing check** (`if (import.meta.main && process.argv[2] === "--check")`):
```ts
const a = gapAfterFees({ bid: 0.50, ask: 0.51 }, { bid: 0.55, ask: 0.56 }, 0, 0.07);
console.assert(a.dir === "buyPoly" && Math.abs(a.edge - (0.55 - 0.51 - 0.07 * 0.55 * 0.45)) < 1e-9, "crossed after fees", a);
console.assert(gapAfterFees({ bid: 0.50, ask: 0.51 }, { bid: 0.51, ask: 0.52 }, 0, 0.07).dir === null, "inside fees: no edge");
console.log("gaps self-check ok");
```
- [ ] **Step 2:** `bun run scripts/gaps.ts --check`. Expected: fail (no file).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `bun run scripts/gaps.ts --check`, then `PORT=3090 timeout 75 bun run scripts/gaps.ts & sleep 70; curl -s localhost:3090 | head -c 300`. Expected: `gaps self-check ok`, and JSON with a `summary` key.

### Task 5: Scoreboard (one scorer) and results server

**Files:**
- Create: `src/scoreboard.ts`
- Create: `scripts/results.ts`
- Modify: `compare.ts` (`--all` uses scoreboard; the pair mode and helpers stay)
- Test: `src/scoreboard.ts` self-check

**Interfaces:**
- Consumes: `hitRate`, `wilson` (`src/score.ts`); `sinceReset`, `markout` (move both from `compare.ts` into `scoreboard.ts` and re-export them from `compare.ts`).
- Produces:
  - Sessions rows in `data/sessions.jsonl` (written by Task 6): `{ stamp, venue, marketId, label, startedAt, game, strategies?: { strategy, runName, venue, marketId }[] }`. A row without `strategies` = legacy (files `polymarket-mock-<stamp>` and `polymarket-jev-<stamp>`).
  - `interface SessionScore { strategy: string; stamp: string; label: string; day: string; mins: number; net: number; netExSettle: number; spread: number; settlement: number; rewards: number; fees: number; model: number; fills: number; hit: { hits: number; n: number } | null; maxDrawdown: number }`. `day` is the local YYYY-MM-DD of startedAt. Strategies `legacy-mock` and `legacy-jev` are for old rows.
  - `async function scoreAll(dataDir = "data", horizon = 30): Promise<SessionScore[]>`. It skips runs under 5 min. Settlement uses `settlePrice(venue, marketId)`.
  - `async function settlePrice(venue: string, marketId: string): Promise<0 | 1 | null>`, cached in `data/outcomes.json`:
    - Polymarket: Gamma `markets?clob_token_ids=<id>`, with `closed` and `outcomePrices[0]` → 1 or 0.
    - Kalshi: `markets/<ticker>`, `result` "yes" → 1, "no" → 0.
    - Not resolved yet → null (and don't cache).
  - `function tInterval(xs: number[]): [number, number] | null`: 95% t-interval. The critical-value table covers df 1-30 (12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042), 1.96 above that, null when n < 2.
  - `interface StrategySummary { strategy: string; sessions: number; net: number; netRange: [number, number] | null; netExSettle: number; spread: number; settlement: number; rewards: number; fees: number; model: number; worstDay: number; hit: { hits: number; n: number } | null; checklist: { label: string; ok: boolean | null }[]; explain: string }`.
  - `function summarize(scores: SessionScore[], dailyLossUsd = 25): StrategySummary[]`. The checklist is in the spec's 5-item order. Item 5 has `ok: null` (manual).
  - `explain` is one plain-English paragraph built from the numbers, for example: "Made $X over N games ($R from rewards, $S from spread, $T from positions held at the end). The 95% range is $a to $b, so [it is / it is not yet] proven. Worst day: $W."
  - `scripts/results.ts`: `Bun.serve` on `PORT` (default 3099). `GET /results` returns `{ summaries, sessions, gaps }`, where `gaps` = the summary from `http://localhost:3090/` (null if it's down). CORS `*`. It recomputes at most once per 60 s.

- [ ] **Step 1: Write the failing check:**
```ts
const ci = tInterval([1, 2, 3])!; console.assert(Math.abs(ci[0] - (2 - 4.303 / Math.sqrt(3))) < 1e-3, "t-interval df=2", ci);
console.assert(tInterval([5]) === null, "one session: no range");
const s = (strategy: string, day: string, net: number, settlement = 0) => ({ strategy, stamp: day, label: "", day, mins: 60, net, netExSettle: net - settlement, spread: 0, settlement, rewards: net - settlement, fees: 0, model: 0, fills: 1, hit: null, maxDrawdown: 0 });
const [f] = summarize([s("farmer", "2026-11-14", 10), s("farmer", "2026-11-14", -30), s("farmer", "2026-11-15", 4)]);
console.assert(f!.worstDay === -20 && f!.checklist[3]!.ok === true, "worst day sums the day's sessions: -20 is within -25", f);
console.assert(f!.checklist[0]!.ok === false && f!.checklist[4]!.ok === null, "3 sessions < 10; access is manual");
const [j] = summarize([s("jev", "2026-11-15", 640, 640), s("jev", "2026-11-15", -5)]);
console.assert(j!.checklist[1]!.ok === false, "a lucky settlement does not pass net ex-settlement");
// RF4: legacy rows load without throwing and stay separate
const all = await scoreAll(process.env.SCORE_DIR ?? "data");
console.assert(all.every((x) => !x.strategy.startsWith("legacy") || x.stamp < "20261116"), "legacy separate");
console.log("scoreboard self-check ok");
```
- [ ] **Step 2:** `bun run src/scoreboard.ts`. Expected: fail (no file).
- [ ] **Step 3:** Implement. `compare.ts --all` prints `console.table` of `summarize(await scoreAll())` (dropping `checklist` and `explain`), then the per-session table.
- [ ] **Step 4:** Run `bun run src/scoreboard.ts && bun run compare.ts && bun run compare.ts --all | tail -15`. Expected: `scoreboard self-check ok`, `compare self-check ok`, and the existing 11 games as `legacy-mock` / `legacy-jev` with net totals matching today's pooled table (mock 550.29, jev 744.65) within rounding.

### Task 6: duo runs strategies

**Files:**
- Modify: `scripts/duo.ts` (rewrite slot logic)
- Create on first run: `data/strategies.json`

**Interfaces:**
- Consumes:
  - `STRATEGY`, `FAIR_SOURCE`, `MARKET_KIND`, `SESSION_MS` env (Tasks 1 to 3).
  - `VenueMarket.slug`, `kalshiTickers`.
  - `scripts/gaps.ts`, `scripts/results.ts`.
- Produces:
  - `GAME_STRATEGIES = ["farmer", "odds", "kalshi", "jev"] as const`.
  - Port for game slot i, strategy k = `3001 + 10*i + k`. Long-dated = 3051, gaps = 3090, results = 3099.
  - `function enabled(): Record<string, boolean>` reads `data/strategies.json` (creating it with the defaults if it's missing). The `STRATEGIES=farmer,odds` env overrides it. It's read before every pick.
  - Per strategy, child env:
    - farmer: `VENUE=polymarket MODEL=flat STRATEGY=farmer REWARD_SIZING=1`
    - odds: the same plus `STRATEGY=odds FAIR_SOURCE=odds FAIR_WEIGHT=0.5`
    - jev: `MODEL=jev STRATEGY=jev REWARD_SIZING=1`, with flatten off
    - kalshi: `VENUE=kalshi MODEL=flat STRATEGY=kalshi`, plus `MARKET_ID=<first kalshiTickers(slug) that exists>` when the game maps; otherwise no MARKET_ID (its own pick, with `EXCLUDE_IDS` per slot)
    - longdated: `VENUE=polymarket MARKET_KIND=long MODEL=flat STRATEGY=longdated REWARD_SIZING=1 SESSION_MS=21600000`
  - `RUN_NAME=<venue>-<strategy>-<stamp>`. The farmer records `RECORD=data/rec-<stamp>.jsonl`.
  - The sessions.jsonl row has `strategies: [{ strategy, runName, venue, marketId }]`, and odds also has `fairSource`.
  - A game slot ends when the **farmer** exits. The other strategies on that slot are killed at that point, and the slot picks again. (If the farmer is disabled, the first enabled strategy plays that role.)
  - Long-dated runs as its own loop with its own `played` list. A re-pick of the same market is allowed (don't add it to `played`).
  - duo spawns `gaps.ts` (if enabled) and `results.ts` once and kills them on stop.
  - RF1: with no game, the slot sleeps 300 s (as today). Long-dated with no market sleeps 300 s. results.ts runs regardless.
  - RF3: toggling a strategy off doesn't kill a running bot. It's simply not spawned on the next pick.

- [ ] **Step 1: Smoke test (process wiring has no unit test; this run is the check).** Run `STRATEGIES=farmer,longdated,gaps GAMES=1 timeout 120 bun run duo 2>&1 | tail -20` in the background, and after 90 s run `curl -s -o /dev/null -w "%{http_code} " localhost:3001 localhost:3051 localhost:3090 localhost:3099/results`. Expected: before the change, 3051/3090/3099 are refused (000).
- [ ] **Step 2:** Implement per Interfaces.
- [ ] **Step 3:** Rerun Step 1. Expected:
  - `200` for 3001 (if a live reward game exists; otherwise duo logs "no live game"), 3051, 3090 and 3099.
  - `tail -1 data/sessions.jsonl` shows `strategies` with farmer.
  - After the run, `bun run src/scoreboard.ts` still passes.
- [ ] **Step 4:** RF3 check. Write `{"farmer":true,"longdated":false,"gaps":true}` to `data/strategies.json` while the duo is running, and confirm `curl localhost:3051` still answers until the long-dated session ends (the bot isn't killed).

### Task 7: Dashboard strategy tabs, Gaps and Results pages

**Files:**
- Modify: `web/src/lib/config.ts`: replace `apiFor(game)` with `apiFor(slot: number, strategy: Strategy): { base: string; test: string | null }`. `base` = the farmer on the slot. `test` = the strategy's port, or null for farmer.
  - Long-dated: `{ base: :3051, test: null }`.
  - Kalshi: `{ base: kalshi port, test: null }`.
  - Export `STRATEGIES: { id: Strategy | "gaps" | "results"; label: string }[]` in tab order: Reward farmer, Long-dated, Odds-anchored, Kalshi MM, Gap logger, Jev, Results.
  - Export `GAPS_URL = "http://localhost:3090"` and `RESULTS_URL = "http://localhost:3099/results"`.
- Create: `web/src/components/StrategyTabs/StrategyTabs.tsx` (+ module CSS reusing `.game`/`.gameOn` styles). Links are `/compare?s=<id>&game=<n>`, `/gaps` and `/results`.
- Modify: `web/src/components/Compare/Compare.tsx`:
  - props `{ slot, strategy }`.
  - lanes = `base` labelled "Reward farmer", plus `test` labelled with the strategy name when non-null.
  - with `test` null, render one lane (the second column hidden), with no "different markets" warning.
  - keep the game tabs, except on Long-dated (one slot).
  - the kill switch posts to every lane shown.
- Modify: `web/src/app/compare/page.tsx`: read `s` (default `farmer`) and `game`.
- Create: `web/src/app/gaps/page.tsx` (client):
  - polls `GAPS_URL` every 10 s.
  - shows the summary line (games watched, rows, fee-beating gaps, median edge in cents) and a table of the last 50 rows.
  - shows "Gap logger is off or starting" when it can't reach the logger.
- Create: `web/src/app/results/page.tsx` (client):
  - polls `RESULTS_URL` every 60 s.
  - one card per strategy: net $, range, the split (rewards / spread / settlement / fees / model), worst day, hit rate or `n/a`.
  - the checklist as ✓ / ✗ / "check yourself" for `ok: null`, then the `explain` paragraph.
  - Legacy cards last, greyed.
  - a gaps summary card.
- Modify: `web/src/components/LiveView/ErrorBanner.tsx` only if a strategy-specific waiting text is needed. The current "Waiting for a game" copy already covers it.

- [ ] **Step 1:** Run the web typecheck. Expected: errors where `apiFor(slot)` is called with one argument (proves the call sites are found).
- [ ] **Step 2:** Implement per Files.
- [ ] **Step 3:** Run the web typecheck, then, with duo running from Task 6, `for p in "compare?s=farmer" "compare?s=odds&game=2" "compare?s=longdated" gaps results; do curl -s -o /dev/null -w "%{http_code} " "localhost:3000/$p"; done`. Expected: a clean typecheck and `200 200 200 200 200`.
- [ ] **Step 4:** Visual check in the Tauri window (Cmd+R):
  - the tab row shows all 7 tabs.
  - Results shows the legacy cards, with the checklist rendering "check yourself" on item 5.
  - Gaps shows the off/starting text or a table.

### Task 8: Tauri menu toggles and rebuild

**Files:**
- Modify: `app/src-tauri/src/main.rs`
- Modify: `app/src-tauri/Cargo.toml` (`serde_json = "1"`)
- Modify: `app/dist/index.html` (redirect to `/compare?s=farmer`)

**Interfaces:**
- Consumes: the `data/strategies.json` schema from Task 6 (`Record<string, boolean>`, keys farmer, longdated, odds, kalshi, jev, gaps).
- Produces:
  - Bots menu gets a "Strategies" submenu of `CheckMenuItemBuilder` items, ids `strat:<key>`, checked state read from the file at startup.
  - Toggling rewrites the file (create it with the defaults if it's missing) and shows nothing else. The change applies at the next pick, as the spec says.
  - The `halt` loop covers ports 3001..=3060.

- [ ] **Step 1:** Run `cd app/src-tauri && cargo check`. Expected: passes before the change (baseline).
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `cd app && bun run build`, then copy `src-tauri/target/release/bundle/macos/Jev Trader.app` over `~/Applications/Jev Trader.app`. Open it, untick Long-dated, and run `cat ~/jev-trader/data/strategies.json`. Expected: the build succeeds, and the file shows `"longdated":false`.
- [ ] **Step 4:** Kill switch check. Press Cmd+K in the app, then `curl -s localhost:3001 | grep -o '"halted":[a-z]*'`. Expected: `"halted":true`. Then resume with the menu.
