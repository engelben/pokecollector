"""Compact, collector-scoped state summaries for card tiles."""
from collections import defaultdict
from typing import Iterable

from models import CollectionItem, WishlistItem

CANONICAL_VARIANTS = ("Normal", "Holo", "Reverse Holo", "First Edition")


def card_state_summaries(
    db,
    user_id,
    card_ids,
    collection_items: Iterable[CollectionItem] | None = None,
):
    """Return compact, collector-scoped ownership and wishlist summaries.

    Callers that already need exact collection rows for an action modal can pass
    them here, avoiding a second CollectionItem query for the same card page.
    """
    ids = [card_id for card_id in card_ids if card_id]
    summaries = {
        card_id: {
            "owned": False,
            "owned_quantity": 0,
            "owned_variants": [],
            "wishlisted": False,
        }
        for card_id in ids
    }
    if not ids:
        return summaries

    if collection_items is None:
        collection_items = db.query(CollectionItem).filter(
            CollectionItem.user_id == user_id,
            CollectionItem.card_id.in_(ids),
        ).all()

    variants = defaultdict(lambda: defaultdict(int))
    for item in collection_items:
        if item.user_id != user_id or item.card_id not in summaries:
            continue
        quantity = max(int(item.quantity or 0), 0)
        if quantity:
            variants[item.card_id][item.variant or "Normal"] += quantity
    for card_id, by_variant in variants.items():
        total = sum(by_variant.values())
        ordered_variants = [variant for variant in CANONICAL_VARIANTS if by_variant.get(variant, 0) > 0]
        # Dict insertion order preserves the stable order in which custom variants
        # were encountered after canonical variants.
        ordered_variants.extend(
            variant
            for variant in by_variant
            if variant not in CANONICAL_VARIANTS and by_variant[variant] > 0
        )
        summaries[card_id].update(
            owned=True,
            owned_quantity=total,
            owned_variants=[
                {"variant": variant, "quantity": by_variant[variant]}
                for variant in ordered_variants
            ],
        )
    for (card_id,) in db.query(WishlistItem.card_id).filter(
        WishlistItem.user_id == user_id,
        WishlistItem.card_id.in_(ids),
    ).all():
        if card_id in summaries:
            summaries[card_id]["wishlisted"] = True
    return summaries
