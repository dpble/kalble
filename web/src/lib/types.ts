export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
/** This block's post-only limit order. `sent` until its receipt lands, then `placed` or `reverted`. */
export interface Quote { side: Side; price: number; size: number; txHash: string | null; gasMon: number; cancel: number[]; status: "sent" | "placed" | "reverted" | "lost" | "sim"; orderId: number | null; capped: boolean }
/** A taker hit one of our resting orders. */
export interface Fill { side: Side; size: number; price: number; txHash: string | null; orderId: number; simulated: boolean }
export interface Decision { action: Action; probabilities: { buy: number; sell: number; hold: number }; upIn10: number; latencyMs: number; late: boolean; reused?: boolean; pWin?: number }
export interface Position { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number }
export interface Totals { blocks: number; decisions: number; quotes: number; fills: number; reverted: number; lateBlocks: number; jevUsd: number; gasMon: number; gasUsd: number; realizedUsd: number; pnlUsd: number; pnlMon: number; pnlPct: number; feesUsd?: number; netUsd?: number; rewardsUsd?: number }
export interface BlockEvent { block: number; ts: number; mid: number; bestBid: number; bestAsk: number; spreadBps: number; decision: Decision | null; quote: Quote | null; fill: Fill | null; resting: { bidMon: number; askMon: number }; position: Position; totals: Totals; quotes?: Quote[]; halted?: boolean; game?: Game | null; fairSource?: "odds" | "none" }
export interface Game { title: string; score: string | null; period: string | null; elapsed: string | null; live: boolean | null; ended: boolean | null }
export interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number; venue: string; runName: string; tickMs: number; horizonBlocks: number; hasKey: boolean; hasOddsKey?: boolean; halted?: boolean; strategy?: string; fairSource?: "odds" | "kalshi" | "none" | null }
export type ConnectionState = "connecting" | "live" | "reconnecting";
export interface FeedError { message: string; ts: number }
export interface FeedState { meta: Meta | null; events: BlockEvent[]; latest: BlockEvent | null; connection: ConnectionState; avgLatencyMs: number; lastError: FeedError | null }
