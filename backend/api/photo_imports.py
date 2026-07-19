from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, cast, func, or_
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from api.auth import get_current_user
from api.collection import (
    _active_product_link_quantity,
    _add_collection_item,
    _find_card_by_code,
    ensure_card_exists,
)
from api.recognize import build_gemini_generate_url, get_gemini_key, post_gemini_generate
from database import get_db
from models import Card, CollectionItem, PhotoImportSession, Set, User
from schemas import CollectionItemCreate
from services.card_visibility import visible_card_filter
from services.photo_import import (
    ALLOWED_COMMIT_MODES,
    ALLOWED_CONDITIONS,
    ALLOWED_ITEM_STATUSES,
    ALLOWED_VARIANTS,
    LAYOUTS,
    aggregate_import_items,
    classify_candidates,
    crop_grid,
    normalize_card_number,
    normalize_text,
    parse_gemini_page_response,
    projected_quantity,
    safe_child_path,
    score_candidate,
    simplify_card_name,
)
from services.tcgdex_languages import (
    is_supported_tcgdex_language,
    normalize_tcgdex_language,
)

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGES_PER_SESSION = 100
MAX_VISUAL_VERIFICATIONS_PER_PAGE = 4
PHOTO_IMPORT_STORAGE_DIR = Path(os.environ.get("PHOTO_IMPORT_STORAGE_DIR", "/app/data/photo-imports"))
_CODE_NUMBER_RE = re.compile(r"^([A-Za-z]+\d*)\s+(\d+)$")


class PhotoImportCreate(BaseModel):
    layout: str = "3x3"
    default_lang: str = "en"
    default_condition: str = "NM"
    default_variant: str = "Normal"
    commit_mode: str = "add"


class PhotoImportSessionUpdate(BaseModel):
    default_lang: str | None = None
    default_condition: str | None = None
    default_variant: str | None = None
    commit_mode: str | None = None
    apply_defaults_to_unedited: bool = False


class PhotoImportItemUpdate(BaseModel):
    selected_card_id: str | None = None
    status: str | None = None
    lang: str | None = None
    condition: str | None = None
    variant: str | None = None
    quantity: int | None = Field(None, ge=1, le=99)


class PhotoImportCommitRequest(BaseModel):
    commit_mode: str | None = None


def _validate_layout(layout: str) -> str:
    if layout not in LAYOUTS:
        raise HTTPException(status_code=422, detail=f"layout must be one of: {', '.join(LAYOUTS)}")
    return layout


def _validate_lang(lang: str) -> str:
    normalized = normalize_tcgdex_language(lang or "en")
    if not is_supported_tcgdex_language(normalized):
        raise HTTPException(status_code=422, detail="Unsupported TCGdex language")
    return normalized


def _validate_condition(condition: str) -> str:
    if condition not in ALLOWED_CONDITIONS:
        raise HTTPException(status_code=422, detail=f"condition must be one of: {', '.join(sorted(ALLOWED_CONDITIONS))}")
    return condition


def _validate_variant(variant: str) -> str:
    if variant not in ALLOWED_VARIANTS:
        raise HTTPException(status_code=422, detail=f"variant must be one of: {', '.join(sorted(ALLOWED_VARIANTS))}")
    return variant


def _validate_commit_mode(mode: str) -> str:
    if mode not in ALLOWED_COMMIT_MODES:
        raise HTTPException(status_code=422, detail="commit_mode must be 'add' or 'set_scanned'")
    return mode


def _payload(session: PhotoImportSession) -> dict:
    value = session.payload if isinstance(session.payload, dict) else {}
    return {
        **value,
        "images": [dict(image) for image in value.get("images", []) if isinstance(image, dict)],
        "items": [dict(item) for item in value.get("items", []) if isinstance(item, dict)],
    }


def _store_payload(session: PhotoImportSession, value: dict) -> None:
    session.payload = {
        **value,
        "images": list(value.get("images") or []),
        "items": list(value.get("items") or []),
    }
    session.updated_at = datetime.utcnow()


def _session_or_404(
    db: Session,
    current_user: User,
    session_id: str,
    *,
    lock: bool = False,
) -> PhotoImportSession:
    query = db.query(PhotoImportSession).filter(
        PhotoImportSession.id == session_id,
        PhotoImportSession.user_id == current_user.id,
    )
    if lock:
        query = query.with_for_update()
    session = query.first()
    if not session:
        raise HTTPException(status_code=404, detail="Photo import session not found")
    return session


