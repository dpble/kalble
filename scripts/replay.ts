/**
 * Replay a recorded game offline (record one with RECORD=path; `bun run duo` records every game to data/rec-<stamp>.jsonl).
 *   bun run scripts/replay.ts data/rec-X.jsonl            current settings (from env / .env)
 *   bun run scripts/replay.ts data/rec-X.jsonl --sweep    grid over the main knobs, best net first
 * Uses the mock model (free, instant). Same simulator as live dry runs, so the same caveats apply:
 * fills assume our order is first at its price, rewards are an estimate.
 */
import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) { console.log("usage: bun run scripts/replay.ts data/rec-X.jsonl [--sweep]"); process.exit(1); }
const meta = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]!).meta;
process.env.REPLAY = path;
process.env.VENUE = meta.label.startsWith("kalshi") ? "kalshi" : "polymarket";
process.env.RUN_NAME = ""; // no log files
delete process.env.RECORD;
const { config } = await import("../src/config");
const { VenueMarket } = await import("../src/venues");
const { Trader } = await import("../src/trader");
const { MockModel } = await import("../src/model");
const { hitRate } = await import("../src/score");

type Knobs = Partial<Record<"fairWeight" | "inventorySkew" | "signalSkew" | "jumpTicks" | "minPrice" | "minEdge" | "horizonBlocks", number>>;

async function run(knobs: Knobs) {
  Object.assign(config, knobs);
  const m = new VenueMarket();
  await m.init();
  const events: any[] = [], fills: { block: number; side: string; size: number; price: number }[] = [];
  let done = false;
  const t = new Trader(m as any, new MockModel(), (e) => events.push(e), (block, f) => fills.push({ block, ...f }));
  t.onError = (msg) => { if (msg === "replay finished") done = true; };
  t.attachTradeFeed(0, m.feed as any);
  for (let b = 1; !done; b++) await t.onBlock(b);

  const mid = new Map(events.map((e) => [e.block, e.mid]));
  let mk = 0, sz = 0; // size-weighted markout over the horizon, cents per contract (positive = the fill was good)
  for (const f of fills) {
    const later = mid.get(f.block + config.horizonBlocks);
    if (later === undefined) continue;
    mk += (later - f.price) * (f.side === "buy" ? 1 : -1) * f.size * 100; sz += f.size;
  }
  const last = events.at(-1)?.totals ?? {};
  const h = hitRate(events, config.horizonBlocks);
  return { ...knobs, ticks: events.length, fills: fills.length, contracts: Math.round(sz), "markout¢": sz ? +(mk / sz).toFixed(2) : null, rewards$: +(last.rewardsUsd ?? 0).toFixed(2), net$: +(last.netUsd ?? 0).toFixed(2), hit: h.rate === null ? null : `${Math.round(h.rate * 100)}% n=${h.n}`, halted: events.at(-1)?.halted ?? false };
}

console.log(`replay · ${meta.label}`);
if (process.argv.includes("--sweep")) {
  const rows = [];
  const base = { ...config };
  for (const fairWeight of [0, 0.5, 1])
    for (const inventorySkew of [0.5, 1.5, 3])
      for (const jumpTicks of [2, 99])
        for (const minPrice of [0, 0.1]) {
          Object.assign(config, base);
          rows.push(await run({ fairWeight, inventorySkew, jumpTicks, minPrice }));
        }
  rows.sort((a, b) => b.net$ - a.net$);
  console.table(rows.slice(0, 12));
  console.log("jumpTicks 99 = event guard off. One game is one sample: only trust a setting that wins across several recordings.");
} else {
  console.table([await run({})]);
}
