from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session, joinedload

from api.auth import AuthSession, get_auth_session
from database import get_db
from models import (
    BudgetAccount,
    BudgetDraftCart,
    BudgetDraftCartItem,
    BudgetLedgerEntry,
    BudgetPurchasePlan,
    BudgetPurchasePlanItem,
    Card,
    User,
    WishlistItem,
)

router = APIRouter()

LEDGER_TYPES = {"weekly_allowance", "parent_adjustment", "gift", "purchase", "refund", "correction"}
PLAN_STATUSES = {"draft", "pending_approval", "confirmed", "cancelled"}


class BudgetAccountUpsert(BaseModel):
    user_id: int | None = None
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    weekly_credit_cents: int = Field(default=500, ge=0, le=100000)
    next_credit_date: date | None = None
    credit_enabled: bool = True
    season_end_date: date | None = None
    source_wishlist_ids: list[int] = Field(default_factory=list)
    parent_covers_shipping: bool = True


class LedgerCreate(BaseModel):
    user_id: int | None = None
    amount_cents: int = Field(ge=-10000000, le=10000000)
    entry_type: str
    effective_date: date = Field(default_factory=date.today)
    note: str | None = Field(default=None, max_length=500)


class PurchasePlanCreate(BaseModel):
    user_id: int | None = None
    wishlist_item_ids: list[int] = Field(min_length=1, max_length=100)


class DraftCartItemWrite(BaseModel):
    user_id: int | None = None
    wishlist_item_id: int
    quantity: int = Field(default=1, ge=1, le=99)


class PurchasePlanSubmit(BaseModel):
    note: str | None = Field(default=None, max_length=500)


class PurchasePlanItemActual(BaseModel):
    item_id: int
    actual_unit_price_cents: int = Field(ge=0, le=10000000)


class PurchasePlanConfirm(BaseModel):
    items: list[PurchasePlanItemActual]
    shipping_cents: int = Field(default=0, ge=0, le=1000000)
    charge_shipping_to_wallet: bool = False
    note: str | None = Field(default=None, max_length=500)


def _target_user(db: Session, session: AuthSession, requested_user_id: int | None, manage: bool = False) -> User:
    target_id = requested_user_id or session.current_user.id
    if target_id == session.current_user.id:
        target = session.current_user
    elif session.current_user.id == session.actor_user.id:
        target = db.query(User).filter(
            User.id == target_id,
            User.managed_by_user_id == session.actor_user.id,
            User.is_active.is_(True),
        ).first()
    else:
        target = None
    if not target:
        raise HTTPException(status_code=403, detail="This collector profile is not available")
    if manage and session.current_user.id != session.actor_user.id:
        raise HTTPException(status_code=403, detail="Switch back to the managing profile first")
    if manage and target.id != session.actor_user.id and target.managed_by_user_id != session.actor_user.id:
        raise HTTPException(status_code=403, detail="Parent access required")
    return target


def _account(db: Session, user_id: int) -> BudgetAccount | None:
    return db.query(BudgetAccount).filter(BudgetAccount.user_id == user_id).first()


def _accrue(db: Session, account: BudgetAccount) -> int:
    if not account.credit_enabled or account.weekly_credit_cents <= 0 or not account.next_credit_date:
        return 0

    # Serialize accrual for one account. The partial unique index on weekly credits is
    # a final safeguard, while the row lock avoids duplicate insert attempts entirely.
    account = db.query(BudgetAccount).filter(BudgetAccount.id == account.id).with_for_update().one()
    today = date.today()
    credited = 0
    original_next_date = account.next_credit_date
    next_date = original_next_date
    while next_date <= today:
        exists = db.query(BudgetLedgerEntry).filter(
            BudgetLedgerEntry.account_id == account.id,
            BudgetLedgerEntry.entry_type == "weekly_allowance",
            BudgetLedgerEntry.effective_date == next_date,
        ).first()
        if not exists:
            db.add(BudgetLedgerEntry(
                account_id=account.id,
                amount_cents=account.weekly_credit_cents,
                entry_type="weekly_allowance",
                effective_date=next_date,
                note="Automatic weekly allowance",
            ))
            credited += 1
        next_date += timedelta(days=7)

    account.next_credit_date = next_date
    if credited or next_date != original_next_date:
        db.commit()
        db.refresh(account)
    return credited


def _balance(db: Session, account_id: int) -> int:
    value = db.query(BudgetLedgerEntry.amount_cents).filter(BudgetLedgerEntry.account_id == account_id).all()
    return sum(int(row[0] or 0) for row in value)