def _assert_mutable(session: PhotoImportSession) -> None:
    if session.status in {"committing", "committed"}:
        raise HTTPException(status_code=409, detail="Committed photo import sessions cannot be changed")


def _storage_root() -> Path:
    PHOTO_IMPORT_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    return PHOTO_IMPORT_STORAGE_DIR


def _session_directory(session: PhotoImportSession) -> Path:
    return safe_child_path(_storage_root(), _storage_root() / str(session.user_id) / session.id)


def _image_directory(session: PhotoImportSession, image_id: str) -> Path:
    return safe_child_path(_session_directory(session), _session_directory(session) / image_id)


def _card_snapshot(card: Card | None) -> dict | None:
    if not card:
        return None
    set_ref = getattr(card, "set_ref", None)
    variants = []
    if card.variants_normal:
        variants.append("Normal")
    if card.variants_holo:
        variants.append("Holo")
    if card.variants_reverse:
        variants.append("Reverse Holo")
    if card.variants_first_edition:
        variants.append("First Edition")
    return {
        "id": card.id,
        "tcg_card_id": card.tcg_card_id,
        "name": card.name,
        "number": card.number,
        "set_id": card.set_id,
        "set": set_ref.name if set_ref else card.set_id,
        "set_abbreviation": set_ref.abbreviation if set_ref else None,
        "lang": card.lang or "en",
        "image": card.custom_image_url or card.images_small or card.images_large,
        "rarity": card.rarity,
        "dex_ids": card.dex_ids,
        "variants": variants,
    }


def _candidate_snapshot(candidate: dict | None) -> dict | None:
    if not candidate:
        return None
    return {
        key: candidate.get(key)
        for key in (
            "id", "tcg_card_id", "name", "number", "set_id", "set",
            "set_abbreviation", "lang", "image", "rarity", "variants",
        )
    }


def _serialize_session(db: Session, session: PhotoImportSession) -> dict:
    payload = _payload(session)
    image_order_by_id = {image.get("id"): int(image.get("upload_order") or 0) for image in payload["images"]}
    items = []
    for raw in payload["items"]:
        item = dict(raw)
        item["image_order"] = image_order_by_id.get(item.get("image_id"), 0)
        image_id = item.get("image_id")
        slot = item.get("slot")
        item["crop_url"] = f"/api/photo-imports/{session.id}/images/{image_id}/slots/{slot}"
        selected_id = item.get("selected_card_id") or item.get("proposed_card_id")
        selected = item.get("selected_card")
        if not selected and selected_id:
            selected = _candidate_snapshot(next(
                (candidate for candidate in item.get("candidates", []) if candidate.get("id") == selected_id),
                None,
            ))
        if not selected and selected_id:
            selected = _card_snapshot(db.query(Card).filter(Card.id == selected_id).first())
        item["selected_card"] = selected
        item["needs_review"] = (
            item.get("status") in {"review", "unresolved"}
            or item.get("variant_state") == "review"
        )
        items.append(item)

    images = []
    for raw in payload["images"]:
        image = dict(raw)
        image["preview_url"] = f"/api/photo-imports/{session.id}/images/{image['id']}/original"
        images.append(image)

    counts = {
        "images": len(images),
        "items": len(items),
        "accepted": sum(item.get("status") == "accepted" for item in items),
        "review": sum(item.get("status") == "review" or item.get("variant_state") == "review" for item in items),
        "unresolved": sum(item.get("status") == "unresolved" for item in items),
        "excluded": sum(item.get("status") == "excluded" for item in items),
        "empty_slots": sum(int(image.get("empty_slots") or 0) for image in images),
    }
    return {
        "id": session.id,
        "status": session.status,
        "layout": session.layout,
        "default_lang": session.default_lang,
        "default_condition": session.default_condition,
        "default_variant": session.default_variant,
        "commit_mode": session.commit_mode,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "committed_at": session.committed_at,
        "commit_result": session.commit_result,
        "images": images,
        "items": items,
        "counts": counts,
    }


