import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

/** Models answer buy or sell. `hold` only appears on late blocks (no decision was made). */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: string; // "MON-USDC" on Kuru, or "<venue> YES contract" (price 0..1 = implied probability)
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting MON within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  allowed: { buy: boolean; sell: boolean };
  /** Live game state (Polymarket only; null elsewhere). score is "home-away" as the venue reports it. */
  game: Game | null;
  /** Same taker-flow summary over the last ~5 minutes, to tell a burst from a trend. */
  tradesLong: { windowSec: number; count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null };
  /** Typical size of a move over the horizon, in cents (from recent tick-to-tick volatility). */
  expectedMoveCents: number;
  /** Mid of the same outcome on the other venue (Kalshi for a Polymarket game), or null. */
  otherVenueMid: number | null;
}

export interface Game { title: string; score: string | null; period: string | null; elapsed: string | null; live: boolean | null; ended: boolean | null }

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
  /** Jev's probability that YES wins the game (prediction markets only; null for the mock). */
  pWin?: number | null;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will the price of `market` be higher or lower than the current mid after `horizonBlocks` more blocks?",
      goal: "Make markets on `market`. A block is one decision step of `blockMs` ms; `horizonBlocks` blocks is the horizon. On a prediction market the price is the YES contract in dollars (0..1, the implied probability) and moves on game events. Every block one post-only limit order goes on the side you pick, just inside the touch, replacing the previous one. It never crosses, so we earn `spreadBps` rather than pay it. The cost is adverse selection: a taker fills us exactly when the market is about to run the other way. Pick the side whose inventory you want to be holding `horizonBlocks` from now.",
      timing: "The order rests on the book from the next block until it is replaced, cancelled or filled. It fills only when a taker crosses it: a bid is filled by a taker sell, an ask by a taker buy. Most blocks do not fill.",
      inputs: "Taker flow is the strongest signal: `trades.cvdMon` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book, and therefore who would hit us. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. A wide `spreadBps` means more edge per fill. If `allowed.buy` is false the order goes on the sell side regardless, and vice versa. `game` (when present) has the live score, period and clock: late in a close game prices jump on every score, late in a blowout they drift toward 0 or 1. `tradesLong` is the same flow over about 5 minutes. `expectedMoveCents` is how far price usually moves over the horizon; a call only matters if the move you expect beats the spread.",
    },
    criteria: {
      buy: "Post a bid: mid more likely to be higher after `horizonBlocks` blocks. A fill here leaves us long, bought below mid.",
      sell: "Post an ask: mid more likely to be lower after `horizonBlocks` blocks. A fill here leaves us short, sold above mid.",
    },
  },
} as const;

/** Prediction markets only: a second question in the same call, Jev's own fair price for the contract. */
const WIN = {
  win: {
    type: "choice",
    instructions: {
      question: "Will the YES outcome of `market` win, so the contract settles at $1?",
      goal: "Give your honest probability that YES wins. `mid` is the market's price, `otherVenueMid` another exchange's price for the same outcome, `game` the live score and clock. Only move away from those prices for a concrete reason in the game state.",
    },
    criteria: { yes: "YES wins: the contract settles at $1.", no: "YES loses: the contract settles at $0." },
  },
} as const;

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel implements Model {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const venue = config.venue !== "kuru";
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: venue ? { ...QUESTIONS, ...WIN } : QUESTIONS, maxRetries: 0 });
    const a = r.answers.direction;
    const w = (r.answers as any).win;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
      pWin: w ? (w.probabilities?.yes ?? (w.choice === "yes" ? 1 : 0)) : null,
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + mean reversion toward flat. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // momentum + book imbalance + noise, pulled back toward flat so it trades both ways
    const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.block);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    if (!process.env.REPLAY) await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production (not in offline replays)
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(block: number) {
    let h = block * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

/**
 * Jev needs TYPESAFE_AI_API_KEY. Without one every call fails, so every block is a late hold and
 * the dashboard shows nothing happening. Run the mock instead: the snapshot names it, so the
 * dashboard labels it as a stand-in rather than passing it off as Jev.
 */
/** No model calls: a neutral answer every tick, so the quoting engine runs on its own (reward farming). */
export class FlatModel implements Model {
  readonly name = "flat";
  async decide(): Promise<Decision> {
    return { action: "hold", probabilities: { buy: 0.5, sell: 0.5, hold: 0 }, upIn10: 0.5, latencyMs: 0, inputTokens: 0 };
  }
}

export const createModel = (kind: "mock" | "jev" | "flat" = config.model): Model => {
  if (kind === "flat") return new FlatModel();
  if (kind !== "jev") return new MockModel();
  if (!process.env.TYPESAFE_AI_API_KEY?.trim()) {
    console.warn("MODEL=jev but TYPESAFE_AI_API_KEY is not set: running the mock model instead");
    return new MockModel();
  }
  return new JevModel();
};
