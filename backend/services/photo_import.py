from __future__ import annotations

import io
import json
import math
import re
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageOps

LAYOUTS: dict[str, tuple[int, int]] = {
    "3x3": (3, 3),
    "4x3": (4, 3),
    "single": (1, 1),
}

ALLOWED_CONDITIONS = {"Mint", "NM", "LP", "MP", "HP"}
ALLOWED_VARIANTS = {"Normal", "Holo", "Reverse Holo", "First Edition"}
ALLOWED_COMMIT_MODES = {"add", "set_scanned"}
ALLOWED_ITEM_STATUSES = {"accepted", "review", "unresolved", "excluded"}

_JSON_OBJECT_RE = re.compile(r"\{.*\}", re.DOTALL)
_SUFFIX_RE = re.compile(
    r"[\s-]+(?:EX|ex|GX|gx|V|VMAX|VSTAR|VStar|TAG\s*TEAM|BREAK|LV\.?\s*X)\s*$",
    re.IGNORECASE,
)


def layout_dimensions(layout: str) -> tuple[int, int]:
    try:
        return LAYOUTS[layout]
    except KeyError as exc:
        raise ValueError(f"Unsupported layout: {layout}") from exc


def crop_grid(
    image_bytes: bytes,
    layout: str,
    *,
    max_dimension: int = 2600,
    outer_margin_ratio: float = 0.012,
    cell_inset_ratio: float = 0.025,
) -> tuple[bytes, list[bytes]]:
    """Normalize a page photo and return an ordered set of fixed-grid JPEG crops.

    The MVP intentionally assumes a straight-on photograph. Perspective/corner
    correction is not hidden inside this helper: adding it later should produce
    the same normalized page bytes before this deterministic grid step.
    """
    rows, columns = layout_dimensions(layout)
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")

    largest = max(image.size)
    if largest > max_dimension:
        scale = max_dimension / largest
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )

    normalized_buffer = io.BytesIO()
    image.save(normalized_buffer, format="JPEG", quality=90, optimize=True)

    margin_x = round(image.width * outer_margin_ratio)
    margin_y = round(image.height * outer_margin_ratio)
    usable_left = margin_x
    usable_top = margin_y
    usable_right = image.width - margin_x
    usable_bottom = image.height - margin_y
    usable_width = max(1, usable_right - usable_left)
    usable_height = max(1, usable_bottom - usable_top)

    cell_width = usable_width / columns
    cell_height = usable_height / rows
    crops: list[bytes] = []

    for row in range(rows):
        for column in range(columns):
            left = usable_left + column * cell_width
            top = usable_top + row * cell_height
            right = usable_left + (column + 1) * cell_width
            bottom = usable_top + (row + 1) * cell_height

            inset_x = cell_width * cell_inset_ratio
            inset_y = cell_height * cell_inset_ratio
            box = (
                max(0, math.floor(left + inset_x)),
                max(0, math.floor(top + inset_y)),
                min(image.width, math.ceil(right - inset_x)),
                min(image.height, math.ceil(bottom - inset_y)),
            )
            crop = image.crop(box)
            crop_buffer = io.BytesIO()
            crop.save(crop_buffer, format="JPEG", quality=88, optimize=True)
            crops.append(crop_buffer.getvalue())

    return normalized_buffer.getvalue(), crops


def parse_gemini_page_response(text: str, slot_count: int) -> list[dict]:
    match = _JSON_OBJECT_RE.search(text or "")
    if not match:
        raise ValueError("Gemini response did not contain a JSON object")
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ValueError("Gemini response contained invalid JSON") from exc

    cards = payload.get("cards") if isinstance(payload, dict) else None
    if not isinstance(cards, list):
        raise ValueError("Gemini response must contain a cards array")

    by_slot: dict[int, dict] = {}
    for entry in cards:
        if not isinstance(entry, dict):
            continue
        try:
            slot = int(entry.get("slot"))
        except (TypeError, ValueError):
            continue
        if slot < 1 or slot > slot_count or slot in by_slot:
            continue
        occupied = bool(entry.get("occupied", True))
        cleaned = {
            "slot": slot,
            "occupied": occupied,
            "name": _clean_optional_string(entry.get("name")),
            "name_en": _clean_optional_string(entry.get("name_en")),
            "number": _clean_optional_string(entry.get("number")),
            "set_hint": _clean_optional_string(entry.get("set_hint")),
            "language": _clean_optional_string(entry.get("language")) or "en",
            "variant_hint": _normalize_variant_hint(entry.get("variant_hint")),
        }
        by_slot[slot] = cleaned

    # Missing slots are represented explicitly as unresolved occupied slots. This
    # avoids silently dropping a crop when Gemini omits one array entry.
    return [
        by_slot.get(slot, {
            "slot": slot,
            "occupied": True,
            "name": None,
            "name_en": None,
            "number": None,
            "set_hint": None,
            "language": "en",
            "variant_hint": None,
            "parse_error": "slot_missing_from_response",
        })
        for slot in range(1, slot_count + 1)
    ]


