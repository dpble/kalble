/** bun run scripts/quote-check.ts: two-sided quoting, inventory skew, and the joined-level fill rule. No network. */
process.env.VENUE = "polymarket";
process.env.TAKER_FEE_RATE = "0.07";
process.env.STRATEGY = "farmer";
process.env.TRADE_SIZE_MON = "20";
process.env.MAX_POSITION_MON = "100";
process.env.INVENTORY_SKEW = "1.5"; // expected prices below assume this skew
process.env.RUN_NAME = "quote-check";
const { Trader } = await import("../src/trader");

const market: any = { wallet: null, address: null, tick: 0.01, fair: null, fairAt: 0, rewards: null, quotePrice: (side: string, b: any) => (side === "buy" ? b.bid + 0.01 : b.ask - 0.01) }; // one tick inside (wide book)
const book = { bid: 0.48, ask: 0.52, mid: 0.5 } as any;
const t = new Trader(market as any, { name: "mock" } as any, () => {}) as any;
const px = (qs: any[]) => Object.fromEntries(qs.map((q) => [q.side, Math.round(q.price * 100)]));
const eq = (a: any, b: any, msg: string) => console.assert(JSON.stringify(a) === JSON.stringify(b), msg, a, "!=", b);

eq(px(t.twoSided(1, book, 0.5)), { buy: 49, sell: 51 }, "flat + neutral: one tick inside both sides");
eq(px(t.twoSided(1, book, 0.55)), { buy: 49, sell: 51 }, "weak call below MIN_EDGE changes nothing");
eq(px(t.twoSided(1, book, 0.9)), { buy: 49, sell: 52 }, "confident buy call: ask backs off");
t.position = { mon: 50, costUsd: 25 };
eq(px(t.twoSided(1, book, 0.5)), { buy: 48, sell: 51 }, "half long: bid backs off");
t.position = { mon: 100, costUsd: 50 };
eq(px(t.twoSided(1, book, 0.5)), { sell: 51 }, "at max long: no bid");

// joined level (bid 0.48 = best bid) needs a print through it
t.position = { mon: 50, costUsd: 25 };
t.twoSided(1, book, 0.5);
eq(t.simFills([{ block: 2, side: "sell", price: 0.48, size: 5 }]).length, 0, "print at a joined level does not fill us");
eq(t.simFills([{ block: 2, side: "sell", price: 0.47, size: 5 }]).length, 1, "print through it does");

// event guard: a 2-tick jump pulls all quotes for COOLDOWN_TICKS (5)
t.position = { mon: 0, costUsd: 0 };
t.mids = [0.5, 0.52];
eq(t.twoSided(10, { bid: 0.5, ask: 0.54, mid: 0.52 }, 0.5).length, 0, "jump pulls quotes");
t.mids = [0.52, 0.52];
eq(t.twoSided(14, { bid: 0.5, ask: 0.54, mid: 0.52 }, 0.5).length, 0, "still cooling down");
eq(t.twoSided(15, { bid: 0.5, ask: 0.54, mid: 0.52 }, 0.5).length, 2, "back after the cooldown");

// longshot rule: no bid under 10c to open, but a bid that reduces a short is fine
t.mids = [0.07, 0.07];
eq(px(t.twoSided(20, { bid: 0.06, ask: 0.08, mid: 0.07 }, 0.5)), { sell: 8 }, "no longshot bid");
t.position = { mon: -20, costUsd: -1.6 };
eq(px(t.twoSided(21, { bid: 0.06, ask: 0.08, mid: 0.07 }, 0.5)).buy, 6, "reducing bid allowed");
t.position = { mon: -5, costUsd: -0.4 };
eq(t.twoSided(22, { bid: 0.06, ask: 0.08, mid: 0.07 }, 0.5).find((q: any) => q.side === "buy").size, 5, "longshot reducing bid only closes, never flips");

// fair price: Kalshi at 0.56 vs mid 0.50 with weight 0.5 leans r up 3c
t.position = { mon: 0, costUsd: 0 };
t.mids = [0.5, 0.5];
market.fair = 0.56; market.fairAt = Date.now();
eq(px(t.twoSided(30, book, 0.5)), { buy: 49, sell: 54 }, "lean toward fair: ask backs off");
market.fair = null;

