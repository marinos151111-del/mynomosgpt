-- Seed the relevance labels in a second migration because rows inserted into
-- search_eval_queries are not visible to sibling data-modifying CTEs in the
-- same PostgreSQL statement snapshot.
with seed(query_text, expected_case_id) as (
  values
  ('Alexander Keith Edward','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('30/2016','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('Κεφ. 224 άρθρο 61','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('εχθρική κατοχή','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('adverse possession','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('echthriki katochi','bed1353b-4fd5-44dc-9b32-e4b4ec7d07d3'::uuid),
  ('Σωκράτους','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('405/2016','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('εύλογη προσδοκία ιδιωτικής ζωής','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('reasonable expectation of privacy','67c09376-96d6-413c-bfe4-ebefda68d3fb'::uuid),
  ('συμφωνία υπό αίρεση','d48dd390-a9b2-4ab4-88ef-f9111d136e15'::uuid),
  ('conditional contract misrepresentation','d48dd390-a9b2-4ab4-88ef-f9111d136e15'::uuid),
  ('δεδικασμένο ενοίκια','0bd0e115-de6b-4bd2-a27b-cf0b59a82edf'::uuid),
  ('res judicata rent','0bd0e115-de6b-4bd2-a27b-cf0b59a82edf'::uuid),
  ('γενικοί και αόριστοι λόγοι έφεσης','e560fd6d-93fa-4a5e-9c18-657d6ab88cf7'::uuid),
  ('διαμεσολάβηση ασφαλιστήρια','b0a6891a-d7a7-4a77-8d86-28ed8ae93c24'::uuid),
  ('φορολογική δήλωση δάνειο','5c28bdde-c92f-4df0-9abc-3e24af8c55ac'::uuid),
  ('Mandamus δημόσιο καθήκον','404d07fa-64bd-4204-978d-7af5b33c137c'::uuid)
)
insert into nomologies.search_eval_labels(query_id,case_id,relevance)
select q.id,s.expected_case_id,3
from seed s
join nomologies.search_eval_queries q on q.query_text=s.query_text
on conflict (query_id,case_id) do update set relevance=excluded.relevance;
