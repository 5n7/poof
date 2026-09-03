-- `document_version` stores blob metadata. `document` keeps the identity, title,
-- per-document TTL, and current-version pointer. D1 applies this migration in one
-- transaction.

CREATE TABLE document_version (
  document_id TEXT    NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,          -- 1-based, allocated MAX(version)+1
  kind        TEXT    NOT NULL,          -- 'html' | 'md'
  r2_key      TEXT    NOT NULL,          -- rendered HTML blob in R2
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, version)
);

-- The weekly orphan sweep queries `r2_key IN (...)` once per R2 listing page;
-- without this index each page is a full table scan.
CREATE INDEX idx_document_version_r2_key ON document_version(r2_key);

-- Backfill each existing document as version 1 with its current `doc/{id}.html`
-- key. This does not copy, move, or rewrite R2 objects.
INSERT INTO document_version (document_id, version, kind, r2_key, created_at)
  SELECT id, 1, kind, r2_key, created_at FROM document;

ALTER TABLE document ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE document ADD COLUMN updated_at      INTEGER NOT NULL DEFAULT 0;
UPDATE document SET updated_at = created_at;

-- kind/r2_key are now in document_version. Both are unindexed, not part of any
-- key, and unreferenced by FK/trigger/view/CHECK, so SQLite's DROP COLUMN
-- preconditions hold; share's FK to document(id) is untouched.
ALTER TABLE document DROP COLUMN kind;
ALTER TABLE document DROP COLUMN r2_key;
