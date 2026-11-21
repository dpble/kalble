/**
 * Dry-run prediction-market venues (Polymarket, Kalshi) behind the same surface the Trader uses
 * from Market + TradeFeed. Public market data only: nothing is signed, nothing is sent.
 *
 * Everything is priced in the YES contract (0..1 dollars). "block" = one loop tick (TICK_MS).
 * Sizes are contracts; the MON-named config knobs (TRADE_SIZE_MON etc.) are reused as contracts.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { config } from "./config";
import type { Book, Quote, QuoteResult, Side } from "./market";
import type { MakerFill, TradePrint, TradeSummary } from "./trades";
import type { Game } from "./model";
import { oddsFair } from "./odds";

type Level = [price: number, size: number];
interface RawTrade { id: string; ts: number; price: number; size: number; side: Side } // side = taker side on YES

interface Adapter {
  id: string; // MARKET_ID that selects this market again
  label: string;
  tick: number; // price tick in dollars
  levels(): Promise<{ bids: Level[]; asks: Level[] }>; // best first
  trades(sinceSec: number): Promise<RawTrade[]>;
  game?(): Promise<Game | null>; // live score/clock, where the venue has it
  /** Fair price for the same YES outcome (`p`) and when it was observed (`at`, ms epoch); null if unknown or too wide to mean anything. */
  fair?(): Promise<{ p: number; at: number } | null>;
  /** Liquidity rewards on this market: qualifying min size (contracts), max distance from mid (cents), pool per day. */
  rewards?: Rewards | null;
  /** Taker fee rate for this market: fee per contract = rate * p * (1 - p). Undefined = config.takerFeeRate. */
  takerFee?: number;
  /** Re-read the reward pool and fee schedule (they change during a game). */
  refresh?(): Promise<void>;
  /** When the market is expected to be over (ms epoch), or null. */
  expectedEnd?: number | null;
  slug?: string; // Polymarket event slug
  event?: string; // Kalshi event_ticker (both team markets of one game share it)
}
/** Typical game length by slug prefix, in hours. Kept short on purpose: flattening a little early is cheap, holding into the result is not. */
export function sportHours(slug: string): number {
  const s = slug.split("-")[0]!;
  return /^(nfl|cfb)$/.test(s) ? 2.75 : /^(nba|wnba)$/.test(s) ? 2.1 : s === "cbb" ? 1.75 : s === "nhl" ? 2.25 : s === "mlb" ? 2.5 : SOCCER.has(s) ? 1.75 : 1.5;
}
// Polymarket soccer league prefixes (sports tagged "Soccer", id 100350, in gamma /sports as of 2026-11-15).
// ponytail: static list; a new league falls to "other" (1.5 h), which only flattens 15 min earlier
const SOCCER = new Set("acl2 acle afc afcl afcq afwq arg argcopa argpn asean aseanc aseanw aswq atc auc aus aut aze1 aze2 azec bel1 bel2 bl2 bl3 blr1 bol1 bra bra2 bra3 brcm brco bul bun caf cafcl canch canpl ccc ccup cde cdr chfa chi chi1 chi2 chl2 clf cof col col1 col2 con conl copaam cwc cze1 den dfb ecs ecu1 efa efl egy1 el1 el2 elc enl epl ere es2 es3 est1 euc ewq fif fifaw fifwc fin1 fl1 fpd fr2 fro1 frtc geo1 grc gre1 gsc gtm hr1 hun icwq idn1 idn2 ire irl1 isc isl1 isp isr itc itsb j1100 j2100 ja2 ja3 jap kaz1 kor kor2 lal lec lib ltu1 lva1 mar1 mex mex2 mls nawq ncag ned2 nirl1 nlc nln nls nor nor2 nwsl ofc owq par1 per1 pol por pt2 ptc ptsc qat1 rou1 rus saf1 sawq sclc scoc scop sea serc skc slo spl srb ssc sud sui svk1 swe swe2 tha1 tpe1 tpew trsk tur tur2 u20wwc uae1 ucl uef uel ueq ukr1 unl uru1 usc usl1 uslc usoc uwcl uwec uzb1 ven1 weuc weuq wsl wsl2 wwcquefa".split(" "));
/**
 * Reward pool terms. Polymarket: min size + max distance from mid. Kalshi LIP: `target` and `discount` set (see kalshiShare).
 * Polymarket US: `us` set too, with optional `maxSpread` (dollars) and the market `tick` (see usShare).
 */
export interface Rewards { minSize: number; maxSpreadC: number; dailyUsd: number; target?: number; discount?: number; us?: boolean; maxSpread?: number; tick?: number }

export const getJson = async (url: string) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`${new URL(url).host} http ${r.status}`); } // an unread body times out later as an unhandled rejection
  return r.json() as Promise<any>;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Markets the multi-game runner already played (comma-separated ids); auto-pick skips them. */
const excluded = (...ids: (string | undefined)[]) => { const ex = (process.env.EXCLUDE_IDS ?? "").split(",").filter(Boolean); return ids.some((i) => i && ex.includes(i)); };
/** REQUIRE_LIVE=1: only pick a game that is in progress (no "not started yet" fallback). */
const requireLive = () => process.env.REQUIRE_LIVE === "1";

// --- Polymarket -------------------------------------------------------------------------------

export const GAMMA = "https://gamma-api.polymarket.com", CLOB = "https://clob.polymarket.com";

const rewardsOf = (m: any): Rewards | null => {
  const now = Date.now();
  const daily = (m.clobRewards ?? []).filter((c: any) => !c.endDate || Date.parse(c.endDate) > now).reduce((s: number, c: any) => s + Number(c.rewardsDailyRate ?? 0), 0);
  return daily > 0 && m.rewardsMinSize && m.rewardsMaxSpread ? { minSize: Number(m.rewardsMinSize), maxSpreadC: Number(m.rewardsMaxSpread), dailyUsd: daily } : null;
};

/** Polymarket taker fee rate from the market's feeSchedule (0 when fees are off). ponytail: modelled as rate * p * (1 - p) like Kalshi; maker rebates ignored (in our favour, so left out). */
export const feeOf = (m: any) => (m.feesEnabled && Number(m.feeSchedule?.rate) > 0 ? Number(m.feeSchedule.rate) : 0);

/**
 * Our share of a market's liquidity-reward pool, per Polymarket's formula: each order scores ((v - s) / v)^2 * size
 * within v cents of mid; two-sided is scored by the smaller side (one side alone counts 1/3 when mid is 10-90c).
 * ponytail: everyone else's book is treated as one maker and their per-order min size is ignored. An estimate, not a payout.
 */
export function rewardShare(rw: Rewards, mid: number, bids: Level[], asks: Level[], mine: { side: Side; price: number; size: number }[]) {
  const S = (p: number) => { const s = Math.abs(p - mid) * 100; return s < rw.maxSpreadC ? ((rw.maxSpreadC - s) / rw.maxSpreadC) ** 2 : 0; };
  const two = (b: number, a: number) => (mid >= 0.1 && mid <= 0.9 ? Math.max(Math.min(b, a), Math.max(b, a) / 3) : Math.min(b, a));
  const side = (s: Side) => mine.filter((x) => x.side === s && x.size >= rw.minSize).reduce((t, x) => t + S(x.price) * x.size, 0);
  const me = two(side("buy"), side("sell"));
  if (!me) return 0;
  const them = two(bids.reduce((t, [p, z]) => t + S(p) * z, 0), asks.reduce((t, [p, z]) => t + S(p) * z, 0));
  return me / (me + them);
}

