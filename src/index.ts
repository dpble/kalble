import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer, type Meta } from "./server";
import { chmodSync } from "node:fs";
import { VenueMarket } from "./venues";
import type { Quote } from "./market";

// VENUE=kuru (default, Monad chain) | polymarket | kalshi (dry-run only, public data, 1 loop tick = TICK_MS)

const venue = process.env.VENUE ?? "kuru";
const market: Market = venue === "kuru" ? new Market() : (new VenueMarket() as unknown as Market);
await market.init();
const label = venue === "kuru" ? `market ${config.market}` : (market as unknown as VenueMarket).label;
const model = createModel();

const hasKey = () => !!process.env.TYPESAFE_AI_API_KEY?.trim();
const hasOddsKey = () => !!process.env.ODDS_API_KEY?.trim();
const meta: Meta = { model: model.name, wallet: market.address, dryRun: config.dryRun, market: venue === "kuru" ? config.market : label, startedAt: Date.now(), venue, runName: config.runName, tickMs: venue === "kuru" ? 300 : config.tickMs, horizonBlocks: config.horizonBlocks, hasKey: hasKey(), hasOddsKey: hasOddsKey(), halted: false, strategy: config.strategy, fairSource: venue === "kuru" ? null : process.env.FAIR_SOURCE === "odds" ? "none" : config.fairWeight > 0 ? "kalshi" : null };
const server = startServer(meta, () => trader.history, async ({ apiKey, oddsKey, model: kind, halt }) => {
  if (halt !== undefined) {
    trader.halt(halt);
    meta.halted = halt;
    console.log(halt ? "kill switch ON (manual): quoting stopped" : "kill switch OFF: quoting resumed");
  }
  // Only the Jev and legacy bots may swap models: a swap resets the session, so on a strategy tab it would relabel the bot and hide its losses.
  if (kind && !["jev", "legacy"].includes(config.strategy)) throw new Error(`the ${config.strategy} bot runs the flat model; switch models on the Jev tab`);
  if (apiKey) {
    await saveEnv("TYPESAFE_AI_API_KEY", apiKey);
    process.env.TYPESAFE_AI_API_KEY = apiKey;
    meta.hasKey = true;
  }
  if (oddsKey) {
    await saveEnv("ODDS_API_KEY", oddsKey);
    process.env.ODDS_API_KEY = oddsKey;
    meta.hasOddsKey = true;
  }
  const want = kind ?? (apiKey && trader.modelName === "mock" && config.model === "jev" ? "jev" : null);
  if (want) {
    if (want === "jev" && !hasKey()) throw new Error("add your TypeSafe API key first");
    trader.setModel(createModel(want));
    meta.model = trader.modelName;
    meta.startedAt = Date.now();
    meta.halted = false;
    console.log(`model -> ${meta.model} (session reset)`);
  }
  server.broadcastSnapshot();
});

/** Replace or append KEY=value in .env (owner-only perms). The value is never logged. */
async function saveEnv(key: string, value: string) {
  const f = Bun.file(".env");
  const text = (await f.exists()) ? await f.text() : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  await Bun.write(".env", re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n?$/, "\n")}${line}\n`);
  chmodSync(".env", 0o600);
}
const trader = new Trader(
  market,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.fairSource && e.fairSource !== meta.fairSource) meta.fairSource = e.fairSource;
    if (e.halted !== meta.halted) { meta.halted = e.halted; server.broadcastSnapshot(); } // loss-limit trip
    if (venue !== "kuru") health(e.bestBid >= 0.03 && e.bestAsk <= 0.97 && !(market as unknown as VenueMarket).game?.ended);
    if (trader.doneAfterKill) exit("loss limit hit and position closed"); // free the slot for the next game
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const fmt = (q: Quote) => `${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
      const quote = e.halted ? " HALTED" : !e.quotes.length ? " NO QUOTE (cap or funds on both sides)" : " " + e.quotes.map(fmt).join(" | ");
      console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
  },
);
trader.onError = (m) => { server.broadcastError(m); if (venue !== "kuru" && !m.startsWith("kill switch")) health(false); };

/** A venue market is finished once it has looked decided (or errored) for END_AFTER_MS straight. Exit 10 so `bun run duo` moves on. */
let badSince = 0;
function health(ok: boolean) {
  if (ok) { badSince = 0; return; }
  badSince ||= Date.now();
  if (Date.now() - badSince > config.endAfterMs) exit("market finished or unreachable");
}
/** Never leave holding: pull quotes, exit the position (flattenTick runs each tick while halted), then quit. Gives up after 20 s (empty book). */
let exiting = false;
function exit(why: string, code = 10) {
  if (exiting) return;
  exiting = true;
  console.log(`${why}: exiting the position, then quitting`);
  if (venue === "kuru") process.exit(code);
  trader.halt(true);
  const t0 = Date.now();
  setInterval(() => { if (trader.isFlat || Date.now() - t0 > 20_000) process.exit(code); }, 500);
}
if (config.sessionMs) setTimeout(() => exit("session over"), config.sessionMs);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => exit(sig, 0)); // duo stops sibling bots with SIGTERM
if (venue === "kuru") trader.attachTradeFeed(log10(market.params.sizePrecision));
else trader.attachTradeFeed(0, (market as unknown as VenueMarket).feed as any);

console.log(`jev-trader · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · ${label} · :${config.port} · log data/${config.runName}.jsonl`);
if (venue === "kuru") startBlockFeed((block) => trader.onBlock(block));
else { let tick = 0; setInterval(() => trader.onBlock(++tick), config.tickMs); }
