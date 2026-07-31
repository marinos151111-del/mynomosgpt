import { parseSearchQuery as parseBaseSearchQuery } from "./query.ts";
import type { ParsedSearchQueryV1, SearchFiltersV1 } from "./types.ts";

/**
 * Elite search treats ordinary query language as a ranking signal, not a hard
 * filter. A lawyer typing "κτηματολογική εγγραφή" may still need a property,
 * civil-procedure or evidence case. Hard filters are applied only when the UI
 * or API explicitly supplies them.
 */
export function parseSearchQuery(
  raw: string,
  suppliedFilters: SearchFiltersV1 = {},
): ParsedSearchQueryV1 {
  const parsed = parseBaseSearchQuery(raw, suppliedFilters);
  const filters = { ...parsed.filters };
  if (!suppliedFilters.legalArea) delete filters.legalArea;
  if (!suppliedFilters.proceedingType) delete filters.proceedingType;
  return { ...parsed, filters };
}
