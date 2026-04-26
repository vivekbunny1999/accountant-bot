import unittest

from api import (
    _classify_suspected_duplicate_plaid_rows,
    _plaid_display_duplicate_key,
)


class PlaidDisplayDedupTests(unittest.TestCase):
    def _candidate(
        self,
        *,
        institution_name="Chase",
        account_id="acct-1",
        account_name="Freedom Checking",
        account_mask="1234",
        posted_date="2026-04-20",
        merchant_name="Coffee Shop",
        amount=12.34,
    ):
        return {
            "duplicate_key": _plaid_display_duplicate_key(
                institution_name=institution_name,
                account_id=account_id,
                account_name=account_name,
                account_mask=account_mask,
                posted_date=posted_date,
                merchant_name=merchant_name,
                amount=amount,
            ),
            "amount": amount,
            "merchant": merchant_name,
        }

    def test_exact_repeat_marks_first_counted_and_later_rows_suspected(self):
        rows = [
            self._candidate(),
            self._candidate(),
            self._candidate(account_id="acct-2"),
        ]

        classified = _classify_suspected_duplicate_plaid_rows(rows)

        self.assertTrue(classified[0]["counted"])
        self.assertFalse(classified[0]["suspected_duplicate"])
        self.assertEqual(classified[0]["duplicate_group_size"], 3)

        self.assertFalse(classified[1]["counted"])
        self.assertTrue(classified[1]["suspected_duplicate"])
        self.assertEqual(classified[1]["duplicate_group_index"], 1)

        self.assertFalse(classified[2]["counted"])
        self.assertTrue(classified[2]["suspected_duplicate"])
        self.assertEqual(classified[2]["duplicate_group_index"], 2)

    def test_last4_or_name_change_breaks_duplicate_group(self):
        baseline = self._candidate()
        different_last4 = self._candidate(account_mask="9999")
        different_name = self._candidate(account_name="Sapphire Checking")

        classified = _classify_suspected_duplicate_plaid_rows(
            [baseline, different_last4, different_name]
        )

        for row in classified:
            self.assertTrue(row["counted"])
            self.assertFalse(row["suspected_duplicate"])
            self.assertEqual(row["duplicate_group_size"], 1)


if __name__ == "__main__":
    unittest.main()
