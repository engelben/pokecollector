from __future__ import annotations

import csv
import io
from datetime import date, datetime
from urllib.parse import quote_plus

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from api.auth import get_current_user
from api.collection import ensure_card_exists
from database import get_db
from models import Card, Set, User, Wishlist, WishlistItem
from services.card_visibility import visible_card_filter
from services.wishlists import ensure_default_wishlist

router = APIRouter()

WISHLIST_MIN_QUANTITY = 1
WISHLIST_MAX_QUANTITY = 99
PURCHASE_RULES = {
    "purchase_allowed",
    "open_or_trade_only",
    "season_end_purchase",
    "parent_approval_required",
}


class WishlistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    color: str = Field(default="#EE1515", min_length=4, max_length=16)
    icon: str | None = Field(default=None, max_length=40)


class WishlistUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    color: str | None = Field(default=None, min_length=4, max_length=16)
    icon: str | None = Field(default=None, max_length=40)
    is_archived: bool | None = None
    sort_order: int | None = None


class WishlistItemCreate(BaseModel):
    card_id: str
    wishlist_id: int | None = None
    quantity: int = Field(default=1, ge=1, le=99)
    desired_variant: str = Field(default="Any", max_length=40)
    desired_condition: str = Field(default="Any", max_length=20)
    priority: int = Field(default=0, ge=0, le=5)
    notes: str | None = Field(default=None, max_length=1000)
    purchase_rule: str = "purchase_allowed"
    eligible_after: date | None = None
    purpose_labels: list[str] = Field(default_factory=list)
    cardmarket_url: str | None = Field(default=None, max_length=1000)
    price_alert_above: float | None = None
    price_alert_below: float | None = None


class WishlistItemUpdate(BaseModel):
    quantity: int | None = Field(default=None, ge=1, le=99)
    desired_variant: str | None = Field(default=None, max_length=40)
    desired_condition: str | None = Field(default=None, max_length=20)
    priority: int | None = Field(default=None, ge=0, le=5)
    notes: str | None = Field(default=None, max_length=1000)
    purchase_rule: str | None = None
    eligible_after: date | None = None
    purpose_labels: list[str] | None = None
    cardmarket_url: str | None = Field(default=None, max_length=1000)
    price_alert_above: float | None = None
    price_alert_below: float | None = None


class WishlistItemTransfer(BaseModel):
    target_wishlist_id: int
    copy: bool = False


def _normalize_labels(labels: list[str] | None) -> list[str]:
    clean: list[str] = []
    seen: set[str] = set()
    for raw in labels or []:
        label = str(raw).strip()
        key = label.casefold()
        if not label or key in seen:
            continue
        seen.add(key)
        clean.append(label[:50])
    return clean[:20]


def _validate_purchase_rule(value: str) -> str:
    if value not in PURCHASE_RULES:
        raise HTTPException(status_code=400, detail="Invalid purchase rule")
    return value



def _default_list(db: Session, user_id: int) -> Wishlist:
    return ensure_default_wishlist(db, user_id)


def _owned_list(db: Session, user_id: int, wishlist_id: int) -> Wishlist:
    wishlist = db.query(Wishlist).filter(Wishlist.id == wishlist_id, Wishlist.user_id == user_id).first()
    if not wishlist:
        raise HTTPException(status_code=404, detail="Wishlist not found")
    return wishlist


def _normalize_variant(value: str | None) -> str | None:
    normalized = str(value or "").strip().lower()
    if normalized in {"reverse holo", "reverse"}:
        return "reverse"
    if normalized in {"first edition", "first-edition", "1st edition"}:
        return "first edition"
    if normalized in {"holo", "normal"}:
        return normalized
    return normalized or None


def _product_rows(card: Card) -> list[tuple[int, str | None, str | None]]:
    rows: list[tuple[int, str | None, str | None]] = []
    for product in card.cardmarket_products if isinstance(card.cardmarket_products, list) else []:
        if not isinstance(product, dict):
            continue
        raw = product.get("product_id") or product.get("idProduct") or product.get("id")
        try:
            product_id = int(raw)
        except (TypeError, ValueError):
            continue
        if product_id <= 0:
            continue
        rows.append((product_id, _normalize_variant(product.get("variant")), str(product.get("foil")) if product.get("foil") else None))
    return rows


