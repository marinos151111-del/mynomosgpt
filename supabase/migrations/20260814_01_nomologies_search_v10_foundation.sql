-- Nomologies Search V10 — additive installation.
-- This migration does not replace the live hybrid_case_search RPC.

create extension if not exists pg_trgm;
create extension if not exists unaccent;
create extension if not exists vector;

create or replace function nomologies.legal_lemma_token(input text)
returns text
language plpgsql
stable
parallel safe
set search_path = nomologies, public
as $$
declare
  t text := lower(unaccent(coalesce(input, '')));
  suffix text;
begin
  t := replace(t, 'ς', 'σ');
  t := regexp_replace(t, '[^a-zα-ω0-9.]+', '', 'g');
  if t = '' or t ~ '^\d+(?:\.\d+)*$' or length(t) <= 4 then return t; end if;
  if t in ('και','η','ο','το','τα','τη','την','του','των','σε','στη','στην','στο','στον','με','για','δια','ωσ','εν','επι','απο','προσ','υπο','περι','κατα','ανευ','μη','δεν','να','που','and','or','not','the','of','to','in','on','for','by','with','from','without') then
    return t;
  end if;

  if t ~ 'ει(?:α|ασ|εσ|ων)$' and length(t) >= 6 then return regexp_replace(t, 'ει(?:α|ασ|εσ|ων)$', 'ει'); end if;
  if t ~ 'ασ(?:η|ησ|εισ|εων)$' and length(t) >= 6 then return regexp_replace(t, 'ασ(?:η|ησ|εισ|εων)$', 'ασ'); end if;
  if t ~ 'ωσ(?:η|ησ|εισ|εων)$' and length(t) >= 6 then return regexp_replace(t, 'ωσ(?:η|ησ|εισ|εων)$', 'ωσ'); end if;
  if t ~ 'ησ(?:η|ησ|εισ|εων)$' and length(t) >= 6 then return regexp_replace(t, 'ησ(?:η|ησ|εισ|εων)$', 'ησ'); end if;
  if t ~ 'ετ(?:η|ησ|εσ|ων)$' and length(t) >= 6 then return regexp_replace(t, 'ετ(?:η|ησ|εσ|ων)$', 'ετ'); end if;
  if t ~ 'οτ(?:ητα|ητασ|ητεσ|ητων)$' and length(t) >= 8 then return regexp_replace(t, 'οτ(?:ητα|ητασ|ητεσ|ητων)$', 'οτ'); end if;
  if t ~ 'ευσ(?:η|ησ|εισ|εων)$' and length(t) >= 7 then return regexp_replace(t, 'ευσ(?:η|ησ|εισ|εων)$', 'ευσ'); end if;
  if t ~ 'ποιησ(?:η|ησ|εισ|εων)$' and length(t) >= 9 then return regexp_replace(t, 'ποιησ(?:η|ησ|εισ|εων)$', 'ποιησ'); end if;
  if t ~ 'ουργημ(?:α|ατοσ|ατα|ατων)$' and length(t) >= 9 then return regexp_replace(t, 'ουργημ(?:α|ατοσ|ατα|ατων)$', 'ουργημ'); end if;

  foreach suffix in array array[
    'τικων','τικοισ','τικουσ','τικησ','τικεσ','τικοσ','τικου','τικη','τικα',
    'ικων','ικοισ','ικουσ','ικησ','ικεσ','ικοσ','ικου','ικη','ικα',
    'μενων','μενοισ','μενουσ','μενησ','μενεσ','μενοσ','μενου','μενη','μενα',
    'σεων','σεωσ','ηδων','αδων','ουδων','ατοσ','ατων','ματα','ματοσ','ματων',
    'ουσεσ','ουνται','ηκαν','ηκε','ηκα','ωσαν','ωσε','ωσα','εων','εωσ','ιασ','ιεσ','ιων','ιου','ιουσ',
    'ουσ','οισ','αισ','ων','ου','οι','ον','ασ','εσ','ησ'
  ] loop
    if right(t, length(suffix)) = suffix and length(t) - length(suffix) >= 4 then
      return left(t, length(t) - length(suffix));
    end if;
  end loop;
  return t;
end;
$$;

create or replace function nomologies.legal_lemma_text(input text)
returns text
language sql
stable
parallel safe
set search_path = nomologies, public
as $$
  select coalesce(string_agg(nomologies.legal_lemma_token(token), ' ' order by ordinal), '')
  from regexp_split_to_table(nomologies.normalize_search_text(input), '[^a-z0-9α-ω]+') with ordinality as t(token, ordinal)
  where length(token) >= 2;
$$;

