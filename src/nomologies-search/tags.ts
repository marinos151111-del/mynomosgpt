import type {
  EvidenceAnchorV2,
  ExtractedFieldV2,
  NomologiesCaseRecordV2,
} from "../nomologies-v2/types.ts";
import { aliasesForConcept, detectConcepts } from "./synonyms.ts";
import { bounded, compactKey, normalizeLegalText, tokenizeLegalText } from "./normalize.ts";
import type { SmartTagKindV1, SmartTagV1 } from "./types.ts";

type AnyField = ExtractedFieldV2<unknown>;

const ENUM_LABELS: Record<string, string> = {
  criminal_law: "ποινικό δίκαιο",
  private_law: "ιδιωτικό δίκαιο",
  public_law: "δημόσιο δίκαιο",
  constitutional_law: "συνταγματικό δίκαιο",
  family_law: "οικογενειακό δίκαιο",
  employment_law: "εργατικό δίκαιο",
  civil_procedure: "πολιτική δικονομία",
  criminal_procedure: "ποινική δικονομία",
  contract: "συμβάσεις",
  construction: "κατασκευαστικές διαφορές",
  property: "ακίνητη ιδιοκτησία",
  land_registry: "κτηματολογικές διαφορές",
  company: "εταιρικό δίκαιο",
  insolvency: "αφερεγγυότητα",
  tax: "φορολογικό δίκαιο",
  immigration: "μετανάστευση",
  asylum: "άσυλο",
  evidence: "δίκαιο απόδειξης",
  sentencing: "επιμέτρηση ποινής",
  expedition_application: "αίτηση επίσπευσης έφεσης",
  interim_application: "ενδιάμεση αίτηση",
  civil_appeal: "πολιτική έφεση",
  criminal_appeal: "ποινική έφεση",
  administrative_appeal: "διοικητική έφεση",
  certiorari: "προνομιακό ένταλμα certiorari",
  habeas_corpus: "habeas corpus",
  interim_stage: "ενδιάμεσο στάδιο",
  appeal: "κατ’ έφεση διαδικασία",
  application_dismissed: "αίτηση απορρίφθηκε",
  appeal_dismissed: "έφεση απορρίφθηκε",
  appeal_allowed: "έφεση επιτράπηκε",
  conviction_quashed: "καταδίκη ακυρώθηκε",
  sentence_reduced: "μείωση ποινής",
};

function available<T>(field: ExtractedFieldV2<T>): boolean {
  if (field.status !== "available") return false;
  if (typeof field.value === "string") return field.value.trim().length > 0;
  if (Array.isArray(field.value)) return field.value.length > 0;
  return field.value !== null && field.value !== undefined;
}

function paragraphIds(evidence: EvidenceAnchorV2[] = []): string[] {
  return [...new Set(evidence.flatMap((anchor) => anchor.paragraphIds).filter((id) => id && id !== "TITLE"))];
}

