import type {
  EvidenceAnchorV2,
  JudgmentParagraphV2,
  JudgmentSourceV2,
  MoneyAwardV2,
  SectionMapV2,
} from "./types.ts";
import type { SpecialistResultsV2 } from "./agents.ts";
import {
  applyDeterministicBaseline as applyBaseDeterministicBaseline,
  extractDeterministicLegislation,
  provisionOwnershipConflicts,
  type DeterministicFindingV2,
} from "https://raw.githubusercontent.com/marinos151111-del/mynomosgpt/0f9f16c7c27d5ff83ec2196ace634f52f5ae63e0/src/nomologies-v2/deterministic-baseline.ts";

export { extractDeterministicLegislation, provisionOwnershipConflicts };
export type { DeterministicFindingV2 };

type SafeMoneyAward = MoneyAwardV2 & {
  amountStatus?: "fixed" | "to_be_assessed" | "open" | "not_stated";
  scale?: string;
};

function fold(value: string): string {
  return value.toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ς/g, "σ");
}

function spanFor(paragraph: JudgmentParagraphV2, source: JudgmentSourceV2, map: SectionMapV2) {
  const ordinalById = new Map(source.paragraphs.map((item) => [item.id, item.ordinal]));
  return map.spans.find((span) => {
    const start = ordinalById.get(span.startParagraphId);
    const end = ordinalById.get(span.endParagraphId);
    return start !== undefined && end !== undefined && paragraph.ordinal >= start && paragraph.ordinal <= end;
  });
}

function nonQuotedCourtParagraph(paragraph: JudgmentParagraphV2, source: JudgmentSourceV2, map: SectionMapV2): boolean {
  const span = spanFor(paragraph, source, map);
  if (!span) return true;
  return !span.isQuotedMaterial && !["quoted_authority", "quoted_legislation"].includes(span.sectionType);
}

function partyFromOrder(text: string, marker: "υπέρ" | "εναντίον"): string {
  const rx = marker === "υπέρ"
    ? /υπέρ\s+(.+?)(?=\s+(?:και\s+εναντίον|για\s+το\s+ποσό|έξοδ|costs?|ύψους)|[,.€·;]|$)/iu
    : /εναντίον\s+(.+?)(?=\s+(?:για\s+το\s+ποσό|έξοδ|costs?|ύψους)|[,.€·;]|$)/iu;
  return text.match(rx)?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function costStage(text: string): MoneyAwardV2["stage"] {
  if (/(?:πρωτόδικ|πρώτου\s+βαθμού|first[ -]?instance|trial costs?)/iu.test(text)) return "first_instance";
  if (/(?:επανεκδίκ|retrial)/iu.test(text)) return "retrial";
  if (/(?:έφεσ|appellate|appeal costs?)/iu.test(text)) return "appellate";
  return "other";
}

function vatStatus(text: string): MoneyAwardV2["vatStatus"] {
  if (/(?:Φ\.?\s*Π\.?\s*Α\.?|ΦΠΑ|VAT)[^!;]{0,35}(?:αν\s+υπάρχει|if\s+applicable)/iu.test(text)) return "plus_vat_if_applicable";
  if (/(?:πλέον|plus)\s+(?:του\s+)?(?:Φ\.?\s*Π\.?\s*Α\.?|ΦΠΑ|VAT)/iu.test(text)) return "plus_vat";
  if (/(?:περιλαμβάν|included)[^!;]{0,30}(?:Φ\.?\s*Π\.?\s*Α\.?|ΦΠΑ|VAT)/iu.test(text)) return "included";
  return "not_stated";
}

function clauses(text: string): string[] {
  // Split legal clauses, but preserve thousands separators such as €3,400.
  return text.split(/[;·]|,(?!\d)/u).map((item) => item.trim()).filter(Boolean);
}

function explicitAmount(text: string): string {
  const match = text.match(/€\s*(\d+(?:[.,]\d+)*)|(\d+(?:[.,]\d+)*)\s*(?:ευρώ|EUR)/iu);
  return (match?.[1] || match?.[2] || "").trim();
}

function safeCostSegment(text: string): { segment: string; amount: string } {
  const parts = clauses(text);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!/(?:έξοδ|costs?)/iu.test(part)) continue;
    let segment = part;
    let amount = explicitAmount(segment);
    const next = parts[index + 1] || "";
    if (!amount && /^(?:ύψους|στο\s+ποσό|ποσού|fixed|assessed|in\s+the\s+sum)/iu.test(next)) {
      segment = `${segment}, ${next}`;
      amount = explicitAmount(segment);
    }
    if (amount) return { segment, amount };
  }
  const mostSpecific = [...parts].reverse().find((part) => /(?:έξοδ|costs?)/iu.test(part)) || text;
  return { segment: mostSpecific, amount: "" };
}

