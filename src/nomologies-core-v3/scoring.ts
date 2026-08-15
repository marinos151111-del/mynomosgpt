import type { CoreMergedRecord, CorePrecedentialWeight, CoreVerifierRecord } from "./types.ts";

type JsonRecord=Record<string,unknown>;
function object(value:unknown):JsonRecord{return value&&typeof value==="object"&&!Array.isArray(value)?value as JsonRecord:{};}
function array(value:unknown):unknown[]{return Array.isArray(value)?value:[];}
function value<T>(field:unknown,fallback:T):T{const row=object(field);return row.status==="available"?row.value as T:fallback;}
function available(field:unknown):boolean{const row=object(field);const v=row.value;return row.status==="available"&&(typeof v==="string"?v.trim().length>0:Array.isArray(v)?v.length>0:v!==null&&v!==undefined);}
function tokens(text:unknown):Set<string>{return new Set(String(text||"").toLocaleLowerCase("el").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/ς/g,"σ").replace(/[^a-zα-ω0-9]+/gu," ").split(/\s+/u).filter((token)=>token.length>=4));}
function similarity(left:unknown,right:unknown):number{const a=tokens(left),b=tokens(right);if(!a.size&&!b.size)return 1;if(!a.size||!b.size)return 0;let intersection=0;for(const token of a)if(b.has(token))intersection+=1;return intersection/new Set([...a,...b]).size;}
function countField(field:unknown):number{const row=object(field);return row.status==="available"&&Array.isArray(row.value)?row.value.length:0;}
function stringField(field:unknown):string{return available(field)?String(object(field).value||""):"";}

export function precedentialWeight(record: Pick<CoreMergedRecord,"identity"|"legal">):CorePrecedentialWeight{
  const court=stringField(record.identity.court).toLocaleLowerCase("el");
  const proceeding=stringField(record.identity.proceedingType).toLocaleLowerCase("el");
  const principle=available(record.legal.dominantLegalPrinciple);
  const issues=countField(record.legal.legalIssues);
  const supreme=/ανώτατο|supreme|court of appeal|εφετείο/iu.test(court);
  const interim=/interim|ενδιάμεσ|leave|άδεια|expedition|επίσπευσ/iu.test(proceeding);
  if(supreme&&principle&&issues>0&&!interim)return"high";
  if((supreme||principle)&&issues>0)return"medium";
  return"low";
}

export function coreScore(record:CoreMergedRecord,verifier:CoreVerifierRecord):{score:number;passed:boolean;breakdown:JsonRecord}{
  const points:Record<string,number>={};
  points.identity=[record.identity.caseName,record.identity.caseNumber,record.identity.court,record.identity.decisionDate,record.identity.judges].reduce((sum,field)=>sum+(available(field)?3:0),0);
  points.facts=(available(record.legal.factsSummary)?10:0)+(available(record.legal.materialFacts)?5:0);
  points.legal=(available(record.legal.dominantLegalPrinciple)?8:0)+(available(record.legal.legalIssues)?12:0);
  points.obiter=record.legal.obiterDicta.status==="indeterminate"?0:5;
  points.outcome=(available(record.outcome.overallOutcome)?5:0)+(available(record.outcome.dispositionText)?6:0)+(record.outcome.orders.status==="indeterminate"?0:3)+(record.outcome.money.status==="indeterminate"?0:6);
  points.authorities=(record.outcome.legislation.status==="indeterminate"?0:8)+(record.outcome.authorities.status==="indeterminate"?0:7);
  const exact=record.evidenceValidation.exactAnchors,rejected=record.evidenceValidation.rejectedAnchors;
  points.evidence=exact>0?Math.max(0,Math.min(10,Math.round(10*(exact/(exact+rejected||1))))):0;
  let score=Object.values(points).reduce((sum,item)=>sum+item,0);
  const critical=verifier.checks.filter((check)=>check.status==="fail"&&check.severity==="critical");
  const material=verifier.checks.filter((check)=>check.status==="fail"&&check.severity==="material");
  score=Math.max(0,score-critical.length*20-material.length*6);
  if(critical.length)score=Math.min(score,59);
  const passed=score>=90&&verifier.overallStatus==="pass"&&!critical.length&&!material.length;
  return{score,passed,breakdown:{points,critical:critical.map((item)=>item.code),material:material.map((item)=>item.code),evidence:{exact,rejected}}};
}

export function compareWithBaseline(record:CoreMergedRecord,baseline:JsonRecord):JsonRecord{
  const analysis=object(baseline.analysis),facts=object(baseline.facts),identity=object(baseline.identity),authorities=object(baseline.authorities),outcome=object(baseline.outcome);
  const baselineMetrics={
    factsLength:stringField(facts.summary).length,
    legalIssues:countField(analysis.legalIssues),ratio:countField(analysis.ratioDecidendi),obiter:countField(analysis.obiterDicta),
    legislation:countField(authorities.legislation),authorities:countField(authorities.authorities),judges:countField(identity.judges),
    orders:countField(outcome.orders),money:countField(outcome.monetaryAwards)+countField(outcome.costs),
    principleLength:stringField(analysis.legalPrincipleSummary).length,holdingLength:stringField(analysis.holding).length,
  };
  const candidateIssues=value<Array<{question:string;ruling:string}>>(record.legal.legalIssues,[]);
  const candidateMetrics={
    factsLength:stringField(record.legal.factsSummary).length,
    legalIssues:candidateIssues.length,ratio:available(record.legal.dominantLegalPrinciple)?1:0,obiter:countField(record.legal.obiterDicta),
    legislation:countField(record.outcome.legislation),authorities:countField(record.outcome.authorities),judges:countField(record.identity.judges),
    orders:countField(record.outcome.orders),money:countField(record.outcome.money),
    principleLength:stringField(record.legal.dominantLegalPrinciple).length,holdingLength:candidateIssues.map((item)=>item.ruling).join(" ").length,
  };
  const regressions:string[]=[];
  if(baselineMetrics.factsLength>0&&candidateMetrics.factsLength===0)regressions.push("facts_missing");
  if(baselineMetrics.legalIssues>0&&candidateMetrics.legalIssues===0)regressions.push("legal_issues_missing");
  if(baselineMetrics.ratio>0&&candidateMetrics.ratio===0)regressions.push("dominant_principle_missing");
  if(baselineMetrics.obiter>0&&candidateMetrics.obiter===0)regressions.push("obiter_lost");
  if(baselineMetrics.legislation>0&&candidateMetrics.legislation===0)regressions.push("legislation_lost");
  if(baselineMetrics.authorities>0&&candidateMetrics.authorities===0)regressions.push("authorities_lost");
  if(baselineMetrics.judges>0&&candidateMetrics.judges===0)regressions.push("judicial_composition_lost");
  if(baselineMetrics.orders>0&&candidateMetrics.orders===0)regressions.push("orders_lost");
  const similarities={
    facts:similarity(stringField(facts.summary),stringField(record.legal.factsSummary)),
    principle:similarity(stringField(analysis.legalPrincipleSummary),stringField(record.legal.dominantLegalPrinciple)),
    holding:similarity(stringField(analysis.holding),candidateIssues.map((item)=>item.ruling).join(" ")),
  };
  return{baselineMetrics,candidateMetrics,similarities,regressions,coreParityPass:regressions.length===0};
}
