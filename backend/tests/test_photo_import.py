import io
import json
import unittest

from PIL import Image

from services.photo_import import (
    aggregate_import_items,
    classify_candidates,
    crop_grid,
    normalize_card_number,
    parse_gemini_page_response,
    projected_quantity,
    score_candidate,
)


class PhotoImportServiceTests(unittest.TestCase):
    def test_crop_grid_returns_ordered_3x3_crops(self):
        image = Image.new("RGB", (900, 1200), "white")
        raw = io.BytesIO()
        image.save(raw, format="JPEG")

        normalized, crops = crop_grid(raw.getvalue(), "3x3")

        self.assertTrue(normalized.startswith(b"\xff\xd8"))
        self.assertEqual(9, len(crops))
        self.assertTrue(all(crop.startswith(b"\xff\xd8") for crop in crops))

    def test_crop_grid_returns_ordered_4x3_crops(self):
        image = Image.new("RGB", (900, 1600), "white")
        raw = io.BytesIO()
        image.save(raw, format="JPEG")

        _, crops = crop_grid(raw.getvalue(), "4x3")

        self.assertEqual(12, len(crops))

    def test_parse_gemini_response_preserves_all_slots(self):
        payload = {
            "cards": [
                {"slot": 1, "occupied": True, "name": "Pikachu", "number": "025/165", "language": "de"},
                {"slot": 2, "occupied": False},
            ]
        }

        cards = parse_gemini_page_response(json.dumps(payload), 3)

        self.assertEqual([1, 2, 3], [card["slot"] for card in cards])
        self.assertFalse(cards[1]["occupied"])
        self.assertEqual("slot_missing_from_response", cards[2]["parse_error"])

    def test_candidate_score_prefers_exact_number_name_and_set(self):
        recognized = {
            "name": "Pikachu",
            "name_en": "Pikachu",
            "number": "025/165",
            "set_hint": "151",
            "language": "de",
        }
        candidate = {
            "name": "Pikachu",
            "number": "25",
            "set": "Karmesin & Purpur – 151",
            "set_abbreviation": "MEW",
            "lang": "de",
        }

        score, reasons = score_candidate(recognized, candidate)

        self.assertEqual(100, score)
        self.assertIn("exact_number", reasons)
        self.assertIn("exact_name", reasons)
        self.assertIn("set_match", reasons)

    def test_classify_candidates_requires_a_decisive_match(self):
        state, score, _ = classify_candidates([
            {"score": 80, "reasons": ["exact_number", "exact_name"]},
            {"score": 76, "reasons": ["exact_number", "exact_name"]},
        ])
        self.assertEqual("review", state)
        self.assertEqual(80, score)

    def test_aggregate_import_items_groups_duplicates(self):
        rows = aggregate_import_items([
            {
                "id": "one",
                "status": "accepted",
                "selected_card_id": "sv1-25_de",
                "lang": "de",
                "variant": "Normal",
                "condition": "NM",
                "quantity": 1,
            },
            {
                "id": "two",
                "status": "accepted",
                "selected_card_id": "sv1-25_de",
                "lang": "de",
                "variant": "Normal",
                "condition": "NM",
                "quantity": 2,
            },
            {"id": "ignored", "status": "excluded", "selected_card_id": "sv1-25_de"},
        ])

        self.assertEqual(1, len(rows))
        self.assertEqual(3, rows[0]["scanned_quantity"])
        self.assertEqual(["one", "two"], rows[0]["item_ids"])

    def test_card_number_normalization_handles_leading_zeroes(self):
        self.assertEqual("25", normalize_card_number("025/165"))
        self.assertEqual("25", normalize_card_number("25"))

    def test_projected_quantity_supports_both_commit_modes(self):
        self.assertEqual(5, projected_quantity(3, 2, "add"))
        self.assertEqual(2, projected_quantity(3, 2, "set_scanned"))
        with self.assertRaises(ValueError):
            projected_quantity(3, 2, "replace_everything")


if __name__ == "__main__":
    unittest.main()