function scaleFrom(text: string): string {
  return text.match(/(?:στην|με\s+την)\s+κλίμακα[^.;]*/iu)?.[0]?.replace(/\s+/g, " ").trim() || "";
}

function dedupeAwards(values: SafeMoneyAward[]): SafeMoneyAward[] {
  const output = new Map<string, SafeMoneyAward>();
  for (const item of values) {
    const key = `${item.type}|${item.stage}|${item.amount}|${fold(item.payer)}|${fold(item.payee)}|${item.amountStatus || ""}`;
    if (!output.has(key)) output.set(key, item);
  }
  return [...output.values()];
}

function evidenceForParagraphs(current: EvidenceAnchorV2[], ids: Set<string>): EvidenceAnchorV2[] {
  return current.filter((anchor) => anchor.paragraphIds.some((id) => ids.has(id)));
}

export function applyDeterministicBaseline(
  input: SpecialistResultsV2,
  source: JudgmentSourceV2,
  map: SectionMapV2,
): { specialists: SpecialistResultsV2; findings: DeterministicFindingV2[] } {
  const result = applyBaseDeterministicBaseline(input, source, map);
  const specialists = result.specialists as SpecialistResultsV2 & Record<string, any>;
  const tail = source.paragraphs
    .slice(Math.max(0, source.paragraphs.length - 45))
    .filter((paragraph) => nonQuotedCourtParagraph(paragraph, source, map));

  const costParagraphs = tail.filter((paragraph) => /(?:έξοδ|costs?)/iu.test(paragraph.text));
  if (costParagraphs.length) {
    const safeCosts: SafeMoneyAward[] = [];
    for (const paragraph of costParagraphs) {
      const parsed = safeCostSegment(paragraph.text);
      const toBeAssessed = /(?:ως\s+θα\s+υπολογισθ|θα\s+υπολογιστ|πρωτοκολλητ|registrar|to\s+be\s+assessed|to\s+be\s+taxed)/iu.test(parsed.segment);
      const status = vatStatus(parsed.segment);
      safeCosts.push({
        type: "costs",
        stage: costStage(parsed.segment || paragraph.text),
        amount: parsed.amount,
        currency: parsed.amount ? "EUR" : "",
        payer: partyFromOrder(paragraph.text, "εναντίον"),
        payee: partyFromOrder(paragraph.text, "υπέρ"),
        vatIncluded: status === "included",
        vatStatus: status,
        interest: "",
        amountStatus: parsed.amount ? "fixed" : toBeAssessed ? "to_be_assessed" : "not_stated",
        scale: scaleFrom(parsed.segment),
      });
    }
    const ids = new Set(costParagraphs.map((paragraph) => paragraph.id));
    specialists.outcome.costs.status = "available";
    specialists.outcome.costs.value = dedupeAwards(safeCosts) as MoneyAwardV2[];
    specialists.outcome.costs.confidence = Math.max(specialists.outcome.costs.confidence || 0, 0.99);
    specialists.outcome.costs.evidence = evidenceForParagraphs(specialists.outcome.costs.evidence || [], ids);
    specialists.outcome.costs.conflicts = [];

    result.findings = result.findings.filter((finding) => finding.kind !== "costs");
    for (const paragraph of costParagraphs) {
      const parsed = safeCostSegment(paragraph.text);
      result.findings.push({
        kind: "costs",
        value: parsed.amount ? `${parsed.amount} EUR` : paragraph.text.trim(),
        paragraphId: paragraph.id,
        quote: paragraph.text.trim(),
      });
    }
  }

  if (specialists.outcome.monetaryAwards?.status === "available") {
    specialists.outcome.monetaryAwards.value = specialists.outcome.monetaryAwards.value.map((award: SafeMoneyAward) => {
      if (award.type !== "damages" && award.type !== "compensation") return award;
      const paragraph = tail.find((item) => {
        const amount = award.amount ? item.text.includes(award.amount) : false;
        return amount && /(?:ζημι|damages?|compensation|αποζημί|(?:απόφαση|judgment)[^.!;]{0,120}(?:ποσό|amount))/iu.test(item.text);
      });
      return {
        ...award,
        stage: "other",
        payer: paragraph ? partyFromOrder(paragraph.text, "εναντίον") : award.payer,
        payee: paragraph ? partyFromOrder(paragraph.text, "υπέρ") : award.payee,
        amountStatus: award.amount ? "fixed" : "not_stated",
      } as MoneyAwardV2;
    });
  }

  return result;
}
