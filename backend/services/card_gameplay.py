"""Gameplay fingerprint helpers for playable-equivalent card matching."""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Optional


def _normalize_text(value: Any) -> Any:
    if value is None:
        return None
    if not isinstance(value, str):
        return value
    return re.sub(r"\s+", " ", value.strip().lower())


def _normalize_list(values: Any) -> list:
    if not values:
        return []
    if not isinstance(values, list):
        return [_normalize_text(values)]
    return [_normalize_text(value) for value in values]


def _normalize_attacks(attacks: Any) -> list[dict]:
    if not isinstance(attacks, list):
        return []
    normalized = []
    for attack in attacks:
        if not isinstance(attack, dict):
            continue
        normalized.append({
            "cost": _normalize_list(attack.get("cost")),
            "name": _normalize_text(attack.get("name")),
            "effect": _normalize_text(attack.get("effect")),
            "damage": _normalize_text(attack.get("damage")),
        })
    return normalized


def _normalize_abilities(abilities: Any) -> list[dict]:
    if not isinstance(abilities, list):
        return []
    normalized = []
    for ability in abilities:
        if not isinstance(ability, dict):
            continue
        normalized.append({
            "type": _normalize_text(ability.get("type")),
            "name": _normalize_text(ability.get("name")),
            "effect": _normalize_text(ability.get("effect")),
        })
    return normalized


def _normalize_type_modifiers(modifiers: Any) -> list[dict]:
    if not isinstance(modifiers, list):
        return []
    normalized = []
    for modifier in modifiers:
        if not isinstance(modifier, dict):
            continue
        normalized.append({
            "type": _normalize_text(modifier.get("type")),
            "value": _normalize_text(modifier.get("value")),
        })
    return normalized


def _has_full_gameplay_data(card_data: dict) -> bool:
    """Avoid generating weak fingerprints from brief list/search responses."""
    return any(
        key in card_data
        for key in (
            "attacks",
            "abilities",
            "weaknesses",
            "resistances",
            "retreat",
            "effect",
            "trainerType",
            "energyType",
            "stage",
            "evolveFrom",
            "suffix",
        )
    )


def playable_fingerprint_payload(card_data: dict) -> Optional[dict]:
    """Return the normalized payload used for equivalent playable-print matching."""
    if not _has_full_gameplay_data(card_data):
        return None

    hp = card_data.get("hp")
    retreat = card_data.get("retreat")
    try:
        retreat = int(retreat) if retreat is not None else None
    except (TypeError, ValueError):
        retreat = None

    payload = {
        "name": _normalize_text(card_data.get("name")),
        "category": _normalize_text(card_data.get("category") or card_data.get("supertype")),
        "hp": str(hp) if hp is not None else None,
        "types": _normalize_list(card_data.get("types")),
        "stage": _normalize_text(card_data.get("stage")),
        "suffix": _normalize_text(card_data.get("suffix")),
        "evolve_from": _normalize_text(card_data.get("evolveFrom") or card_data.get("evolve_from")),
        "trainer_type": _normalize_text(card_data.get("trainerType") or card_data.get("trainer_type")),
        "energy_type": _normalize_text(card_data.get("energyType") or card_data.get("energy_type")),
        "effect": _normalize_text(card_data.get("effect") or card_data.get("card_effect")),
        "attacks": _normalize_attacks(card_data.get("attacks")),
        "abilities": _normalize_abilities(card_data.get("abilities")),
        "weaknesses": _normalize_type_modifiers(card_data.get("weaknesses")),
        "resistances": _normalize_type_modifiers(card_data.get("resistances")),
        "retreat": retreat,
    }

    # If the payload contains no meaningful gameplay/text detail, skip it.
    if not any((
        payload["attacks"],
        payload["abilities"],
        payload["weaknesses"],
        payload["resistances"],
        payload["effect"],
        payload["trainer_type"],
        payload["energy_type"],
        payload["stage"],
        payload["suffix"],
        payload["evolve_from"],
        payload["retreat"] is not None,
    )):
        return None

    return payload


def playable_fingerprint(card_data: dict) -> Optional[str]:
    payload = playable_fingerprint_payload(card_data)
    if payload is None:
        return None
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()