def _gemini_page_prompt(slot_count: int) -> str:
    return f"""You are identifying Pokemon Trading Card Game cards from {slot_count} ordered binder-slot crops.
For every numbered slot, decide whether a card is present and extract visible identity data.
Do not guess card condition. Foil treatment is only a hint and may be null because binder sleeves create glare.

Return ONLY this exact JSON shape, without markdown:
{{
  "cards": [
    {{
      "slot": 1,
      "occupied": true,
      "name": "exact printed card name or null",
      "name_en": "English card name or null",
      "number": "collector number such as 025/165 or null",
      "set_hint": "visible set name, abbreviation, or symbol description or null",
      "language": "two-letter TCGdex language code",
      "variant_hint": "Normal, Holo, Reverse Holo, First Edition, or null"
    }}
  ]
}}
Include exactly one entry for every slot from 1 through {slot_count}."""


async def _extract_page_cards(
    crop_paths: list[Path],
    *,
    api_key: str,
) -> list[dict]:
    parts: list[dict] = [{"text": _gemini_page_prompt(len(crop_paths))}]
    for index, crop_path in enumerate(crop_paths, start=1):
        parts.append({"text": f"Slot {index}:"})
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(crop_path.read_bytes()).decode("ascii"),
            }
        })

    async with httpx.AsyncClient(timeout=60) as client:
        response = await post_gemini_generate(
            client,
            build_gemini_generate_url(),
            api_key,
            {"contents": [{"parts": parts}]},
        )
    result = response.json()
    text = result["candidates"][0]["content"]["parts"][0]["text"].strip()
    return parse_gemini_page_response(text, len(crop_paths))


async def _search_tcgdex_candidates(
    client: httpx.AsyncClient,
    recognized: dict,
) -> list[dict]:
    detected_lang = normalize_tcgdex_language(recognized.get("language") or "en")
    if not is_supported_tcgdex_language(detected_lang):
        detected_lang = "en"

    search_pairs: list[tuple[str, str]] = []
    for language, raw_name in (
        (detected_lang, simplify_card_name(recognized.get("name"))),
        (detected_lang, recognized.get("name")),
        ("en", simplify_card_name(recognized.get("name_en"))),
        ("en", recognized.get("name_en")),
    ):
        name = str(raw_name or "").strip()
        pair = (language, name)
        if name and pair not in search_pairs:
            search_pairs.append(pair)

    candidates: list[dict] = []
    seen: set[str] = set()
    for language, search_name in search_pairs:
        try:
            response = await client.get(
                f"https://api.tcgdex.net/v2/{language}/cards",
                params={"name": search_name},
                timeout=15,
            )
        except httpx.RequestError:
            continue
        if response.status_code != 200:
            continue
        body = response.json()
        if not isinstance(body, list):
            continue
        for card in body[:12]:
            tcg_card_id = card.get("id")
            if not tcg_card_id:
                continue
            composite_id = f"{tcg_card_id}_{language}"
            if composite_id in seen:
                continue
            seen.add(composite_id)
            set_data = card.get("set") if isinstance(card.get("set"), dict) else {}
            image_base = card.get("image")
            candidate = {
                "id": composite_id,
                "tcg_card_id": tcg_card_id,
                "name": card.get("name"),
                "number": card.get("localId"),
                "set_id": set_data.get("id"),
                "set": set_data.get("name"),
                "set_abbreviation": set_data.get("abbreviation"),
                "lang": language,
                "image": f"{image_base}/low.webp" if image_base else None,
                "rarity": card.get("rarity"),
                "variants": [],
            }
            score, reasons = score_candidate(recognized, candidate)
            candidate["score"] = score
            candidate["reasons"] = reasons
            candidates.append(candidate)

    candidates.sort(key=lambda card: (-int(card.get("score") or 0), card.get("id") or ""))
    return candidates[:8]


