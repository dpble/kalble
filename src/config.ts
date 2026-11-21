const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
const num = (key: string) => (env(key) ? Number(env(key)) : undefined);

export const config = {
  rpcUrl: env("RPC_URL", "https://rpc.monad.xyz")!, // sends, receipts, nonce, gas estimation
  readRpcUrl: env("READ_RPC_URL", "https://rpc.monad.xyz")!, // book reads + eth_blockNumber polling + trade logs
  wsUrl: env("WS_URL"), // optional; polling backstop always runs
  chainId: 143,
  market: env("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")!, // Kuru MON-USDC
  /** Kuru MarginAccount this market settles against (slot 73 of the OrderBook proxy; verifiedMarket(market) is true). */
  marginAccount: env("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5")!,
  privateKey: env("PRIVATE_KEY"),
  /** Always true: this build has no live trading. Going live is a separate project (spec non-goal); this keeps the old Kuru signing path unreachable. */
  dryRun: true,
  tradeSizeMon: Number(env("TRADE_SIZE_MON", "200")), // Kuru MON-USDC minimum order is 200 MON
  maxPositionMon: Number(env("MAX_POSITION_MON", "1000")),
  /** Capital the bot may tie up in contracts (dry run enforces it too). Also the base for pnlPct. */
  bankrollUsd: Number(env("BANKROLL_USD", "250")),
  /** Quote this many ticks inside the touch (0 = join the best bid/ask). Never crosses: clamps to the touch when the spread is too tight. */
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** Startup deposits into the Kuru margin account, topped up to these balances. Limit orders draw from margin, not the wallet. */
  marginMon: Number(env("MARGIN_MON", "600")),
  marginUsdc: Number(env("MARGIN_USDC", "20")),
  // Monad charges gas on the LIMIT, so never estimate per block: estimate once at init (or override) and hardcode.
  gasLimit: num("GAS_LIMIT"),
  gasLimitFallback: 350_000, // batchUpdate: one cancel + one post-only place measured at ~282k for the place alone
  // EIP-1559 type-2 only. Effective price = base + priority, so a high static cap is free.
  maxFeeGwei: Number(env("MAX_FEE_GWEI", "400")),
  priorityFeeGwei: Number(env("PRIORITY_FEE_GWEI", "2")), // Monad hardcodes eth_maxPriorityFeePerGas at 2
  pendingBlocks: 10, // give up on a tx with no receipt after this many blocks
  refreshBlocks: 200, // how often to refresh the fee estimate, margin balances and the vault check
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")), // the model is asked about the move over this many blocks (~30 s)
  model: env("MODEL", "mock") as "mock" | "jev" | "flat",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
  /** Prediction-market venues: loop interval in ms (Kalshi throttles public reads; keep it >= 3000 there). */
  tickMs: Number(env("TICK_MS", env("VENUE") === "kalshi" ? "3000" : "1000")),
  marketName: env("VENUE", "kuru") === "kuru" ? "MON-USDC" : `${env("VENUE")} YES contract`,
  /** Events go to data/<RUN_NAME>.jsonl, so two runs on the same market can be compared. */
  runName: env("RUN_NAME", "events")!,
  venue: env("VENUE", "kuru")!,

  // --- Prediction-market quoting (Avellaneda-Stoikov style, two-sided) and risk ---
  /** Ignore model calls weaker than this: |p(buy) - 0.5| < MIN_EDGE quotes as if p = 0.5. */
  minEdge: Number(env("MIN_EDGE", "0.1")),
  /** A full-confidence call moves our reservation price this many expected horizon moves toward the call. */
  signalSkew: Number(env("SIGNAL_SKEW", "1")),
  /** Holding MAX_POSITION moves the reservation price this many expected horizon moves against the position. */
  inventorySkew: Number(env("INVENTORY_SKEW", "3")),
  /** Kill switch: stop quoting once net P&L (exit-marked, after fees and model cost) drops below -MAX_LOSS_USD. */
  maxLossUsd: Number(env("MAX_LOSS_USD", "25")),
  /** Position cap from the loss limit: a contract can gap ADVERSE_MOVE (10c, about one score) before we get out, so cap = MAX_LOSS_USD / ADVERSE_MOVE (250). */
  get maxShares() { return Math.floor(this.maxLossUsd / Number(env("ADVERSE_MOVE", "0.1"))); },
  /** Ask the model every N ticks and reuse its answer in between (Jev cost / N). Same cadence for both models. */
  decideEvery: Number(env("DECIDE_EVERY", "10")),
  /** Pull all quotes for COOLDOWN_TICKS after the mid jumps JUMP_TICKS+ ticks in one tick, or the score changes. */
  jumpTicks: Number(env("JUMP_TICKS", "2")),
  cooldownTicks: Number(env("COOLDOWN_TICKS", "5")),
  /** Longshot rule: never bid below MIN_PRICE or offer above 1 - MIN_PRICE, unless it reduces the position. */
  minPrice: Number(env("MIN_PRICE", "0.1")),
  /** How far to lean toward the other venue's price for the same game: r += FAIR_WEIGHT * (fair - mid). */
  fairWeight: Number(env("FAIR_WEIGHT", "0.5")),
  /** Quote the venue's reward minimum size (and cap position at 2x it) where the market pays liquidity rewards. */
  rewardSizing: env("REWARD_SIZING") === "1",
  /** RECORD=path: save every book and trade poll so the session can be replayed offline (scripts/replay.ts). */
  record: env("RECORD"),
  /** Maker fee per contract = rate * p * (1 - p). Kalshi charges 0.0175 on many markets; Polymarket makers pay 0. */
  makerFeeRate: Number(env("MAKER_FEE_RATE", env("VENUE") === "kalshi" ? "0.0175" : "0")),
  /** Taker fee per contract = rate * p * (1 - p). Kalshi 0.07; Polymarket reads each market's own feeSchedule (sports 0.03, others up to 0.05). Only the flatten exit pays it. */
  takerFeeRate: Number(env("TAKER_FEE_RATE", env("VENUE") === "kalshi" ? "0.07" : "0")),
  /** Strategy tab this bot runs for. "legacy" keeps the old behaviour; the duo runner maps the rest to models. */
  strategy: env("STRATEGY", "legacy") as "farmer" | "longdated" | "odds" | "kalshi" | "lip" | "jev" | "legacy",
  /** True for farmer/longdated/odds/kalshi/lip: exit before the market ends. */
  flatten: ["farmer", "longdated", "odds", "kalshi", "lip"].includes(env("STRATEGY", "legacy")!),
  /** News-type markets (long-dated, Kalshi LIP) can jump straight to 0 or 1: each side is sized so that jump costs at most MAX_LOSS_USD, and after a fill only the reducing side is quoted (exit as a maker, not by paying the taker fee). */
  jumpRisk: ["longdated", "lip", "polyus"].includes(env("STRATEGY", "legacy")!),
  /** Polymarket reward quoting: sit this fraction of the reward band back from mid (0 = one tick inside the touch). Fewer fills, still scores ((1 - d)^2 of the max per share). */
  rewardDepth: Number(env("REWARD_DEPTH", "0")),
  /** Exit the position at the touch this long before the market's expected end, then stay flat. */
  flattenBeforeMs: Number(env("FLATTEN_BEFORE_MS", "1200000")),
  /** Exit (code 10) after this long, so a long-dated bot ends its own session. */
  sessionMs: num("SESSION_MS") ?? null,
  /** Total daily loss limit across bots. */
  dailyLossUsd: Number(env("DAILY_LOSS_USD", "25")),
  /** Exit (code 10) once the market looks finished for this long, so `bun run duo` can move to the next game. */
  endAfterMs: Number(env("END_AFTER_MS", "120000")),
};