function compactIssue(value: string): string {
  const cleaned = String(value || "")
    .replace(/^\s*(αν|κατά πόσο|κατα πόσο|whether)\s+/iu, "")
    .replace(/[;·].*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = tokenizeLegalText(cleaned, { keepStopwords: true, stem: false });
  if (tokens.length <= 10 && cleaned.length <= 110) return cleaned.replace(/[.;:]$/u, "");
  const significant = tokenizeLegalText(cleaned, { stem: false }).slice(0, 9);
  return significant.join(" ");
}

function tagBoost(kind: SmartTagKindV1): number {
  return {
    identity: 16,
    provision: 14,
    principle: 13,
    issue: 12,
    outcome: 11,
    procedure: 10,
    authority: 8,
    legal_area: 8,
    remedy: 7,
    evidence: 6,
    fact: 5,
  }[kind];
}

export function buildSmartTags(record: NomologiesCaseRecordV2): SmartTagV1[] {
  const byKey = new Map<string, SmartTagV1>();

  const add = (input: {
    label: string;
    kind: SmartTagKindV1;
    confidence?: number;
    aliases?: string[];
    evidence?: EvidenceAnchorV2[];
    sourceField: string;
    boost?: number;
  }) => {
    const label = compactIssue(input.label);
    const normalized = normalizeLegalText(label);
    if (!label || !normalized || normalized.length < 2) return;
    if (label.length > 140) return;
    const key = `${input.kind}:${compactKey(normalized)}`;
    const aliases = [...new Set([
      label,
      ...(input.aliases || []),
      ...aliasesForConcept(label),
    ].map((item) => String(item || "").trim()).filter(Boolean))];
    const ids = paragraphIds(input.evidence);
    const existing = byKey.get(key);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, bounded(input.confidence ?? 0.8));
      existing.boost = Math.max(existing.boost, input.boost ?? tagBoost(input.kind));
      existing.aliases = [...new Set([...existing.aliases, ...aliases])];
      existing.evidenceParagraphIds = [...new Set([...existing.evidenceParagraphIds, ...ids])];
      return;
    }
    byKey.set(key, {
      id: `tag_${compactKey(`${input.kind}_${normalized}`)}`.slice(0, 120),
      label,
      normalized,
      kind: input.kind,
      confidence: bounded(input.confidence ?? 0.8),
      aliases,
      evidenceParagraphIds: ids,
      boost: input.boost ?? tagBoost(input.kind),
      sourceField: input.sourceField,
    });
  };

  const addFieldValue = (field: AnyField, kind: SmartTagKindV1, sourceField: string) => {
    if (!available(field)) return;
    const values = Array.isArray(field.value) ? field.value : [field.value];
    for (const value of values) {
      if (typeof value === "string") add({ label: ENUM_LABELS[value] || value, kind, confidence: field.confidence, evidence: field.evidence, sourceField });
    }
  };

  addFieldValue(record.identity.caseName, "identity", "identity.caseName");
  addFieldValue(record.identity.shortName, "identity", "identity.shortName");
  addFieldValue(record.identity.caseNumber, "identity", "identity.caseNumber");
  addFieldValue(record.identity.citation, "identity", "identity.citation");
  addFieldValue(record.identity.ecli, "identity", "identity.ecli");

  addFieldValue(record.classification.caseFamily, "legal_area", "classification.caseFamily");
  addFieldValue(record.classification.primaryLegalArea, "legal_area", "classification.primaryLegalArea");
  addFieldValue(record.classification.legalAreas, "legal_area", "classification.legalAreas");
  addFieldValue(record.classification.proceedingType, "procedure", "classification.proceedingType");
  addFieldValue(record.classification.proceduralPosture, "procedure", "classification.proceduralPosture");
  addFieldValue(record.classification.applicationTypes, "procedure", "classification.applicationTypes");
  addFieldValue(record.classification.subjectMatter, "fact", "classification.subjectMatter");

  if (available(record.analysis.legalIssues)) {
    for (const issue of record.analysis.legalIssues.value) {
      add({ label: issue.issue, kind: "issue", confidence: record.analysis.legalIssues.confidence, evidence: record.analysis.legalIssues.evidence, sourceField: "analysis.legalIssues" });
      if (issue.determination) add({ label: issue.determination, kind: "outcome", confidence: record.analysis.legalIssues.confidence, evidence: record.analysis.legalIssues.evidence, sourceField: "analysis.legalIssues" });
    }
  }
  addFieldValue(record.analysis.dominantIssue, "issue", "analysis.dominantIssue");
  addFieldValue(record.analysis.legalPrincipleSummary, "principle", "analysis.legalPrincipleSummary");
  addFieldValue(record.analysis.legalTestsAndStandards, "principle", "analysis.legalTestsAndStandards");

  if (available(record.analysis.ratioDecidendi)) {
    for (const principle of record.analysis.ratioDecidendi.value) {
      add({ label: principle.principle, kind: "principle", confidence: record.analysis.ratioDecidendi.confidence, evidence: record.analysis.ratioDecidendi.evidence, sourceField: "analysis.ratioDecidendi" });
      for (const condition of principle.conditions) add({ label: condition, kind: "principle", confidence: record.analysis.ratioDecidendi.confidence * 0.9, evidence: record.analysis.ratioDecidendi.evidence, sourceField: "analysis.ratioDecidendi.conditions", boost: 9 });
    }
  }

  const conceptText = [
    available(record.analysis.legalPrincipleSummary) ? record.analysis.legalPrincipleSummary.value : "",
    available(record.analysis.dominantIssue) ? record.analysis.dominantIssue.value : "",
    available(record.analysis.holding) ? record.analysis.holding.value : "",
    available(record.facts.summary) ? record.facts.summary.value : "",
    available(record.procedure.proceduralHistory) ? record.procedure.proceduralHistory.value : "",
  ].join(" ");
  for (const concept of detectConcepts(conceptText)) {
    const kind: SmartTagKindV1 = concept.type === "area" ? "legal_area" : concept.type === "outcome" ? "outcome" : concept.type === "evidence" ? "evidence" : concept.type === "remedy" ? "remedy" : concept.type === "procedure" ? "procedure" : "principle";
    add({ label: concept.label, aliases: concept.aliases, kind, confidence: 0.96, sourceField: `concept.${concept.id}`, boost: tagBoost(kind) + 1 });
  }

  if (available(record.authorities.legislation)) {
    for (const instrument of record.authorities.legislation.value) {
      add({ label: instrument.lawLabel || instrument.instrumentName || instrument.lawId, kind: "provision", confidence: record.authorities.legislation.confidence, evidence: record.authorities.legislation.evidence, sourceField: "authorities.legislation", boost: instrument.primary ? 15 : 11 });
      for (const provision of instrument.provisions) {
        const display = [instrument.lawLabel || instrument.lawId, provision.display || provision.normalized].filter(Boolean).join(" · ");
        add({ label: display, kind: "provision", confidence: record.authorities.legislation.confidence, evidence: record.authorities.legislation.evidence, sourceField: "authorities.legislation.provisions", boost: instrument.primary ? 16 : 12 });
      }
    }
  }

  if (available(record.authorities.authorities)) {
    for (const authority of record.authorities.authorities.value) {
      const contextBoost = authority.citationContext === "direct" ? 10 : authority.citationContext === "adopted_quotation" ? 11 : authority.citationContext === "nested_quotation" ? 5 : 7;
      add({
        label: authority.name,
        aliases: [authority.citation, authority.ecli].filter(Boolean),
        kind: "authority",
        confidence: record.authorities.authorities.confidence,
        evidence: record.authorities.authorities.evidence,
        sourceField: `authorities.authorities.${authority.citationContext}.${authority.treatment}`,
        boost: contextBoost,
      });
    }
  }

  addFieldValue(record.outcome.overallOutcome, "outcome", "outcome.overallOutcome");
  addFieldValue(record.outcome.orders, "remedy", "outcome.orders");
  addFieldValue(record.outcome.remedies, "remedy", "outcome.remedies");

  if (available(record.facts.witnessesAndEvidence)) {
    for (const item of record.facts.witnessesAndEvidence.value) {
      add({ label: item.name || item.type, kind: "evidence", confidence: record.facts.witnessesAndEvidence.confidence, evidence: record.facts.witnessesAndEvidence.evidence, sourceField: "facts.witnessesAndEvidence", boost: 6 });
    }
  }

  return [...byKey.values()]
    .filter((tag) => tag.kind === "identity" || tag.normalized.split(/\s+/u).length <= 12)
    .sort((left, right) => right.boost - left.boost || right.confidence - left.confidence || left.label.localeCompare(right.label, "el"))
    .slice(0, 120);
}
