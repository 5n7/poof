ALTER TABLE document_version ADD COLUMN filename TEXT;
ALTER TABLE document_version ADD COLUMN media_type TEXT NOT NULL DEFAULT 'text/html';
ALTER TABLE document_version ADD COLUMN title TEXT;
