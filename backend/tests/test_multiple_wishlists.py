from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.wishlist import _cardmarket_url, _normalize_labels, _validate_purchase_rule


def card(**overrides):
    values = {
        "name": "Pikachu",
        "number": "025",
        "set_id": "base1",
        "set_ref": SimpleNamespace(name="Base Set", abbreviation="BS"),
        "cardmarket_products": [],
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_normalize_labels_deduplicates_case_insensitively():
    assert _normalize_labels(["Kanto", " kanto ", "Binder"]) == ["Kanto", "Binder"]


def test_purchase_rule_validation_accepts_known_rule():
    assert _validate_purchase_rule("purchase_allowed") == "purchase_allowed"


def test_purchase_rule_validation_rejects_unknown_rule():
    with pytest.raises(HTTPException):
        _validate_purchase_rule("buy_everything")


def test_cardmarket_url_uses_exact_product_and_reverse_parameter():
    url, source, product_id = _cardmarket_url(
        card(cardmarket_products=[{"product_id": 12345, "variant": "normal"}]),
        desired_variant="Reverse Holo",
    )
    assert product_id == 12345
    assert source == "exact_product"
    assert "idProduct=12345" in url
    assert "isReverseHolo=Y" in url


def test_cardmarket_url_falls_back_to_constrained_search():
    url, source, product_id = _cardmarket_url(card())
    assert product_id is None
    assert source == "search_fallback"
    assert "/Pokemon/Products/Singles" in url
    assert "Pikachu" in url
