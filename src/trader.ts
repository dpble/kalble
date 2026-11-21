import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";
import { TradeFeed, type MakerFill, type TradePrint } from "./trades";
import { shareOf, type Rewards } from "./venues";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  /** `reused`: the model was not asked this tick (DECIDE_EVERY); this is its last answer. */
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean; reused?: boolean; pWin?: number | null } | null;
  /** The other venue's price for this outcome when fresh, and whether quotes were pulled this tick (jump / score change). */
  fair?: number | null;
  pulled?: boolean;
  /** Odds strategy only: "odds" once a sportsbook price has come back, "none" until then. */
  fairSource?: "odds" | "none";
  /** This tick the bot was exiting before the market ends (no quotes). */
  flattened?: true;
  /** The order this block put on the book (two-sided venues: the one on the side the model favours). */
  quote: Quote | null;
  /** Every order this block put on the book (two-sided venues post a bid and an ask). */
  quotes: Quote[];
  /** Kill switch tripped (loss limit or manual): no quotes until the session is reset. */
  halted: boolean;
  /** Live score/clock where the venue has it. */
  game: TradeState["game"];
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
  /** Maker fees on simulated fills. */
  feesUsd: number;
  /** Estimated liquidity-reward share (dry run: an estimate from the public book, see rewardTick). */
  rewardsUsd: number;
  /** The honest number: realized + position marked where it could actually be closed (bid if long, ask if short) - fees - gas - model cost. */
  netUsd: number;
}

/** `joined`: rested at an existing price level, so others were ahead of us in the queue. */
interface Resting { side: Side; price: number; size: number; block: number; joined?: boolean; at?: number } // at = when it went up (ms)

