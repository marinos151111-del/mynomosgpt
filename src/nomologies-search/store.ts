import type { NomologiesCaseRecordV2 } from "../nomologies-v2/types.ts";
import { EliteCaseSearchEngineV1 } from "./engine.ts";
import type { SearchFiltersV1 } from "./types.ts";

const engine = new EliteCaseSearchEngineV1();

export function searchEngine(): EliteCaseSearchEngineV1 {
  return engine;
}

export async function indexNomologiesRecord(
  record: NomologiesCaseRecordV2,
  options: { semantic?: boolean; signal?: AbortSignal } = {},
) {
  return await engine.upsertRecord(record, options);
}

export async function searchNomologiesCorpus(
  text: string,
  options: { filters?: SearchFiltersV1; limit?: number; semantic?: boolean; signal?: AbortSignal } = {},
) {
  return await engine.search(text, options);
}

export function clearNomologiesCorpus(): void {
  engine.clear();
}

export function searchCorpusStatus(): Record<string, unknown> {
  const documents = engine.list();
  return {
    indexSize: documents.length,
    cases: documents.map((document) => ({
      id: document.id,
      title: document.shortTitle || document.title,
      caseNumber: document.caseNumber,
      court: document.court,
      year: document.year,
      outcome: document.outcome,
      smartTags: document.smartTags.slice(0, 12).map((tag) => tag.label),
      semanticReady: true,
    })),
  };
}
