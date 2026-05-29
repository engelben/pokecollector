import unittest

from services.binder_csv import BINDER_CSV_DUPLICATE_QUANTITY_ERROR, combine_binder_required_quantity


class BinderCsvTests(unittest.TestCase):
    def test_duplicate_required_quantities_are_summed(self):
        self.assertEqual(combine_binder_required_quantity(2, 3), 5)

    def test_import_quantity_is_added_to_existing_quantity(self):
        current_required_quantity = 3
        imported_csv_quantity = 4
        self.assertEqual(combine_binder_required_quantity(current_required_quantity, imported_csv_quantity), 7)

    def test_combined_required_quantity_may_reach_99(self):
        self.assertEqual(combine_binder_required_quantity(98, 1), 99)

    def test_combined_required_quantity_rejects_values_over_99(self):
        with self.assertRaises(ValueError) as context:
            combine_binder_required_quantity(98, 2)
        self.assertEqual(str(context.exception), BINDER_CSV_DUPLICATE_QUANTITY_ERROR)


if __name__ == "__main__":
    unittest.main()