def _select_product_id(card: Card, desired_variant: str | None) -> int | None:
    rows = _product_rows(card)
    requested = _normalize_variant(desired_variant)
    if requested:
        exact = [row for row in rows if row[1] == requested]
        if exact:
            return exact[0][0]
        ordinary = [row for row in rows if not row[2] and row[1] != "first edition"]
        if ordinary:
            return ordinary[0][0]
    return rows[0][0] if rows else None


def _cardmarket_url(
    card: Card,
    item: WishlistItem | None = None,
    desired_variant: str | None = None,
) -> tuple[str, str, int | None]:
    if item and item.cardmarket_url and item.cardmarket_url_source == "manual":
        return item.cardmarket_url, "manual", item.cardmarket_product_id

    desired_variant = item.desired_variant if item else desired_variant
    product_id = _select_product_id(card, desired_variant)
    if product_id:
        suffix = "&isReverseHolo=Y" if _normalize_variant(desired_variant) == "reverse" else ""
        return (
            f"https://www.cardmarket.com/en/Pokemon/Products?idProduct={product_id}{suffix}",
            "exact_product",
            product_id,
        )

    set_code = card.set_ref.abbreviation if card.set_ref and card.set_ref.abbreviation else (card.set_id or "")
    query = " ".join(part for part in [card.name, set_code, card.number] if part)
    reverse = "&isReverseHolo=Y" if _normalize_variant(desired_variant) == "reverse" else ""
    return (
        "https://www.cardmarket.com/en/Pokemon/Products/Singles"
        f"?searchMode=v2&idCategory=51&idExpansion=0&searchString={quote_plus(query)}&idRarity=0{reverse}",
        "search_fallback",
        None,
    )


def _card_payload(card: Card | None) -> dict | None:
    if not card:
        return None
    fields = [
        "id", "tcg_card_id", "name", "set_id", "number", "rarity", "types", "supertype",
        "images_small", "images_large", "custom_image_url", "lang", "price_market", "price_low",
        "price_mid", "price_high", "price_trend", "price_avg1", "price_avg7", "price_avg30",
        "price_market_holo", "price_low_holo", "price_trend_holo", "price_avg1_holo",
        "price_avg7_holo", "price_avg30_holo", "cardmarket_products", "variants_normal",
        "variants_reverse", "variants_holo", "variants_first_edition",
    ]
    payload = {field: getattr(card, field, None) for field in fields}
    if card.set_ref:
        payload["set_ref"] = {
            "id": card.set_ref.id,
            "tcg_set_id": card.set_ref.tcg_set_id,
            "name": card.set_ref.name,
            "abbreviation": card.set_ref.abbreviation,
            "lang": card.set_ref.lang,
        }
    else:
        payload["set_ref"] = None
    return payload


def _item_payload(item: WishlistItem) -> dict:
    url, source, product_id = _cardmarket_url(item.card, item) if item.card else (item.cardmarket_url, item.cardmarket_url_source, item.cardmarket_product_id)
    return {
        "id": item.id,
        "wishlist_id": item.wishlist_id,
        "card_id": item.card_id,
        "quantity": item.quantity,
        "desired_variant": item.desired_variant or "Any",
        "desired_condition": item.desired_condition or "Any",
        "priority": item.priority or 0,
        "notes": item.notes,
        "purchase_rule": item.purchase_rule or "purchase_allowed",
        "eligible_after": item.eligible_after.isoformat() if item.eligible_after else None,
        "purpose_labels": item.purpose_labels or [],
        "cardmarket_url": url,
        "cardmarket_product_id": product_id,
        "cardmarket_url_source": source,
        "price_alert_above": item.price_alert_above,
        "price_alert_below": item.price_alert_below,
        "notified_at": item.notified_at.isoformat() if item.notified_at else None,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        "card": _card_payload(item.card),
    }