def _price_cents(card: Card) -> int | None:
    for field in ("price_trend", "price_market", "price_low", "price_avg7", "price_avg30"):
        raw = getattr(card, field, None)
        if raw is not None and raw >= 0:
            return int(round(float(raw) * 100))
    return None


def _as_date(value) -> date | None:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None
    return None


def _purchase_rule_bucket(
    rule: str,
    eligible_after,
    season_end_date: date | None,
    *,
    today: date | None = None,
) -> tuple[str | None, date | None]:
    """Return a non-price suggestion bucket and the effective unlock date."""
    today = today or date.today()
    if rule == "open_or_trade_only":
        return "open_or_trade_only", None
    if rule == "parent_approval_required":
        return "parent_approval", None
    if rule == "season_end_purchase":
        unlock_date = max(
            [value for value in (_as_date(eligible_after), season_end_date) if value is not None],
            default=None,
        )
        if unlock_date and unlock_date > today:
            return "season_end", unlock_date
    return None, None


def _wishlist_metadata(db: Session, item_ids: list[int]) -> dict[int, dict]:
    if not item_ids:
        return {}
    bind = db.get_bind()
    inspector = inspect(bind) if bind is not None else None
    if not inspector or not inspector.has_table("wishlist"):
        return {}
    columns = {column["name"] for column in inspector.get_columns("wishlist")}
    wanted = [name for name in ("purchase_rule", "eligible_after", "wishlist_id", "desired_variant", "desired_condition", "cardmarket_url") if name in columns]
    if not wanted:
        return {}
    rows = db.execute(text(
        f"SELECT id, {', '.join(wanted)} FROM wishlist WHERE id = ANY(:ids)"
    ), {"ids": item_ids}).mappings().all()
    return {int(row["id"]): dict(row) for row in rows}


def _source_item_ids(db: Session, account: BudgetAccount) -> list[int] | None:
    source_ids = [int(value) for value in (account.source_wishlist_ids or []) if str(value).isdigit()]
    if not source_ids:
        return None
    bind = db.get_bind()
    inspector = inspect(bind) if bind is not None else None
    if not inspector or not inspector.has_table("wishlist"):
        return None
    columns = {column["name"] for column in inspector.get_columns("wishlist")}
    if "wishlist_id" not in columns:
        return None
    return [int(row[0]) for row in db.execute(text(
        "SELECT id FROM wishlist WHERE user_id = :user_id AND wishlist_id = ANY(:wishlist_ids)"
    ), {"user_id": account.user_id, "wishlist_ids": source_ids}).all()]


def _suggestions(db: Session, account: BudgetAccount, balance_cents: int) -> list[dict]:
    query = db.query(WishlistItem).options(joinedload(WishlistItem.card).joinedload(Card.set_ref)).filter(
        WishlistItem.user_id == account.user_id
    )
    source_item_ids = _source_item_ids(db, account)
    if source_item_ids is not None:
        if not source_item_ids:
            return []
        query = query.filter(WishlistItem.id.in_(source_item_ids))
    items = query.all()
    metadata = _wishlist_metadata(db, [item.id for item in items])
    results = []
    today = date.today()
    for item in items:
        card = item.card
        if not card:
            continue
        meta = metadata.get(item.id, {})
        rule = meta.get("purchase_rule") or "purchase_allowed"
        eligible_after = _as_date(meta.get("eligible_after"))
        rule_bucket, unlock_date = _purchase_rule_bucket(
            rule, eligible_after, account.season_end_date, today=today
        )
        price = _price_cents(card)
        if rule_bucket:
            bucket = rule_bucket
        elif price is None:
            bucket = "no_price"
        elif price <= balance_cents:
            bucket = "affordable_now"
        else:
            bucket = "almost_affordable"
        results.append({
            "wishlist_item_id": item.id,
            "card_id": card.id,
            "name": card.name,
            "set_name": card.set_ref.name if card.set_ref else card.set_id,
            "number": card.number,
            "image": card.images_small or card.images_large or card.custom_image_url,
            "quantity": item.quantity,
            "price_cents": price,
            "shortfall_cents": max(0, (price or 0) - balance_cents) if price is not None else None,
            "purchase_rule": rule,
            "eligible_after": (unlock_date or eligible_after).isoformat() if (unlock_date or eligible_after) else None,
            "cardmarket_url": meta.get("cardmarket_url"),
            "bucket": bucket,
        })
    order = {"affordable_now": 0, "almost_affordable": 1, "parent_approval": 2, "season_end": 3, "open_or_trade_only": 4, "no_price": 5}
    return sorted(results, key=lambda row: (order.get(row["bucket"], 9), row["price_cents"] if row["price_cents"] is not None else 10**12, row["name"]))


