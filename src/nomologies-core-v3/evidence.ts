import type {
  CoreEvidenceRef,
  CoreField,
  CoreIdentityAgentRecord,
  CoreLegalAgentRecord,
  CoreOutcomeAgentRecord,
} from "./types.ts";

type JsonRecord = Record<string, unknown>;
export interface CoreSourceParagraph { id: string; ordinal: number; text: string; [key: string]: unknown }
export interface CoreSource { sourceTitle?: string; sourceUrl?: string; sourceHash?: string; cleanText?: string; paragraphs: CoreSourceParagraph[]; [key: string]: unknown }

function object(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function confidence(value: unknown): number { const n=Number(value); return Number.isFinite(n) ? Math.max(0,Math.min(1,n)) : 0; }
export function normalizeEvidenceText(value: string): string {
  return String(value || "").normalize("NFC").replace(/[\u00a0\u2007\u202f]/g," ").replace(/\s+/gu," ").trim();
}
function meaningful(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value as JsonRecord).length > 0;
  return value !== null && value !== undefined;
}

function contiguous(ids: string[], source: CoreSource): CoreSourceParagraph[] | null {
  if (!ids.length) return null;
  const byId = new Map(source.paragraphs.map((paragraph)=>[paragraph.id,paragraph]));
  const rows = ids.map((id)=>byId.get(id)).filter(Boolean) as CoreSourceParagraph[];
  if (rows.length !== ids.length) return null;
  rows.sort((left,right)=>left.ordinal-right.ordinal);
  for (let index=1; index<rows.length; index+=1) if (rows[index].ordinal !== rows[index-1].ordinal+1) return null;
  return rows;
}

function recoverQuote(quote: string, source: CoreSource): CoreSourceParagraph[] | null {
  const needle = normalizeEvidenceText(quote);
  if (!needle) return null;
  const matches: CoreSourceParagraph[][] = [];
  for (let start=0; start<source.paragraphs.length; start+=1) {
    for (let width=1; width<=4 && start+width<=source.paragraphs.length; width+=1) {
      const rows=source.paragraphs.slice(start,start+width);
      if (normalizeEvidenceText(rows.map((row)=>row.text).join(" ")).includes(needle)) matches.push(rows);
    }
  }
  if (!matches.length) return null;
  matches.sort((left,right)=>left.length-right.length || left[0].ordinal-right[0].ordinal);
  const shortest=matches[0];
  const starts=new Set(matches.map((rows)=>rows[0].id));
  return starts.size===1 ? shortest : null;
}

function validateAnchor(raw: unknown, source: CoreSource): { anchor: CoreEvidenceRef | null; flags: string[] } {
  const row=object(raw);
  const quote=string(row.quote);
  const ids=array(row.paragraphIds).map(string).filter(Boolean);
  if (!quote || normalizeEvidenceText(quote).length < 5) return {anchor:null,flags:["evidence_quote_missing_or_too_short"]};
  if (ids.length===1 && ids[0]==="TITLE") {
    if (normalizeEvidenceText(String(source.sourceTitle||"")).includes(normalizeEvidenceText(quote))) {
      return {anchor:{paragraphIds:["TITLE"],quote,exactMatch:true},flags:[]};
    }
    return {anchor:null,flags:["title_evidence_mismatch"]};
  }
  let rows=contiguous(ids,source);
  let exact=Boolean(rows && normalizeEvidenceText(rows.map((paragraph)=>paragraph.text).join(" ")).includes(normalizeEvidenceText(quote)));
  const flags:string[]=[];
  if (!rows || !exact) {
    rows=recoverQuote(quote,source);
    if (!rows) return {anchor:null,flags:[rows?"evidence_quote_not_found":"evidence_ids_invalid_or_quote_not_unique"]};
    exact=true;
    flags.push("evidence_ids_recovered");
  }
  return {anchor:{paragraphIds:rows.map((paragraph)=>paragraph.id),quote,exactMatch:exact},flags};
}

export function sanitizeField<T>(raw: unknown, fallback: T, path: string, source: CoreSource): { field: CoreField<T>; flags: string[]; exact: number; rejected: number } {
  const row=object(raw);
  const requested=string(row.status);
  const value=(row.value===undefined?fallback:row.value) as T;
  if (requested==="unavailable" || (requested==="indeterminate" && !meaningful(value))) {
    return {field:{status:requested==="unavailable"?"unavailable":"indeterminate",value:fallback,confidence:confidence(row.confidence),evidence:[]},flags:[],exact:0,rejected:0};
  }
  const evidence:CoreEvidenceRef[]=[];
  const flags:string[]=[];
  let rejected=0;
  for (const item of array(row.evidence)) {
    const checked=validateAnchor(item,source);
    flags.push(...checked.flags.map((flag)=>`${path}:${flag}`));
    if (checked.anchor) evidence.push(checked.anchor); else rejected+=1;
  }
  const available=requested==="available" && meaningful(value) && evidence.length>0;
  if (!available) {
    if (requested==="available") flags.push(`${path}:available_without_exact_evidence`);
    return {field:{status:"indeterminate",value:fallback,confidence:0,evidence:[]},flags,exact:0,rejected};
  }
  const unique=[...new Map(evidence.map((anchor)=>[`${anchor.paragraphIds.join(",")}|${normalizeEvidenceText(anchor.quote)}`,anchor])).values()];
  return {field:{status:"available",value,confidence:confidence(row.confidence),evidence:unique},flags,exact:unique.length,rejected};
}

