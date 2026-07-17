# Implementation brief: National Pokédex for PokéCollector

## Goal

Add an additive species-first view covering National Dex #001–1025 while retaining all existing set, card, collection, binder, and wishlist workflows.

## Required user journey

```text
Pokédex → filter/search → open a missing species → browse matching card printings
→ open an exact Cardmarket product or fallback search → acquire/add the card
→ species becomes Owned automatically
```

## Functional requirements

- First-class `/pokedex` navigation and `/pokedex/{dex_id}` species routes.
- Visual compact tile grid inspired behaviorally by a traditional Pokédex: pixel sprite, number, names, completion status, owned quantity, and available-printing count.
- National view grouped by Kanto through Paldea, with National and Gen 1–9 pills.
- Search by English/German name and padded/unpadded National Dex number.
- All/Owned/Missing filters and scope-level progress.
- Species page with official artwork, sprite fallback, previous/next navigation, and the existing card grid filtered by `dex_id`.
- Ownership derived only from existing collection items.
- Store TCGdex `dexId` as an array and Cardmarket products as a variant-aware list.
- Full-card enrichment and an idempotent backfill; no live TCGdex join during page rendering.
- Persistent local image cache with eager CLI population and lazy fill.
- Exact Cardmarket product links per printing/variant, with a safe search fallback.
- Existing set-driven behavior must remain unchanged.

## Scope boundaries

Not included in this feature:

- manually selected representative/binder-slot cards;
- separate curated-Pokédex completion records;
- Cardmarket authentication or API synchronization;
- automatic wants-list/cart/Shopping Wizard operations;
- replacement of existing set completion logic.

## Follow-up

Add a wishlist-to-Cardmarket transfer assistant after this feature. The first version should provide exact-product links/checklist and an optional Cardmarket decklist-text export with clear matching limitations.