/**
 * Our share of a Kalshi Liquidity Incentive Program pool. Kalshi snapshots the book every second; per side, the reference
 * price is the first level where cumulative size reaches `target` (1000). Orders at or better than it score full size,
 * each cent worse is multiplied by `discount` (0.5). Share = our score / everyone's on that side.
 * ponytail: half the pool per side, our order is not counted when finding the reference, and snapshots Kalshi excludes
 * (both sides need the target resting) are ignored. Unconfirmed rules: confirm with one small real order before going live.
 */
export function kalshiShare(rw: Rewards, bids: Level[], asks: Level[], mine: { side: Side; price: number; size: number }[]) {
  const side = (levels: Level[], dir: 1 | -1, my: { price: number; size: number }[]) => {
    let cum = 0, ref = levels.at(-1)?.[0];
    for (const [p, z] of levels) { cum += z; if (cum >= rw.target!) { ref = p; break; } }
    const w = (p: number) => (ref === undefined ? 1 : rw.discount! ** Math.max(0, Math.round((dir * (ref - p)) / 0.01)));
    const me = my.reduce((t, x) => t + x.size * w(x.price), 0);
    return me ? me / (me + levels.reduce((t, [p, z]) => t + z * w(p), 0)) : 0;
  };
  return 0.5 * side(bids, 1, mine.filter((x) => x.side === "buy")) + 0.5 * side(asks, -1, mine.filter((x) => x.side === "sell"));
}

/**
 * Our share of a Polymarket US liquidity pool (docs.polymarket.us/incentives/liquidity), per snapshot. Per side, walk from the
 * best price (ours included: a real order would be on the book) until raw size reaches `target`; only orders inside that walk
 * score, each `discount ^ ticks from the side's best price` x size. A side short of the target scores nothing. With `maxSpread`,
 * both sides must reach the target and the two walk-end prices must be within 2 x maxSpread, or nobody is paid that second.
 * Each side is normalised to 1, so the pool is half per side. ponytail: we join the back of the queue at our price.
 */
export function usShare(rw: Rewards, bids: Level[], asks: Level[], mine: { side: Side; price: number; size: number }[]) {
  const tick = rw.tick ?? 0.01;
  const side = (levels: Level[], dir: 1 | -1, my: { price: number; size: number }[]) => {
    const all = [...levels.map(([p, z]) => ({ p, z, me: false })), ...my.map((x) => ({ p: x.price, z: x.size, me: true }))]
      .sort((a, b) => dir * (b.p - a.p) || Number(a.me) - Number(b.me)); // best first; ours behind others at the same price
    let cum = 0, tot = 0, me = 0, end: number | null = null;
    for (const o of all) {
      if (cum >= rw.target!) break;
      const w = rw.discount! ** Math.round(Math.abs(all[0]!.p - o.p) / tick);
      tot += w * o.z; if (o.me) me += w * o.z; cum += o.z; end = o.p;
    }
    return { share: cum >= rw.target! && tot ? me / tot : 0, end: cum >= rw.target! ? end : null };
  };
  const b = side(bids, 1, mine.filter((x) => x.side === "buy")), a = side(asks, -1, mine.filter((x) => x.side === "sell"));
  if (rw.maxSpread !== undefined && (b.end === null || a.end === null || a.end - b.end > 2 * rw.maxSpread + 1e-9)) return 0;
  return 0.5 * b.share + 0.5 * a.share;
}

/** Share of the pool for whichever program this is. */
export const shareOf = (rw: Rewards, mid: number, bids: Level[], asks: Level[], mine: { side: Side; price: number; size: number }[]) =>
  rw.us ? usShare(rw, bids, asks, mine) : rw.target ? kalshiShare(rw, bids, asks, mine) : rewardShare(rw, mid, bids, asks, mine);

/** What one side may lose if the market jumps to the other end: a long loses p a contract, a short 1 - p. Budget = MAX_LOSS_USD (per bot) capped by the bankroll. */
export const jumpBudget = () => Math.min(Number(process.env.MAX_LOSS_USD ?? config.maxLossUsd), config.bankrollUsd);
/** Contracts we would quote on a side within the jump budget: Polymarket only at its reward minimum (0 if that does not fit), Kalshi as many as fit. */
export function sideSize(rw: Rewards, side: Side, p: number) {
  const fit = Math.floor(jumpBudget() / (side === "buy" ? p : 1 - p) + 1e-9);
  return rw.target ? Math.min(fit, config.maxShares) : fit >= rw.minSize ? rw.minSize : 0;
}

const open = (m: any) => Number(m.bestBid) >= 0.03 && Number(m.bestAsk) <= 0.97; // not already decided
/** MARKET_KIND=long candidates: not a game, takes orders, has a reward pool, ends at least 7 days out. */
export function isLongDated(m: any, now: number) {
  return !m.gameStartTime && !m.sportsMarketType && !!m.acceptingOrders && open(m) && !!rewardsOf(m) && Date.parse(m.endDate) >= now + 7 * 86_400_000;
}

/**
 * Reward $/hour we would expect. Default: min size one tick inside the touch (or at it, if the spread is one tick).
 * `sizes` = contracts per side (0 = that side not quoted). `depth` (Polymarket) = sit that fraction of the band back from mid.
 * Kalshi LIP joins the best bid / ask (full credit, back of the queue).
 */
export function rewardPerHour(rw: Rewards, tick: number, bids: Level[], asks: Level[], sizes?: { buy: number; sell: number }, depth = 0) {
  const bid = bids[0]?.[0], ask = asks[0]?.[0];
  if (bid === undefined || ask === undefined) return 0;
  const mid = (bid + ask) / 2, room = ask - bid > tick + 1e-9, band = (depth * rw.maxSpreadC) / 100;
  // Kalshi LIP joins the touch. Polymarket US scores only orders inside the walk to the target size, so a crowded touch
  // leaves a joiner at zero: step one tick inside when there is room (we become the best price and score first).
  const px = rw.us ? { buy: room ? bid + tick : bid, sell: room ? ask - tick : ask } : rw.target ? { buy: bid, sell: ask } : {
    buy: Math.min(room ? bid + tick : bid, depth ? Math.floor((mid - band) / tick + 1e-6) * tick : Infinity),
    sell: Math.max(room ? ask - tick : ask, depth ? Math.ceil((mid + band) / tick - 1e-6) * tick : -Infinity),
  };
  const mine = (["buy", "sell"] as Side[]).map((side) => ({ side, price: px[side], size: sizes ? sizes[side] : rw.minSize })).filter((x) => x.size > 0);
  return shareOf(rw, mid, bids, asks, mine) * rw.dailyUsd / 24;
}

/** Polymarket game slug "nba-dal-cle-2026-11-14" -> Kalshi "KXNBAGAME-26NOV14DALCLE-DAL" (YES = first team). Pro leagues only. */
const KALSHI_LEAGUE: Record<string, string> = { nba: "KXNBAGAME", nhl: "KXNHLGAME", nfl: "KXNFLGAME", mlb: "KXMLBGAME" };
export function kalshiTickers(slug: string): string[] {
  const m = slug.match(/^([a-z]+)-([a-z]+)-([a-z]+)-(\d{4})-(\d{2})-(\d{2})$/);
  const series = m && KALSHI_LEAGUE[m[1]!];
  if (!m || !series) return [];
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(m[5]) - 1];
  const day = `${m[4]!.slice(2)}${mon}${m[6]}`, a = m[2]!.toUpperCase(), b = m[3]!.toUpperCase();
  return [`${series}-${day}${a}${b}-${a}`, `${series}-${day}${b}${a}-${a}`]; // either home/away order
}