async def _visual_verify_candidate(
    client: httpx.AsyncClient,
    crop_path: Path,
    candidates: list[dict],
    *,
    api_key: str,
) -> str | None:
    candidates = [candidate for candidate in candidates[:4] if candidate.get("image")]
    if len(candidates) < 2:
        return None

    parts: list[dict] = [
        {"text": "Original binder-slot crop:"},
        {"inline_data": {
            "mime_type": "image/jpeg",
            "data": base64.b64encode(crop_path.read_bytes()).decode("ascii"),
        }},
        {"text": "Pick the matching database card by artwork, name, number and set. Reply only with 1, 2, 3, 4, or 0 for none."},
    ]
    usable: list[dict] = []
    for candidate in candidates:
        try:
            response = await client.get(candidate["image"], timeout=8)
        except httpx.RequestError:
            continue
        if response.status_code != 200:
            continue
        usable.append(candidate)
        parts.append({"text": f"Candidate {len(usable)}: {candidate.get('name')} #{candidate.get('number')} ({candidate.get('set')})"})
        parts.append({"inline_data": {
            "mime_type": response.headers.get("content-type", "image/webp"),
            "data": base64.b64encode(response.content).decode("ascii"),
        }})
    if len(usable) < 2:
        return None

    try:
        response = await post_gemini_generate(
            client,
            build_gemini_generate_url(),
            api_key,
            {"contents": [{"parts": parts}]},
            max_attempts=2,
        )
        text = response.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        match = re.search(r"\d+", text)
        picked = int(match.group(0)) if match else 0
    except Exception:
        logger.warning("Photo import visual verification failed", exc_info=True)
        return None
    if 1 <= picked <= len(usable):
        return usable[picked - 1]["id"]
    return None


async def _recognize_image_items(
    session: PhotoImportSession,
    image: dict,
    *,
    api_key: str,
) -> tuple[list[dict], int]:
    directory = _image_directory(session, image["id"])
    crop_paths = [safe_child_path(directory, directory / f"slot-{slot:02d}.jpg") for slot in range(1, int(image["slot_count"]) + 1)]
    recognized_cards = await _extract_page_cards(crop_paths, api_key=api_key)
    occupied = [card for card in recognized_cards if card.get("occupied")]
    empty_slots = len(recognized_cards) - len(occupied)

    semaphore = asyncio.Semaphore(4)
    async with httpx.AsyncClient(timeout=30) as client:
        async def resolve(card: dict) -> tuple[dict, list[dict]]:
            if not card.get("name") and not card.get("name_en"):
                return card, []
            async with semaphore:
                return card, await _search_tcgdex_candidates(client, card)

        resolved = await asyncio.gather(*(resolve(card) for card in occupied))
        visual_count = 0
        items: list[dict] = []
        for recognized, candidates in resolved:
            state, score, reasons = classify_candidates(candidates)
            crop_path = crop_paths[int(recognized["slot"]) - 1]
            if state == "review" and visual_count < MAX_VISUAL_VERIFICATIONS_PER_PAGE:
                picked_id = await _visual_verify_candidate(client, crop_path, candidates, api_key=api_key)
                if picked_id is not None:
                    visual_count += 1
                    picked = next((index for index, candidate in enumerate(candidates) if candidate.get("id") == picked_id), None)
                    if picked is None:
                        picked = 0
                    winner = candidates.pop(picked)
                    winner["score"] = max(int(winner.get("score") or 0), 78)
                    winner["reasons"] = list(dict.fromkeys([*(winner.get("reasons") or []), "artwork_match"]))
                    candidates.insert(0, winner)
                    state, score, reasons = classify_candidates(candidates)

            proposed = candidates[0] if candidates else None
            hint = recognized.get("variant_hint")
            variant = hint if hint in ALLOWED_VARIANTS else session.default_variant
            variant_needs_review = hint in {"Holo", "Reverse Holo", "First Edition"}
            item_status = "accepted" if state == "high" and not variant_needs_review else state
            if item_status == "high":
                item_status = "accepted"
            if item_status not in ALLOWED_ITEM_STATUSES:
                item_status = "review"

            items.append({
                "id": uuid4().hex,
                "image_id": image["id"],
                "slot": int(recognized["slot"]),
                "recognized": recognized,
                "candidates": candidates,
                "proposed_card_id": proposed.get("id") if proposed else None,
                "selected_card_id": proposed.get("id") if proposed else None,
                "selected_card": _candidate_snapshot(proposed),
                "identity_score": score,
                "identity_state": state,
                "confidence_reasons": reasons,
                "variant_state": "review" if variant_needs_review else "default",
                "lang": (
                    normalize_tcgdex_language(recognized.get("language") or session.default_lang)
                    if is_supported_tcgdex_language(normalize_tcgdex_language(recognized.get("language") or session.default_lang))
                    else session.default_lang
                ),
                "condition": session.default_condition,
                "variant": variant,
                "quantity": 1,
                "status": item_status,
                "match_source": "automatic",
                "manually_edited": False,
            })
    return items, empty_slots


