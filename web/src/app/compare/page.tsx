import Compare from "@/components/Compare/Compare";
import { STRATEGIES, type Strategy } from "@/lib/config";

export default async function Page({ searchParams }: { searchParams: Promise<{ game?: string; s?: string }> }) {
  const { game, s } = await searchParams;
  const strategy = (STRATEGIES.some((x) => x.id === s) && s !== "gaps" && s !== "results" ? s : "farmer") as Strategy;
  return <Compare slot={Math.max(1, Number(game) || 1)} strategy={strategy} />;
}
