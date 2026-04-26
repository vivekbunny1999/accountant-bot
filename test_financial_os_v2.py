import unittest
from datetime import date

from api import _build_financial_os_v2_from_snapshot, _project_debt_with_extra


class FinancialOsV2Tests(unittest.TestCase):
    def test_large_cash_does_not_turn_into_large_sts(self):
        result = _build_financial_os_v2_from_snapshot(
            {
                "as_of_date": date(2026, 4, 26),
                "window_days": 21,
                "total_cash": 126000.0,
                "upcoming_obligations": 500.0,
                "debt_minimums": 50.0,
                "monthly_essentials": 2000.0,
                "runway_target_months": 3.0,
                "monthly_discretionary_cap": 800.0,
                "discretionary_spend_month_to_date": 200.0,
                "planned_monthly_discretionary_baseline": 800.0,
                "debts": [],
            }
        )

        self.assertEqual(result["remaining_discretionary_this_month"], 600.0)
        self.assertEqual(result["current_period_safe_to_spend"], 600.0)
        self.assertLess(result["weekly_safe_to_spend"], result["total_cash"])

    def test_obligations_and_minimums_are_protected_before_discretionary(self):
        result = _build_financial_os_v2_from_snapshot(
            {
                "as_of_date": date(2026, 4, 26),
                "window_days": 7,
                "total_cash": 1000.0,
                "upcoming_obligations": 500.0,
                "debt_minimums": 50.0,
                "monthly_essentials": 1000.0,
                "runway_target_months": 1.0,
                "monthly_discretionary_cap": 300.0,
                "discretionary_spend_month_to_date": 0.0,
                "planned_monthly_discretionary_baseline": 300.0,
                "debts": [],
            }
        )

        self.assertEqual(result["upcoming_obligations_cash"], 500.0)
        self.assertEqual(result["debt_minimums_cash"], 50.0)
        self.assertEqual(result["current_period_safe_to_spend"], 0.0)

    def test_debt_projection_uses_real_amortization(self):
        projection = _project_debt_with_extra(800.0, 31.0, 50.0, 500.0)
        self.assertEqual(projection["with_extra_months"], 2)
        self.assertGreater(projection["minimum_only_months"], projection["with_extra_months"])
        self.assertGreater(projection["interest_saved"], 0.0)

    def test_sts_explains_setup_required_when_cap_cannot_be_derived(self):
        result = _build_financial_os_v2_from_snapshot(
            {
                "as_of_date": date(2026, 4, 26),
                "window_days": 21,
                "total_cash": 5000.0,
                "upcoming_obligations": 500.0,
                "debt_minimums": 50.0,
                "monthly_essentials": 1200.0,
                "runway_target_months": 1.0,
                "monthly_discretionary_cap": 0.0,
                "monthly_discretionary_cap_details": {
                    "mode": "missing_discretionary_plan",
                    "source": "missing_discretionary_plan",
                    "spend_pct": 25.0,
                    "fallback_baseline": None,
                    "pending_income_cap": True,
                },
                "discretionary_spend_month_to_date": 0.0,
                "planned_monthly_discretionary_baseline": 0.0,
                "monthly_income_baseline": None,
                "debts": [],
            }
        )

        self.assertEqual(result["current_period_safe_to_spend"], 0.0)
        self.assertEqual(result["sts_status"]["code"], "no_spending_plan_or_income_baseline")
        self.assertEqual(result["setup_status"]["state"], "setup_required")
        self.assertEqual(result["protected_obligations_total"], 550.0)

    def test_fi_target_derivation_is_exposed(self):
        result = _build_financial_os_v2_from_snapshot(
            {
                "as_of_date": date(2026, 4, 26),
                "window_days": 21,
                "total_cash": 10000.0,
                "upcoming_obligations": 500.0,
                "debt_minimums": 50.0,
                "monthly_essentials": 2000.0,
                "runway_target_months": 1.0,
                "monthly_discretionary_cap": 600.0,
                "monthly_discretionary_cap_details": {
                    "mode": "income_percentage_cap",
                    "source": "paycheck_spend_pct_25.0",
                    "spend_pct": 25.0,
                    "fallback_baseline": None,
                    "pending_income_cap": False,
                },
                "discretionary_spend_month_to_date": 100.0,
                "planned_monthly_discretionary_baseline": 600.0,
                "monthly_income_baseline": 4000.0,
                "debts": [],
            }
        )

        self.assertEqual(result["fi_target_details"]["source"], "derived_annual_required_spend_x25")
        self.assertEqual(result["fi_target_details"]["annual_required_spend"], 31200.0)
        self.assertEqual(result["fi_target"], 780000.0)


if __name__ == "__main__":
    unittest.main()
