/** The two bots `bun run duo` starts. Override with NEXT_PUBLIC_API_URL / NEXT_PUBLIC_JEV_API_URL. */
export const API = {
  mock: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  jev: process.env.NEXT_PUBLIC_JEV_API_URL ?? "http://localhost:3002",
} as const;
export type Lane = keyof typeof API;
/** How many games `bun run duo` runs at once (its GAMES, default 2). */
export const GAMES = Number(process.env.NEXT_PUBLIC_GAMES ?? 2);

export type Strategy = "farmer" | "longdated" | "odds" | "kalshi" | "lip" | "polyus" | "jev";
/** Tab order. Ids other than a Strategy are their own pages. */
export const STRATEGIES: { id: Strategy | "gaps" | "results"; label: string }[] = [
  { id: "farmer", label: "Reward farmer" }, { id: "longdated", label: "Long-dated" }, { id: "odds", label: "Odds-anchored" },
  { id: "kalshi", label: "Kalshi MM" }, { id: "lip", label: "Kalshi LIP" }, { id: "polyus", label: "Polymarket US" }, { id: "gaps", label: "Gap logger" }, { id: "jev", label: "Jev" }, { id: "results", label: "Results" },
];
export const GAPS_URL = "http://localhost:3090";
export const RESULTS_URL = "http://localhost:3099/results";
const port = (p: number) => `http://localhost:${p}`;
/** Market slots per strategy, matching `bun run duo` (LONG_SLOTS 2, LIP_SLOTS 2, GAMES 2). */
export const SLOTS: Record<Strategy, number> = { farmer: GAMES, odds: GAMES, jev: GAMES, kalshi: 1, longdated: Number(process.env.NEXT_PUBLIC_LONG_SLOTS ?? 2), lip: Number(process.env.NEXT_PUBLIC_LIP_SLOTS ?? 2), polyus: Number(process.env.NEXT_PUBLIC_US_SLOTS ?? 2) };
/** Slot n (1-based): games farmer 3001+10i, odds 3002+10i, jev 3004+10i; long-dated 3051+2i; Kalshi MM 3052; Kalshi LIP 3061+i; Polymarket US 3071+i. */
export const apiFor = (slot: number, strategy: Strategy): { base: string; test: string | null } => {
  const i = slot - 1;
  if (strategy === "longdated") return { base: port(3051 + 2 * i), test: null };
  if (strategy === "lip") return { base: port(3061 + i), test: null };
  if (strategy === "polyus") return { base: port(3071 + i), test: null };
  if (strategy === "kalshi") return { base: port(3052), test: null };
  const base = port(3001 + 10 * i);
  return strategy === "farmer" ? { base, test: null } : { base, test: port((strategy === "odds" ? 3002 : 3004) + 10 * i) };
};
