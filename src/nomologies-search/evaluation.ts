export interface RelevanceJudgment {
  caseId: string;
  relevance: number;
}

export interface RankedResult {
  caseId: string;
}

export interface SearchEvaluationMetrics {
  reciprocalRank: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  precisionAt1: number;
}

function dcg(results: RankedResult[], judgments: Map<string, number>, k: number): number {
  return results.slice(0, k).reduce((sum, result, index) => {
    const relevance = Math.max(0, judgments.get(result.caseId) || 0);
    return sum + (Math.pow(2, relevance) - 1) / Math.log2(index + 2);
  }, 0);
}

export function evaluateRanking(results: RankedResult[], labels: RelevanceJudgment[]): SearchEvaluationMetrics {
  const judgments = new Map(labels.map((label) => [label.caseId, label.relevance]));
  const relevant = labels.filter((label) => label.relevance > 0);
  const firstRelevant = results.findIndex((result) => (judgments.get(result.caseId) || 0) > 0);
  const ideal = [...labels]
    .sort((left, right) => right.relevance - left.relevance)
    .map((label) => ({ caseId: label.caseId }));
  const idealDcg = dcg(ideal, judgments, 10);
  const hitsAt = (k: number) => results.slice(0, k).filter((result) => (judgments.get(result.caseId) || 0) > 0).length;

  return {
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    recallAt5: relevant.length ? hitsAt(5) / relevant.length : 1,
    recallAt10: relevant.length ? hitsAt(10) / relevant.length : 1,
    ndcgAt10: idealDcg > 0 ? dcg(results, judgments, 10) / idealDcg : 1,
    precisionAt1: results.length && (judgments.get(results[0].caseId) || 0) > 0 ? 1 : 0,
  };
}