/**
 * Only reward pools we can qualify for: the reward minimum must fit inside the position cap the loss limit allows, and one
 * min-size fill on the dearer side must fit the bankroll (a long costs p, a short ties up 1 - p).
 */
export const fits = (x: any) => { const n = Number(x.rewardsMinSize ?? 0), p = Number(x.bestAsk ?? 0.5); return n <= config.maxShares && n * Math.max(p, 1 - p) <= config.bankrollUsd; };

/** MARKET_ID = YES token id, or auto-pick: among started moneyline games, the most expected reward $/hour (pool x our share of the book). */
async function rankByRewardPerHour(cands: any[]): Promise<{ x: any; h: number }[]> {
  // A big pool in a crowded book pays less than a smaller pool nobody is quoting: rank by expected $/hour from the live book.
  const pool = (x: any) => rewardsOf(x)?.dailyUsd ?? 0;
  const perHour = await Promise.all(cands.map(async (x) => {
    const rw = rewardsOf(x);
    const b = rw && (await getJson(`${CLOB}/book?token_id=${JSON.parse(x.clobTokenIds)[0]}`).catch(() => null));
    if (!rw || !b) return 0;
    const lv = (l: any[], dir: number) => l.map((y: any) => [Number(y.price), Number(y.size)] as Level).sort((p, q) => dir * (p[0] - q[0]));
    return rewardPerHour(rw, Number(x.orderPriceMinTickSize ?? 0.01), lv(b.bids, -1), lv(b.asks, 1));
  }));
  return cands.map((x, i) => ({ x, h: perHour[i]! })).sort((a, b) => b.h - a.h || pool(b.x) - pool(a.x));
}

/**
 * Long-dated picker: quiet, non-game reward markets ranked by expected reward at the size the jump budget allows, sitting
 * REWARD_DEPTH back in the band. A big pool means a crowded book; a 20-share minimum in a thin book pays ~7x more per unit
 * of competition. Markets estimated under $1/day are dropped: Polymarket does not pay out below $1.
 */
export async function rankLongDated(ms: any[], now: number): Promise<{ x: any; h: number }[]> {
  const depth = Number(process.env.REWARD_DEPTH ?? 0);
  const quiet = ms.filter((x) => isLongDated(x, now) && Number(x.bestBid) >= 0.15 && Number(x.bestAsk) <= 0.85 && Math.abs(Number(x.oneDayPriceChange ?? 0)) <= 0.05
    && !excluded(JSON.parse(x.clobTokenIds ?? "[]")[0], x.conditionId));
  const fit = quiet.filter((x) => { const rw = rewardsOf(x)!, p = Number(x.bestAsk); return sideSize(rw, "buy", p) + sideSize(rw, "sell", p) > 0; });
  const top = fit.sort((p, q) => rewardsOf(q)!.dailyUsd / rewardsOf(q)!.minSize - rewardsOf(p)!.dailyUsd / rewardsOf(p)!.minSize).slice(0, 40); // pool per min share: small minimums first
  const out = await Promise.all(top.map(async (x) => {
    const rw = rewardsOf(x)!, b = await getJson(`${CLOB}/book?token_id=${JSON.parse(x.clobTokenIds)[0]}`).catch(() => null);
    if (!b) return { x, h: 0 };
    const lv = (l: any[], dir: number) => l.map((y: any) => [Number(y.price), Number(y.size)] as Level).sort((p, q) => dir * (p[0] - q[0]));
    const bids = lv(b.bids, -1), asks = lv(b.asks, 1), mid = ((bids[0]?.[0] ?? 0) + (asks[0]?.[0] ?? 1)) / 2;
    return { x, h: rewardPerHour(rw, Number(x.orderPriceMinTickSize ?? 0.01), bids, asks, { buy: sideSize(rw, "buy", mid), sell: sideSize(rw, "sell", mid) }, depth) };
  }));
  const ranked = out.filter((r) => r.h * 24 >= 1).sort((a, b) => b.h - a.h);
  if (ranked.length) console.error(`long pick: ${ranked.slice(0, 5).map((r) => `${r.x.question} ~$${(r.h * 24).toFixed(2)}/d (min ${r.x.rewardsMinSize})`).join(" | ")}`);
  return ranked;
}