create or replace function nomologies.greek_to_latin_search(input text)
returns text
language plpgsql
stable
parallel safe
set search_path = nomologies, public
as $$
declare
  source text := nomologies.normalize_search_text(input);
  output text := '';
  ch text;
  i integer;
begin
  for i in 1..char_length(source) loop
    ch := substr(source, i, 1);
    output := output || case ch
      when 'α' then 'a' when 'β' then 'v' when 'γ' then 'g' when 'δ' then 'd'
      when 'ε' then 'e' when 'ζ' then 'z' when 'η' then 'i' when 'θ' then 'th'
      when 'ι' then 'i' when 'κ' then 'k' when 'λ' then 'l' when 'μ' then 'm'
      when 'ν' then 'n' when 'ξ' then 'x' when 'ο' then 'o' when 'π' then 'p'
      when 'ρ' then 'r' when 'σ' then 's' when 'ς' then 's' when 'τ' then 't'
      when 'υ' then 'y' when 'φ' then 'f' when 'χ' then 'ch' when 'ψ' then 'ps'
      when 'ω' then 'o' else ch end;
  end loop;
  return trim(regexp_replace(output, '\s+', ' ', 'g'));
end;
$$;

create or replace function nomologies.search_or_prefix_tsquery(input text)
returns tsquery
language sql
stable
parallel safe
set search_path = nomologies, public
as $$
  with tokens as (
    select distinct nomologies.legal_lemma_token(token) token
    from regexp_split_to_table(nomologies.normalize_search_text(input), '[^a-z0-9α-ω]+') token
    where length(token) >= 2
  ), terms as (
    select quote_literal(token) || ':*' term from tokens where token <> ''
  )
  select coalesce(to_tsquery('simple', string_agg(term, ' | ' order by term)), ''::tsquery) from terms;
$$;

alter table nomologies.case_search_fields
  add column if not exists search_v10 text not null default '',
  add column if not exists lemma_lexical tsvector;

alter table nomologies.case_search_documents
  add column if not exists identity_search_v10 text not null default '',
  add column if not exists identity_lemma_lexical tsvector;

alter table nomologies.smart_tags
  add column if not exists search_v10 text not null default '';

create or replace function nomologies.populate_case_search_field_v10()
returns trigger
language plpgsql
set search_path = nomologies, public
as $$
begin
  new.search_v10 := trim(concat_ws(' ',
    nomologies.normalize_search_text(new.field_text),
    nomologies.legal_lemma_text(new.field_text),
    nomologies.greek_to_latin_search(new.field_text)
  ));
  new.lemma_lexical := to_tsvector('simple', nomologies.legal_lemma_text(new.field_text));
  return new;
end;
$$;

drop trigger if exists case_search_fields_v10_trigger on nomologies.case_search_fields;
create trigger case_search_fields_v10_trigger
before insert or update of field_text on nomologies.case_search_fields
for each row execute function nomologies.populate_case_search_field_v10();

create or replace function nomologies.populate_case_search_document_v10()
returns trigger
language plpgsql
set search_path = nomologies, public
as $$
declare
  identity_text text;
begin
  identity_text := concat_ws(' ', new.title, new.short_title, new.citation, new.case_number, new.ecli, array_to_string(new.aliases, ' '), array_to_string(new.judges, ' '), array_to_string(new.authoring_judges, ' '));
  new.identity_search_v10 := trim(concat_ws(' ',
    nomologies.normalize_search_text(identity_text),
    nomologies.legal_lemma_text(identity_text),
    nomologies.greek_to_latin_search(identity_text)
  ));
  new.identity_lemma_lexical := to_tsvector('simple', nomologies.legal_lemma_text(identity_text));
  return new;
end;
$$;

drop trigger if exists case_search_documents_v10_trigger on nomologies.case_search_documents;
create trigger case_search_documents_v10_trigger
before insert or update of title, short_title, citation, case_number, ecli, aliases, judges, authoring_judges on nomologies.case_search_documents
for each row execute function nomologies.populate_case_search_document_v10();

create or replace function nomologies.populate_smart_tag_v10()
returns trigger
language plpgsql
set search_path = nomologies, public
as $$
declare
  tag_text text;
begin
  tag_text := concat_ws(' ', new.label, new.normalized, array_to_string(new.aliases, ' '));
  new.search_v10 := trim(concat_ws(' ',
    nomologies.normalize_search_text(tag_text),
    nomologies.legal_lemma_text(tag_text),
    nomologies.greek_to_latin_search(tag_text)
  ));
  return new;
end;
$$;

drop trigger if exists smart_tags_v10_trigger on nomologies.smart_tags;
create trigger smart_tags_v10_trigger
before insert or update of label, normalized, aliases on nomologies.smart_tags
for each row execute function nomologies.populate_smart_tag_v10();

