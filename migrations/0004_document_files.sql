ALTER TABLE document_version ADD COLUMN ready INTEGER NOT NULL DEFAULT 1;

-- Each version is an ordered snapshot. Unchanged files may reuse a source blob.
CREATE TABLE document_file (
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  filename TEXT,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (document_id, version, path),
  FOREIGN KEY (document_id, version) REFERENCES document_version(document_id, version) ON DELETE CASCADE
);
CREATE INDEX idx_document_file_r2_key ON document_file(r2_key);
INSERT INTO document_file (document_id, version, path, filename, kind, media_type, r2_key, position)
SELECT document_id, version,
  CASE WHEN filename IS NOT NULL AND filename != '' AND filename NOT LIKE '%/%'
    AND instr(filename, char(0)) = 0 AND filename NOT GLOB '*[^a-zA-Z0-9 ._-]*' AND length(filename) <= 512 AND filename NOT IN ('.', '..') THEN filename
    ELSE 'document.' || CASE kind WHEN 'file' THEN 'bin' WHEN 'text' THEN 'txt' ELSE kind END END,
  filename, kind, media_type, r2_key, 0
FROM document_version;