@router.get("/")
def list_photo_imports(
    include_committed: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(PhotoImportSession).filter(PhotoImportSession.user_id == current_user.id)
    if not include_committed:
        query = query.filter(PhotoImportSession.status != "committed")
    sessions = query.order_by(PhotoImportSession.updated_at.desc(), PhotoImportSession.created_at.desc()).limit(20).all()
    return [{
        "id": session.id,
        "status": session.status,
        "layout": session.layout,
        "updated_at": session.updated_at,
        "created_at": session.created_at,
        "counts": _serialize_session(db, session)["counts"],
    } for session in sessions]


@router.post("/")
def create_photo_import(
    request: PhotoImportCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = PhotoImportSession(
        id=uuid4().hex,
        user_id=current_user.id,
        status="draft",
        layout=_validate_layout(request.layout),
        default_lang=_validate_lang(request.default_lang),
        default_condition=_validate_condition(request.default_condition),
        default_variant=_validate_variant(request.default_variant),
        commit_mode=_validate_commit_mode(request.commit_mode),
        payload={"images": [], "items": []},
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    _session_directory(session).mkdir(parents=True, exist_ok=True)
    return _serialize_session(db, session)


@router.get("/{session_id}")
def get_photo_import(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _serialize_session(db, _session_or_404(db, current_user, session_id))


@router.put("/{session_id}")
def update_photo_import(
    session_id: str,
    request: PhotoImportSessionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    _assert_mutable(session)
    changes = request.model_dump(exclude_unset=True)
    apply_defaults = bool(changes.pop("apply_defaults_to_unedited", False))
    if "default_lang" in changes:
        changes["default_lang"] = _validate_lang(changes["default_lang"])
    if "default_condition" in changes:
        changes["default_condition"] = _validate_condition(changes["default_condition"])
    if "default_variant" in changes:
        changes["default_variant"] = _validate_variant(changes["default_variant"])
    if "commit_mode" in changes:
        changes["commit_mode"] = _validate_commit_mode(changes["commit_mode"])
    for key, value in changes.items():
        setattr(session, key, value)

    if apply_defaults:
        payload = _payload(session)
        for item in payload["items"]:
            if item.get("manually_edited") or item.get("status") == "excluded":
                continue
            if "default_lang" in changes:
                item["lang"] = changes["default_lang"]
            if "default_condition" in changes:
                item["condition"] = changes["default_condition"]
            if "default_variant" in changes:
                item["variant"] = changes["default_variant"]
                item["variant_state"] = "default"
        _store_payload(session, payload)
    else:
        session.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(session)
    return _serialize_session(db, session)


@router.delete("/{session_id}")
def delete_photo_import(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    _assert_mutable(session)
    directory = _session_directory(session)
    db.delete(session)
    db.commit()
    shutil.rmtree(directory, ignore_errors=True)
    return {"deleted": True}


@router.post("/{session_id}/images")
async def upload_photo_import_image(
    session_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    _assert_mutable(session)
    payload = _payload(session)
    if len(payload["images"]) >= MAX_IMAGES_PER_SESSION:
        raise HTTPException(status_code=413, detail=f"A photo import session is limited to {MAX_IMAGES_PER_SESSION} images")

    raw = await file.read(MAX_IMAGE_BYTES + 1)
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image is too large")
    if not raw:
        raise HTTPException(status_code=422, detail="Image is empty")
    digest = hashlib.sha256(raw).hexdigest()
    if any(image.get("sha256") == digest for image in payload["images"]):
        raise HTTPException(status_code=409, detail="This exact image is already in the import session")

    try:
        normalized, crops = crop_grid(raw, session.layout)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="The uploaded file is not a readable image") from exc

    image_id = uuid4().hex
    directory = _image_directory(session, image_id)
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "original.jpg").write_bytes(normalized)
    for slot, crop in enumerate(crops, start=1):
        (directory / f"slot-{slot:02d}.jpg").write_bytes(crop)

    image = {
        "id": image_id,
        "upload_order": len(payload["images"]) + 1,
        "filename": file.filename or f"page-{len(payload['images']) + 1}.jpg",
        "sha256": digest,
        "status": "ready",
        "error": None,
        "slot_count": len(crops),
        "empty_slots": 0,
    }
    payload["images"].append(image)
    session.status = "draft"
    _store_payload(session, payload)
    db.commit()
    db.refresh(session)
    return _serialize_session(db, session)


@router.delete("/{session_id}/images/{image_id}")
def delete_photo_import_image(
    session_id: str,
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    _assert_mutable(session)
    payload = _payload(session)
    if not any(image.get("id") == image_id for image in payload["images"]):
        raise HTTPException(status_code=404, detail="Photo import image not found")
    payload["images"] = [image for image in payload["images"] if image.get("id") != image_id]
    payload["items"] = [item for item in payload["items"] if item.get("image_id") != image_id]
    for order, image in enumerate(payload["images"], start=1):
        image["upload_order"] = order
    _store_payload(session, payload)
    db.commit()
    shutil.rmtree(_image_directory(session, image_id), ignore_errors=True)
    return _serialize_session(db, session)


@router.post("/{session_id}/images/{image_id}/analyze")
async def analyze_photo_import_image(
    session_id: str,
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    _assert_mutable(session)
    api_key = get_gemini_key(db, user_id=current_user.id)
    if not api_key:
        raise HTTPException(status_code=400, detail="No Gemini API key is configured for this user")

    payload = _payload(session)
    image = next((entry for entry in payload["images"] if entry.get("id") == image_id), None)
    if not image:
        raise HTTPException(status_code=404, detail="Photo import image not found")
    image["status"] = "processing"
    image["error"] = None
    session.status = "processing"
    _store_payload(session, payload)
    db.commit()

    try:
        items, empty_slots = await _recognize_image_items(session, image, api_key=api_key)
    except HTTPException:
        image["status"] = "failed"
        image["error"] = "Gemini request failed"
        session.status = "review" if payload["items"] else "failed"
        _store_payload(session, payload)
        db.commit()
        raise
    except Exception as exc:
        logger.exception("Photo import page analysis failed")
        image["status"] = "failed"
        image["error"] = str(exc)
        session.status = "review" if payload["items"] else "failed"
        _store_payload(session, payload)
        db.commit()
        raise HTTPException(status_code=500, detail="Photo page analysis failed") from exc

    payload["items"] = [item for item in payload["items"] if item.get("image_id") != image_id]
    payload["items"].extend(items)
    image["status"] = "analyzed"
    image["empty_slots"] = empty_slots
    session.status = "review"
    _store_payload(session, payload)
    db.commit()
    db.refresh(session)
    return _serialize_session(db, session)


@router.get("/{session_id}/images/{image_id}/original")
def get_photo_import_original(
    session_id: str,
    image_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    payload = _payload(session)
    if not any(image.get("id") == image_id for image in payload["images"]):
        raise HTTPException(status_code=404, detail="Photo import image not found")
    path = safe_child_path(_image_directory(session, image_id), _image_directory(session, image_id) / "original.jpg")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stored image is missing")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@router.get("/{session_id}/images/{image_id}/slots/{slot}")
def get_photo_import_crop(
    session_id: str,
    image_id: str,
    slot: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    payload = _payload(session)
    image = next((entry for entry in payload["images"] if entry.get("id") == image_id), None)
    if not image or slot < 1 or slot > int(image.get("slot_count") or 0):
        raise HTTPException(status_code=404, detail="Photo import crop not found")
    path = safe_child_path(_image_directory(session, image_id), _image_directory(session, image_id) / f"slot-{slot:02d}.jpg")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stored crop is missing")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})


@router.put("/{session_id}/items/{item_id}")
def update_photo_import_item(
    session_id: str,
    item_id: str,
    request: PhotoImportItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    _assert_mutable(session)
    payload = _payload(session)
    item = next((entry for entry in payload["items"] if entry.get("id") == item_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Photo import item not found")

    changes = request.model_dump(exclude_unset=True)
    if "lang" in changes:
        changes["lang"] = _validate_lang(changes["lang"])
    if "condition" in changes:
        changes["condition"] = _validate_condition(changes["condition"])
    if "variant" in changes:
        changes["variant"] = _validate_variant(changes["variant"])
        item["variant_state"] = "manual"
    if "status" in changes and changes["status"] not in ALLOWED_ITEM_STATUSES:
        raise HTTPException(status_code=422, detail="Invalid item status")

    selected_card_id = changes.pop("selected_card_id", None) if "selected_card_id" in changes else None
    if selected_card_id:
        card = ensure_card_exists(db, selected_card_id, lang=changes.get("lang") or item.get("lang") or session.default_lang)
        item["selected_card_id"] = card.id
        item["selected_card"] = _card_snapshot(card)
        item["identity_state"] = "manual"
        item["identity_score"] = 100
        item["confidence_reasons"] = ["manual_selection"]
        item["match_source"] = "manual"
        item["status"] = "accepted"

    for key, value in changes.items():
        item[key] = value
    if item.get("status") == "accepted" and not (item.get("selected_card_id") or item.get("proposed_card_id")):
        raise HTTPException(status_code=422, detail="An accepted item must have a selected card")
    item["manually_edited"] = True
    _store_payload(session, payload)
    db.commit()
    db.refresh(session)
    return _serialize_session(db, session)


@router.get("/{session_id}/card-search")
async def search_photo_import_cards(
    session_id: str,
    q: str = Query(..., min_length=1, max_length=120),
    lang: str = "all",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _session_or_404(db, current_user, session_id)
    query_text = q.strip()
    normalized_lang = normalize_tcgdex_language(lang)
    if normalized_lang != "all" and not is_supported_tcgdex_language(normalized_lang):
        normalized_lang = "all"

    results: list[dict] = []
    seen: set[str] = set()
    code_number = _CODE_NUMBER_RE.match(query_text)
    if code_number and normalized_lang != "all":
        try:
            card = _find_card_by_code(db, code_number.group(1), code_number.group(2), normalized_lang)
            snapshot = _card_snapshot(card)
            if snapshot:
                results.append(snapshot)
                seen.add(card.id)
        except Exception:
            db.rollback()

    local_query = db.query(Card).outerjoin(
        Set,
        and_(Set.tcg_set_id == Card.set_id, Set.lang == Card.lang),
    ).filter(
        Card.is_custom.is_(False),
        visible_card_filter(db, current_user.id, normalized_lang),
    )
    dex_match = re.fullmatch(r"#?(\d{1,4})", query_text)
    if dex_match:
        dex_id = int(dex_match.group(1))
        local_query = local_query.filter(Card.dex_ids.op("@>")(cast([dex_id], JSONB)))
    else:
        like = f"%{query_text.casefold()}%"
        local_query = local_query.filter(or_(
            func.lower(Card.name).like(like),
            func.lower(func.coalesce(Card.number, "")).like(like),
            func.lower(func.coalesce(Card.set_id, "")).like(like),
            func.lower(func.coalesce(Set.name, "")).like(like),
            func.lower(func.coalesce(Set.abbreviation, "")).like(like),
        ))
    for card in local_query.order_by(Card.name.asc(), Card.number.asc()).limit(30).all():
        if card.id in seen:
            continue
        snapshot = _card_snapshot(card)
        if snapshot:
            results.append(snapshot)
            seen.add(card.id)

    if len(results) < 12 and not dex_match and len(query_text) >= 2:
        search_lang = normalized_lang if normalized_lang != "all" else "en"
        async with httpx.AsyncClient(timeout=20) as client:
            live = await _search_tcgdex_candidates(client, {
                "name": query_text,
                "name_en": query_text,
                "language": search_lang,
            })
        for candidate in live:
            if candidate["id"] in seen:
                continue
            results.append(_candidate_snapshot(candidate))
            seen.add(candidate["id"])
            if len(results) >= 30:
                break

    return {"data": results, "total_count": len(results)}


def _summary_rows(db: Session, current_user: User, session: PhotoImportSession) -> tuple[list[dict], dict]:
    payload = _payload(session)
    groups = aggregate_import_items(payload["items"])
    rows: list[dict] = []
    for group in groups:
        current_quantity = int(db.query(func.coalesce(func.sum(CollectionItem.quantity), 0)).filter(
            CollectionItem.user_id == current_user.id,
            CollectionItem.card_id == group["card_id"],
            CollectionItem.lang == group["lang"],
            CollectionItem.variant == group["variant"],
            CollectionItem.condition == group["condition"],
            CollectionItem.purchase_price.is_(None),
        ).scalar() or 0)
        result_quantity = projected_quantity(
            current_quantity,
            group["scanned_quantity"],
            session.commit_mode,
        )
        card = group.get("card") or _card_snapshot(db.query(Card).filter(Card.id == group["card_id"]).first())
        rows.append({
            **group,
            "card": card,
            "current_quantity": current_quantity,
            "result_quantity": result_quantity,
        })

    meta = {
        "accepted_items": sum(item.get("status") == "accepted" for item in payload["items"]),
        "unique_entries": len(rows),
        "scanned_copies": sum(row["scanned_quantity"] for row in rows),
        "excluded": sum(item.get("status") == "excluded" for item in payload["items"]),
        "unresolved": sum(item.get("status") in {"review", "unresolved"} for item in payload["items"]),
    }
    return rows, meta


@router.get("/{session_id}/summary")
def get_photo_import_summary(
    session_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id)
    rows, meta = _summary_rows(db, current_user, session)
    return {"commit_mode": session.commit_mode, "rows": rows, **meta}


def _set_scanned_quantity(
    db: Session,
    current_user: User,
    group: dict,
) -> str:
    rows = db.query(CollectionItem).filter(
        CollectionItem.user_id == current_user.id,
        CollectionItem.card_id == group["card_id"],
        CollectionItem.lang == group["lang"],
        CollectionItem.variant == group["variant"],
        CollectionItem.condition == group["condition"],
        CollectionItem.purchase_price.is_(None),
    ).order_by(CollectionItem.id.asc()).all()
    target = int(group["scanned_quantity"])
    current = sum(int(row.quantity or 0) for row in rows)
    if current == target:
        return "unchanged"
    if not rows:
        _add_collection_item(db, current_user, CollectionItemCreate(
            card_id=group["card_id"],
            quantity=target,
            condition=group["condition"],
            variant=group["variant"],
            purchase_price=None,
            lang=group["lang"],
        ), commit=False)
        return "added"
    if target > current:
        rows[0].quantity += target - current
        return "updated"

    to_remove = current - target
    for row in reversed(rows):
        protected = _active_product_link_quantity(db, current_user, row.id)
        removable = max(0, int(row.quantity or 0) - protected)
        reduction = min(removable, to_remove)
        row.quantity -= reduction
        to_remove -= reduction
        if row.quantity == 0:
            db.delete(row)
        if to_remove == 0:
            break
    if to_remove:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot reduce {group['card_id']} below quantities linked to product purchases",
        )
    return "updated"


@router.post("/{session_id}/commit")
def commit_photo_import(
    session_id: str,
    request: PhotoImportCommitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    session = _session_or_404(db, current_user, session_id, lock=True)
    if session.status == "committed":
        return session.commit_result or {"committed": True}
    _assert_mutable(session)
    if request.commit_mode:
        session.commit_mode = _validate_commit_mode(request.commit_mode)

    payload = _payload(session)
    groups = aggregate_import_items(payload["items"])
    if not groups:
        raise HTTPException(status_code=422, detail="There are no accepted cards to commit")

    result = {
        "added": 0,
        "updated": 0,
        "unchanged": 0,
        "excluded": sum(item.get("status") == "excluded" for item in payload["items"]),
        "unresolved": sum(item.get("status") in {"review", "unresolved"} for item in payload["items"]),
        "failed": 0,
        "errors": [],
    }
    session.status = "committing"
    try:
        for group in groups:
            card = ensure_card_exists(db, group["card_id"], lang=group["lang"])
            group["card_id"] = card.id
            if session.commit_mode == "add":
                status = _add_collection_item(db, current_user, CollectionItemCreate(
                    card_id=card.id,
                    quantity=group["scanned_quantity"],
                    condition=group["condition"],
                    variant=group["variant"],
                    purchase_price=None,
                    lang=group["lang"],
                ), commit=False)
            else:
                status = _set_scanned_quantity(db, current_user, group)
            result[status] += 1

        session.status = "committed"
        session.committed_at = datetime.utcnow()
        session.commit_result = result
        session.updated_at = datetime.utcnow()
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("Photo import commit failed")
        raise HTTPException(status_code=500, detail="Photo import commit failed") from exc
    return result
