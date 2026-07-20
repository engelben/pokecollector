# Allowance wallet

The wallet is an optional, per-collector financial ledger designed for managed collector profiles. It is independent from wishlist ownership: the wallet reads wishlist items to produce affordable-card suggestions, but deleting or disabling the wallet never changes wishlists.

Money is stored as integer cents. Weekly credits are accrued lazily and idempotently whenever the wallet is opened, so missed weeks are credited after downtime and unused money naturally carries over. All balance changes are immutable ledger entries.

Managed profiles may inspect the balance, build a draft basket and request approval. The managing profile configures the allowance, records gifts or adjustments and confirms actual prices. Shipping is recorded separately and may be paid by the parent or charged to the wallet.

The wallet can run on the flat wishlist model. When the multiple-wishlists feature is also present, `source_wishlist_ids` restricts suggestions to selected lists without creating a hard dependency between the two features.
