"""Static National Pokédex catalogue and collection aggregation helpers."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Iterable

from sqlalchemy.orm import Session

from models import Card, CollectionItem
from services.card_visibility import visible_card_filter

MAX_DEX_ID = 1025
REGION_RANGES = {
    1: (1, 151),
    2: (152, 251),
    3: (252, 386),
    4: (387, 493),
    5: (494, 649),
    6: (650, 721),
    7: (722, 809),
    8: (810, 905),
    9: (906, 1025),
}


def _catalogue_path() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "pokedex.json"


@lru_cache(maxsize=1)
def load_pokedex() -> tuple[dict, ...]:
    data = json.loads(_catalogue_path().read_text(encoding="utf-8"))
    return tuple(data)


@lru_cache(maxsize=1)
def pokedex_by_id() -> dict[int, dict]:
    return {int(entry["dex_id"]): entry for entry in load_pokedex()}


def normalize_dex_ids(value) -> list[int]:
    if not isinstance(value, list):
        return []
    result = []
    for raw in value:
        try:
            dex_id = int(raw)
        except (TypeError, ValueError):
            continue
        if 1 <= dex_id <= MAX_DEX_ID and dex_id not in result:
            result.append(dex_id)
    return result


def _matches_search(entry: dict, search: str | None) -> bool:
    if not search:
        return True
    needle = search.strip().casefold()
    if not needle:
        return True
    numeric = needle.lstrip("#").lstrip("0") or "0"
    if numeric.isdigit() and int(numeric) == int(entry["dex_id"]):
        return True
    return needle in entry.get("name_en", "").casefold() or needle in entry.get("name_de", "").casefold()


def aggregate_pokedex(
    db: Session,
    user_id: int,
    *,
    language: str = "en",
    generation: int | None = None,
    region: str | None = None,
    status: str = "all",
    search: str | None = None,
) -> dict:
    """Return all species with available-printing and ownership counts.

    This deliberately uses two bulk queries and aggregates JSON arrays in Python.
    It avoids PostgreSQL-specific JSON operators in the overview path and remains
    compatible with the lightweight test database used by contributors.
    """
    catalogue = list(load_pokedex())

    available_rows = (
        db.query(Card.tcg_card_id, Card.dex_ids)
        .filter(
            Card.is_custom.is_(False),
            Card.dex_ids.isnot(None),
            visible_card_filter(db, user_id, language),
        )
        .all()
    )
    available: dict[int, set[str]] = {}
    for tcg_card_id, dex_ids in available_rows:
        for dex_id in normalize_dex_ids(dex_ids):
            available.setdefault(dex_id, set()).add(tcg_card_id or f"unknown-{dex_id}")

    owned_rows = (
        db.query(CollectionItem.quantity, Card.dex_ids)
        .join(Card, Card.id == CollectionItem.card_id)
        .filter(
            CollectionItem.user_id == user_id,
            Card.dex_ids.isnot(None),
            Card.is_custom.is_(False),
            visible_card_filter(db, user_id, "all"),
        )
        .all()
    )
    owned: dict[int, int] = {}
    for quantity, dex_ids in owned_rows:
        for dex_id in normalize_dex_ids(dex_ids):
            owned[dex_id] = owned.get(dex_id, 0) + max(int(quantity or 0), 0)

    scoped = [
        entry for entry in catalogue
        if (generation is None or int(entry["generation"]) == generation)
        and (region is None or entry["region"].casefold() == region.casefold())
    ]
    scope_total = len(scoped)
    scope_owned = sum(1 for entry in scoped if owned.get(int(entry["dex_id"]), 0) > 0)

    entries = []
    for entry in scoped:
        dex_id = int(entry["dex_id"])
        owned_cards = owned.get(dex_id, 0)
        is_owned = owned_cards > 0
        if status == "owned" and not is_owned:
            continue
        if status == "missing" and is_owned:
            continue
        if not _matches_search(entry, search):
            continue
        row = dict(entry)
        row.update(
            owned=is_owned,
            owned_cards=owned_cards,
            available_printings=len(available.get(dex_id, set())),
            sprite_url=f"/api/pokedex/images/sprites/{dex_id}.png",
            artwork_url=f"/api/pokedex/images/artwork/{dex_id}.png",
        )
        entries.append(row)

    return {
        "summary": {
            "generation": generation,
            "region": region,
            "total": scope_total,
            "owned": scope_owned,
            "missing": scope_total - scope_owned,
            "visible": len(entries),
        },
        "entries": entries,
    }


def species_detail(db: Session, user_id: int, dex_id: int, *, language: str = "en") -> dict | None:
    entry = pokedex_by_id().get(dex_id)
    if not entry:
        return None
    aggregate = aggregate_pokedex(db, user_id, language=language, search=str(dex_id))
    current = next((row for row in aggregate["entries"] if row["dex_id"] == dex_id), None)
    if not current:
        current = {
            **entry,
            "owned": False,
            "owned_cards": 0,
            "available_printings": 0,
            "sprite_url": f"/api/pokedex/images/sprites/{dex_id}.png",
            "artwork_url": f"/api/pokedex/images/artwork/{dex_id}.png",
        }
    current["previous_dex_id"] = dex_id - 1 if dex_id > 1 else None
    current["next_dex_id"] = dex_id + 1 if dex_id < MAX_DEX_ID else None
    return current
