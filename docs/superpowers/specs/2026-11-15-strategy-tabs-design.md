# Strategy tabs: five strategies plus a results tab

Date: 2026-11-15. Status: draft for approval.

## Intent and why

The end goal is a bot the owner can trust with real money. The data so far (11 simulated games, Polymarket):

- Liquidity rewards are almost all of the steady profit. Jev's directional edge over the plain rule bot is not proven: its hit rate is 55% (range 51-58%) vs 52% (range 49-56%).
- The biggest swings come from holding inventory when a game settles (Texas vs LSU +$640, Louisville -$209). Those are luck, not edge.
- The no-reward game lost about $21 per bot. The bots also sit idle when no live game has a reward pool, for example after 11:30 pm.

So this build runs several candidate strategies side by side in dry-run, scores them on the same terms, and shows which one, if any, has earned real money. A results tab explains it in plain English, for quant interviews.

## Goals

1. Strategy tabs in the existing Tauri app, top row: **Reward farmer · Long-dated · Odds-anchored · Kalshi MM · Gap logger · Jev · Results**, with game tabs under each trading strategy.
2. Every trading strategy runs on the existing engine (`src/trader.ts`) in dry-run, using real market data and simulated fills.
3. One scoring path: `compare.ts --all` groups by strategy, and the Results tab reads the same numbers.
4. Results tab: per strategy, net $ with a range across sessions, the split between rewards, spread and settlement, hit rate, and a **go-live checklist** that is checked automatically against the owner's rules.
5. An on/off switch per strategy, in the app menu and in an env var, so the Mac isn't running every bot when it doesn't need to.

## Non-goals

- **No live order placement.** The prediction-market venues have no live order code today, and this build adds none. Going live is a separate, later project that the owner starts by hand.
- No new venues beyond Polymarket and Kalshi.
- No parameter auto-tuning (replay sweeps stay a manual script).

## Anti-goals (a failure even if it runs)

- Results that make a strategy look profitable because of one lucky settlement. Settlement P&L must be shown separately, and the go-live check must require an edge across multiple sessions.
- Any path that can post a real order or read a private key.
- Hiding Jev's model cost or Kalshi fees from net $.

## Constraints

- **Owner's risk rules** (Notion task): dry-run until the comparison shows an edge across multiple sessions. If it ever goes live: tiny capital, max position, daily loss limit, kill switch. Treat community performance claims as marketing.
- **Existing stack:** Bun, the TypeScript bot (`src/`), `scripts/duo.ts` runner, Next 16 dashboard (`web/`), Tauri shell (`app/`). Ponytail: minimal code, reuse the engine.
- **Odds-anchored** needs a the-odds-api.com key (free tier, 500 requests/month). The owner signs up and enters it through the local UI, the same way the TypeSafe key is entered. At 500 requests per month, poll odds about every 10 min per game, not every tick.
- **Kalshi:** public market data needs no auth. Maker fee about 0.0175·p·(1-p) (already in config). Whether Kalshi currently runs a liquidity incentive program is unverified.
- **Real-money access is unverified.** Can the owner (Maryland, US) trade on Polymarket's main exchange or only Polymarket US? Are Kalshi sports contracts available in Maryland? The Results tab lists both as manual checks on the go-live checklist. They decide which strategy can go live, so they're shown, not assumed.
- No automatic git commits.

## Approaches

- **A. One engine, strategy tabs (picked).** Each strategy is a `STRATEGY` value with its own port range and `RUN_NAME` prefix, run by `duo`. One dashboard and one scorer. Trade-off: more processes (about 2 per strategy per game), handled by the on/off switch.
- B. Separate mini-apps per strategy. Simpler per piece, but no side-by-side scoring and five windows. Rejected.
- C. One bot process that runs every strategy internally on a shared book feed. Fewer processes, but a big rewrite of `trader.ts`, and one crash takes every strategy down. Rejected for now. Revisit if process count becomes a problem.

## Strategies

| Tab | What it does | Market picker | Model |
|---|---|---|---|
| Reward farmer | Two-sided quotes at reward min size to farm the pool. **Flattens and stops quoting before settlement**: no new risk in the final stretch, then exits inventory at the touch. | live game with the most expected reward $/h (existing picker) | none (p = 0.5, inventory skew only) |
| Long-dated | Same as Reward farmer | non-game markets (politics, econ, crypto) with a reward pool, end date at least 7 days out, ranked by expected $/h | none |
| Odds-anchored | Reward farmer, with the reservation price leaning toward the sportsbook consensus price (vig removed). Reuses the `fair()` / FAIR_WEIGHT path. | same as Reward farmer, only games the odds API covers | sportsbook fair value |
| Kalshi MM | Two-sided spread capture on Kalshi games, fees included. Flattens before settlement. | live Kalshi game market with the most volume | none |
| Gap logger | Does not trade. For each live game on both venues, logs Polymarket mid, Kalshi mid, and the gap after both venues' fees, and flags gaps that are bigger than the fees. | games matched across venues (existing `kalshiTickers`) | n/a |
| Jev | Today's Jev bot, kept for comparison. **Off by default.** | same as Reward farmer | Jev |

