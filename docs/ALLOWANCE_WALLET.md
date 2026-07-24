# Allowance wallet

The wallet is an optional, per-collector financial ledger designed for managed collector profiles. It is independent from wishlist ownership: the wallet reads wishlist items to produce affordable-card suggestions, but deleting or disabling the wallet never changes wishlists.

Money is stored as integer cents. Weekly credits are accrued lazily and idempotently whenever the wallet is opened, so missed weeks are credited after downtime and unused money naturally carries over. All balance changes are immutable ledger entries.

Managed profiles may inspect the balance, build a persistent draft cart directly from the wishlist and request approval. The managing profile configures the allowance, records gifts or adjustments and confirms actual prices. Shipping is recorded separately and may be paid by the parent or charged to the wallet. A cart is never a reservation or a balance mutation: submitting it creates the immutable purchase-plan snapshot, and only parent confirmation writes the purchase debit to the ledger.

The cart API is available at `/api/budget/cart` (`GET`, `PUT /items`, `DELETE /items/{wishlist_item_id}`, and `POST /submit`). Its item rows retain only wishlist IDs and integer quantities; current card prices are recalculated for display. This keeps a cart compatible with both the flat wishlist and a future `wishlist_id`-based multiple-wishlists schema.

The wallet can run on the flat wishlist model. When the multiple-wishlists feature is also present, `source_wishlist_ids` restricts suggestions to selected lists without creating a hard dependency between the two features.
