/** Results server for the dashboard's Results tab: GET /results -> { summaries, sessions, gaps }. */
import { scoreAll, summarize, worstDay } from "../src/scoreboard";

const cors = { "Access-Control-Allow-Origin": "*" };
let at = 0, inflight: Promise<any> | null = null, last: any = null;

async function compute() {
  const sessions = await scoreAll();
  const gaps = await fetch("http://localhost:3090/", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).then((j: any) => j.summary ?? null).catch(() => null);
  const done = sessions.filter((s) => !s.live && !s.strategy.startsWith("legacy")); // the $25 limit is on all bots together
  return { summaries: summarize(sessions, Number(process.env.DAILY_LOSS_USD ?? 25)), worstDayAll: done.length ? worstDay(done) : null, sessions, gaps };
}

Bun.serve({
  port: Number(process.env.PORT ?? 3099),
  async fetch(req) {
    if (new URL(req.url).pathname !== "/results") return new Response("not found", { status: 404, headers: cors });
    if (!inflight || Date.now() - at > 60_000) { at = Date.now(); inflight = compute().then((b) => (last = b), () => last); }
    const body = await inflight;
    return body ? Response.json(body, { headers: cors }) : new Response("compute failed", { status: 503, headers: cors });
  },
});
console.log(`results on :${process.env.PORT ?? 3099}`);