Every trading tab also runs its paired `mock` baseline, as today. The baseline for Reward farmer is the strategy itself, so it runs alone.

"Before settlement": games use the event's live clock where Polymarket gives it, otherwise the scheduled end time. Long-dated markets use end date minus 1 day.

## Results tab

- A table, one row per strategy: sessions, net $ (range across sessions), rewards $, spread $, settlement $, fees and model cost, max drawdown, hit rate.
- **Go-live checklist** per strategy. Each item is a green/red light:
  1. at least 10 sessions
  2. net $ is positive with settlement P&L removed
  3. the low end of the session range is above 0
  4. worst single session is within the daily loss limit
  5. manual: venue access is confirmed for the owner's state
- A plain-English paragraph per strategy, generated from the numbers ("Made $X over N games, mostly from rewards; the range crosses zero, so not proven yet"), for interview talking points.
- The data comes from the same code as `compare.ts --all`, with no second implementation.

## Decided by the owner

- Approach A, all five ideas, Jev kept as a tab, Results tab added, goal = a bot fit for real money.
- **Daily loss limit: $25/day total across all bots.** Checklist item 4 checks the worst calendar day (summed across that strategy's sessions) against it. It is also the limit a future live build must enforce.
- Design approved 2026-11-15 ("25, go for it").

## Calls I made (owner can override)

- Build order: Reward farmer → Long-dated → Gap logger → Odds-anchored → Kalshi MM → Results, each one ending with a working tab.
- Jev off by default, to save TypeSafe cost.
- Go-live thresholds: 10 sessions, and the range must be above zero.
- Default enabled: Reward farmer, Long-dated, Gap logger. Turn on the others as each is built.

## Settled after builder review (my calls)

1. **Settlement $**: inventory still held at the bot's last tick, valued at the real outcome (0 or 1) from Gamma/Kalshi once the market resolves; until then, at the exit mark. The bot logs a `finalPosition` and `finalMark` in its totals. Spread $ = realized - settlement. Flatten strategies should show settlement about 0. That is intended: the split exists to expose luck in Jev/legacy runs.
2. **Session** = one strategy on one game. Each duo slot picks one game, and every enabled Polymarket strategy runs on it under the same stamp (comparable on the same terms). Kalshi MM runs on that game's Kalshi market when `kalshiTickers` maps it, otherwise its own Kalshi pick. Rows in `sessions.jsonl` and run names get a `strategy` field. "10 sessions" = 10 games for that strategy. GAMES stays 2.
3. **Picker**: shared per slot (the existing serialized `pick()`); `played` exclusion stays per slot. Long-dated runs in its own slot.
4. **Flatten**: at `FLATTEN_BEFORE_MS` (default 20 min) before the expected end, cancel quotes, take a simulated taker exit at the touch (cost counts in spread $), then idle until the normal code-10 exit. Expected end = the live clock when Polymarket's events API has one, otherwise gameStartTime plus a per-sport duration (football 3.5 h, basketball and hockey 2.5 h, baseball 3 h, soccer 2 h, other 2 h).
5. **Range for net $**: a 95% t-interval on per-session net. The "low end above 0" check uses that.
6. **Gap logger**: a separate non-trading process writing `data/gaps-<stamp>.jsonl`. Results shows how many gaps beat both venues' fees, their median size and their duration. No go-live checklist for it. Only pro leagues are matched (`kalshiTickers`), so expect few games.
7. **Kalshi fees**: charged on every simulated fill at MAKER_FEE_RATE. Spread $ is net of fees.
8. **Odds-anchored**: the sportsbook price replaces `fair()` for that strategy (no Kalshi blend). One odds API call returns every event in a sport, so poll each active sport every 30 min (about 10-15 calls a day), and match games on team names. A game with no match runs as plain Reward farmer and is tagged so. The key is entered in KeyPanel and stays on the bot side, never in the web bundle.
9. **Results data**: the scorer moves into one module in `src/` that `compare.ts` and a Next route handler both import. The route reads `../data` on the server. The Tauri app already points at the local dev server, so that works.
10. **On/off**: the Bots menu writes `data/strategies.json`. duo reads it before each new pick, so a change applies after the current game, and it persists across launches. The `STRATEGIES` env var overrides it.
11. **Long-dated session** = a 6-hour window, then a code-10 exit and a re-pick (the same market is allowed). REQUIRE_LIVE does not apply.
12. **The old 11 sessions** show in Results as "Legacy (mock/jev)". They don't count toward the new strategies' checklists.

## Left to the builder

- Port layout, env var names, file layout, how duo enables strategies.
- The exact flatten timing, as long as it is a single config knob.
- Dashboard styling, reusing the existing Compare components and CSS.