def _list_payload(wishlist: Wishlist, item_count: int | None = None, copy_count: int | None = None) -> dict:
    return {
        "id": wishlist.id,
        "name": wishlist.name,
        "description": wishlist.description,
        "is_default": bool(wishlist.is_default),
        "is_archived": bool(wishlist.is_archived),
        "sort_order": wishlist.sort_order or 0,
        "color": wishlist.color or "#EE1515",
        "icon": wishlist.icon,
        "item_count": item_count or 0,
        "copy_count": copy_count or 0,
        "created_at": wishlist.created_at.isoformat() if wishlist.created_at else None,
        "updated_at": wishlist.updated_at.isoformat() if wishlist.updated_at else None,
    }


def _query_items(db: Session, user_id: int, wishlist_id: int):
    return (
        db.query(WishlistItem)
        .join(Card, Card.id == WishlistItem.card_id)
        .options(joinedload(WishlistItem.card).joinedload(Card.set_ref))
        .filter(
            WishlistItem.user_id == user_id,
            WishlistItem.wishlist_id == wishlist_id,
            visible_card_filter(db, user_id, "all"),
        )
        .order_by(WishlistItem.priority.desc(), WishlistItem.created_at.desc(), WishlistItem.id.desc())
    )


@router.get("/lists")
def list_wishlists(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _default_list(db, current_user.id)
    count_rows = (
        db.query(
            WishlistItem.wishlist_id,
            func.count(WishlistItem.id),
            func.coalesce(func.sum(WishlistItem.quantity), 0),
        )
        .filter(WishlistItem.user_id == current_user.id)
        .group_by(WishlistItem.wishlist_id)
        .all()
    )
    counts = {row[0]: (int(row[1]), int(row[2] or 0)) for row in count_rows}
    rows = (
        db.query(Wishlist)
        .filter(Wishlist.user_id == current_user.id)
        .order_by(Wishlist.is_archived.asc(), Wishlist.sort_order.asc(), Wishlist.is_default.desc(), Wishlist.name.asc())
        .all()
    )
    result = []
    for row in rows:
        item_count, copy_count = counts.get(row.id, (0, 0))
        result.append(_list_payload(row, int(item_count), int(copy_count)))
    return result


@router.post("/lists")
def create_wishlist(data: WishlistCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    name = data.name.strip()
    duplicate = db.query(Wishlist).filter(Wishlist.user_id == current_user.id, func.lower(Wishlist.name) == name.lower()).first()
    if duplicate:
        raise HTTPException(status_code=409, detail="A wishlist with this name already exists")
    max_order = db.query(func.max(Wishlist.sort_order)).filter(Wishlist.user_id == current_user.id).scalar() or 0
    row = Wishlist(
        user_id=current_user.id,
        name=name,
        description=(data.description or "").strip() or None,
        color=data.color,
        icon=data.icon,
        is_default=False,
        sort_order=max_order + 1,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _list_payload(row)


@router.put("/lists/{wishlist_id}")
def update_wishlist(wishlist_id: int, data: WishlistUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _owned_list(db, current_user.id, wishlist_id)
    values = data.model_dump(exclude_unset=True)
    if "name" in values:
        values["name"] = values["name"].strip()
        duplicate = db.query(Wishlist).filter(
            Wishlist.user_id == current_user.id,
            Wishlist.id != row.id,
            func.lower(Wishlist.name) == values["name"].lower(),
        ).first()
        if duplicate:
            raise HTTPException(status_code=409, detail="A wishlist with this name already exists")
    for key, value in values.items():
        setattr(row, key, value)
    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _list_payload(row)


@router.delete("/lists/{wishlist_id}")
def delete_wishlist(wishlist_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _owned_list(db, current_user.id, wishlist_id)
    if row.is_default:
        raise HTTPException(status_code=400, detail="The default wishlist cannot be deleted")
    db.delete(row)
    db.commit()
    return {"message": "Wishlist deleted"}


@router.get("/lists/{wishlist_id}/items")
def get_list_items(wishlist_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned_list(db, current_user.id, wishlist_id)
    return [_item_payload(item) for item in _query_items(db, current_user.id, wishlist_id).all()]


@router.get("/")
def get_default_wishlist(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    wishlist = _default_list(db, current_user.id)
    return [_item_payload(item) for item in _query_items(db, current_user.id, wishlist.id).all()]


@router.post("/")
def add_to_wishlist(data: WishlistItemCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ensure_card_exists(db, data.card_id)
    requested_wishlist_id = getattr(data, "wishlist_id", None)
    wishlist = _owned_list(db, current_user.id, requested_wishlist_id) if requested_wishlist_id else _default_list(db, current_user.id)
    purchase_rule = _validate_purchase_rule(getattr(data, "purchase_rule", "purchase_allowed"))
    desired_variant = (getattr(data, "desired_variant", "Any") or "Any").strip() or "Any"
    desired_condition = (getattr(data, "desired_condition", "Any") or "Any").strip() or "Any"
    existing = db.query(WishlistItem).filter(
        WishlistItem.wishlist_id == wishlist.id,
        WishlistItem.card_id == data.card_id,
        WishlistItem.desired_variant == desired_variant,
        WishlistItem.desired_condition == desired_condition,
    ).first()
    if existing:
        next_quantity = int(existing.quantity or 1) + data.quantity
        if next_quantity > WISHLIST_MAX_QUANTITY:
            raise HTTPException(status_code=400, detail="Wishlist quantity cannot exceed 99")
        existing.quantity = next_quantity
        existing.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(existing)
        existing.card = db.query(Card).options(joinedload(Card.set_ref)).filter(Card.id == existing.card_id).first()
        return _item_payload(existing)
    card = db.query(Card).options(joinedload(Card.set_ref)).filter(Card.id == data.card_id).first()
    url, source, product_id = _cardmarket_url(card, desired_variant=desired_variant)
    item = WishlistItem(
        wishlist_id=wishlist.id,
        user_id=current_user.id,
        card_id=data.card_id,
        quantity=data.quantity,
        desired_variant=desired_variant,
        desired_condition=desired_condition,
        priority=getattr(data, "priority", 0),
        notes=(getattr(data, "notes", None) or "").strip() or None,
        purchase_rule=purchase_rule,
        eligible_after=getattr(data, "eligible_after", None),
        purpose_labels=_normalize_labels(getattr(data, "purpose_labels", [])),
        cardmarket_url=getattr(data, "cardmarket_url", None) or url,
        cardmarket_product_id=product_id,
        cardmarket_url_source="manual" if getattr(data, "cardmarket_url", None) else source,
        price_alert_above=data.price_alert_above,
        price_alert_below=data.price_alert_below,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    item.card = card
    return _item_payload(item)


@router.put("/{item_id}")
def update_wishlist_item(item_id: int, data: WishlistItemUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.query(WishlistItem).filter(WishlistItem.id == item_id, WishlistItem.user_id == current_user.id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Wishlist item not found")
    values = data.model_dump(exclude_unset=True)
    if "purchase_rule" in values and values["purchase_rule"] is not None:
        values["purchase_rule"] = _validate_purchase_rule(values["purchase_rule"])
    if "purpose_labels" in values:
        values["purpose_labels"] = _normalize_labels(values["purpose_labels"])
    if "cardmarket_url" in values:
        values["cardmarket_url_source"] = "manual" if values["cardmarket_url"] else None
    for key, value in values.items():
        setattr(item, key, value)
    if ("desired_variant" in values or "cardmarket_url" in values) and item.cardmarket_url_source != "manual":
        card = db.query(Card).options(joinedload(Card.set_ref)).filter(Card.id == item.card_id).first()
        if card:
            url, source, product_id = _cardmarket_url(card, item)
            item.cardmarket_url = url
            item.cardmarket_url_source = source
            item.cardmarket_product_id = product_id
    item.updated_at = datetime.utcnow()
    db.commit()
    item = _query_items(db, current_user.id, item.wishlist_id).filter(WishlistItem.id == item_id).first()
    return _item_payload(item)


@router.post("/{item_id}/transfer")
def transfer_wishlist_item(item_id: int, data: WishlistItemTransfer, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.query(WishlistItem).filter(WishlistItem.id == item_id, WishlistItem.user_id == current_user.id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Wishlist item not found")
    target = _owned_list(db, current_user.id, data.target_wishlist_id)
    if target.id == item.wishlist_id:
        return {"message": "Item is already on this wishlist"}
    existing = db.query(WishlistItem).filter(
        WishlistItem.wishlist_id == target.id,
        WishlistItem.card_id == item.card_id,
        WishlistItem.desired_variant == item.desired_variant,
        WishlistItem.desired_condition == item.desired_condition,
    ).first()
    if existing:
        existing.quantity = min(99, int(existing.quantity or 1) + int(item.quantity or 1))
        existing.updated_at = datetime.utcnow()
    else:
        existing = WishlistItem(
            wishlist_id=target.id,
            user_id=current_user.id,
            card_id=item.card_id,
            quantity=item.quantity,
            desired_variant=item.desired_variant,
            desired_condition=item.desired_condition,
            priority=item.priority,
            notes=item.notes,
            purchase_rule=item.purchase_rule,
            eligible_after=item.eligible_after,
            purpose_labels=list(item.purpose_labels or []),
            cardmarket_url=item.cardmarket_url,
            cardmarket_product_id=item.cardmarket_product_id,
            cardmarket_url_source=item.cardmarket_url_source,
            price_alert_above=item.price_alert_above,
            price_alert_below=item.price_alert_below,
        )
        db.add(existing)
    if not data.copy:
        db.delete(item)
    db.commit()
    return {"message": "Item copied" if data.copy else "Item moved", "target_wishlist_id": target.id}


@router.delete("/{item_id}")
def remove_from_wishlist(item_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.query(WishlistItem).filter(WishlistItem.id == item_id, WishlistItem.user_id == current_user.id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Wishlist item not found")
    db.delete(item)
    db.commit()
    return {"message": "Removed from wishlist"}


def _export_rows(db: Session, current_user: User, wishlist_id: int) -> tuple[Wishlist, list[WishlistItem]]:
    wishlist = _owned_list(db, current_user.id, wishlist_id)
    rows = _query_items(db, current_user.id, wishlist_id).all()
    return wishlist, rows


@router.get("/lists/{wishlist_id}/export.csv")
def export_wishlist_csv(wishlist_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    wishlist, rows = _export_rows(db, current_user, wishlist_id)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "quantity", "name", "set", "number", "language", "variant", "condition",
        "cardmarket_url", "purchase_rule", "purpose_labels", "notes",
    ])
    for item in rows:
        card = item.card
        url, _, _ = _cardmarket_url(card, item)
        writer.writerow([
            item.quantity,
            card.name,
            card.set_ref.name if card.set_ref else card.set_id,
            card.number,
            card.lang,
            item.desired_variant,
            item.desired_condition,
            url,
            item.purchase_rule,
            "|".join(item.purpose_labels or []),
            item.notes or "",
        ])
    filename = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in wishlist.name).strip("-") or "wishlist"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
    )


@router.get("/lists/{wishlist_id}/export.txt", response_class=PlainTextResponse)
def export_cardmarket_text(wishlist_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Export a paste-ready Cardmarket Pokémon wants/deck-list text file.

    Cardmarket's public Pokémon wants import accepts one card per line and expects the
    complete card name; quantities use the familiar ``4x Name`` prefix. Exact product
    URLs are included as comments for redundancy and manual verification.
    """
    wishlist, rows = _export_rows(db, current_user, wishlist_id)
    lines = [f"# {wishlist.name}"]
    for item in rows:
        card = item.card
        name = card.name.strip()
        lines.append(f"{item.quantity}x {name}")
        url, _, _ = _cardmarket_url(card, item)
        lines.append(f"# {card.set_ref.name if card.set_ref else card.set_id} {card.number or ''} | {url}")
    return "\n".join(lines) + "\n"
