# Multiple wishlists

This feature replaces the single flat wishlist with named, user-owned lists while keeping the existing `/api/wishlist/` route as the default-list compatibility API. Existing rows are migrated into a default list.

Each entry may record desired variant and condition, priority, acquisition rule, eligibility date, purpose labels, notes and a durable Cardmarket URL. Lists can be exported as generic CSV or a paste-ready Cardmarket Pokémon wants/deck-list text file.

The text export follows Cardmarket's public Pokémon wants guidance: one complete card name per line with an optional `Nx` quantity prefix. Exact Cardmarket URLs are retained as comment lines for manual verification.
