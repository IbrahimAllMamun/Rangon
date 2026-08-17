# ADR-0007 — PostgreSQL trigram + indexed facets instead of a search engine

**Status:** Accepted · 2026-08-17

## Context

Plan §19: "Only introduce Elasticsearch/Meilisearch if real requirements justify it." Catalogue size at
launch is hundreds to low thousands of variants.

## Decision

- `pg_trgm` extension + GIN indexes on `product.name`, `product.short_description`, `brand.name`,
  `variant.sku`, `variant.barcode`.
- Ranked search via `SearchVector`/`SearchRank` for names and descriptions, `trigram_similar` for
  typo tolerance, exact match first for SKU/barcode (POS needs exact-first, always).
- Facets (category, brand, price range, size, colour, availability) are plain indexed joins over
  `VariantAttributeValue` with counts computed by aggregation.

## Consequences

- One fewer service to run, back up, secure and keep in sync. No indexing lag, no reindex job, no
  split-brain between the database and a search index.
- Good enough for the catalogue size; the query is measured in `tests/test_performance.py` with a query
  budget so a regression is caught.
- Migration path if the catalogue grows or merchandising demands relevance tuning: search moves behind
  `catalog/search.py`, which is already the single entry point for every search caller.
