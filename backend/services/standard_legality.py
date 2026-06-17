"""Standard format legality helpers."""

from __future__ import annotations

from typing import Iterable

STANDARD_MIN_REGULATION_MARK = "H"


def normalize_regulation_mark(mark: str | None) -> str | None:
    if not mark:
        return None
    normalized = str(mark).strip().upper()
    if len(normalized) != 1 or not normalized.isalpha():
        return None
    return normalized


def is_standard_regulation_mark(mark: str | None) -> bool:
    normalized = normalize_regulation_mark(mark)
    return normalized is not None and normalized >= STANDARD_MIN_REGULATION_MARK


def standard_legal_fingerprints(cards: Iterable) -> set[str]:
    return {
        card.playable_fingerprint
        for card in cards
        if getattr(card, "playable_fingerprint", None)
        and not getattr(card, "is_custom", False)
        and is_standard_regulation_mark(getattr(card, "regulation_mark", None))
    }


def is_standard_legal_card(card, legal_fingerprints: set[str] | None = None) -> bool:
    if not card or getattr(card, "is_custom", False):
        return False
    if is_standard_regulation_mark(getattr(card, "regulation_mark", None)):
        return True
    fingerprint = getattr(card, "playable_fingerprint", None)
    return bool(fingerprint and legal_fingerprints and fingerprint in legal_fingerprints)
