import unittest
from types import SimpleNamespace

from services.card_values import effective_market_price


class CardValueVariantTests(unittest.TestCase):
    def setUp(self):
        self.card = SimpleNamespace(
            price_market=26.81,
            price_trend=32.22,
            price_avg1=6.00,
            price_avg7=13.10,
            price_avg30=24.69,
            price_low=3.00,
            price_market_holo=11.49,
            price_trend_holo=12.91,
            price_avg1_holo=2.49,
            price_avg7_holo=9.65,
            price_avg30_holo=9.55,
            price_low_holo=3.00,
        )

    def test_normal_uses_base_cardmarket_price(self):
        self.assertEqual(effective_market_price(self.card, 'Normal', 'price_trend'), 32.22)

    def test_standard_holo_uses_base_cardmarket_price(self):
        self.assertEqual(effective_market_price(self.card, 'Holo', 'price_trend'), 32.22)

    def test_reverse_holo_uses_alternate_holo_price(self):
        self.assertEqual(effective_market_price(self.card, 'Reverse Holo', 'price_trend'), 12.91)

    def test_reverse_holo_falls_back_when_alternate_price_missing(self):
        self.card.price_trend_holo = 0
        self.card.price_market_holo = None
        self.assertEqual(effective_market_price(self.card, 'Reverse Holo', 'price_trend'), 32.22)


if __name__ == '__main__':
    unittest.main()
