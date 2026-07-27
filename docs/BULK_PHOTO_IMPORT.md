# Bulk Photo Collection Import

## Purpose

Bulk Photo Import turns straight-on photographs of binder pages or card groups into a staged collection update. It is intended for a large initial migration and occasional bulk purchases. It does not track physical binder pages or reconcile moved/removed cards.

## MVP scope

- Layouts: fixed `3x3`, fixed `4x3`, and one card per image.
- Multiple images in a resumable, user-owned import session.
- Deterministic grid crops generated server-side with Pillow.
- One primary Gemini request per image containing the ordered slot crops.
- TCGdex lookup and deterministic match scoring; visual verification only for ambiguous matches.
- Review ordered by lowest confidence, with source crop and proposed database image side by side.
- Image-backed dynamic replacement search across the local catalogue, with TCGdex fallback.
- Session defaults for language, condition, and variant, plus per-card corrections.
- Duplicate aggregation before commit.
- Idempotent commit.

## Safety boundaries

Gemini proposes identities; it never writes directly to the collection. Condition is never inferred from a photograph. Foil detection is treated as a hint and flagged for review.

`Add scanned quantities` increments matching collection entries.

`Set scanned quantities` sets only the exact card/language/variant/condition combinations represented by accepted scan results. It does not delete unrelated cards, does not infer missing cards from unphotographed pages, and is not a full inventory synchronization.

## Storage and persistence

A single `photo_import_sessions` row stores the temporary workflow payload as JSONB. Source images and slot crops are stored under `PHOTO_IMPORT_STORAGE_DIR` (default `/app/data/photo-imports`). A persistent deployment should mount that directory, for example:

```yaml
services:
  backend:
    volumes:
      - ./data/photo-imports:/app/data/photo-imports
```

Images are private and served through authenticated API endpoints. Deleting a draft session removes its files. Committed sessions are retained as an idempotency and audit record; source-file cleanup can be added later as a separate retention feature.

## Workflow

1. Create or resume a session and choose layout/defaults/commit mode.
2. Capture or upload page photographs. Pages must be framed straight-on and contain only the selected grid.
3. The backend normalizes each page and creates ordered crops.
4. Gemini extracts one structured result for every slot.
5. PokéCollector resolves candidates and automatically accepts only decisive matches.
6. Review unresolved, low-confidence, and foil-uncertain items. Manual selections are permanent and cannot be overwritten by later analysis.
7. Preview aggregated current/scanned/result quantities.
8. Commit accepted items once. Unresolved and excluded items are skipped and reported.

## Non-goals

- perspective/corner correction;
- arbitrary card detection outside the selected grid;
- permanent binder/page/slot records;
- photographic condition grading;
- reliable foil classification from a single sleeve photograph;
- background queues;
- deleting collection entries not represented in the scan.

## Validation

Backend unit tests cover grid ordering, Gemini response normalization, matching/scoring, duplicate aggregation, and number normalization. Full integration validation should additionally cover authentication, image persistence, both commit modes, idempotent commit, frontend build, Gemini errors, and query refresh after commit.
