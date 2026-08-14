-- Materialise controlled multilingual concepts as public smart tags only when
-- the current published case record contains a supporting indexed proposition.
with synonym_labels as (
  select
    s.canonical_key,
    case when s.kind = 'legal_area' then 'legal_area' else 'issue' end as tag_kind,
    coalesce(
      (select term from unnest(s.terms) with ordinality t(term, ordinal)
       where term ~ '[Α-Ωα-ω]' order by ordinal limit 1),
      s.canonical_key
    ) as label,
    s.terms,
    s.weight
  from nomologies.legal_search_synonyms s
  where s.active
), prepared as (
  select
    canonical_key,
    tag_kind,
    label,
    nomologies.normalize_search_text(label) as normalized,
    terms,
    weight
  from synonym_labels
), inserted as (
  insert into nomologies.smart_tags(tag_key,label,normalized,kind,aliases,updated_at)
  select
    'v10_' || tag_kind || '_' || canonical_key,
    label,
    normalized,
    tag_kind,
    terms,
    now()
  from prepared
  on conflict (kind,normalized) do update set
    aliases = (
      select array_agg(distinct alias order by alias)
      from unnest(nomologies.smart_tags.aliases || excluded.aliases) alias
      where trim(alias) <> ''
    ),
    updated_at = now()
  returning id,kind,normalized
), resolved_tags as (
  select p.*, st.id as tag_id
  from prepared p
  join nomologies.smart_tags st
    on st.kind=p.tag_kind and st.normalized=p.normalized
), supported_cases as (
  select
    f.case_id,
    rt.tag_id,
    rt.canonical_key,
    rt.weight,
    array_agg(distinct paragraph_id order by paragraph_id) filter(where paragraph_id <> '') as evidence_paragraph_ids
  from resolved_tags rt
  join nomologies.case_search_fields f
    on f.field_name in ('principle','ratio','holding','issues','provisions','authorities','facts','procedure')
   and exists (
     select 1
     from unnest(rt.terms) term
     where length(nomologies.normalize_search_text(term)) >= 4
       and f.search_v10 like '%' || nomologies.normalize_search_text(term) || '%'
   )
  join nomologies.case_search_documents d on d.case_id=f.case_id
  join nomologies.cases c
    on c.id=f.case_id
   and c.publication_status='published'
   and c.current_version_id=d.case_version_id
  left join lateral unnest(f.paragraph_ids) paragraph_id on true
  group by f.case_id,rt.tag_id,rt.canonical_key,rt.weight
)
insert into nomologies.case_smart_tags(case_id,tag_id,confidence,boost,evidence_paragraph_ids,source_field)
select
  case_id,
  tag_id,
  0.96,
  greatest(10,least(14,round(weight*10,3))),
  coalesce(evidence_paragraph_ids,'{}'::text[]),
  'concept.v10.' || canonical_key
from supported_cases
on conflict (case_id,tag_id) do update set
  confidence=greatest(nomologies.case_smart_tags.confidence,excluded.confidence),
  boost=greatest(nomologies.case_smart_tags.boost,excluded.boost),
  evidence_paragraph_ids=(
    select array_agg(distinct paragraph_id order by paragraph_id)
    from unnest(nomologies.case_smart_tags.evidence_paragraph_ids || excluded.evidence_paragraph_ids) paragraph_id
  ),
  source_field=case when nomologies.case_smart_tags.source_field like 'concept.%'
    then nomologies.case_smart_tags.source_field else excluded.source_field end;
