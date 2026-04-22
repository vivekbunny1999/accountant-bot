from datetime import datetime

from sqlalchemy import select

from db import SessionLocal, ensure_column, initialize_database
from models import (
    AdviceLog,
    Bill,
    CashAccount,
    Debt,
    Goal,
    ManualBill,
    MerchantRule,
    MonthlySnapshot,
    Paycheck,
    PlaidAccount,
    PlaidItem,
    PlaidTransaction,
    Profile,
    RecurringCandidate,
    Statement,
    User,
    UserSettings,
)


LEGACY_USER_TABLES = [
    Statement,
    MerchantRule,
    Profile,
    MonthlySnapshot,
    AdviceLog,
    CashAccount,
    PlaidItem,
    PlaidAccount,
    PlaidTransaction,
    Bill,
    Debt,
    ManualBill,
    Goal,
    Paycheck,
    RecurringCandidate,
]


def _backfill_legacy_users():
    db = SessionLocal()
    try:
        seen = set()
        for model in LEGACY_USER_TABLES:
            rows = db.execute(select(model.user_id).distinct()).all()
            for (user_id,) in rows:
                if user_id:
                    seen.add(user_id)

        for user_id in sorted(seen):
            existing = db.query(User).filter(User.id == user_id).first()
            if not existing:
                db.add(
                    User(
                        id=user_id,
                        email=None,
                        password_hash=None,
                        display_name=user_id,
                        auth_enabled=False,
                        created_at=datetime.utcnow(),
                        updated_at=datetime.utcnow(),
                    )
                )
            settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
            if not settings:
                db.add(
                    UserSettings(
                        user_id=user_id,
                        settings_json="{}",
                        category_rules_json="{}",
                        created_at=datetime.utcnow(),
                        updated_at=datetime.utcnow(),
                    )
                )
        db.commit()
    finally:
        db.close()


def main():
    initialize_database()

    # transactions.posted_date (already used in your code)
    ensure_column("transactions", "posted_date", "posted_date TEXT")

    # statements card identity
    ensure_column("statements", "card_name", "card_name TEXT")
    ensure_column("statements", "card_last4", "card_last4 TEXT")
    ensure_column("plaid_items", "access_token_encrypted", "access_token_encrypted TEXT")
    _backfill_legacy_users()

    print("DB initialized/updated")


if __name__ == "__main__":
    main()