// rewards: one qualifying two-sided quote against an empty book takes the whole pool for the tick
market.rewards = { minSize: 20, maxSpreadC: 2.5, dailyUsd: 86_400 };
const wide = { ...book, levels: { bids: [], asks: [] } };
const r1 = t.rewardTick(wide, t.twoSided(40, book, 0.5));
console.assert(Math.abs(r1 - 1) < 1e-9, "full pool share = $1 per 1 s tick", r1);
const crowded = { ...book, levels: { bids: [[0.49, 1e6]], asks: [[0.51, 1e6]] } };
console.assert(t.rewardTick(crowded, t.twoSided(41, book, 0.5)) < 0.001, "tiny share in a crowded book");
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
// halted bot still flattens: the onBlock path runs flattenTick before the halted branch
t.position = { mon: 20, costUsd: 9.6 }; t.halted = true; t.busy = false;
market.expectedEnd = Date.now() + 60_000;
market.readBook = async () => ({ ...book, spreadBps: 800, imbalance: 0, depthBps: {}, levels: { bids: [[0.48, 100]], asks: [[0.52, 100]] } }); market.pollPending = async () => []; market.refresh = async () => {};
t.model = { name: "flat", decide: async () => ({ action: "hold", probabilities: { buy: 0.5, sell: 0.5, hold: 0 }, upIn10: 0.5, latencyMs: 0, inputTokens: 0 }) };
await t.onBlock(32);
eq(t.position.mon, 0, "halted bot flattened in the window");
t.halted = false;
// M1: the exit walks the visible bids: 20 at 0.48 + 10 at 0.45 this tick, the last 10 wait for the next tick
t.position = { mon: 40, costUsd: 19.2 }; t.totals.realizedUsd = 0; t.totals.feesUsd = 0;
t.flattenTick(33, { ...book, levels: { bids: [[0.48, 20], [0.45, 10]], asks: [[0.52, 100]] } });
eq(t.position.mon, 10, "only the visible depth fills: 10 left");
eq(+t.totals.realizedUsd.toFixed(4), +(-10 * 0.03).toFixed(4), "size-weighted exit: 10 sold 3c under entry");
eq(+t.totals.feesUsd.toFixed(6), +(0.07 * (20 * 0.48 * 0.52 + 10 * 0.45 * 0.55)).toFixed(6), "taker fee per level");
// I3: the game is in its final period: flatten now even though the expected end is hours away
market.expectedEnd = Date.now() + 5 * 3600_000;
market.game = { period: "Q4", ended: false };
console.assert(t.flattening() === true, "period Q4 triggers flattening");
// kill switch exits: a killed bot flattens even with the game hours from its end, and a manual resume clears it
market.game = { period: "Q1", ended: false };
console.assert(t.flattening() === false, "Q1, far from the end: no flatten");
t.killed = true; t.halted = true;
console.assert(t.flattening() === true, "loss kill switch: flatten now");
t.halt(false);
console.assert(t.flattening() === false && t.killed === false, "resume clears the kill flatten");
t.halt(true);
console.assert(t.flattening() === true, "manual halt also exits the position");
t.halt(false);
market.game = { period: "Q2", ended: false };
console.assert(t.flattening() === false, "period Q2 does not");
market.game = { period: null, ended: true };
console.assert(t.flattening() === true, "game ended triggers flattening");
market.game = null;
// D2: odds fair stays fresh for 35 min (its fetch time), a Kalshi mid only 30 s
market.fair = 0.6; market.fairAt = Date.now() - 10 * 60_000; market.fairSource = "odds";
console.assert(t.fairNow() === 0.6, "10 min old odds: fresh");
market.fairAt = Date.now() - 40 * 60_000;
console.assert(t.fairNow() === null, "40 min old odds: stale");
market.fairSource = "kalshi"; market.fairAt = Date.now() - 60_000;
console.assert(t.fairNow() === null, "1 min old Kalshi mid: stale");
market.fair = null; market.fairSource = null;
market.expectedEnd = null;

