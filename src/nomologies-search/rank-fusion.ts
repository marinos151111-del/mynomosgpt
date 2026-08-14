export interface RankedLaneItem {
  id: string;
  rank: number;
  score?: number;
}

export interface RankedLane {
  name: string;
  weight: number;
  items: RankedLaneItem[];
}

export interface FusionResult {
  id: string;
  score: number;
  lanes: Array<{ name: string; rank: number; contribution: number }>;
}

export function reciprocalRankFusion(lanes: RankedLane[], k = 60): FusionResult[] {
  const fused = new Map<string, FusionResult>();
  for (const lane of lanes) {
    for (const item of lane.items) {
      if (!item.id || item.rank < 1) continue;
      const contribution = lane.weight / (k + item.rank);
      const current = fused.get(item.id) || { id: item.id, score: 0, lanes: [] };
      current.score += contribution;
      current.lanes.push({ name: lane.name, rank: item.rank, contribution });
      fused.set(item.id, current);
    }
  }
  return [...fused.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function normalizeScore(value: unknown, maximum = 100): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.max(0, Math.min(1, number / maximum));
}

export function blendSearchScore(input: {
  exactIdentity?: number;
  retrieval?: number;
  precision?: number;
  semantic?: number;
  precedential?: number;
  strictReady?: boolean;
}): number {
  const exact = Number(input.exactIdentity || 0);
  if (exact >= 150) return 10_000 + exact;
  const retrieval = normalizeScore(input.retrieval, 180);
  const precision = normalizeScore(input.precision, 100);
  const semantic = Math.max(0, Math.min(1, Number(input.semantic || 0)));
  const precedential = normalizeScore(input.precedential, 100);
  const readiness = input.strictReady === false ? -0.04 : 0;
  return 100 * (retrieval * 0.50 + precision * 0.32 + semantic * 0.15 + precedential * 0.03 + readiness);
}
