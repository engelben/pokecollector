import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base
from models import Card, CollectionItem, Setting, User

from services.pokemon_api import extract_cardmarket_products, extract_dex_ids, parse_card_for_db
from services.pokedex import aggregate_pokedex, load_pokedex, normalize_dex_ids
from services import pokedex_images


class PokedexMetadataTests(unittest.TestCase):
    def test_catalogue_contains_complete_national_dex(self):
        catalogue = load_pokedex()
        self.assertEqual(len(catalogue), 1025)
        self.assertEqual(catalogue[93]["name_en"], "Gengar")
        self.assertEqual(catalogue[93]["name_de"], "Gengar")
        self.assertEqual(catalogue[1024]["name_en"], "Pecharunt")

    def test_dex_ids_accept_scalar_and_multiple_values(self):
        self.assertEqual(extract_dex_ids({"dexId": 94}), [94])
        self.assertEqual(extract_dex_ids({"dexId": [25, "133", 25, None]}), [25, 133])
        self.assertEqual(normalize_dex_ids([25, "133", 25, 0, 1026]), [25, 133])

    def test_cardmarket_products_preserve_variant_and_foil(self):
        data = {
            "variants": [
                {"type": "holo", "thirdParty": {"cardmarket": 733689}},
                {"type": "reverse", "thirdParty": {"cardmarket": 733689}},
                {"type": "holo", "foil": "galaxy", "thirdParty": {"cardmarket": 861151}},
            ]
        }
        self.assertEqual(
            extract_cardmarket_products(data),
            [
                {"variant": "holo", "foil": None, "product_id": 733689},
                {"variant": "reverse", "foil": None, "product_id": 733689},
                {"variant": "holo", "foil": "galaxy", "product_id": 861151},
            ],
        )

    def test_parse_full_card_adds_pokedex_and_cardmarket_metadata(self):
        parsed = parse_card_for_db({
            "id": "sv03.5-094",
            "localId": "094",
            "name": "Gengar",
            "category": "Pokemon",
            "dexId": [94],
            "variants": [
                {"type": "holo", "thirdParty": {"cardmarket": 733689}},
            ],
        }, lang="en")
        self.assertEqual(parsed["dex_ids"], [94])
        self.assertEqual(parsed["cardmarket_products"][0]["product_id"], 733689)
        # Rich variant arrays also populate the legacy availability booleans.
        self.assertTrue(parsed["variants_holo"])

    def test_full_card_without_mapping_marks_metadata_as_checked(self):
        parsed = parse_card_for_db({
            "id": "base1-1",
            "localId": "1",
            "name": "Trainer",
            "category": "Trainer",
        }, lang="en")
        self.assertEqual(parsed["dex_ids"], [])
        self.assertEqual(parsed["cardmarket_products"], [])

    def test_brief_card_keeps_metadata_null_for_later_enrichment(self):
        parsed = parse_card_for_db({
            "id": "base1-1",
            "localId": "1",
            "name": "Brief card",
        }, lang="en")
        self.assertIsNone(parsed["dex_ids"])
        self.assertIsNone(parsed["cardmarket_products"])


class PokedexAggregationTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)
        self.db = Session()
        self.user = User(username="misty", hashed_password="x", role="admin", is_active=True)
        self.db.add_all([
            self.user,
            Setting(key="tcgdex_sync_languages", value="en,de"),
            Setting(key="tcgdex_digital_sets_enabled", value="true"),
        ])
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def _entry(self, result, dex_id):
        return next(entry for entry in result["entries"] if entry["dex_id"] == dex_id)

    def test_ownership_is_derived_from_collection_and_updates_after_removal(self):
        gengar = Card(
            id="sv03.5-094_en", tcg_card_id="sv03.5-094", name="Gengar",
            number="094", lang="en", is_custom=False, dex_ids=[94],
        )
        self.db.add(gengar)
        self.db.commit()

        missing = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertFalse(self._entry(missing, 94)["owned"])

        owned_item = CollectionItem(card_id=gengar.id, user_id=self.user.id, quantity=2, lang="en")
        self.db.add(owned_item)
        self.db.commit()
        owned = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertTrue(self._entry(owned, 94)["owned"])
        self.assertEqual(self._entry(owned, 94)["owned_cards"], 2)

        self.db.delete(owned_item)
        self.db.commit()
        removed = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertFalse(self._entry(removed, 94)["owned"])

    def test_multispecies_card_counts_for_each_species(self):
        card = Card(
            id="multi-1_en", tcg_card_id="multi-1", name="Friends",
            lang="en", is_custom=False, dex_ids=[25, 133],
        )
        self.db.add(card)
        self.db.commit()
        self.db.add(CollectionItem(card_id=card.id, user_id=self.user.id, quantity=1, lang="en"))
        self.db.commit()

        result = aggregate_pokedex(self.db, self.user.id, language="en", generation=1)
        self.assertTrue(self._entry(result, 25)["owned"])
        self.assertTrue(self._entry(result, 133)["owned"])

    def test_available_printings_are_deduplicated_across_languages(self):
        self.db.add_all([
            Card(id="base-1_en", tcg_card_id="base-1", name="Gengar", lang="en", is_custom=False, dex_ids=[94]),
            Card(id="base-1_de", tcg_card_id="base-1", name="Gengar", lang="de", is_custom=False, dex_ids=[94]),
            Card(id="other-1_en", tcg_card_id="other-1", name="Gengar", lang="en", is_custom=False, dex_ids=[94]),
        ])
        self.db.commit()
        result = aggregate_pokedex(self.db, self.user.id, language="all", generation=1)
        self.assertEqual(self._entry(result, 94)["available_printings"], 2)

    def test_search_accepts_padded_and_unpadded_numbers(self):
        padded = aggregate_pokedex(self.db, self.user.id, search="094")
        unpadded = aggregate_pokedex(self.db, self.user.id, search="94")
        self.assertEqual([row["dex_id"] for row in padded["entries"]], [94])
        self.assertEqual([row["dex_id"] for row in unpadded["entries"]], [94])


class PokedexImageCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_root = pokedex_images.CACHE_ROOT
        pokedex_images.CACHE_ROOT = Path(self.temp_dir.name)

    def tearDown(self):
        pokedex_images.CACHE_ROOT = self.old_root
        self.temp_dir.cleanup()

    def test_cache_path_validates_kind_and_number(self):
        self.assertEqual(
            pokedex_images.cache_path("sprites", 94),
            Path(self.temp_dir.name) / "sprites" / "94.png",
        )
        with self.assertRaises(ValueError):
            pokedex_images.cache_path("../secret", 94)
        with self.assertRaises(ValueError):
            pokedex_images.cache_path("sprites", 0)

    def test_fetch_image_uses_existing_file_without_network(self):
        path = pokedex_images.cache_path("sprites", 94)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"png")
        client = Mock()
        self.assertEqual(pokedex_images.fetch_image("sprites", 94, client=client), path)
        client.get.assert_not_called()

    def test_fetch_image_writes_atomically(self):
        response = Mock(status_code=200, content=b"image-data")
        response.raise_for_status = Mock()
        client = Mock()
        client.get.return_value = response
        path = pokedex_images.fetch_image("artwork", 94, client=client)
        self.assertEqual(path.read_bytes(), b"image-data")
        self.assertFalse(any(path.parent.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
