from __future__ import annotations

import datetime
import json
import logging
import os
import time

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from models import Card, Setting
from services.card_metadata import (
    POKEMON_SUPERTYPE_VALUES,
    _json_value_missing,
    enrich_cards_metadata,
)

logger = logging.getLogger(__name__)

COMPLETED_SETTING_KEY = "pokedex_metadata_backfill_completed"
STATUS_SETTING_KEY = "pokedex_metadata_backfill_status"
DEFAULT_BATCH_LIMIT = 5000
DEFAULT_BATCH_DELAY_SECONDS = 0.5


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _setting(db: Session, key: str) -> Setting | None:
    return db.query(Setting).filter(Setting.key == key).first()


def _set_setting(db: Session, key: str, value: str) -> None:
    row = _setting(db, key)
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))
    db.commit()


def pokedex_backfill_query(db: Session):
    return (
        db.query(Card)
        .filter(Card.is_custom.is_(False), Card.tcg_card_id.isnot(None))
        .filter(
            or_(_json_value_missing(Card.dex_ids), _json_value_missing(Card.cardmarket_products)),
            or_(Card.supertype.is_(None), func.lower(Card.supertype).in_(POKEMON_SUPERTYPE_VALUES)),
        )
        .order_by(Card.updated_at.asc(), Card.id.asc())
    )


def pokedex_metadata_backfill_completed(db: Session) -> bool:
    row = _setting(db, COMPLETED_SETTING_KEY)
    return bool(row and row.value == "true")


def missing_pokedex_metadata_count(db: Session) -> int:
    return int(pokedex_backfill_query(db).count())


def mark_pokedex_metadata_backfill_incomplete(db: Session, *, reason: str) -> None:
    _set_setting(db, COMPLETED_SETTING_KEY, "false")
    _set_setting(
        db,
        STATUS_SETTING_KEY,
        json.dumps({"status": "pending", "reason": reason, "updated_at": _now_iso()}),
    )


def mark_pokedex_metadata_backfill_complete(db: Session, *, result: dict | None = None) -> None:
    payload = {"status": "complete", "completed_at": _now_iso()}
    if result:
        payload["result"] = result
    _set_setting(db, COMPLETED_SETTING_KEY, "true")
    _set_setting(db, STATUS_SETTING_KEY, json.dumps(payload))


def run_pokedex_metadata_backfill(
    db: Session,
    *,
    batch_limit: int = DEFAULT_BATCH_LIMIT,
    batch_delay_seconds: float = DEFAULT_BATCH_DELAY_SECONDS,
    max_batches: int | None = None,
) -> dict:
    """Backfill Pokédex metadata once, recording a durable completion marker."""
    if pokedex_metadata_backfill_completed(db):
        return {"skipped": True, "reason": "already_completed", "attempted": 0, "updated": 0, "missing": 0, "failed": 0}

    batch_limit = max(int(batch_limit or DEFAULT_BATCH_LIMIT), 1)
    batch_delay_seconds = max(float(batch_delay_seconds or 0), 0)
    card_ids = [card_id for (card_id,) in pokedex_backfill_query(db).with_entities(Card.id).all()]
    result = {
        "skipped": False,
        "attempted": 0,
        "updated": 0,
        "missing": 0,
        "failed": 0,
        "batches": 0,
        "completed": False,
        "selected": len(card_ids),
    }
    _set_setting(
        db,
        STATUS_SETTING_KEY,
        json.dumps({"status": "running", "started_at": _now_iso(), "batch_limit": batch_limit}),
    )

    if not card_ids:
        result["completed"] = True
        mark_pokedex_metadata_backfill_complete(db, result=result)
        return result

    for index in range(0, len(card_ids), batch_limit):
        batch_ids = card_ids[index:index + batch_limit]
        cards = db.query(Card).filter(Card.id.in_(batch_ids)).order_by(Card.updated_at.asc(), Card.id.asc()).all()
        if not cards:
            continue
        batch = enrich_cards_metadata(db, cards, limit=len(cards), commit_every=25, force=True)
        result["batches"] += 1
        result["attempted"] += batch["attempted"]
        result["updated"] += batch["updated"]
        result["missing"] += batch["missing"]
        result["failed"] += batch["failed"]

        _set_setting(
            db,
            STATUS_SETTING_KEY,
            json.dumps({"status": "running", "updated_at": _now_iso(), "result": result}),
        )

        if batch["failed"]:
            _set_setting(
                db,
                STATUS_SETTING_KEY,
                json.dumps({"status": "failed", "failed_at": _now_iso(), "result": result}),
            )
            logger.warning("Pokédex metadata backfill stopped after %s failed rows", batch["failed"])
            return result

        if max_batches is not None and result["batches"] >= max_batches:
            return result

        if batch_delay_seconds:
            time.sleep(batch_delay_seconds)

    result["completed"] = True
    mark_pokedex_metadata_backfill_complete(db, result=result)
    return result


def startup_pokedex_backfill_enabled() -> bool:
    return os.environ.get("POKEDEX_METADATA_BACKFILL_ON_STARTUP", "true").lower() not in {"0", "false", "no", "off"}


def startup_pokedex_backfill_batch_limit() -> int:
    raw = os.environ.get("POKEDEX_METADATA_BACKFILL_BATCH_LIMIT")
    if not raw:
        return DEFAULT_BATCH_LIMIT
    try:
        return max(int(raw), 1)
    except ValueError:
        return DEFAULT_BATCH_LIMIT


def startup_pokedex_backfill_batch_delay_seconds() -> float:
    raw = os.environ.get("POKEDEX_METADATA_BACKFILL_BATCH_DELAY_SECONDS")
    if not raw:
        return DEFAULT_BATCH_DELAY_SECONDS
    try:
        return max(float(raw), 0)
    except ValueError:
        return DEFAULT_BATCH_DELAY_SECONDS
