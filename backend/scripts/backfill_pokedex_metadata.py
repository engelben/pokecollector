from __future__ import annotations

import argparse
import json

from sqlalchemy import func, or_

from database import SessionLocal
from models import Card
from services.card_metadata import (
    POKEMON_SUPERTYPE_VALUES,
    _json_value_missing,
    enrich_cards_metadata,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill TCGdex Pokédex and Cardmarket metadata")
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--language")
    parser.add_argument("--refresh", action="store_true", help="refetch matching rows even when metadata exists")
    parser.add_argument("--missing-only", action="store_true", help="only rows missing Pokédex/Cardmarket metadata (default)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        query = db.query(Card).filter(Card.is_custom.is_(False), Card.tcg_card_id.isnot(None))
        if args.language:
            query = query.filter(Card.lang == args.language)
        if not args.refresh:
            query = query.filter(
                or_(_json_value_missing(Card.dex_ids), _json_value_missing(Card.cardmarket_products)),
                or_(Card.supertype.is_(None), func.lower(Card.supertype).in_(POKEMON_SUPERTYPE_VALUES)),
            )
        cards = query.order_by(Card.updated_at.asc(), Card.id.asc()).limit(max(args.limit, 1)).all()
        # Force the selected rows through enrichment; the generic selector is
        # intentionally bypassed because Cardmarket IDs may be absent even on
        # otherwise complete card rows.
        result = enrich_cards_metadata(db, cards, limit=len(cards), commit_every=25, force=True)
        print(json.dumps(result, indent=2))
        return 1 if result["failed"] else 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
