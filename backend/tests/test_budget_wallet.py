from datetime import date
import ast
from pathlib import Path
from types import SimpleNamespace

from api.budget import _price_cents, _purchase_rule_bucket
from models import BudgetDraftCart, BudgetDraftCartItem


def test_wallet_core_models_are_defined_once_with_cart_capable_account():
    """Keep wallet model consolidation explicit during future feature merges."""
    tree = ast.parse(Path(__file__).parents[1].joinpath("models.py").read_text())
    classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}
    core_names = {
        "BudgetAccount",
        "BudgetPurchasePlan",
        "BudgetLedgerEntry",
        "BudgetPurchasePlanItem",
    }
    assert sum(node.name in core_names for node in tree.body if isinstance(node, ast.ClassDef)) == len(core_names)
    account_fields = {node.targets[0].id for node in classes["BudgetAccount"].body
                      if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    assert {"weekly_credit_cents", "source_wishlist_ids", "parent_covers_shipping", "cart"} <= account_fields


def test_price_cents_uses_trend_first():
    card = SimpleNamespace(price_trend=1.23, price_market=2.0, price_low=0.5, price_avg7=None, price_avg30=None)
    assert _price_cents(card) == 123


def test_price_cents_returns_none_without_prices():
    card = SimpleNamespace(price_trend=None, price_market=None, price_low=None, price_avg7=None, price_avg30=None)
    assert _price_cents(card) is None


def test_open_or_trade_rule_is_never_purchasable():
    bucket, unlock = _purchase_rule_bucket("open_or_trade_only", None, None, today=date(2026, 7, 20))
    assert bucket == "open_or_trade_only"
    assert unlock is None


def test_parent_approval_rule_gets_approval_bucket():
    bucket, _ = _purchase_rule_bucket("parent_approval_required", None, None, today=date(2026, 7, 20))
    assert bucket == "parent_approval"


def test_season_end_uses_later_unlock_date():
    bucket, unlock = _purchase_rule_bucket(
        "season_end_purchase",
        "2026-08-01",
        date(2026, 9, 1),
        today=date(2026, 7, 20),
    )
    assert bucket == "season_end"
    assert unlock == date(2026, 9, 1)


def test_season_end_becomes_purchasable_after_unlock():
    bucket, unlock = _purchase_rule_bucket(
        "season_end_purchase",
        date(2026, 7, 1),
        date(2026, 7, 15),
        today=date(2026, 7, 20),
    )
    assert bucket is None
    assert unlock is None


def test_draft_cart_models_keep_quantity_separate_from_ledger_plans():
    cart = BudgetDraftCart(account_id=4)
    item = BudgetDraftCartItem(wishlist_item_id=12, quantity=3)
    cart.items.append(item)
    assert cart.items[0].wishlist_item_id == 12
    assert cart.items[0].quantity == 3