function sanitizeGroup<T extends JsonRecord>(raw: unknown, definitions: Record<string,{fallback:unknown;path:string}>, source:CoreSource): {record:T;flags:string[];exact:number;rejected:number} {
  const row=object(raw); const record:JsonRecord={}; const flags:string[]=[]; let exact=0; let rejected=0;
  for (const [key,definition] of Object.entries(definitions)) {
    const cleaned=sanitizeField(row[key],definition.fallback,definition.path,source);
    record[key]=cleaned.field; flags.push(...cleaned.flags); exact+=cleaned.exact; rejected+=cleaned.rejected;
  }
  return {record:record as T,flags,exact,rejected};
}

export function sanitizeIdentity(raw:unknown,source:CoreSource){return sanitizeGroup<CoreIdentityAgentRecord>(raw,{
  caseName:{fallback:"",path:"identity.caseName"},caseNumber:{fallback:"",path:"identity.caseNumber"},citation:{fallback:"",path:"identity.citation"},court:{fallback:"",path:"identity.court"},decisionDate:{fallback:"",path:"identity.decisionDate"},caseFamily:{fallback:"unknown",path:"identity.caseFamily"},primaryLegalArea:{fallback:"unknown",path:"identity.primaryLegalArea"},proceedingType:{fallback:"unknown",path:"identity.proceedingType"},judges:{fallback:[],path:"identity.judges"},authoringJudges:{fallback:[],path:"identity.authoringJudges"},
},source);}

export function sanitizeLegal(raw:unknown,source:CoreSource){return sanitizeGroup<CoreLegalAgentRecord>(raw,{
  factsSummary:{fallback:"",path:"legal.factsSummary"},materialFacts:{fallback:[],path:"legal.materialFacts"},dominantLegalPrinciple:{fallback:"",path:"legal.dominantLegalPrinciple"},legalIssues:{fallback:[],path:"legal.legalIssues"},obiterDicta:{fallback:[],path:"legal.obiterDicta"},
},source);}

export function sanitizeOutcome(raw:unknown,source:CoreSource){return sanitizeGroup<CoreOutcomeAgentRecord>(raw,{
  overallOutcome:{fallback:"unknown",path:"outcome.overallOutcome"},dispositionText:{fallback:"",path:"outcome.dispositionText"},orders:{fallback:[],path:"outcome.orders"},money:{fallback:[],path:"outcome.money"},remittalInstructions:{fallback:[],path:"outcome.remittalInstructions"},legislation:{fallback:[],path:"outcome.legislation"},authorities:{fallback:[],path:"outcome.authorities"},
},source);}

function collectFields(value: unknown, output: CoreEvidenceRef[]): void {
  if (!value || typeof value!=="object") return;
  if (Array.isArray(value)) { value.forEach((item)=>collectFields(item,output)); return; }
  const row=value as JsonRecord;
  if (Array.isArray(row.evidence)) for (const item of row.evidence) {
    const evidence=object(item); const quote=string(evidence.quote); const ids=array(evidence.paragraphIds).map(string).filter(Boolean);
    if (quote&&ids.length) output.push({paragraphIds:ids,quote,exactMatch:Boolean(evidence.exactMatch)});
  }
  Object.values(row).forEach((item)=>collectFields(item,output));
}

export function verifierContext(source:CoreSource, candidate:unknown): JsonRecord[] {
  const anchors:CoreEvidenceRef[]=[]; collectFields(candidate,anchors);
  const ordinals=new Set<number>(); const byId=new Map(source.paragraphs.map((paragraph)=>[paragraph.id,paragraph]));
  for (const anchor of anchors) for (const id of anchor.paragraphIds) {
    const paragraph=byId.get(id); if (!paragraph) continue;
    for (let offset=-1;offset<=1;offset+=1) if (paragraph.ordinal+offset>=1) ordinals.add(paragraph.ordinal+offset);
  }
  source.paragraphs.slice(0,24).forEach((paragraph)=>ordinals.add(paragraph.ordinal));
  source.paragraphs.slice(-24).forEach((paragraph)=>ordinals.add(paragraph.ordinal));
  return source.paragraphs.filter((paragraph)=>ordinals.has(paragraph.ordinal)).map((paragraph)=>({id:paragraph.id,ordinal:paragraph.ordinal,text:paragraph.text}));
}

export function collectExactEvidence(candidate:unknown):CoreEvidenceRef[]{const output:CoreEvidenceRef[]=[];collectFields(candidate,output);return [...new Map(output.map((anchor)=>[`${anchor.paragraphIds.join(",")}|${normalizeEvidenceText(anchor.quote)}`,anchor])).values()];}