def _clean_optional_string(value) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _normalize_variant_hint(value) -> str | None:
    cleaned = _clean_optional_string(value)
    if not cleaned:
        return None
    aliases = {
        "normal": "Normal",
        "non-holo": "Normal",
        "non holo": "Normal",
        "holo": "Holo",
        "holofoil": "Holo",
        "reverse": "Reverse Holo",
        "reverse holo": "Reverse Holo",
        "reverse holofoil": "Reverse Holo",
        "first edition": "First Edition",
        "1st edition": "First Edition",
    }
    return aliases.get(cleaned.casefold())


def normalize_text(value: str | None) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value or ""))
    without_marks = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", " ", without_marks.casefold()).strip()


def simplify_card_name(value: str | None) -> str:
    return _SUFFIX_RE.sub("", str(value or "")).strip()


def normalize_card_number(value: str | None) -> str:
    raw = str(value or "").strip().split("/", 1)[0].strip()
    numeric = re.match(r"^(\d+)", raw)
    if numeric:
        return str(int(numeric.group(1)))
    return normalize_text(raw)


def score_candidate(recognized: dict, candidate: dict) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []

    recognized_number = normalize_card_number(recognized.get("number"))
    candidate_number = normalize_card_number(candidate.get("number") or candidate.get("localId"))
    if recognized_number and candidate_number and recognized_number == candidate_number:
        score += 45
        reasons.append("exact_number")

    recognized_names = {
        normalize_text(recognized.get("name")),
        normalize_text(recognized.get("name_en")),
        normalize_text(simplify_card_name(recognized.get("name"))),
        normalize_text(simplify_card_name(recognized.get("name_en"))),
    } - {""}
    candidate_name = normalize_text(candidate.get("name"))
    candidate_simple = normalize_text(simplify_card_name(candidate.get("name")))
    if candidate_name and candidate_name in recognized_names:
        score += 30
        reasons.append("exact_name")
    elif candidate_simple and candidate_simple in recognized_names:
        score += 24
        reasons.append("simplified_name")
    elif candidate_name and any(
        candidate_name in name or name in candidate_name for name in recognized_names
    ):
        score += 15
        reasons.append("partial_name")

    set_hint = normalize_text(recognized.get("set_hint"))
    candidate_set_values = {
        normalize_text(candidate.get("set")),
        normalize_text(candidate.get("set_name")),
        normalize_text(candidate.get("set_abbreviation")),
        normalize_text(candidate.get("set_id")),
    } - {""}
    if set_hint and any(
        set_hint == value or set_hint in value or value in set_hint
        for value in candidate_set_values
    ):
        score += 20
        reasons.append("set_match")

    recognized_lang = normalize_text(recognized.get("language"))
    candidate_lang = normalize_text(candidate.get("lang"))
    if recognized_lang and candidate_lang and recognized_lang == candidate_lang:
        score += 5
        reasons.append("language_match")

    return min(score, 100), reasons


def classify_candidates(scored_candidates: list[dict]) -> tuple[str, int, list[str]]:
    if not scored_candidates:
        return "unresolved", 0, ["no_candidates"]

    best = scored_candidates[0]
    best_score = int(best.get("score") or 0)
    next_score = int(scored_candidates[1].get("score") or 0) if len(scored_candidates) > 1 else 0
    reasons = list(best.get("reasons") or [])
    decisive_gap = best_score - next_score

    if best_score >= 75 and (decisive_gap >= 10 or "exact_number" in reasons and "set_match" in reasons):
        return "high", best_score, reasons
    if best_score >= 35:
        return "review", best_score, reasons
    return "unresolved", best_score, reasons or ["weak_match"]


def aggregate_import_items(items: Iterable[dict]) -> list[dict]:
    grouped: dict[tuple, dict] = {}
    for item in items:
        if item.get("status") != "accepted":
            continue
        card_id = item.get("selected_card_id") or item.get("proposed_card_id")
        if not card_id:
            continue
        key = (
            card_id,
            item.get("lang") or "en",
            item.get("variant") or "Normal",
            item.get("condition") or "NM",
        )
        quantity = max(1, int(item.get("quantity") or 1))
        if key not in grouped:
            grouped[key] = {
                "card_id": card_id,
                "lang": key[1],
                "variant": key[2],
                "condition": key[3],
                "scanned_quantity": 0,
                "item_ids": [],
                "card": item.get("selected_card") or item.get("proposed_card"),
            }
        grouped[key]["scanned_quantity"] += quantity
        grouped[key]["item_ids"].append(item.get("id"))
    return list(grouped.values())



def projected_quantity(current_quantity: int, scanned_quantity: int, commit_mode: str) -> int:
    if commit_mode not in ALLOWED_COMMIT_MODES:
        raise ValueError(f"Unsupported commit mode: {commit_mode}")
    current = max(0, int(current_quantity or 0))
    scanned = max(0, int(scanned_quantity or 0))
    return current + scanned if commit_mode == "add" else scanned

def safe_child_path(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve()
    candidate_resolved = candidate.resolve()
    if candidate_resolved != root_resolved and root_resolved not in candidate_resolved.parents:
        raise ValueError("Path escapes the photo import storage root")
    return candidate_resolved
