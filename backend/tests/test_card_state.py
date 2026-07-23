import unittest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import Card, CollectionItem, User, WishlistItem
from services.card_state import card_state_summaries


class CardStateSummaryTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.db = sessionmaker(bind=engine)()
        self.owner = User(username="owner", hashed_password="x")
        self.other = User(username="other", hashed_password="x")
        self.card = Card(id="base-1_en", tcg_card_id="base-1", name="Bulbasaur", lang="en", is_custom=False)
        self.db.add_all([self.owner, self.other, self.card])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_aggregates_variants_omits_zero_and_isolates_collector_state(self):
        self.db.add_all([
            CollectionItem(card_id=self.card.id, user_id=self.owner.id, variant="Normal", condition="NM", quantity=1),
            CollectionItem(card_id=self.card.id, user_id=self.owner.id, variant="Normal", condition="LP", quantity=2),
            CollectionItem(card_id=self.card.id, user_id=self.owner.id, variant="Holo", quantity=1),
            CollectionItem(card_id=self.card.id, user_id=self.owner.id, variant="Reverse Holo", quantity=0),
            CollectionItem(card_id=self.card.id, user_id=self.other.id, variant="First Edition", quantity=9),
            WishlistItem(card_id=self.card.id, user_id=self.owner.id),
            WishlistItem(card_id=self.card.id, user_id=self.other.id),
        ])
        self.db.commit()
        summary = card_state_summaries(self.db, self.owner.id, [self.card.id])[self.card.id]
        self.assertEqual(summary["owned_quantity"], 4)
        self.assertEqual(summary["owned_variants"], [{"variant": "Normal", "quantity": 3}, {"variant": "Holo", "quantity": 1}])
        self.assertTrue(summary["owned"])
        self.assertTrue(summary["wishlisted"])


if __name__ == "__main__":
    unittest.main()