update nomologies.case_search_fields set field_text = field_text;
update nomologies.case_search_documents set title = title;
update nomologies.smart_tags set label = label;

create index if not exists case_search_fields_search_v10_trgm_idx
  on nomologies.case_search_fields using gin (search_v10 gin_trgm_ops);
create index if not exists case_search_fields_lemma_lexical_idx
  on nomologies.case_search_fields using gin (lemma_lexical);
create index if not exists case_search_documents_identity_search_v10_trgm_idx
  on nomologies.case_search_documents using gin (identity_search_v10 gin_trgm_ops);
create index if not exists case_search_documents_identity_lemma_lexical_idx
  on nomologies.case_search_documents using gin (identity_lemma_lexical);
create index if not exists smart_tags_search_v10_trgm_idx
  on nomologies.smart_tags using gin (search_v10 gin_trgm_ops);

create table if not exists nomologies.legal_search_synonyms (
  id bigserial primary key,
  canonical_key text not null unique,
  kind text not null default 'concept',
  terms text[] not null,
  weight numeric not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into nomologies.legal_search_synonyms(canonical_key, kind, terms, weight) values
('adverse_possession','concept',array['εχθρική κατοχή','χρησικτησία','κτητική παραγραφή','adverse possession','continuous adverse possession','echthriki katochi','christiktisia'],1.25),
('misrepresentation','concept',array['ψευδής παράσταση','ψευδή παράσταση','misrepresentation','false representation','fraudulent representation','pseydis parastasi','psevdis parastasi','psevdh parastasi'],1.2),
('conditional_contract','concept',array['σύμβαση υπό αίρεση','συμφωνία υπό αίρεση','conditional contract','contract subject to condition','symvasi ypo airesi'],1.2),
('privacy_expectation','concept',array['εύλογη προσδοκία ιδιωτικής ζωής','ιδιωτική ζωή','reasonable expectation of privacy','privacy expectation','idiotiki zoi'],1.2),
('res_judicata','concept',array['δεδικασμένο','κώλυμα δεδικασμένου','res judicata','issue estoppel','dedikasmeno'],1.2),
('credibility_review','concept',array['αξιολόγηση αξιοπιστίας','εφετειακή επέμβαση στην αξιοπιστία','credibility assessment','appellate interference with credibility','axiopistia'],1.1),
('burden_of_proof','concept',array['βάρος απόδειξης','αποδεικτικό βάρος','burden of proof','onus of proof','varos apodeixis'],1.1),
('natural_justice','concept',array['φυσική δικαιοσύνη','δικαίωμα ακρόασης','natural justice','right to be heard','audi alteram partem'],1.1),
('limitation','concept',array['παραγραφή','περίοδος παραγραφής','limitation period','statute of limitations','time barred'],1.1),
('prerogative_writs','concept',array['προνομιακό ένταλμα','προνομιακά εντάλματα','prerogative writ','certiorari','mandamus','prohibition'],1.15),
('public_duty','concept',array['δημόσιο καθήκον','άσκηση δημόσιας εξουσίας','public duty','exercise of public power'],1.15),
('damages','concept',array['αποζημίωση','αποζημιώσεις','γενικές αποζημιώσεις','damages','compensation','monetary award'],1.0),
('future_loss','concept',array['απώλεια μελλοντικών απολαβών','μελλοντική ζημιά','future loss of earnings','future loss'],1.1),
('multiplier_multiplicand','concept',array['πολλαπλασιαστής και πολλαπλασιαστέο','μέθοδος πολλαπλασιαστή','multiplier and multiplicand'],1.15),
('hearsay','concept',array['εξ ακοής μαρτυρία','hearsay evidence','hearsay'],1.1),
('land_registry','concept',array['κτηματολόγιο','κτηματικό μητρώο','land registry','land register'],1.1),
('civil_procedure','legal_area',array['πολιτική δικονομία','πολιτικοδικονομία','civil procedure','CPR 2023'],1.0),
('company_law','legal_area',array['εταιρικό δίκαιο','περί Εταιρειών Νόμος','company law','corporate law','Cap 113','Κεφ. 113'],1.0),
('contract','legal_area',array['σύμβαση','συμβατική υποχρέωση','contract','contractual obligation','breach of contract'],1.0),
('negligence','legal_area',array['αμέλεια','καθήκον επιμέλειας','negligence','duty of care'],1.0)
on conflict (canonical_key) do update set
  kind = excluded.kind,
  terms = excluded.terms,
  weight = excluded.weight,
  active = true,
  updated_at = now();

create index if not exists legal_search_synonyms_terms_idx
  on nomologies.legal_search_synonyms using gin (terms);

alter table nomologies.legal_search_synonyms enable row level security;