/** Started, open, order-accepting moneyline games (no reward or exclusion filtering). */
export async function liveGames(): Promise<any[]> {
  const ms: any[] = await getJson(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=200`);
  const now = Date.now();
  return ms.filter((x) => x.sportsMarketType === "moneyline" && x.acceptingOrders && open(x) && x.gameStartTime && Date.parse(x.gameStartTime.replace(" ", "T").replace("+00", "Z")) <= now);
}

async function polymarket(): Promise<Adapter> {
  const long = process.env.MARKET_KIND === "long"; // long-dated reward market instead of a live game; REQUIRE_LIVE is ignored
  const page = (o: number) => getJson(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${long ? 500 : 200}&offset=${o}`);
  const ms: any[] = long ? (await Promise.all([0, 500, 1000, 1500].map((o) => page(o).catch(() => [])))).flat() : await page(0); // reward markets sit deep in the volume order
  const now = Date.now();
  const id = process.env.MARKET_ID;
  const started = (m: any) => m.gameStartTime && Date.parse(m.gameStartTime.replace(" ", "T").replace("+00", "Z")) <= now;
  const m = id
    ? ms.find((x) => x.clobTokenIds?.includes(id)) ?? (await getJson(`${GAMMA}/markets?clob_token_ids=${id}`))[0]
    : await (async () => {
        if (long) return (await rankLongDated(ms, now))[0]?.x;
        const ok = ms.filter((x) => x.sportsMarketType === "moneyline" && x.acceptingOrders && open(x) && !excluded(JSON.parse(x.clobTokenIds ?? "[]")[0], x.conditionId));
        const pool = (x: any) => rewardsOf(x)?.dailyUsd ?? 0;
        // REQUIRE_REWARDS=1 (duo): skip games with no reward pool. In the first 6 games rewards were ~95% of the profit; the no-reward game lost $21.
        const live = ok.filter((x) => started(x) && (process.env.REQUIRE_REWARDS !== "1" || (pool(x) > 0 && fits(x)))).sort((a, b) => pool(b) - pool(a)).slice(0, 10);
        const ranked = await rankByRewardPerHour(live);
        if (ranked.length) console.error(`pick: ${ranked.slice(0, 5).map((r) => `${r.x.question} ~$${r.h.toFixed(2)}/h (pool $${pool(r.x).toFixed(0)}/d)`).join(" | ")}`);
        return ranked[0]?.x ?? (requireLive() ? undefined : ok[0]);
      })();
  if (!m) throw new Error(long ? "polymarket: no long-dated reward market found" : "polymarket: no open moneyline game found; set MARKET_ID to a YES token id");
  const [yes, no] = JSON.parse(m.clobTokenIds) as [string, string];
  const [outcome, other] = JSON.parse(m.outcomes) as string[];
  const parse = (l: any[]) => l.map((x) => [Number(x.price), Number(x.size)] as Level);
  const eventId = m.events?.[0]?.id;
  const slug: string = m.events?.[0]?.slug ?? "";
  const start = m.gameStartTime ? Date.parse(m.gameStartTime.replace(" ", "T").replace("+00", "Z")) : NaN;
  const endMs = m.endDate ? Date.parse(m.endDate) : NaN;
  // long-dated: the flatten point is a day before the end, or the session's own exit (SESSION_MS) if that comes first
  const longEnd = Number.isFinite(endMs) ? Math.min(endMs - 86_400_000, config.sessionMs ? now + config.sessionMs : Infinity) : config.sessionMs ? now + config.sessionMs : null;
  const expectedEnd = Number.isFinite(start) ? start + sportHours(slug) * 3.6e6 : longEnd;
  let fairTicker: string | null | undefined; // undefined = not looked up yet, null = no Kalshi match
  // Trades come from the CLOB market websocket (sub-second). The data-api trades endpoint is cached ~5 min, which made
  // every simulated fill a match against stale prints. Opened on first use so the duo picker never holds a socket.
  const live: RawTrade[] = [];
  let ws: WebSocket | null = null;
  const connect = () => {
    ws = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    ws.onopen = () => ws!.send(JSON.stringify({ assets_ids: [yes, no], type: "market" }));
    ws.onmessage = (e) => {
      let d: any; try { d = JSON.parse(String(e.data)); } catch { return; } // "PONG"
      for (const t of [d].flat()) {
        if (t?.event_type !== "last_trade_price" || (t.asset_id !== yes && t.asset_id !== no)) continue;
        const isYes = t.asset_id === yes, price = Number(t.price), ts = Number(t.timestamp);
        // `side` is the taker's side on the token they traded. Buying NO at p = selling YES at 1-p.
        live.push({ id: `${t.transaction_hash ?? ""}:${t.asset_id}:${ts}:${t.size}:${t.price}`, ts: ts / 1000, price: isYes ? price : Math.round((1 - price) * 1e6) / 1e6, size: Number(t.size), side: (t.side === "BUY") === isYes ? "buy" : "sell" });
      }
      if (live.length > 5000) live.splice(0, 1000);
    };
    ws.onclose = () => setTimeout(connect, 2000);
    ws.onerror = () => ws?.close();
  };
  const adapter: Adapter = {
    id: yes,
    slug,
    expectedEnd,
    rewards: rewardsOf(m),
    takerFee: feeOf(m),
    async refresh() {
      const x = (await getJson(`${GAMMA}/markets?clob_token_ids=${yes}`))[0];
      if (!x) return;
      adapter.rewards = rewardsOf(x);
      adapter.takerFee = feeOf(x);
    },
    async fair() {
      if (process.env.FAIR_SOURCE === "odds") return oddsFair(slug, outcome!, other ?? ""); // `at` = when the sportsbook odds were fetched
      if (fairTicker === undefined) {
        fairTicker = null;
        for (const t of kalshiTickers(m.events?.[0]?.slug ?? "")) {
          if (await getJson(`${KALSHI}/markets/${t}`).then(() => true, () => false)) { fairTicker = t; break; }
        }
      }
      if (!fairTicker) return null;
      const k = (await getJson(`${KALSHI}/markets/${fairTicker}`)).market;
      const bid = Number(k.yes_bid_dollars), ask = Number(k.yes_ask_dollars);
      return ask - bid <= 0.05 ? { p: (bid + ask) / 2, at: Date.now() } : null; // a wide book says little
    },
    async game() {
      if (!eventId) return null;
      const e = await getJson(`${GAMMA}/events/${eventId}`);
      return { title: e.title, score: e.score || null, period: e.period || null, elapsed: e.elapsed || null, live: e.live ?? null, ended: e.ended ?? null };
    },
    label: `polymarket · ${long ? "long · " : ""}${m.question} · YES=${outcome}${long || started(m) ? "" : " (not started yet)"}`,
    tick: Number(m.orderPriceMinTickSize ?? 0.01),
    async levels() {
      const b = await getJson(`${CLOB}/book?token_id=${yes}`);
      return { bids: parse(b.bids).sort((a, b) => b[0] - a[0]), asks: parse(b.asks).sort((a, b) => a[0] - b[0]) };
    },
    async trades() {
      if (!ws) { connect(); setInterval(() => ws?.readyState === 1 && ws.send("PING"), 10_000); }
      return live.splice(0);
    },
  };
  return adapter;
}

// --- Kalshi -----------------------------------------------------------------------------------

export const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const KALSHI_SERIES = ["KXNBAGAME", "KXNFLGAME", "KXNHLGAME", "KXNCAABGAME", "KXNCAAFGAME", "KXMLBGAME"];

/** Kalshi order book -> YES bids and asks, best first. Both arrays come back as bids, worst first; a NO bid at p is a YES ask at 1-p. */
function kalshiBook(b: any) {
  const num = (l: [string, string][] | undefined) => (l ?? []).map(([p, s]) => [Number(p), Number(s)] as Level);
  return { bids: num(b.yes_dollars).sort((a, b) => b[0] - a[0]), asks: num(b.no_dollars).map(([p, s]) => [Math.round((1 - p) * 1e4) / 1e4, s] as Level).sort((a, b) => a[0] - b[0]) };
}

