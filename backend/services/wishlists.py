from __future__ import annotations

from sqlalchemy.orm import Session

from models import Wishlist, WishlistItem


def ensure_default_wishlist(db: Session, user_id: int, *, commit: bool = True) -> Wishlist:
    """Return the user's default wishlist, creating and backfilling it when needed.

    Keeping this helper outside the API router lets binder imports and other legacy
    add-to-wishlist paths consistently target the same default list.
    """
    wishlist = (
        db.query(Wishlist)
        .filter(Wishlist.user_id == user_id, Wishlist.is_default.is_(True))
        .order_by(Wishlist.id.asc())
        .first()
    )
    if wishlist:
        return wishlist

    wishlist = Wishlist(user_id=user_id, name="Wishlist", is_default=True, sort_order=0)
    db.add(wishlist)
    db.flush()
    db.query(WishlistItem).filter(
        WishlistItem.user_id == user_id,
        WishlistItem.wishlist_id.is_(None),
    ).update({WishlistItem.wishlist_id: wishlist.id}, synchronize_session=False)
    if commit:
        db.commit()
        db.refresh(wishlist)
    return wishlist
