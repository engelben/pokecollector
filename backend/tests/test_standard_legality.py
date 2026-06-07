import unittest
from types import SimpleNamespace

from services.standard_legality import (
    is_standard_legal_card,
    is_standard_regulation_mark,
    standard_legal_fingerprints,
)


def card(mark=None, fingerprint=None, is_custom=False):
    return SimpleNamespace(
        regulation_mark=mark,
        playable_fingerprint=fingerprint,
        is_custom=is_custom,
    )


class StandardLegalityTests(unittest.TestCase):
    def test_current_and_future_regulation_marks_are_standard_legal(self):
        self.assertFalse(is_standard_regulation_mark("G"))
        self.assertTrue(is_standard_regulation_mark("H"))
        self.assertTrue(is_standard_regulation_mark("I"))
        self.assertTrue(is_standard_regulation_mark("J"))
        self.assertTrue(is_standard_regulation_mark("K"))

    def test_direct_current_mark_is_legal(self):
        self.assertTrue(is_standard_legal_card(card(mark="H")))

    def test_old_print_is_legal_when_matching_current_reprint_fingerprint(self):
        legal_fingerprints = standard_legal_fingerprints([
            card(mark="H", fingerprint="judge-v2"),
        ])

        self.assertTrue(is_standard_legal_card(card(mark=None, fingerprint="judge-v2"), legal_fingerprints))

    def test_old_print_without_current_reprint_match_is_not_legal(self):
        legal_fingerprints = standard_legal_fingerprints([
            card(mark="H", fingerprint="rare-candy"),
        ])

        self.assertFalse(is_standard_legal_card(card(mark="G", fingerprint="ultra-ball"), legal_fingerprints))

    def test_custom_cards_are_not_standard_legal(self):
        self.assertFalse(is_standard_legal_card(card(mark="H", fingerprint="custom", is_custom=True), {"custom"}))


if __name__ == "__main__":
    unittest.main()
