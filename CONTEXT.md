# Poof document sharing

Poof keeps a private library of documents and grants temporary public access through shares.

## Language

**Document**:
A collection of related files with one identity, title, lifetime, and version history. A document appears once in the library and can have several shares.
_Avoid_: Record, bundle, project

**File**:
One item within a document, identified by its relative path. Files in the same document can use different formats and link to each other.
_Avoid_: Record, document when referring to one item in a collection

**Version**:
An immutable snapshot of a document's complete ordered file set. The current version is the snapshot shown by the document's live shares.
_Avoid_: File revision when referring to a complete snapshot

**Share**:
Temporary public access to a document through a secret URL. Each share has its own expiry and can be revoked independently.
_Avoid_: Document lifetime, owner URL