// C1: a print that happened before our order went up cannot fill it (the 5-min-stale trade batches did)
t.position = { mon: 0, costUsd: 0 }; t.mids = [0.5, 0.5]; t.cooldownUntil = 0; market.rewards = null;
t.twoSided(50, book, 0.5);
const placed = [...t.orders.values()][0].at;
eq(t.simFills([{ block: 51, ts: placed - 1000, side: "sell", price: 0.40, size: 5 }]).length, 0, "stale print: no fill");
eq(t.simFills([{ block: 51, ts: placed + 10, side: "sell", price: 0.40, size: 5 }]).length, 1, "print after the order: fills");
// C3: the position cap comes from the loss limit: $25 / 10c = 250, even when the reward minimum asks for 1000
process.env.MAX_LOSS_USD = "25";
const { config } = await import("../src/config");
console.assert(config.maxShares === 250, "250 shares from $25 / 10c", config.maxShares);
const oldPos = config.maxPositionMon, oldSizing = config.rewardSizing;
(config as any).maxPositionMon = 5000; (config as any).rewardSizing = true; market.rewards = { minSize: 1000, maxSpreadC: 3, dailyUsd: 100 };
console.assert(t.maxPos === 250 && t.size === 250, "1000-share reward minimum capped at 250", t.maxPos, t.size);
// capital: a 250-share long at 0.95 ties up $237.50, under the $250 bankroll; 300 short at 0.05 ties up $285, over it
t.orders.clear(); t.position = { mon: 0, costUsd: 0 }; const oldBank = config.bankrollUsd; (config as any).bankrollUsd = 250; // .env may set its own
console.assert(t.allowed("buy", { bid: 0.94, ask: 0.96, mid: 0.95 }) === true, "within bankroll");
t.position = { mon: -50, costUsd: -2.5 };
console.assert(t.allowed("sell", { bid: 0.04, ask: 0.06, mid: 0.05 }) === false, "300 short at 5c ties up $285: over the bankroll");
t.position = { mon: 0, costUsd: 0 };
(config as any).maxPositionMon = oldPos; (config as any).rewardSizing = oldSizing; market.rewards = null; (config as any).bankrollUsd = oldBank;
// I6: a long position must not skew the bid out of the reward band (3c): bid stays within 2c of mid
market.rewards = { minSize: 20, maxSpreadC: 3, dailyUsd: 100 };
t.position = { mon: 100, costUsd: 50 }; t.mids = [0.5, 0.5];
(process.env as any).X = "";
const q = t.twoSided(60, { bid: 0.45, ask: 0.55, mid: 0.5, levels: { bids: [], asks: [] } }, 0.5);
const sell = q.find((x: any) => x.side === "sell");
console.assert(sell && sell.price <= 0.52 + 1e-9, "ask clamped inside the reward band", q);
market.rewards = null; t.position = { mon: 0, costUsd: 0 };
// I3a: estimated rewards do not hold off the loss limit
t.halt(false); t.totals.netUsd = 0; t.totals.rewardsUsd = 10; t.totals.realizedUsd = -30;
t.emit(70, book, null, [], null, false);
console.assert(t.halted === true && t.killed === true, "trading loss of $30 trips the $25 limit despite $10 of estimated rewards");
t.halt(false); t.totals.realizedUsd = 0; t.totals.rewardsUsd = 0;
// Idea 4: jump-risk sizing. $8 budget at mid 0.30: a long may hold 26 (8 / 0.30), a short only 11 (8 / 0.70)
{
  const c = config as any, keep = { jumpRisk: c.jumpRisk, maxLossUsd: c.maxLossUsd, bankrollUsd: c.bankrollUsd, rewardDepth: c.rewardDepth, maxPositionMon: c.maxPositionMon };
  c.jumpRisk = true; c.maxLossUsd = 8; c.bankrollUsd = 100; c.maxPositionMon = 1000;
  t.position = { mon: 0, costUsd: 0 }; t.orders.clear(); t.mids = [0.3, 0.3]; t.cooldownUntil = 0;
  const b3 = { bid: 0.29, ask: 0.31, mid: 0.3, levels: { bids: [], asks: [] } } as any;
  console.assert(t.room("buy", b3) === 26 && t.room("sell", b3) === 11, "room by jump loss", t.room("buy", b3), t.room("sell", b3));
  market.rewards = { minSize: 20, maxSpreadC: 4, dailyUsd: 10 };
  const qs = t.twoSided(80, b3, 0.5);
  console.assert(qs.length === 1 && qs[0].side === "buy" && qs[0].size === 20, "short side under the 20 minimum is not posted; long side at min size", qs);
  // maker unwind: holding long, only the sell side is quoted
  t.position = { mon: 20, costUsd: 6 }; t.orders.clear();
  const u = t.twoSided(81, b3, 0.5);
  console.assert(u.length === 1 && u[0].side === "sell", "holding: only the reducing side", u);
  // REWARD_DEPTH 0.5 on a 4c band: the bid sits 2c back from mid (0.28), not one tick inside the touch (0.30)
  c.jumpRisk = false; c.rewardDepth = 0.5; t.position = { mon: 0, costUsd: 0 }; t.orders.clear();
  const d = t.twoSided(82, b3, 0.5); // tight book: one tick inside would be 0.30 / 0.30
  console.assert(d.find((q: any) => q.side === "buy")?.price === 0.28 && d.find((q: any) => q.side === "sell")?.price === 0.32, "sit back half the band", d);
  const wideB = { bid: 0.25, ask: 0.35, mid: 0.3, levels: { bids: [], asks: [] } } as any;
  // Kalshi LIP: no band clamp or depth, quotes join the touch, reward from kalshiShare
  market.rewards = { minSize: 1, maxSpreadC: 99, dailyUsd: 86_400, target: 1000, discount: 0.5 };
  const k = t.twoSided(83, { ...wideB, levels: { bids: [[0.25, 10]], asks: [[0.35, 10]] } }, 0.5);
  console.assert(Math.abs(t.rewardTick({ ...wideB, levels: { bids: [[0.25, 10]], asks: [[0.35, 10]] } }, k) - 0.5 * (k[0].size / (k[0].size + 10) + k[1].size / (k[1].size + 10))) < 1e-9, "LIP reward through kalshiShare", k);
  Object.assign(c, keep); market.rewards = null; t.position = { mon: 0, costUsd: 0 }; t.orders.clear();
}
console.log("quote check ok");