/** Every active Kalshi liquidity program (public, ~6,000, paged). */
async function lipPrograms(): Promise<any[]> {
  const out: any[] = [];
  let cursor = "";
  do {
    const r = await getJson(`${KALSHI}/incentive_programs?status=active&limit=1000${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...(r.incentive_programs ?? []).filter((p: any) => p.incentive_type === "liquidity"));
    cursor = r.next_cursor ?? "";
    await sleep(300);
  } while (cursor && out.length < 50_000);
  return out;
}
/** Program terms as Rewards. `period_reward` is in centi-cents (Kalshi caps a pool at $1,000/day; read as cents it would break that). */
export const lipRewards = (p: any): Rewards => ({
  minSize: 1, maxSpreadC: 99, target: Number(p.target_size_fp ?? 1000), discount: Number(p.discount_factor_bps ?? 5000) / 1e4,
  dailyUsd: Number(p.period_reward) / 1e4 / Math.max(1, (Date.parse(p.end_date) - Date.parse(p.start_date)) / 86_400_000),
});

/**
 * MARKET_KIND=lip: the Kalshi program market paying us the most per day for the jump budget. Non-sports only (sports
 * contracts are the contested part for Maryland), no maker-fee series, 10-90c (the longshot rule blocks the cheap side
 * otherwise), little volume (a resting order is paid for waiting, not for being traded against), 2+ days left.
 */
async function pickLip(): Promise<{ m: any; p: any }> {
  const now = Date.now(), progs = await lipPrograms();
  const perDay = (p: any) => lipRewards(p).dailyUsd, daysLeft = (p: any) => (Date.parse(p.end_date) - now) / 86_400_000;
  const live = progs.filter((p) => Date.parse(p.start_date) <= now && Date.parse(p.end_date) > now + 86_400_000 && !excluded(p.market_ticker, p.event_ticker));
  // Every program's market (50 per call): the biggest pools sit in the most crowded books, so rank them all by what OUR size would earn.
  const mk = new Map<string, any>();
  for (let i = 0; i < live.length; i += 50) {
    const r = await getJson(`${KALSHI}/markets?limit=50&tickers=${live.slice(i, i + 50).map((p) => p.market_ticker).join(",")}`).catch(() => ({ markets: [] }));
    for (const m of r.markets ?? []) mk.set(m.ticker, m);
    await sleep(150);
  }
  // Quick estimate from the touch sizes the market listing already carries; the full book is read only for the finalists.
  const quick = (p: any, m: any) => {
    const rw = lipRewards(p), bid = Number(m.yes_bid_dollars), ask = Number(m.yes_ask_dollars), nb = sideSize(rw, "buy", bid), ns = sideSize(rw, "sell", ask);
    return rw.dailyUsd * 0.5 * (nb / (nb + Number(m.yes_bid_size_fp ?? 0) || 0) + ns / (ns + Number(m.yes_ask_size_fp ?? 0) || 0));
  };
  const ok = live.map((p) => ({ p, m: mk.get(p.market_ticker) })).filter(({ m }) => m && m.status === "active" && Number(m.yes_bid_dollars) >= 0.1 && Number(m.yes_ask_dollars) <= 0.9
    && Number(m.volume_24h_fp ?? 0) <= 150 && Date.parse(m.close_time) > now + 2 * 86_400_000)
    .map((x) => ({ ...x, q: quick(x.p, x.m) })).filter((x) => x.q * daysLeft(x.p) >= 1).sort((a, b) => b.q - a.q);
  const series = new Map<string, any>(), best: { m: any; p: any; h: number }[] = [];
  for (const { p } of ok.slice(0, 60)) { // the quick estimate only sees the touch; deeper walls count too (everything down to the 1000-contract reference)
    if (!series.has(p.series_ticker)) { series.set(p.series_ticker, (await getJson(`${KALSHI}/series/${p.series_ticker}`).catch(() => null))?.series ?? null); await sleep(300); }
    const s = series.get(p.series_ticker);
    if (!s || /sport/i.test(s.category ?? "") || /maker/.test(s.fee_type ?? "")) continue;
    const b = await getJson(`${KALSHI}/markets/${p.market_ticker}/orderbook?depth=40`).catch(() => null);
    await sleep(300);
    if (!b) continue;
    const { bids, asks } = kalshiBook(b.orderbook_fp ?? {}), rw = lipRewards(p);
    if (!bids.length || !asks.length) continue;
    best.push({ m: mk.get(p.market_ticker), p, h: rewardPerHour(rw, 0.01, bids, asks, { buy: sideSize(rw, "buy", bids[0]![0]), sell: sideSize(rw, "sell", asks[0]![0]) }) });
  }
  const ranked = best.filter((r) => r.h * 24 * daysLeft(r.p) >= 1).sort((a, b) => b.h - a.h); // Kalshi pays nothing under $1 for the whole program
  console.error(`lip: ${live.length} programs, ${ok.length} pass the quick estimate, ${best.length} books read, ${ranked.length} pay $1+ over their program; best ${best.sort((a, b) => b.h - a.h).slice(0, 3).map((r) => `${r.m.ticker} $${(r.h * 24).toFixed(2)}/d`).join(", ")}`);
  if (ranked.length) console.error(`lip pick: ${ranked.slice(0, 5).map((r) => `${r.m.ticker} ~$${(r.h * 24).toFixed(2)}/d (pool $${perDay(r.p).toFixed(0)}/d)`).join(" | ")}`);
  if (!ranked[0]) throw new Error("kalshi: no liquidity program market fits the budget");
  return ranked[0];
}

/** MARKET_ID = market ticker, or auto-pick: the highest 24h-volume game market expected to end in the next 4 h. MARKET_KIND=lip: a liquidity program market. */
async function kalshi(): Promise<Adapter> {
  let m: any = null, prog: any = null;
  const lip = process.env.MARKET_KIND === "lip";
  if (lip && !process.env.MARKET_ID) ({ m, p: prog } = await pickLip());
  else if (process.env.MARKET_ID) {
    m = (await getJson(`${KALSHI}/markets/${process.env.MARKET_ID}`)).market;
    if (lip) prog = (await lipPrograms()).find((p) => p.market_ticker === m.ticker) ?? null;
  } else {
    const all: any[] = [];
    for (const s of KALSHI_SERIES) {
      const r = await getJson(`${KALSHI}/markets?status=open&limit=200&series_ticker=${s}`).catch(() => ({ markets: [] }));
      all.push(...(r.markets ?? []));
      await sleep(1200); // public API throttles bursts
    }
    const soon = (x: any) => Date.parse(x.expected_expiration_time) - Date.now() < 4 * 3600_000;
    const vol = (x: any) => Number(x.volume_24h_fp ?? 0);
    const live = all.filter((x) => Number(x.yes_bid_dollars) >= 0.03 && Number(x.yes_ask_dollars) <= 0.97 && !excluded(x.ticker, x.event_ticker)); // not already decided or played
    m = live.filter(soon).sort((a, b) => vol(b) - vol(a))[0] ?? (requireLive() ? null : live.sort((a, b) => vol(b) - vol(a))[0]);
  }
  if (!m) throw new Error("kalshi: no open game market found; set MARKET_ID to a market ticker");
  const ticker = m.ticker;
  // LIP: the flatten point is a day before trading closes or the program ends, or the session's own exit (SESSION_MS) if sooner
  const lipEnd = prog ? Math.min(Date.parse(m.close_time) - 86_400_000, Date.parse(prog.end_date), config.sessionMs ? Date.now() + config.sessionMs : Infinity) : null;
  return {
    id: ticker,
    event: m.event_ticker,
    expectedEnd: lipEnd ?? (Date.parse(m.expected_expiration_time) || null),
    rewards: prog ? lipRewards(prog) : null,
    takerFee: 0.07, // quadratic series: takers pay, makers do not (maker-fee series are skipped by the picker)
    label: `kalshi · ${lip ? "lip · " : ""}${m.title} · ${ticker}`,
    tick: 0.01, // linear_cent
    async levels() {
      return kalshiBook((await getJson(`${KALSHI}/markets/${ticker}/orderbook?depth=${lip ? 40 : 10}`)).orderbook_fp ?? {});
    },
    async trades(sinceSec) {
      const r = await getJson(`${KALSHI}/markets/trades?ticker=${ticker}&min_ts=${sinceSec}&limit=100`);
      return (r.trades ?? []).map((t: any) => ({ id: t.trade_id, ts: Date.parse(t.created_time) / 1000, price: Number(t.yes_price_dollars), size: Number(t.count_fp), side: t.taker_side === "yes" ? "buy" : "sell" } as RawTrade));
    },
  };
}

// --- Polymarket US (the exchange the owner can trade; public data, no API key) -----------------

export const PMUS = "https://gateway.polymarket.us/v1";
// Non-sports slug prefixes that carried liquidity programs on 2026-11-21. The incentives API ignores pageSize/pageToken and
// returns at most 100 programs per query, so each prefix is its own query.
// ponytail: static list, capped at 100 programs per prefix; a new product prefix is missed until added here
const PMUS_PREFIXES = "tac vmc vtc aaagaspc aimrc cranc pvwc enwc nphc rotc ccpc cpc ewc ccrc lawec opdc mlaec aimc ipcc tpoyc apdc ncpdc nclphc cbpac patc cpcxrp pnwpc iarc pmmsc phc cpceth cpcsol rtc trc pintc".split(" ");
const usLevels = (l: any[] | undefined) => (l ?? []).map((x: any) => [Number(x.px.value), Number(x.qty)] as Level);
/** Next midnight US Eastern (ms epoch): daily programs run midnight to midnight ET, and each day pays out on its own. */
export function nextMidnightET(now = Date.now()) {
  const et = new Date(new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const off = et.getTime() - Math.floor(now / 1000) * 1000; // ET wall clock minus real time
  const mid = new Date(et); mid.setHours(24, 0, 0, 0);
  return mid.getTime() - off;
}
/** One active daily liquidity program as Rewards (pool is per day; sports and per-game periods are left out). */
export const usRewards = (t: any, tick = 0.01): Rewards => ({ minSize: 1, maxSpreadC: 99, dailyUsd: Number(t.rewardPool), target: Number(t.targetSize), discount: Number(t.discountFactor), us: true, maxSpread: t.maxSpread === undefined ? undefined : Number(t.maxSpread), tick });
const dailyProgram = (p: any, now: number) => p.category !== "SPR" && (p.timePeriods ?? []).find((t: any) => t.programType === "liquidityProgram" && t.status === "active" && /^daily/.test(t.period) && Date.parse(t.start) <= now);

async function usPrograms(query: string): Promise<any[]> {
  const r = await getJson(`${PMUS}/incentives?statuses=active&programType=liquidityProgram&query=${encodeURIComponent(query)}`).catch(() => ({ programs: [] }));
  return r.programs ?? [];
}

/**
 * VENUE=polyus auto-pick: the daily program paying us the most for the jump budget, from the live book, quoting one tick
 * inside the touch. 10-90c only (the
 * longshot rule blocks the cheap side otherwise), 2+ days to the market's end, and an estimate of $1+/day (nothing under $1 is paid).
 */
/** $/hour our quotes would earn on the book right now, or null when the market is closed or outside 10-90c. */
async function usEstimate(slug: string, t: any) {
  const b = (await getJson(`${PMUS}/markets/${slug}/book`).catch(() => null))?.marketData;
  const bids = usLevels(b?.bids).sort((x, y) => y[0] - x[0]), asks = usLevels(b?.offers).sort((x, y) => x[0] - y[0]);
  if (b?.state !== "MARKET_STATE_OPEN" || !bids.length || !asks.length || bids[0]![0] < 0.1 || asks[0]![0] > 0.9) return null;
  const rw = usRewards(t);
  return rewardPerHour(rw, 0.01, bids, asks, { buy: sideSize(rw, "buy", bids[0]![0]), sell: sideSize(rw, "sell", asks[0]![0]) });
}

async function pickUs(): Promise<{ slug: string; t: any; m: any }> {
  const now = Date.now(), seen = new Map<string, any>();
  for (const q of PMUS_PREFIXES) {
    for (const p of await usPrograms(`${q}-`)) { const t = dailyProgram(p, now); if (t && !seen.has(p.marketSlug) && !excluded(p.marketSlug)) seen.set(p.marketSlug, t); }
    await sleep(100);
  }
  // A small target with a big pool is the cheapest to take a share of; only the best 250 get their book read.
  const top = [...seen].sort((a, b) => b[1].rewardPool / b[1].targetSize - a[1].rewardPool / a[1].targetSize).slice(0, 250); // most are outside 10-90c; ~40 s of reads
  const est: { slug: string; t: any; h: number }[] = [];
  for (const [slug, t] of top) {
    const h = await usEstimate(slug, t);
    await sleep(50);
    if (h !== null) est.push({ slug, t, h });
  }
  const ranked = est.filter((r) => r.h * 24 >= 1).sort((a, b) => b.h - a.h);
  console.error(`polyus: ${seen.size} daily programs, ${est.length} books in 10-90c, ${ranked.length} pay $1+/day on one snapshot; best ${ranked.slice(0, 3).map((r) => `${r.slug} $${(r.h * 24).toFixed(2)}/d`).join(", ")}`);
  const short: { slug: string; t: any; m: any; snap: number; hs: number[] }[] = [];
  for (const r of ranked) { // same-day crypto strikes rank high but end today: keep looking
    const m = (await getJson(`${PMUS}/market/slug/${r.slug}`).catch(() => null))?.market;
    await sleep(50);
    if (m?.active && !m.closed && Date.parse(m.endDate) > now + 2 * 86_400_000) short.push({ slug: r.slug, t: r.t, m, snap: r.h, hs: [] });
    if (short.length >= 8) break;
  }
  // One snapshot can catch a tight book in a market that pays nobody most seconds (maxSpread fails), so rank on the median
  // of US_SAMPLES reads 30 s apart. ponytail: 5 minutes of history; log pay rates across sessions if this still misjudges.
  const n = Number(process.env.US_SAMPLES ?? 10);
  for (let i = 0; i < n; i++) {
    for (const c of short) { c.hs.push((await usEstimate(c.slug, c.t)) ?? 0); await sleep(50); }
    if (i < n - 1) await sleep(30_000);
  }
  const best = short.map((c) => ({ ...c, h: c.hs.sort((a, b) => a - b)[Math.floor(n / 2)]! })).sort((a, b) => b.h - a.h); // median: one thin-book read can 30x a mean
  console.error(`polyus sampled ${n}x: ${best.map((c) => `${c.slug} $${(c.h * 24).toFixed(2)}/d (snapshot $${(c.snap * 24).toFixed(2)})`).join(", ")}`);
  if (best[0] && best[0].h * 24 >= 1) {
    const r = best[0];
    console.error(`polyus pick: ${r.slug} ~$${(r.h * 24).toFixed(2)}/d median (pool $${r.t.rewardPool}/d, target ${r.t.targetSize})`);
    return { slug: r.slug, t: r.t, m: r.m };
  }
  throw new Error("polyus: no daily liquidity program fits the budget");
}

/**
 * VENUE=polyus: one Polymarket US market with a daily liquidity program, held until the next ET midnight (the end of the day's
 * pool) or a day before the market ends. Trades: the public book carries only cumulative `sharesTraded` and the last trade
 * (the trade feed needs an API key), so a rise in sharesTraded is read as one print at lastTradePx, taker side from where it
 * printed against the book before. ponytail: several trades between two ticks merge into one print at the last price.
 */
async function polyus(): Promise<Adapter> {
  const now = Date.now();
  let slug = process.env.MARKET_ID, t: any, m: any;
  if (!slug) ({ slug, t, m } = await pickUs());
  else {
    m = (await getJson(`${PMUS}/market/slug/${slug}`)).market;
    t = dailyProgram((await usPrograms(slug)).find((p) => p.marketSlug === slug) ?? {}, now);
  }
  const tick = Number(m.orderPriceMinTickSize ?? 0.01);
  let prev: { shares: number; bid: number; ask: number } | null = null;
  const pending: RawTrade[] = [];
  const adapter: Adapter = {
    id: slug!,
    label: `polyus · ${m.question}${m.marketSides?.[0]?.description && m.marketSides[0].description !== "Yes" ? ` · YES=${m.marketSides[0].description}` : ""} · ${slug}`,
    tick,
    rewards: t ? usRewards(t, tick) : null,
    takerFee: 0.0695, // API taker coefficient; makers pay none, and the maker rebate starts at $10M a month (not us)
    expectedEnd: Math.min(nextMidnightET(now), Date.parse(m.endDate) - 86_400_000),
    async refresh() {
      const x = dailyProgram((await usPrograms(slug!)).find((p) => p.marketSlug === slug) ?? {}, Date.now());
      adapter.rewards = x ? usRewards(x, tick) : null;
    },
    async levels() {
      const b = (await getJson(`${PMUS}/markets/${slug}/book`)).marketData;
      const bids = usLevels(b.bids).sort((x, y) => y[0] - x[0]), asks = usLevels(b.offers).sort((x, y) => x[0] - y[0]);
      const shares = Number(b.stats?.sharesTraded ?? 0), px = Number(b.stats?.lastTradePx?.value);
      if (prev && shares > prev.shares + 1e-9 && Number.isFinite(px)) {
        const side: Side = px >= prev.ask ? "buy" : px <= prev.bid ? "sell" : px >= (prev.bid + prev.ask) / 2 ? "buy" : "sell";
        const ts = Date.parse(b.stats?.lastTradeSetTime ?? "") || Date.now();
        pending.push({ id: `${slug}:${shares}`, ts: ts / 1000, price: px, size: Math.round((shares - prev.shares) * 100) / 100, side });
      }
      if (bids.length && asks.length) prev = { shares, bid: bids[0]![0], ask: asks[0]![0] };
      return { bids, asks };
    },
    async trades() { return pending.splice(0); },
  };
  return adapter;
}

// --- Shared book / feed / dry-run market -------------------------------------------------------

const BANDS_BPS = [100, 300, 1000]; // 1c ticks on a ~50c contract are ~200 bps, so Kuru's 10/25/50 would be empty

function buildBook(block: number, bids: Level[], asks: Level[]): Book {
  if (!bids.length || !asks.length) throw new Error(`empty book side (bids=${bids.length} asks=${asks.length})`);
  const bid = bids[0]![0], ask = asks[0]![0], mid = (bid + ask) / 2;
  const within = (l: Level[], bps: number) => l.filter(([p]) => Math.abs(p - mid) / mid * 1e4 <= bps).reduce((s, [, q]) => s + q, 0);
  const depthBps: Book["depthBps"] = {};
  for (const b of BANDS_BPS) depthBps[b] = { bid: within(bids, b), ask: within(asks, b) };
  const bd = within(bids, 1000), ad = within(asks, 1000);
  return { block, bid, ask, mid, spreadBps: ((ask - bid) / mid) * 1e4, imbalance: bd + ad ? (bd - ad) / (bd + ad) : 0, levels: { bids: bids.slice(0, 5), asks: asks.slice(0, 5) }, all: { bids, asks }, depthBps };
}

/** Same surface as trades.ts TradeFeed. Prints are stamped with the tick they were seen on. */
class VenueFeed {
  private trades: TradePrint[] = [];
  private fresh: TradePrint[] = [];
  private seen = new Set<string>();
  private since = Math.floor(Date.now() / 1000);
  constructor(private a: Adapter) {}

  get sinceSec() { return this.since - 5; }
  /** Prints are fetched by VenueMarket.readBook together with the book (one recorded tick); this files them. */
  ingest(raw: RawTrade[], block: number) {
    for (const t of [...raw].sort((x, y) => x.ts - y.ts)) {
      if (this.seen.has(t.id)) continue;
      this.seen.add(t.id);
      const p = { block, ts: t.ts * 1000, price: t.price, size: t.size, side: t.side };
      this.trades.push(p); this.fresh.push(p);
      this.since = Math.max(this.since, Math.floor(t.ts));
    }
    if (this.trades.length > 5000) this.trades.splice(0, 1000);
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000)); // ponytail: crude cap, fine for a session
  }
  summary(lastBlocks: number, currentBlock: number): TradeSummary {
    let count = 0, buyMon = 0, sellMon = 0, notional = 0, lastPrice: number | null = null, lastSide: Side | null = null;
    for (const t of this.trades) {
      if (t.block <= currentBlock - lastBlocks) continue;
      count++; if (t.side === "buy") buyMon += t.size; else sellMon += t.size;
      notional += t.size * t.price; lastPrice = t.price; lastSide = t.side;
    }
    const vol = buyMon + sellMon;
    return { count, buyMon, sellMon, cvdMon: buyMon - sellMon, vwap: vol ? notional / vol : null, lastPrice, lastSide };
  }
  recent(n: number) { return this.trades.slice(-n); }
  drainPrints() { const o = this.fresh; this.fresh = []; return o; }
  drainFills(): MakerFill[] { return []; }
}

/** Dry-run only stand-in for Market: real book, simulated quotes. */
export class VenueMarket {
  readonly wallet = null;
  readonly address = null;
  margin = { mon: 0, usdc: 0 };
  feed!: VenueFeed;
  label = "";
  marketId = "";
  /** Latest live game state, refreshed every 15 s off the hot path. */
  game: Game | null = null;
  /** Fair price for this outcome, polled every 10 s; `fairAt` = when it was observed (odds: the cache's fetch time). */
  fair: number | null = null;
  fairAt = 0;
  /** Where `fair` comes from: "odds" (sportsbooks), "kalshi", or "none" (FAIR_SOURCE=odds but no price yet). */
  fairSource: "odds" | "kalshi" | "none" | null = null;
  /** Expected end of the market (ms epoch); null = unknown (replays). */
  expectedEnd: number | null = null;
  slug = "";
  /** Kalshi event_ticker, "" elsewhere. */
  event = "";
  private a!: Adapter;
  private tickNo = 0;
  private gameAt = 0;
  private fairPollAt = 0;
  private replaying = false;
  get tick() { return this.a.tick; }
  get rewards() { return this.a.rewards ?? null; }
  get takerFee() { return this.a.takerFee ?? config.takerFeeRate; }
  private refreshAt = Date.now();

  async init() {
    const venue = process.env.VENUE;
    this.replaying = !!process.env.REPLAY;
    this.a = this.replaying ? replay(process.env.REPLAY!) : venue === "kalshi" ? await kalshi() : venue === "polyus" ? await polyus() : await polymarket();
    this.label = this.a.label;
    this.marketId = this.a.id;
    this.expectedEnd = this.a.expectedEnd ?? null;
    this.slug = this.a.slug ?? "";
    this.event = this.a.event ?? "";
    if (process.env.FAIR_SOURCE === "odds") this.fairSource = "none";
    this.feed = new VenueFeed(this.a);
    if (config.record && !this.replaying) appendFileSync(config.record, JSON.stringify({ meta: { id: this.a.id, label: this.a.label, tick: this.a.tick, rewards: this.a.rewards ?? null } }) + "\n");
  }
  /** One tick of market data: book and new prints together (and, every so often, game state and the other venue's price). */
  async readBook(block = 0): Promise<Book> {
    const now = Date.now();
    if (!this.replaying && this.a.game && now - this.gameAt > 15_000) {
      this.gameAt = now;
      this.a.game().then((g) => (this.game = g)).catch(() => {});
    }
    if (!this.replaying && this.a.refresh && now - this.refreshAt > 120_000) { // reward pools change during a game (500 -> 15,771/day seen)
      this.refreshAt = now;
      this.a.refresh().catch(() => {});
    }
    if (!this.replaying && this.a.fair && now - this.fairPollAt > 10_000) {
      this.fairPollAt = now;
      this.a.fair().then((f) => {
        this.fair = f?.p ?? null; this.fairAt = f?.at ?? Date.now();
        if (process.env.FAIR_SOURCE === "odds") this.fairSource = f !== null ? "odds" : this.fairSource ?? "none";
        else this.fairSource = "kalshi";
      }).catch(() => {});
    }
    const [{ bids, asks }, raw] = await Promise.all([this.a.levels(), this.a.trades(this.feed.sinceSec).catch(() => [] as RawTrade[])]);
    if (this.replaying) { const c = (this.a as ReplayAdapter).cur; this.game = c.game; this.fair = c.fair; this.fairAt = Date.now(); if (c.rewards !== undefined) this.a.rewards = c.rewards; }
    else if (config.record) appendFileSync(config.record, JSON.stringify({ ts: now, bids, asks, trades: raw, game: this.game, fair: this.fair, rewards: this.a.rewards ?? null }) + "\n");
    this.feed.ingest(raw, block);
    return buildBook(++this.tickNo, bids, asks);
  }
  /** `quoteInsideTicks` inside the touch on our side, never crossing; joins the touch if the spread is one tick. */
  quotePrice(side: Side, book: Book) {
    const t = this.a.tick, u = (x: number) => Math.round(x / t);
    const step = config.quoteInsideTicks;
    let p = side === "buy" ? u(book.bid) + step : u(book.ask) - step;
    if (side === "buy" && p >= u(book.ask)) p = u(book.bid);
    if (side === "sell" && p <= u(book.bid)) p = u(book.ask);
    return Math.round(p * t * 1e6) / 1e6;
  }
  async send(_block: number, side: Side, size: number, book: Book, cancel: number[], capped: boolean): Promise<Quote> {
    return { side, price: this.quotePrice(side, book), size, txHash: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
  }
  async pollPending(): Promise<QuoteResult[]> { return []; }
  async refresh() {}
}

/** REPLAY=path: a recorded session (RECORD=path) played back tick by tick. Throws "replay finished" at the end. */
type ReplayAdapter = Adapter & { cur: any };
function replay(path: string): ReplayAdapter {
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const meta = lines[0].meta, ticks = lines.slice(1);
  let i = 0;
  const a: ReplayAdapter = {
    id: meta.id, label: `replay · ${meta.label}`, tick: meta.tick, rewards: meta.rewards, cur: null,
    async levels() {
      a.cur = ticks[i++]; // set synchronously, before trades() is called for the same tick
      if (!a.cur) throw new Error("replay finished");
      return { bids: a.cur.bids, asks: a.cur.asks };
    },
    async trades() { return a.cur?.trades ?? []; },
  };
  return a;
}

if (import.meta.main) {
  const now = Date.parse("2026-11-15T00:00:00Z");
  const lb = { acceptingOrders: true, bestBid: "0.4", bestAsk: "0.42", rewardsMinSize: 50, rewardsMaxSpread: 3, clobRewards: [{ rewardsDailyRate: 10 }] };
  console.assert(isLongDated({ ...lb, endDate: "2026-12-31T00:00:00Z" }, now), "long-dated with rewards");
  console.assert(!isLongDated({ ...lb, endDate: "2026-11-18T00:00:00Z" }, now), "ends in 3 days: no");
  console.assert(!isLongDated({ ...lb, endDate: "2026-12-31T00:00:00Z", sportsMarketType: "moneyline" }, now), "a game: no");
  console.assert(!isLongDated({ ...lb, endDate: "2026-12-31T00:00:00Z", clobRewards: [] }, now), "no pool: no");
  console.assert(fits({ rewardsMinSize: 20, bestAsk: "0.5" }) && !fits({ rewardsMinSize: 1000, bestAsk: "0.5" }) && !fits({ rewardsMinSize: 200, bestAsk: "0.95" }) === (200 * 0.95 > config.bankrollUsd), "fits: min size vs cap and bankroll");
  console.assert(sportHours("cfb-nw-ohiost-2026-11-14") === 2.75 && sportHours("nba-dal-cle-2026-11-14") === 2.1 && sportHours("cbb-duke-unc-2026-11-14") === 1.75 && sportHours("nhl-bos-tor-2026-11-14") === 2.25 && sportHours("mlb-nyy-bos-2026-11-14") === 2.5 && sportHours("epl-ars-che-2026-11-14") === 1.75 && sportHours("lol-blg-gen-2026-11-14") === 1.5, "sport hours");
  console.assert(kalshiTickers("nba-dal-cle-2026-11-14")[0] === "KXNBAGAME-26NOV14DALCLE-DAL", "kalshi ticker", kalshiTickers("nba-dal-cle-2026-11-14"));
  console.assert(kalshiTickers("cfb-nw-ohiost-2026-11-14").length === 0, "college has no mapping");
  // Kalshi LIP: reference = first level reaching 1000 cumulative (0.49); our 100 at 0.50 is full credit vs 1200 on the side
  const lip = { minSize: 1, maxSpreadC: 99, dailyUsd: 48, target: 1000, discount: 0.5 };
  console.assert(Math.abs(kalshiShare(lip, [[0.5, 600], [0.49, 600], [0.48, 400]], [], [{ side: "buy", price: 0.5, size: 100 }]) - 0.5 * 100 / (100 + 600 + 600 + 200)) < 1e-9, "LIP share: 0.48 is one cent past the reference, half credit");
  console.assert(kalshiShare(lip, [[0.5, 100]], [[0.6, 100]], [{ side: "sell", price: 0.6, size: 100 }]) === 0.25, "LIP: half the pool per side");
  console.assert(Math.abs(lipRewards({ period_reward: 700000, start_date: "2026-11-15T00:00:00Z", end_date: "2026-11-22T00:00:00Z" }).dailyUsd - 10) < 1e-9, "70 dollars over 7 days");
  // Polymarket US: the docs' example (discount 0.30): 1000 at best vs 1000 three ticks back -> 1000 / 1027 of the side
  const us: Rewards = { minSize: 1, maxSpreadC: 99, dailyUsd: 40, target: 2000, discount: 0.3, us: true, tick: 0.01 };
  const other: [number, number][] = [[0.47, 1000]];
  console.assert(Math.abs(usShare(us, other, [], [{ side: "buy", price: 0.5, size: 1000 }]) - 0.5 * 1000 / 1027) < 1e-9, "US: 3 ticks back scores 0.3^3; no maxSpread so the empty ask side does not void the bid side");
  console.assert(usShare({ ...us, target: 3000 }, other, [], [{ side: "buy", price: 0.5, size: 1000 }]) === 0, "US: side short of the target scores nothing");
  console.assert(usShare({ ...us, target: 500 }, [[0.5, 600]], [], [{ side: "buy", price: 0.5, size: 100 }]) === 0, "US: the walk reaches the target before our order (same price, queued behind): no score");
  const ms = { ...us, target: 1000, maxSpread: 0.035 };
  console.assert(usShare(ms, [[0.49, 1000]], [[0.51, 1000]], [{ side: "buy", price: 0.5, size: 1000 }]) === 0.5, "US maxSpread: our 1000 at 50c fills the bid target alone (the 49c wall is past it), 50/51 qualifies: the whole bid half");
  console.assert(usShare(ms, [[0.49, 1000]], [[0.57, 1000]], [{ side: "buy", price: 0.49, size: 500 }]) === 0, "US maxSpread: 49/57 is 8c apart (> 7c): nobody paid");
  const midET = nextMidnightET(Date.parse("2026-11-21T15:00:00Z"));
  console.assert(midET === Date.parse("2026-11-22T05:00:00Z"), "next ET midnight (EST is UTC-5)", new Date(midET).toISOString());
  process.env.MAX_LOSS_USD = "8";
  console.assert(sideSize({ minSize: 20, maxSpreadC: 3, dailyUsd: 1 }, "buy", 0.3) === 20 && sideSize({ minSize: 20, maxSpreadC: 3, dailyUsd: 1 }, "sell", 0.3) === 0, "$8 budget at 30c: 20 long fits ($6), 20 short does not ($14)");
  console.assert(sideSize(lip, "buy", 0.2) === Math.min(40, config.maxShares), "Kalshi: as many as the budget allows");
  delete process.env.MAX_LOSS_USD;
  const rw = { minSize: 100, maxSpreadC: 3, dailyUsd: 2400 };
  console.assert(Math.abs(rewardPerHour(rw, 0.01, [[0.48, 1]], [[0.52, 1]]) - 99.75) < 0.01, "near-empty book: 99.75% of the $100/h pool", rewardPerHour(rw, 0.01, [[0.48, 1]], [[0.52, 1]]));
  console.assert(rewardPerHour(rw, 0.01, [[0.49, 1e6]], [[0.51, 1e6]]) < 0.1, "crowded book: almost nothing");

  // Self-check: book building and quote placement, no network.
  const b = buildBook(1, [[0.48, 100], [0.47, 50]], [[0.52, 80], [0.6, 10]]);
  console.assert(b.mid === 0.5 && Math.round(b.spreadBps) === 800, "mid/spread", b);
  const vm = new VenueMarket() as any; vm.a = { tick: 0.01 };
  console.assert(vm.quotePrice("buy", b) === 0.49 && vm.quotePrice("sell", b) === 0.51, "quote inside");
  const tight = buildBook(2, [[0.5, 1]], [[0.51, 1]]);
  console.assert(vm.quotePrice("buy", tight) === 0.5 && vm.quotePrice("sell", tight) === 0.51, "never crosses");
  console.log("venues self-check ok");
}