/**
 * Every block: read the book, ask the model buy or sell, and post one post-only limit order on
 * that side (`quoteInsideTicks` inside the touch), cancelling whatever we had resting. One request
 * in flight; a block that arrives while the previous one is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its receipt
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the Trade log feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills when a real print crosses its price.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  /** Orders we know are resting on the book (live: from receipts; dry run: last block's simulated order). */
  private orders = new Map<number, Resting>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote>();
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private totals: Totals = Trader.zero();
  private halted = false;
  private killed = false; // the loss kill switch fired: exit the position, not just stop quoting
  private last: { decision: Decision; block: number } | null = null;
  private cooldownUntil = 0;
  private lastScore: string | null | undefined;
  private pulled = false;
  /** Per-block failures (model call, book read), so the dashboard can show them. */
  onError: (message: string) => void = () => {};
  private static zero(): Totals { return { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0, feesUsd: 0, netUsd: 0, rewardsUsd: 0 }; }

  get modelName() { return this.model.name; }

  /** Swap the model mid-run (dry run only). Starts a fresh session: stats, position and resting orders reset. */
  setModel(model: Model) {
    this.model = model;
    this.history.length = 0;
    this.totals = Trader.zero();
    this.position = { mon: 0, costUsd: 0 };
    this.orders.clear();
    this.mids = [];
    this.halted = false;
    this.killed = false;
    this.last = null;
    this.cooldownUntil = 0;
  }

  /** Kill switch (manual or the loss limit): pull every quote and exit the position. A real-money bot must not sit on inventory once stopped. */
  halt(on: boolean) {
    this.halted = on;
    if (!on) this.killed = false;
    if (on) this.orders.clear();
  }
  get isHalted() { return this.halted; }
  /** The loss limit fired and the position is closed: nothing left to do in this market. */
  get doneAfterKill() { return this.killed && this.position.mon === 0; }
  get isFlat() { return this.position.mon === 0; }

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
  }

  /** Call once the market params are known. Without it `trades` in the state is all zeros and no fills are ever seen. */
  attachTradeFeed(sizeDec: number, feed?: TradeFeed) {
    if (feed) { this.trades = feed; return; }
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec, maker: this.market.address });
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh().catch(() => {}); // fee estimate + margin + vault check
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, [], null, true);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const venue = config.venue !== "kuru";
      // Venues: book and new prints arrive together, and prints are checked against the orders that were
      // resting during them BEFORE this tick replaces those orders. (Kuru keeps its async log poll.)
      const book = venue ? await (this.market as unknown as { readBook(block: number): Promise<Book> }).readBook(block) : await this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      if (venue) this.harvest();
      else this.trades?.poll(block).then(() => this.harvest()); // off the hot path: eth_getLogs for prints (and our fills) since the last poll

      // Ask the model every DECIDE_EVERY ticks; quotes still refresh every tick with the new book and inventory.
      const fresh = !this.last || block - this.last.block >= config.decideEvery;
      const decision: Decision & { reused?: boolean } = fresh
        ? await this.model.decide(this.buildState(block, book))
        : { ...this.last!.decision, latencyMs: 0, inputTokens: 0, reused: true };
      if (fresh) this.last = { decision: { ...decision }, block };
      const wanted: Side = decision.action === "sell" ? "sell" : "buy";
      const other: Side = wanted === "buy" ? "sell" : "buy";
      // The position cap (and, live, margin funds) can only pick the reducing side. The probabilities still show the model's call.
      const side: Side | null = this.allowed(wanted, book) ? wanted : this.allowed(other, book) ? other : null;
      if (fresh) this.totals.decisions++;
      if (this.model.name !== "mock") this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok; // the mock runs for free

      let quote: Quote | null = null, quotes: Quote[] = [], flattened = false;
      if (config.venue !== "kuru" && this.flattening()) { this.flattenTick(block, book); flattened = true; this.orders.clear(); } // even when halted: never hold into settlement
      if (this.halted) {
        this.orders.clear();
        this.pulled = false;
      } else if (config.venue !== "kuru") {
        quotes = this.twoSided(block, book, decision.probabilities.buy);
        this.totals.rewardsUsd += this.rewardTick(book, quotes);
        quote = quotes.find((q) => q.side === wanted) ?? quotes[0] ?? null;
        this.totals.quotes += quotes.length;
      } else if (side) {
        decision.action = side;
        const cancel = [...this.orders.keys()].filter((id) => id > 0); // simulated orders have negative ids
        quote = await this.market.send(block, side, config.tradeSizeMon, book, cancel, side !== wanted);
        this.totals.quotes++;
        if (quote.status === "sim") {
          this.orders.clear(); // the simulated cancel
          this.orders.set(--this.simId, { side, price: quote.price, size: quote.size, block, at: Date.now() });
        } else if (quote.txHash) {
          this.inflight.set(quote.txHash, quote);
        }
        quotes = [quote];
      }
      this.emit(block, book, decision, quotes, quote, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) }, flattened);
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
      this.onError((e as Error).message);
      if (this.lastBook && config.venue !== "kuru") this.emit(block, this.lastBook, null, [], null, true); // a failed read must not switch off the loss limit: check it on the last good book
    } finally {
      this.busy = false;
    }
  }

  /**
   * Avellaneda-Stoikov style two-sided quote. Reservation price
   *   r = mid + (SIGNAL_SKEW * edge - INVENTORY_SKEW * q) * expected horizon move
   * edge = the model's call (-1..1, zero below MIN_EDGE), q = position / MAX_POSITION (-1..1).
   * Bid and ask sit half a tick either side of r, each at most one tick inside the touch, never crossing.
   * Long inventory pulls r down (bid less eagerly); a confident buy call pulls it up.
   */
  private twoSided(block: number, book: Book, pBuy: number): Quote[] {
    const vm = this.vm;
    const t = vm.tick, ticks = (x: number) => Math.round(x / t);
    this.orders.clear(); // the simulated cancel
    if (this.flattening()) return [];

    // Event guard: a jump of JUMP_TICKS+ in one tick or a score change means news is hitting the book. Step aside.
    const prev = this.mids.at(-2);
    const score = vm.game?.score ?? null;
    if ((prev !== undefined && Math.abs(book.mid - prev) >= config.jumpTicks * t - 1e-9) || (this.lastScore !== undefined && score !== this.lastScore)) this.cooldownUntil = block + config.cooldownTicks;
    this.lastScore = score;
    this.pulled = block < this.cooldownUntil;
    if (this.pulled) return [];

    const move = Math.max(this.sigma() * Math.sqrt(config.horizonBlocks), t);
    const edge = Math.abs(pBuy - 0.5) >= config.minEdge ? (pBuy - 0.5) * 2 : 0;
    const q = this.position.mon / this.maxPos;
    const fair = this.fairNow();
    const r = book.mid + (fair === null ? 0 : config.fairWeight * (fair - book.mid)) + (config.signalSkew * edge - config.inventorySkew * q) * move;
    const out: Quote[] = [];
    const rw = this.vm.rewards, poly = !!rw && !rw.target; // Polymarket-style band (Kalshi LIP joins the touch instead)
    for (const side of ["buy", "sell"] as const) {
      const reduces = side === "buy" ? this.position.mon < 0 : this.position.mon > 0;
      if (config.jumpRisk && this.position.mon !== 0 && !reduces) continue; // holding: only work the exit, as a maker
      const room = this.room(side, book);
      if (room < 1e-9) continue;
      const touch = ticks(vm.quotePrice(side, book));
      let n = side === "buy" ? Math.min(touch, Math.floor((r - t / 2) / t + 1e-9)) : Math.max(touch, Math.ceil((r + t / 2) / t - 1e-9));
      // REWARD_DEPTH: sit back in the band instead of leading the queue (fewer fills, most of which are the bad ones).
      if (poly && config.rewardDepth > 0) { const back = (config.rewardDepth * rw!.maxSpreadC) / 100; n = side === "buy" ? Math.min(n, Math.floor((book.mid - back) / t + 1e-6)) : Math.max(n, Math.ceil((book.mid + back) / t - 1e-6)); }
      // Inventory skew must not push a quote out of the reward band (it then earns nothing); the position cap already limits how much we add.
      // On a wide book that can mean quoting deeper inside the spread than usual, but never crossing it.
      if (poly) { const band = rw!.maxSpreadC / 100 - t; n = side === "buy" ? Math.min(ticks(book.ask) - 1, Math.max(n, Math.ceil((book.mid - band) / t - 1e-6))) : Math.max(ticks(book.bid) + 1, Math.min(n, Math.floor((book.mid + band) / t + 1e-6))); }
      const price = Math.round(n * t * 1e6) / 1e6;
      if (price <= 0 || price >= 1) continue;
      // Longshot rule: cheap contracts lose more often than their price says, so never buy one (or sell its opposite) to open.
      if (!reduces && (side === "buy" ? price < config.minPrice : price > 1 - config.minPrice)) continue;
      // ...and a reducing order in the longshot zone only closes the position, never flips it (a full 1000-lot bid flipped a 772 short into a 228 long at 5c)
      const longshot = side === "buy" ? price < config.minPrice : price > 1 - config.minPrice;
      // Size: what the caps leave room for; an opening Polymarket quote under the reward minimum earns nothing, so it is not posted.
      const size = Math.min(this.size, room, longshot ? Math.abs(this.position.mon) : Infinity);
      if (!reduces && poly && size < rw!.minSize) continue;
      const quote: Quote = { side, price, size, txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false };
      this.orders.set(--this.simId, { side, price, size: quote.size, block, at: Date.now(), joined: side === "buy" ? price <= book.bid : price >= book.ask });
      out.push(quote);
    }
    return out;
  }

  /** Inside the last FLATTEN_BEFORE_MS before the market's expected end, or the live game says it is over or in its final period: stop quoting and exit. */
  private flattening() {
    if (this.halted) return true; // kill switch: manual or loss limit
    if (!config.flatten) return false;
    const { expectedEnd: end, game } = this.vm;
    return (!!end && Date.now() > end - config.flattenBeforeMs) || game?.ended === true || FINAL_PERIOD.test(String(game?.period ?? "").trim());
  }

  /**
   * Exit the position as a taker, walking the visible levels on the exit side (bids for a long, asks for a short):
   * fill what that depth allows this tick (one fill, size-weighted price, taker fee per level); the rest retries next tick.
   * No usable price on that side (empty book) = hold and retry.
   */
  private flattenTick(block: number, book: Book) {
    const mon = this.position.mon;
    if (!mon) return;
    const side: Side = mon > 0 ? "sell" : "buy";
    const levels = (mon > 0 ? book.levels?.bids : book.levels?.asks) ?? [[mon > 0 ? book.bid : book.ask, Infinity]]; // no depth info: the whole size at the touch
    let left = Math.abs(mon), size = 0, cost = 0, fee = 0;
    const touch = levels[0]?.[0] ?? 0, rate = this.vm.takerFee ?? config.takerFeeRate;
    for (const [price, depth] of levels) {
      if (left <= 1e-9) break;
      if (Math.abs(price - touch) > FLATTEN_TICKS * this.vm.tick + 1e-9) break; // no dumping through a thin book in one tick: the rest retries next tick
      if (!(price > 0 && price < 1) || !(depth > 0)) continue;
      const q = Math.min(left, depth);
      size += q; cost += q * price; fee += rate * q * price * (1 - price); left -= q;
    }
    if (!size) return;
    const fill: Fill = { side, size, price: cost / size, txHash: null, orderId: 0, simulated: true };
    this.applyFill(fill, true, fee);
    if (config.runName) appendFileSync(`data/${config.runName}.fills.jsonl`, JSON.stringify({ block, ts: Date.now(), side, size, price: fill.price, mid: book.mid, taker: true }) + "\n");
    this.onFill(block, fill);
  }

  private get vm() {
    return this.market as unknown as { expectedEnd?: number | null; tick: number; quotePrice(side: Side, book: Book): number; game?: TradeState["game"]; fair?: number | null; fairAt?: number; fairSource?: string | null; rewards?: Rewards | null; takerFee?: number };
  }
  /** The fair price if it is fresh: 30 s for a Kalshi mid; sportsbook odds 35 min before the game (cache + margin), 2 min once it is live (one score moves the price 10c). */
  private fairNow() {
    const v = this.vm, maxAge = v.fairSource === "odds" ? (v.game?.live ? 120_000 : 35 * 60_000) : 30_000;
    return v.fair != null && Date.now() - (v.fairAt ?? 0) < maxAge ? v.fair : null;
  }
  /** Order size and position cap: the reward minimum (cap 2x) when REWARD_SIZING=1 and the market pays rewards. */
  private get size() {
    const rw = config.rewardSizing ? this.vm.rewards : null;
    return Math.min(rw ? Math.max(config.tradeSizeMon, rw.minSize) : config.tradeSizeMon, config.maxShares);
  }
  /** Position cap: 2 orders, but never past what the loss limit can carry (config.maxShares). */
  private get maxPos() { return Math.min(Math.max(config.maxPositionMon, 2 * this.size), config.maxShares); }

  /** This tick's slice of the daily reward pool (see rewardShare). ponytail: accrued every tick, Polymarket samples once a minute. */
  private rewardTick(book: Book, quotes: Quote[]) {
    const rw = this.vm.rewards;
    if (!rw || config.venue === "kuru") return 0;
    return shareOf(rw, book.mid, (book.all ?? book.levels).bids, (book.all ?? book.levels).asks, quotes) * rw.dailyUsd * (config.tickMs / 86_400_000);
  }

  /** Per-tick volatility of the mid (RMS of tick-to-tick changes over the last 300 ticks). */
  private sigma() {
    const m = this.mids.slice(-300);
    if (m.length < 3) return 0;
    let s = 0;
    for (let i = 1; i < m.length; i++) s += (m[i]! - m[i - 1]!) ** 2;
    return Math.sqrt(s / (m.length - 1));
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, canceled }: QuoteResult) {
    if (quote.txHash) this.inflight.delete(quote.txHash);
    this.totals.gasMon += quote.gasMon; // charged on reverts too
    if (quote.status === "reverted") this.totals.reverted++;
    for (const id of canceled) this.orders.delete(id);
    if (quote.status === "placed" && quote.orderId !== null) this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    this.onQuote(block, quote);
  }

  /** After each trade-log poll: apply our maker fills (live) or simulate them against the new prints (dry run). */
  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    const fills: Fill[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      if (config.runName) appendFileSync(`data/${config.runName}.fills.jsonl`, JSON.stringify({ block: (f as Fill & { block: number }).block, ts: Date.now(), side: f.side, size: f.size, price: f.price, mid: this.lastBook?.mid ?? null }) + "\n");
      const b = (f as Fill & { block: number }).block;
      byBlock.set(b, [...(byBlock.get(b) ?? []), f]);
    }
    for (const [block, fs] of byBlock) {
      const fill = aggregate(fs);
      const e = this.history.find((h) => h.block === block);
      if (e) e.fill = fill;
      this.onFill(block, fill);
    }
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.size = f.updatedSize;
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, block: f.block });
    }
    return out;
  }

  /**
   * A simulated order placed at block N is on the book from N+1. A taker sell printing at or below
   * our bid (or a taker buy at or above our ask) would have taken us first: fill up to the print's size.
   * If we only joined an existing level, others were queued ahead: it takes a print through our price.
   * ponytail: no queue model beyond that, so fills at an improved price are still optimistic.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        if (p.ts !== undefined && o.at !== undefined && p.ts < o.at) continue; // the trade happened before our order was up
        const through = o.joined ? 1e-9 : 0;
        const hit = o.side === "buy" ? p.side === "sell" && p.price <= o.price - through : p.side === "buy" && p.price >= o.price + through;
        if (!hit) continue;
        const size = Math.min(o.size, p.size);
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        out.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, block: p.block });
      }
    }
    return out;
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const q of this.inflight.values()) if (q.side === side) mon += q.size;
    return mon;
  }

  /** Would this order, and everything already resting on its side, keep us inside the cap and (live) inside margin funds? */
  private allowed(side: Side, book: Book) {
    if (config.venue !== "kuru") return this.room(side, book) >= this.size;
    const size = config.tradeSizeMon;
    const exposure = side === "buy" ? this.position.mon + this.restingMon("buy") + size : this.position.mon - this.restingMon("sell") - size;
    if (Math.abs(exposure) > config.maxPositionMon) return false;
    if (!this.market.wallet) return true;
    // Kuru debits margin when an order is placed, so the balance already excludes what is resting.
    return side === "buy" ? this.market.margin.usdc >= size * book.ask : this.market.margin.mon >= size;
  }

  /**
   * Contracts we may still add on this side (venues): the position cap, and capital: a long ties up p a contract, a short 1 - p.
   * Jump-risk strategies cap that capital at MAX_LOSS_USD, because a news market can go straight to 0 or 1.
   */
  private room(side: Side, book: Book) {
    const dir = side === "buy" ? 1 : -1;
    const pos = this.position.mon + dir * this.restingMon(side); // signed, counting what already rests on this side
    const limit = Math.min(config.bankrollUsd, config.jumpRisk ? config.maxLossUsd : Infinity);
    const capital = limit / (side === "buy" ? book.mid : 1 - book.mid) - dir * pos;
    return Math.max(0, Math.floor(Math.min(this.maxPos - dir * pos, capital) + 1e-9));
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const empty = { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null };
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    return {
      market: config.marketName,
      block,
      horizonBlocks: H,
      blockMs: config.marketName === "MON-USDC" ? 300 : config.tickMs,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : empty,
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
      game: (this.market as unknown as { game?: TradeState["game"] }).game ?? null,
      tradesLong: this.longFlow(block),
      expectedMoveCents: round(this.sigma() * Math.sqrt(H) * 100, 2),
      otherVenueMid: this.fairNow(),
    };
  }

  private longFlow(block: number): TradeState["tradesLong"] {
    const windowSec = 300, blocks = Math.round((windowSec * 1000) / (config.venue === "kuru" ? 300 : config.tickMs));
    const s = this.trades?.summary(blocks, block);
    return { windowSec, count: s?.count ?? 0, buyMon: round(s?.buyMon ?? 0, 1), sellMon: round(s?.sellMon ?? 0, 1), cvdMon: round(s?.cvdMon ?? 0, 1), vwap: s?.vwap ?? null };
  }

  /** `fee` overrides the fee for this fill (flatten: summed per level). */
  private applyFill(f: Fill, taker = false, fee?: number) {
    if (f.size <= 0) return;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    this.totals.feesUsd += fee ?? (taker ? config.takerFeeRate : config.makerFeeRate) * f.size * f.price * (1 - f.price);
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    this.totals.fills++;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, quotes: Quote[], quote: Quote | null, late: boolean, timing?: Timing, flattened = false) {
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd;
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const exit = this.position.mon > 0 ? book.bid : book.ask;
    const exitUnrealized = this.position.mon ? this.position.mon * (exit - this.entryPrice()!) : 0;
    t.netUsd = t.realizedUsd + exitUnrealized - t.feesUsd - t.gasUsd - t.jevUsd + t.rewardsUsd;
    if (!this.killed && t.netUsd - t.rewardsUsd < -config.maxLossUsd) { // rewards are an estimate: trading losses alone trip it
      this.halt(true);
      this.killed = true;
      this.onError(`kill switch: net P&L $${t.netUsd.toFixed(2)} is below -$${config.maxLossUsd}, quoting stopped, exiting the position`);
    }
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false, reused: (decision as { reused?: boolean }).reused || undefined, pWin: decision.pWin ?? undefined },
      fair: this.fairNow(),
      fairSource: process.env.FAIR_SOURCE === "odds" ? (this.market as unknown as { fairSource?: "odds" | "none" }).fairSource : undefined,
      pulled: this.pulled || undefined,
      flattened: flattened || undefined,
      quote,
      quotes,
      halted: this.halted,
      game: (this.market as unknown as { game?: TradeState["game"] }).game ?? null,
      fill: null,
      resting: { bidMon: round(this.restingMon("buy"), 1), askMon: round(this.restingMon("sell"), 1) },
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3), feesUsd: round(t.feesUsd, 4), netUsd: round(t.netUsd, 4), rewardsUsd: round(t.rewardsUsd, 4) },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    if (config.runName) appendFileSync(`data/${config.runName}.jsonl`, JSON.stringify(event) + "\n"); // empty RUN_NAME (replays) = no file
    this.onEvent(event, timing);
  }
}

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[]): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
/** Game periods that mean the end is near: flatten now rather than wait for the expected end. */
/** Flatten walks at most this many ticks past the touch per tick. */
const FLATTEN_TICKS = 3;
export const FINAL_PERIOD = /^(q4|4q|4th|ot|2ot|p3|3rd|3p|2h|h2|9th|top 9|bot 9|bottom 9|extra)/i;
