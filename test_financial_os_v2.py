import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from api import (
    _build_financial_os_v2_from_snapshot,
    _build_upcoming_risk_insight,
    _project_debt_with_extra,
    os_intelligence,
)


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

    def test_zero_spending_allowance_can_still_allow_extra_debt_payment(self):
        high_apr_debt = SimpleNamespace(
            id=7,
            name="Visa Platinum",
            balance=800.0,
            apr=31.0,
            minimum_due=50.0,
        )
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
                "discretionary_spend_month_to_date": 800.0,
                "planned_monthly_discretionary_baseline": 800.0,
                "monthly_income_baseline": 3400.0,
                "debts": [high_apr_debt],
            }
        )

        self.assertEqual(result["current_period_safe_to_spend"], 0.0)
        self.assertEqual(result["discretionary_spending_allowance"], 0.0)
        self.assertEqual(result["remaining_discretionary_this_month"], 0.0)
        self.assertTrue(result["discretionary_spending_paused"])
        self.assertEqual(result["extra_payoff_allocation"], 500.0)
        self.assertEqual(result["next_best_action"]["amount_label"], "Extra payoff allocation")
        self.assertEqual(result["next_best_action"]["allocation_source"], "planned_surplus_after_protections")
        self.assertIn("Pause discretionary spending", result["next_best_action"]["action"])
        self.assertIn("repeatable extra-payment allocation", result["next_best_action"]["reason"])

    def test_upcoming_risk_uses_paused_spending_copy_when_cash_is_strong(self):
        insight = _build_upcoming_risk_insight(
            window_days=21,
            cash_total=126000.0,
            upcoming_total=550.0,
            buffer=100.0,
            safe_to_spend=0.0,
            remaining_discretionary_this_month=0.0,
            discretionary_spending_paused=True,
            upcoming_debt_minimum_total=50.0,
            available_for_minimums=125500.0,
        )

        self.assertEqual(insight["title"], "Bills are covered; discretionary spending is paused.")
        self.assertEqual(insight["severity"], "info")
        self.assertIn("Cash still covers", insight["explanation"])
        self.assertNotIn("cushion is thin", insight["title"].lower())

    def test_stability_label_shows_cash_stable_spending_paused_when_allowance_is_zero(self):
        financial_os_v2 = {
            "current_period_safe_to_spend": 0.0,
            "remaining_discretionary_this_month": 0.0,
            "remaining_discretionary_this_period": 0.0,
            "runway_target_months": 3.0,
            "monthly_essentials": 2000.0,
            "runway_reserve_current": 6000.0,
            "runway_reserve_target": 6000.0,
            "upcoming_obligations": 500.0,
            "debt_minimums": 50.0,
            "debt_payoff_projection": {
                "recurring_extra_payment": 500.0,
                "target_debt_id": 7,
                "debts": [
                    {
                        "debt_id": 7,
                        "name": "Visa Platinum",
                        "apr": 31.0,
                        "balance": 800.0,
                        "minimum_due": 50.0,
                        "recommended_extra_payment": 500.0,
                        "minimum_only_months": 18,
                        "with_extra_months": 2,
                        "months_saved": 16,
                        "interest_saved": 100.0,
                    }
                ],
            },
            "fi_target": 780000.0,
            "fi_progress_amount": 126000.0,
            "fi_progress_percent": 16.15,
        }

        with patch("api._user_settings_payload", return_value={}), \
             patch("api._cash_total_latest", return_value=126000.0), \
             patch("api._upcoming_window_items", return_value=([], 550.0)), \
             patch("api._summarize_upcoming_items", return_value={}), \
             patch("api._sum_essentials_monthly", return_value=(500.0, 50.0, 2000.0)), \
             patch("api.os_debt_utilization", return_value={"total_utilization_pct": None}), \
             patch("api._goal_value_map", return_value={}), \
             patch("api._active_debts_for_intelligence", return_value=[]), \
             patch("api._debt_totals_snapshot", return_value={"total_balance": 800.0, "weighted_apr": 31.0}), \
             patch("api._compute_financial_os_v2", return_value=financial_os_v2), \
             patch("api._build_coaching_insights_payload", return_value={"what_to_do_next": None, "items": [], "source_coverage": {}}):
            result = os_intelligence(
                user_id="demo",
                window_days=21,
                buffer=100.0,
                db=None,
                current_user=SimpleNamespace(id="demo"),
            )

        self.assertEqual(result["stability_meter"]["label"], "Cash stable, spending paused")
        self.assertLess(result["stability_meter"]["value"], 80)
        self.assertIn("discretionary spending is paused", result["stability_meter"]["explanation"])


if __name__ == "__main__":
    unittest.main()
