"""Helpers for adding only missing wishlist/deck binder cards to the global wishlist."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field


@dataclass(frozen=True)
class WishlistAddition:
    card_id: str
    quantity: int


@dataclass(frozen=True)
class MissingWishlistPlan:
    additions: list[WishlistAddition] = field(default_factory=list)
    checked: int = 0
    missing_copies: int = 0
    wishlist_copies: int = 0
    skipped_complete: int = 0
    skipped_existing: int = 0

    @property
    def card_ids_to_add(self) -> list[str]:
        return [addition.card_id for addition in self.additions]

    @property
    def copies_to_add(self) -> int:
        return sum(addition.quantity for addition in self.additions)

    @property
    def skipped(self) -> int:
        return self.skipped_complete + self.skipped_existing


def _safe_int(value: object, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def plan_missing_wishlist_additions(
    entries: Iterable[tuple[str | None, int | None]],
    owned_quantities: Mapping[str, int | None],
    existing_wishlist_quantities: Mapping[str, int | None] | set[str] | frozenset[str] | None = None,
) -> MissingWishlistPlan:
    """Return wishlist quantity deltas needed to satisfy deck or binder needs.

    Wishlist binders can represent deck lists with required quantities. The global
    wishlist now stores one row per card with a quantity. This helper aggregates
    required quantities per card, subtracts owned copies, subtracts existing
    wishlist quantity, then returns only the additional copies still needed.
    """
    existing_wishlist_quantities = existing_wishlist_quantities or {}
    if isinstance(existing_wishlist_quantities, (set, frozenset)):
        wishlist_quantities = {card_id: 1 for card_id in existing_wishlist_quantities}
    else:
        wishlist_quantities = existing_wishlist_quantities

    required_by_card: dict[str, int] = {}
    ordered_card_ids: list[str] = []

    for card_id, required_quantity in entries:
        if not card_id:
            continue
        if card_id not in required_by_card:
            ordered_card_ids.append(card_id)
            required_by_card[card_id] = 0
        required_by_card[card_id] += max(_safe_int(required_quantity, 1), 1)

    additions: list[WishlistAddition] = []
    missing_copies = 0
    wishlist_copies = 0
    skipped_complete = 0
    skipped_existing = 0

    for card_id in ordered_card_ids:
        required_quantity = required_by_card[card_id]
        owned_quantity = max(_safe_int(owned_quantities.get(card_id), 0), 0)
        wished_quantity = max(_safe_int(wishlist_quantities.get(card_id), 0), 0)
        remaining_wanted = max(required_quantity - owned_quantity, 0)
        additional_quantity = max(remaining_wanted - wished_quantity, 0)
        missing_copies += remaining_wanted
        wishlist_copies += min(wished_quantity, remaining_wanted)
        if remaining_wanted <= 0:
            skipped_complete += 1
            continue
        if additional_quantity <= 0:
            skipped_existing += 1
            continue
        additions.append(WishlistAddition(card_id=card_id, quantity=additional_quantity))

    return MissingWishlistPlan(
        additions=additions,
        checked=len(ordered_card_ids),
        missing_copies=missing_copies,
        wishlist_copies=wishlist_copies,
        skipped_complete=skipped_complete,
        skipped_existing=skipped_existing,
    )
