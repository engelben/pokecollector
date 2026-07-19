"""Managed collector profile helpers.

A managed profile is a normal local ``User`` row whose data remains fully isolated by
``user_id`` but which cannot authenticate directly. The manager authenticates once and
receives delegated application tokens for profile switching.
"""
from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from models import (
    Binder,
    BinderCard,
    CollectionItem,
    PortfolioSnapshot,
    ProductCard,
    ProductLedgerEntry,
    ProductPurchase,
    Trade,
    TradeItem,
    User,
    UserSetting,
    WishlistItem,
)


def is_managed_profile(user: User) -> bool:
    return user.managed_by_user_id is not None


def profile_payload(user: User, actor_user: User) -> dict:
    """Return the public authentication/profile payload used by the frontend."""
    managed = is_managed_profile(user)
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "avatar_id": user.avatar_id,
        "must_change_password": bool(user.must_change_password),
        "managed_profile": managed,
        "actor_user_id": actor_user.id,
        "login_enabled": bool(user.login_enabled),
        "profile_pin_required": bool(user.profile_pin_hash) if managed else False,
    }


def list_available_profiles(db: Session, actor_user: User) -> list[User]:
    """Return the actor followed by the profiles directly managed by that actor."""
    managed = (
        db.query(User)
        .filter(User.managed_by_user_id == actor_user.id)
        .order_by(User.is_active.desc(), User.username.asc(), User.id.asc())
        .all()
    )
    return [actor_user, *managed]


def get_managed_profile(db: Session, actor_user: User, profile_id: int) -> User | None:
    return (
        db.query(User)
        .filter(User.id == profile_id, User.managed_by_user_id == actor_user.id)
        .first()
    )


def require_primary_actor(current_user: User, actor_user: User) -> None:
    """Reject profile-management operations while a delegated profile is active."""
    if current_user.id != actor_user.id or is_managed_profile(current_user):
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="Switch back to the managing profile first")


def delete_user_owned_data(db: Session, user_id: int) -> None:
    """Delete all durable rows owned by one user before deleting the User row.

    The optional raw-SQL cleanup keeps this feature compatible with the sibling photo
    import branch without making either branch depend on the other's ORM model.
    """
    bind = db.get_bind()
    has_photo_imports = bool(bind is not None and inspect(bind).has_table("photo_import_sessions"))

    db.query(BinderCard).filter(
        BinderCard.binder_id.in_(db.query(Binder.id).filter(Binder.user_id == user_id))
    ).delete(synchronize_session=False)
    db.query(Binder).filter(Binder.user_id == user_id).delete(synchronize_session=False)
    db.query(TradeItem).filter(TradeItem.user_id == user_id).delete(synchronize_session=False)
    db.query(Trade).filter(Trade.user_id == user_id).delete(synchronize_session=False)
    db.query(ProductLedgerEntry).filter(ProductLedgerEntry.user_id == user_id).delete(synchronize_session=False)
    db.query(ProductCard).filter(ProductCard.user_id == user_id).delete(synchronize_session=False)
    db.query(CollectionItem).filter(CollectionItem.user_id == user_id).delete(synchronize_session=False)
    db.query(WishlistItem).filter(WishlistItem.user_id == user_id).delete(synchronize_session=False)
    db.query(ProductPurchase).filter(ProductPurchase.user_id == user_id).delete(synchronize_session=False)
    db.query(PortfolioSnapshot).filter(PortfolioSnapshot.user_id == user_id).delete(synchronize_session=False)
    db.query(UserSetting).filter(UserSetting.user_id == user_id).delete(synchronize_session=False)

    if has_photo_imports:
        db.execute(text("DELETE FROM photo_import_sessions WHERE user_id = :user_id"), {"user_id": user_id})
