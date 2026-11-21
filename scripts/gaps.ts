/** Polymarket vs Kalshi gap logger. Dry run, public data only: logs the price gap per live game every 60 s to data/gaps-<stamp>.jsonl. */
import { appendFileSync } from "node:fs";
import { CLOB, KALSHI, feeOf, getJson, kalshiTickers, liveGames } from "../src/venues";

type Q = { bid: number; ask: number };
const fee = (rate: number, p: number) => rate * p * (1 - p);

export function gapAfterFees(poly: Q, kal: Q, polyTaker: number, kalTaker: number) {
  const gap = Math.abs((poly.bid + poly.ask) / 2 - (kal.bid + kal.ask) / 2);
  const a = kal.bid - poly.ask - fee(polyTaker, poly.ask) - fee(kalTaker, kal.bid); // buy Poly, sell Kalshi
  const b = poly.bid - kal.ask - fee(polyTaker, poly.bid) - fee(kalTaker, kal.ask); // buy Kalshi, sell Poly
  const edge = Math.max(a, b);
  return { gap, edge, dir: edge > 0 ? (a >= b ? "buyPoly" : "buyKalshi") as "buyPoly" | "buyKalshi" : null };
}

if (import.meta.main && process.argv[2] === "--check") {
  const a = gapAfterFees({ bid: 0.50, ask: 0.51 }, { bid: 0.55, ask: 0.56 }, 0, 0.07);
  console.assert(a.dir === "buyPoly" && Math.abs(a.edge - (0.55 - 0.51 - 0.07 * 0.55 * 0.45)) < 1e-9, "crossed after fees", a);
  console.assert(gapAfterFees({ bid: 0.50, ask: 0.51 }, { bid: 0.51, ask: 0.52 }, 0, 0.07).dir === null, "inside fees: no edge");
  console.assert(gapAfterFees({ bid: 0.50, ask: 0.51 }, { bid: 0.53, ask: 0.54 }, 0, 0.07).dir === "buyPoly" && gapAfterFees({ bid: 0.50, ask: 0.51 }, { bid: 0.53, ask: 0.54 }, 0.03, 0.07).dir === null, "Polymarket's 3% taker fee closes a 2c gap");
  console.assert(feeOf({ feesEnabled: true, feeSchedule: { rate: 0.03 } }) === 0.03 && feeOf({ feesEnabled: false, feeSchedule: { rate: 0.03 } }) === 0, "fee from feeSchedule");
  console.log("gaps self-check ok");
} else if (import.meta.main) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const file = `data/gaps-${stamp}.jsonl`;
  const rows: any[] = [], edges: number[] = [], beatEdges: number[] = [], beatSecs: number[] = [];
  let logged = 0, beating = 0;
  const open = new Map<string, number>(); // label -> consecutive fee-beating samples so far
  const MIN_SIZE = 10; // a gap only counts if at least this many contracts sit at the Polymarket touch we would take
  const tickers = new Map<string, string | null>(); // slug -> found Kalshi ticker, null = none
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function kalshiQuote(slug: string): Promise<Q | null> {
    const known = tickers.get(slug);
    if (known === null) return null;
    for (const t of known ? [known] : kalshiTickers(slug)) {
      await sleep(1000); // public API throttles bursts
      const k = await getJson(`${KALSHI}/markets/${t}`).then((r) => r.market, () => null);
      if (!k) continue;
      tickers.set(slug, t);
      const q = { bid: Number(k.yes_bid_dollars), ask: Number(k.yes_ask_dollars) };
      return q.bid > 0 && q.ask > 0 ? q : null;
    }
    if (!known) tickers.set(slug, null);
    return null;
  }

  async function tick() {
    for (const m of await liveGames().catch(() => [] as any[])) {
      try {
        const slug: string = m.events?.[0]?.slug ?? "";
        if (!kalshiTickers(slug).length) continue;
        const kal = await kalshiQuote(slug);
        if (!kal) continue;
        const poly = { bid: Number(m.bestBid), ask: Number(m.bestAsk) };
        const book = await getJson(`${CLOB}/book?token_id=${JSON.parse(m.clobTokenIds)[0]}`).catch(() => null);
        let bidSize = 0, askSize = 0;
        if (book) { // prefer the live CLOB touch over Gamma's cached best prices
          const bid = Math.max(...book.bids.map((x: any) => Number(x.price))), ask = Math.min(...book.asks.map((x: any) => Number(x.price)));
          if (Number.isFinite(bid) && Number.isFinite(ask)) { poly.bid = bid; poly.ask = ask; }
          bidSize = book.bids.filter((x: any) => Number(x.price) === poly.bid).reduce((t: number, x: any) => t + Number(x.size), 0);
          askSize = book.asks.filter((x: any) => Number(x.price) === poly.ask).reduce((t: number, x: any) => t + Number(x.size), 0);
        }
        const g = gapAfterFees(poly, kal, feeOf(m), 0.07); // Polymarket sports charge takers too (feeSchedule.rate, 0.03 on NFL)
        const size = g.dir === "buyPoly" ? askSize : g.dir === "buyKalshi" ? bidSize : 0;
        const beats = !!g.dir && size >= MIN_SIZE;
        const row = { ts: Date.now(), label: m.question, polyBid: poly.bid, polyAsk: poly.ask, kalBid: kal.bid, kalAsk: kal.ask, gap: g.gap, edge: g.edge, dir: g.dir, size };
        appendFileSync(file, JSON.stringify(row) + "\n");
        rows.push(row); edges.push(g.edge); logged++;
        if (beats) { beating++; beatEdges.push(g.edge); open.set(m.question, (open.get(m.question) ?? 0) + 1); }
        else if (open.has(m.question)) { beatSecs.push(open.get(m.question)! * 60); open.delete(m.question); } // sampled every 60 s: a 1-sample gap reads 60 s
        if (rows.length > 200) rows.shift();
      } catch (e) { console.error(`gaps: ${(e as Error).message}`); }
    }
  }

  const summary = () => {
    const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : null; };
    const secs = [...beatSecs, ...[...open.values()].map((n) => n * 60)];
    return { games: new Set(rows.map((r) => r.label)).size, rowsLogged: logged, feeBeating: beating, medianEdge: med(edges), medianFeeBeatingEdge: med(beatEdges), medianFeeBeatingSecs: med(secs) }; // ponytail: kept in memory, fine for a session
  };
  Bun.serve({ port: Number(process.env.PORT ?? 3090), fetch: () => Response.json({ rows, summary: summary() }, { headers: { "Access-Control-Allow-Origin": "*" } }) });
  console.log(`gaps: logging to ${file}`);
  for (;;) { await tick(); await sleep(60_000); }
}
