import { config } from "./config";
import type { Fill, Quote } from "./market";
import type { BlockEvent } from "./trader";

export interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number; venue: string; runName: string; tickMs: number; horizonBlocks: number; hasKey: boolean; hasOddsKey: boolean; halted: boolean; strategy: string; fairSource: "odds" | "kalshi" | "none" | null }

/** What POST /settings can change. The key is write-only: it is never sent back. */
export interface SettingsUpdate { apiKey?: string; oddsKey?: string; model?: "mock" | "jev"; halt?: boolean }
type ApplySettings = (u: SettingsUpdate) => Promise<void>;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200, headers: Record<string, string> = CORS) => new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** Settings only from this machine AND from a localhost page, so another site open in the browser cannot post a key. */
const localOrigin = (o: string | null) => !!o && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

/**
 * GET / snapshot · GET /history recent blocks · GET /events SSE (`snapshot`, `block`, `quote`, `fill`, `botError`, `ping`)
 * GET/POST /settings (local only) · model swap + API key
 */
export function startServer(meta: Meta, history: () => BlockEvent[], applySettings?: ApplySettings) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  setInterval(() => broadcast("ping", Date.now()), 5_000); // under idleTimeout, so a quiet stream (all errors) stays open

  // Errors repeat every tick when something is wrong (bad key, rate limit): forward at most one per 5 s.
  let lastErr = 0;

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 30, // Bun closes idle sockets after 10 s by default, which would drop SSE when no blocks arrive
    async fetch(req, srv) {
      const { pathname } = new URL(req.url);
      const origin = req.headers.get("origin");
      if (pathname === "/settings") {
        const ip = srv.requestIP(req)?.address ?? "";
        const headers = { "access-control-allow-origin": origin ?? "", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST", vary: "origin" };
        if (!LOOPBACK.has(ip) || (origin && !localOrigin(origin))) return json({ error: "settings are local only" }, 403, {});
        if (req.method === "OPTIONS") return new Response(null, { headers });
        if (req.method === "GET") return json({ model: meta.model, hasKey: meta.hasKey, hasOddsKey: meta.hasOddsKey, halted: meta.halted }, 200, headers);
        if (req.method !== "POST" || !applySettings) return json({ error: "method not allowed" }, 405, headers);
        if (!localOrigin(origin)) return json({ error: "settings are local only" }, 403, {}); // POST must come from a localhost page
        let body: SettingsUpdate;
        try { body = (await req.json()) as SettingsUpdate; } catch { return json({ error: "bad json" }, 400, headers); }
        const key = body.apiKey?.trim();
        if (key !== undefined && (!key || key.length > 400 || /\s/.test(key))) return json({ error: "that does not look like an API key" }, 400, headers);
        const oddsKey = body.oddsKey?.trim();
        if (oddsKey !== undefined && (!oddsKey || oddsKey.length > 400 || /\s/.test(oddsKey))) return json({ error: "that does not look like an Odds API key" }, 400, headers);
        if (body.model && body.model !== "mock" && body.model !== "jev") return json({ error: "model must be mock or jev" }, 400, headers);
        if (body.halt !== undefined && typeof body.halt !== "boolean") return json({ error: "halt must be true or false" }, 400, headers);
        try { await applySettings({ apiKey: key, oddsKey, model: body.model, halt: body.halt }); }
        catch (e) { return json({ error: (e as Error).message }, 400, headers); }
        return json({ model: meta.model, hasKey: meta.hasKey, hasOddsKey: meta.hasOddsKey, halted: meta.halted }, 200, headers);
      }
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/") return json({ ...meta, latest: history().at(-1) ?? null });
      if (pathname === "/history") return json(history());
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, history: history() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  return {
    url: server.url,
    broadcast: (e: BlockEvent) => broadcast("block", e),
    /** A quote's receipt landed: placed (with order id) or reverted, and the real gas. */
    broadcastQuote: (block: number, quote: Quote) => broadcast("quote", { block, quote }),
    /** A taker hit one of our resting orders in `block`. */
    broadcastFill: (block: number, fill: Fill) => broadcast("fill", { block, fill }),
    /** Meta changed (model swap, key saved): clients reset to this snapshot. */
    broadcastSnapshot: () => broadcast("snapshot", { ...meta, history: history() }),
    broadcastError: (message: string) => { if (Date.now() - lastErr > 5000) { lastErr = Date.now(); broadcast("botError", { message, ts: Date.now() }); } },
  };
}