def _account_payload(db: Session, account: BudgetAccount) -> dict:
    _accrue(db, account)
    balance = _balance(db, account.id)
    suggestions = _suggestions(db, account, balance)
    pending = db.query(BudgetPurchasePlan).filter(
        BudgetPurchasePlan.account_id == account.id,
        BudgetPurchasePlan.status == "pending_approval",
    ).count()
    return {
        "id": account.id,
        "user_id": account.user_id,
        "currency": account.currency,
        "weekly_credit_cents": account.weekly_credit_cents,
        "next_credit_date": account.next_credit_date.isoformat() if account.next_credit_date else None,
        "credit_enabled": bool(account.credit_enabled),
        "season_end_date": account.season_end_date.isoformat() if account.season_end_date else None,
        "source_wishlist_ids": account.source_wishlist_ids or [],
        "parent_covers_shipping": bool(account.parent_covers_shipping),
        "balance_cents": balance,
        "affordable_count": sum(1 for row in suggestions if row["bucket"] == "affordable_now"),
        "pending_approval_count": pending,
    }


@router.get("/summary")
def budget_summary(
    user_id: int | None = Query(default=None),
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    return {"enabled": bool(account), "account": _account_payload(db, account) if account else None}


@router.put("/account")
def upsert_budget_account(data: BudgetAccountUpsert, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, data.user_id, manage=True)
    account = _account(db, target.id)
    if not account:
        account = BudgetAccount(user_id=target.id)
        db.add(account)
    account.currency = data.currency.upper()
    account.weekly_credit_cents = data.weekly_credit_cents
    account.next_credit_date = data.next_credit_date or account.next_credit_date or date.today()
    account.credit_enabled = data.credit_enabled
    account.season_end_date = data.season_end_date
    account.source_wishlist_ids = sorted(set(data.source_wishlist_ids))
    account.parent_covers_shipping = data.parent_covers_shipping
    account.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(account)
    return _account_payload(db, account)


@router.get("/ledger")
def get_ledger(user_id: int | None = Query(default=None), session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    if not account:
        return []
    _accrue(db, account)
    rows = db.query(BudgetLedgerEntry).filter(BudgetLedgerEntry.account_id == account.id).order_by(
        BudgetLedgerEntry.effective_date.desc(), BudgetLedgerEntry.id.desc()
    ).limit(250).all()
    return [{
        "id": row.id,
        "amount_cents": row.amount_cents,
        "entry_type": row.entry_type,
        "effective_date": row.effective_date.isoformat(),
        "created_by_user_id": row.created_by_user_id,
        "purchase_plan_id": row.purchase_plan_id,
        "note": row.note,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    } for row in rows]


@router.post("/ledger")
def add_ledger_entry(data: LedgerCreate, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, data.user_id, manage=True)
    if data.entry_type not in LEDGER_TYPES - {"weekly_allowance", "purchase"}:
        raise HTTPException(status_code=400, detail="Invalid manual ledger entry type")
    account = _account(db, target.id)
    if not account:
        raise HTTPException(status_code=404, detail="Budget account not configured")
    row = BudgetLedgerEntry(
        account_id=account.id,
        amount_cents=data.amount_cents,
        entry_type=data.entry_type,
        effective_date=data.effective_date,
        created_by_user_id=session.actor_user.id,
        note=data.note,
    )
    db.add(row)
    db.commit()
    return _account_payload(db, account)


@router.get("/wishlist-sources")
def get_wishlist_sources(
    user_id: int | None = Query(default=None),
    session: AuthSession = Depends(get_auth_session),
    db: Session = Depends(get_db),
):
    """Return selectable named wishlists when Feature A is installed.

    An empty source selection always means all wishlist items, which keeps this
    feature fully usable against the legacy flat wishlist model.
    """
    target = _target_user(db, session, user_id)
    bind = db.get_bind()
    inspector = inspect(bind) if bind is not None else None
    if not inspector or not inspector.has_table("wishlists"):
        return {"multiple_wishlists": False, "lists": []}
    rows = db.execute(text(
        """SELECT id, name, is_default, is_archived
           FROM wishlists
           WHERE user_id = :user_id
           ORDER BY is_default DESC, sort_order ASC, id ASC"""
    ), {"user_id": target.id}).mappings().all()
    return {
        "multiple_wishlists": True,
        "lists": [
            {
                "id": int(row["id"]),
                "name": row["name"],
                "is_default": bool(row["is_default"]),
                "is_archived": bool(row["is_archived"]),
            }
            for row in rows
        ],
    }


@router.get("/suggestions")
def get_suggestions(user_id: int | None = Query(default=None), session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    if not account:
        return []
    _accrue(db, account)
    return _suggestions(db, account, _balance(db, account.id))


def _cart_payload(db: Session, account: BudgetAccount) -> dict:
    cart = db.query(BudgetDraftCart).options(joinedload(BudgetDraftCart.items)).filter(
        BudgetDraftCart.account_id == account.id
    ).first()
    if not cart:
        return {"id": None, "items": [], "item_count": 0, "estimated_total_cents": 0}
    wishlist_ids = [item.wishlist_item_id for item in cart.items]
    wishlist = {item.id: item for item in db.query(WishlistItem).options(
        joinedload(WishlistItem.card).joinedload(Card.set_ref)
    ).filter(WishlistItem.user_id == account.user_id, WishlistItem.id.in_(wishlist_ids)).all()}
    rows, total = [], 0
    for cart_item in cart.items:
        wish = wishlist.get(cart_item.wishlist_item_id)
        if not wish or not wish.card:  # Deleted wishlist rows cannot become purchases.
            continue
        unit = _price_cents(wish.card)
        line_total = (unit or 0) * cart_item.quantity
        total += line_total
        rows.append({"id": cart_item.id, "wishlist_item_id": wish.id, "quantity": cart_item.quantity,
                     "price_cents": unit, "line_total_cents": line_total, "card_id": wish.card.id,
                     "name": wish.card.name, "set_name": wish.card.set_ref.name if wish.card.set_ref else wish.card.set_id,
                     "image": wish.card.images_small or wish.card.images_large or wish.card.custom_image_url})
    return {"id": cart.id, "items": rows, "item_count": sum(row["quantity"] for row in rows), "estimated_total_cents": total}


def _require_cart_item(db: Session, account: BudgetAccount, wishlist_item_id: int) -> WishlistItem:
    item = db.query(WishlistItem).options(joinedload(WishlistItem.card)).filter(
        WishlistItem.id == wishlist_item_id, WishlistItem.user_id == account.user_id
    ).first()
    if not item or not item.card:
        raise HTTPException(status_code=404, detail="Wishlist item is unavailable")
    return item


@router.get("/cart")
def get_cart(user_id: int | None = Query(default=None), session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    if not account:
        return {"id": None, "items": [], "item_count": 0, "estimated_total_cents": 0}
    _accrue(db, account)
    return _cart_payload(db, account)


@router.put("/cart/items")
def put_cart_item(data: DraftCartItemWrite, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, data.user_id)
    account = _account(db, target.id)
    if not account:
        raise HTTPException(status_code=404, detail="Budget account not configured")
    _require_cart_item(db, account, data.wishlist_item_id)
    cart = db.query(BudgetDraftCart).filter(BudgetDraftCart.account_id == account.id).with_for_update().first()
    if not cart:
        cart = BudgetDraftCart(account_id=account.id)
        db.add(cart); db.flush()
    row = db.query(BudgetDraftCartItem).filter(BudgetDraftCartItem.cart_id == cart.id, BudgetDraftCartItem.wishlist_item_id == data.wishlist_item_id).first()
    if row:
        row.quantity = data.quantity
    else:
        db.add(BudgetDraftCartItem(cart_id=cart.id, wishlist_item_id=data.wishlist_item_id, quantity=data.quantity))
    cart.updated_at = datetime.utcnow()
    db.commit()
    return _cart_payload(db, account)


@router.delete("/cart/items/{wishlist_item_id}")
def delete_cart_item(wishlist_item_id: int, user_id: int | None = Query(default=None), session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    if not account:
        raise HTTPException(status_code=404, detail="Budget account not configured")
    cart = db.query(BudgetDraftCart).filter(BudgetDraftCart.account_id == account.id).first()
    if cart:
        db.query(BudgetDraftCartItem).filter(BudgetDraftCartItem.cart_id == cart.id, BudgetDraftCartItem.wishlist_item_id == wishlist_item_id).delete()
        db.commit()
    return _cart_payload(db, account)


@router.post("/cart/submit")
def submit_cart(user_id: int | None = Query(default=None), session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    if not account:
        raise HTTPException(status_code=404, detail="Budget account not configured")
    cart = db.query(BudgetDraftCart).options(joinedload(BudgetDraftCart.items)).filter(BudgetDraftCart.account_id == account.id).first()
    if not cart or not cart.items:
        raise HTTPException(status_code=400, detail="Your cart is empty")
    # A plan preserves the immutable purchase snapshot. Clear the editable cart only
    # after plan creation succeeds, so drafts survive reloads and failed submissions.
    result = create_plan(PurchasePlanCreate(user_id=target.id, wishlist_item_ids=[row.wishlist_item_id for row in cart.items]), session, db)
    plan = db.query(BudgetPurchasePlan).filter(BudgetPurchasePlan.id == result["id"]).one()
    quantities = {row.wishlist_item_id: row.quantity for row in cart.items}
    for item in plan.items:
        item.quantity = quantities[item.wishlist_item_id]
    plan.estimated_card_total_cents = sum(item.estimated_unit_price_cents * item.quantity for item in plan.items)
    db.delete(cart)
    db.commit()
    return {"plan_id": plan.id, "status": plan.status}


@router.post("/plans")
def create_plan(data: PurchasePlanCreate, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, data.user_id)
    account = _account(db, target.id)
    if not account:
        raise HTTPException(status_code=404, detail="Budget account not configured")
    items = db.query(WishlistItem).options(joinedload(WishlistItem.card).joinedload(Card.set_ref)).filter(
        WishlistItem.user_id == target.id,
        WishlistItem.id.in_(data.wishlist_item_ids),
    ).all()
    if len(items) != len(set(data.wishlist_item_ids)):
        raise HTTPException(status_code=400, detail="One or more wishlist items are unavailable")
    metadata = _wishlist_metadata(db, [item.id for item in items])
    today = date.today()
    for item in items:
        meta = metadata.get(item.id, {})
        rule = meta.get("purchase_rule") or "purchase_allowed"
        rule_bucket, unlock_date = _purchase_rule_bucket(
            rule, meta.get("eligible_after"), account.season_end_date, today=today
        )
        if rule_bucket == "open_or_trade_only":
            raise HTTPException(status_code=400, detail=f"{item.card.name if item.card else item.card_id} is open-or-trade only")
        if rule_bucket == "season_end":
            raise HTTPException(status_code=400, detail=f"{item.card.name if item.card else item.card_id} is not purchasable until {unlock_date.isoformat()}")

    plan = BudgetPurchasePlan(
        account_id=account.id,
        status="draft",
        created_by_user_id=session.current_user.id,
        estimated_card_total_cents=0,
    )
    db.add(plan)
    db.flush()
    total = 0
    for item in items:
        card = item.card
        unit = _price_cents(card) or 0
        total += unit
        meta = metadata.get(item.id, {})
        db.add(BudgetPurchasePlanItem(
            purchase_plan_id=plan.id,
            wishlist_item_id=item.id,
            card_id=card.id if card else item.card_id,
            quantity=1,
            estimated_unit_price_cents=unit,
            purchase_rule_snapshot=meta.get("purchase_rule") or "purchase_allowed",
            card_name_snapshot=card.name if card else item.card_id,
            set_name_snapshot=card.set_ref.name if card and card.set_ref else (card.set_id if card else None),
            cardmarket_url_snapshot=meta.get("cardmarket_url"),
        ))
    plan.estimated_card_total_cents = total
    db.commit()
    return {"id": plan.id, "status": plan.status, "estimated_card_total_cents": total}


@router.get("/plans")
def list_plans(user_id: int | None = Query(default=None), session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    target = _target_user(db, session, user_id)
    account = _account(db, target.id)
    if not account:
        return []
    plans = db.query(BudgetPurchasePlan).options(joinedload(BudgetPurchasePlan.items)).filter(
        BudgetPurchasePlan.account_id == account.id
    ).order_by(BudgetPurchasePlan.created_at.desc(), BudgetPurchasePlan.id.desc()).limit(50).all()
    return [{
        "id": plan.id,
        "status": plan.status,
        "estimated_card_total_cents": plan.estimated_card_total_cents,
        "actual_card_total_cents": plan.actual_card_total_cents,
        "shipping_cents": plan.shipping_cents,
        "charge_shipping_to_wallet": bool(plan.charge_shipping_to_wallet),
        "created_by_user_id": plan.created_by_user_id,
        "approved_by_user_id": plan.approved_by_user_id,
        "created_at": plan.created_at.isoformat() if plan.created_at else None,
        "confirmed_at": plan.confirmed_at.isoformat() if plan.confirmed_at else None,
        "items": [{
            "id": item.id,
            "wishlist_item_id": item.wishlist_item_id,
            "card_id": item.card_id,
            "quantity": item.quantity,
            "estimated_unit_price_cents": item.estimated_unit_price_cents,
            "actual_unit_price_cents": item.actual_unit_price_cents,
            "purchase_rule_snapshot": item.purchase_rule_snapshot,
            "card_name_snapshot": item.card_name_snapshot,
            "set_name_snapshot": item.set_name_snapshot,
            "cardmarket_url_snapshot": item.cardmarket_url_snapshot,
        } for item in plan.items],
    } for plan in plans]


@router.post("/plans/{plan_id}/submit")
def submit_plan(plan_id: int, data: PurchasePlanSubmit, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    plan = db.query(BudgetPurchasePlan).join(BudgetAccount).filter(
        BudgetPurchasePlan.id == plan_id,
        BudgetAccount.user_id == session.current_user.id,
        BudgetPurchasePlan.status == "draft",
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Draft purchase plan not found")
    plan.status = "pending_approval"
    plan.note = data.note
    db.commit()
    return {"id": plan.id, "status": plan.status}


@router.post("/plans/{plan_id}/confirm")
def confirm_plan(plan_id: int, data: PurchasePlanConfirm, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    if session.current_user.id != session.actor_user.id:
        raise HTTPException(status_code=403, detail="Switch back to the managing profile to confirm purchases")
    pending_plan = db.query(BudgetPurchasePlan).filter(BudgetPurchasePlan.id == plan_id).first()
    if not pending_plan:
        raise HTTPException(status_code=404, detail="Purchase plan not found")
    pending_account = db.query(BudgetAccount).filter(BudgetAccount.id == pending_plan.account_id).first()
    _target_user(db, session, pending_account.user_id, manage=True)

    # Accrue any due allowance before the balance check, then lock both the plan
    # and account so concurrent confirmations cannot create duplicate debits.
    _accrue(db, pending_account)
    plan = db.query(BudgetPurchasePlan).filter(BudgetPurchasePlan.id == plan_id).with_for_update().first()
    account = db.query(BudgetAccount).filter(BudgetAccount.id == plan.account_id).with_for_update().first()
    db.refresh(plan, attribute_names=["items"])
    if plan.status not in {"draft", "pending_approval"}:
        raise HTTPException(status_code=400, detail="Purchase plan can no longer be confirmed")
    actual_by_id = {row.item_id: row.actual_unit_price_cents for row in data.items}
    if set(actual_by_id) != {item.id for item in plan.items}:
        raise HTTPException(status_code=400, detail="Actual prices are required for every basket item")
    card_total = 0
    for item in plan.items:
        price = actual_by_id[item.id]
        item.actual_unit_price_cents = price
        card_total += price * item.quantity
    debit = card_total + (data.shipping_cents if data.charge_shipping_to_wallet else 0)
    balance = _balance(db, account.id)
    if debit > balance:
        raise HTTPException(status_code=400, detail="The confirmed purchase exceeds the available balance")
    plan.status = "confirmed"
    plan.actual_card_total_cents = card_total
    plan.shipping_cents = data.shipping_cents
    plan.charge_shipping_to_wallet = data.charge_shipping_to_wallet
    plan.approved_by_user_id = session.actor_user.id
    plan.confirmed_at = datetime.utcnow()
    plan.note = data.note or plan.note
    db.add(BudgetLedgerEntry(
        account_id=account.id,
        amount_cents=-debit,
        entry_type="purchase",
        effective_date=date.today(),
        created_by_user_id=session.actor_user.id,
        purchase_plan_id=plan.id,
        note=data.note or "Confirmed card purchase",
    ))
    db.commit()
    return _account_payload(db, account)


@router.post("/plans/{plan_id}/cancel")
def cancel_plan(plan_id: int, session: AuthSession = Depends(get_auth_session), db: Session = Depends(get_db)):
    plan = db.query(BudgetPurchasePlan).join(BudgetAccount).filter(
        BudgetPurchasePlan.id == plan_id,
        BudgetAccount.user_id == session.current_user.id,
        BudgetPurchasePlan.status.in_(["draft", "pending_approval"]),
    ).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Open purchase plan not found")
    plan.status = "cancelled"
    plan.cancelled_at = datetime.utcnow()
    db.commit()
    return {"id": plan.id, "status": plan.status}
