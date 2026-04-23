from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship
from datetime import datetime
from db import Base


class Statement(Base):
    __tablename__ = "statements"

    id = Column(Integer, primary_key=True)
    user_id = Column(String, nullable=False, index=True)
    account_label = Column(String, nullable=True)

    # ✅ card identity
    card_name = Column(String, nullable=True, index=True)   # e.g., "Venture", "Savor One"
    card_last4 = Column(String, nullable=True, index=True)  # e.g., "1234"

    # Keep it simple for now (strings are OK for MVP)
    statement_period = Column(String, nullable=True)

    due_date = Column(String, nullable=True)
    minimum_payment = Column(Float, nullable=True)
    new_balance = Column(Float, nullable=True)
    interest_charged = Column(Float, nullable=True)
    apr = Column(Float, nullable=True)

    # ✅ Needed for dedupe
    fingerprint = Column(String, nullable=True, index=True)

    filename = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    # ✅ NEW: human-friendly ID
    statement_code = Column(String, unique=True, index=True, nullable=True)

    transactions = relationship(
        "Transaction",
        back_populates="statement",
        cascade="all, delete-orphan",
    )


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=True)
    password_hash = Column(Text, nullable=True)
    display_name = Column(String, nullable=True)
    auth_enabled = Column(Boolean, default=False, nullable=False)
    email_verified_at = Column(DateTime, nullable=True)
    beta_access_approved = Column(Boolean, default=False, nullable=False)
    session_version = Column(Integer, default=1, nullable=False)
    password_changed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class UserSession(Base):
    __tablename__ = "user_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    user_agent = Column(String, nullable=True)
    session_version = Column(Integer, default=1, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    token_hash = Column(String, unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    requested_by_ip = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class UserSettings(Base):
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True, nullable=False)
    settings_json = Column(Text, default="{}", nullable=False)
    category_rules_json = Column(Text, default="{}", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True)
    statement_id = Column(Integer, ForeignKey("statements.id"), nullable=False, index=True)

    posted_date = Column(String, nullable=True)  # keep string for now
    description = Column(String, nullable=True, index=True)
    amount = Column(Float, nullable=False, default=0.0)
    txn_type = Column(String, nullable=True)
    category = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    statement = relationship("Statement", back_populates="transactions")


class MerchantRule(Base):
    __tablename__ = "merchant_rules"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True)
    pattern = Column(String, index=True)
    category = Column(String)
    match_type = Column(String, default="contains")
    normalized = Column(String, index=True)
    priority = Column(Integer, default=100)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class Profile(Base):
    __tablename__ = "profiles"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, unique=True, index=True, nullable=False)

    rent_monthly = Column(Float, nullable=True)
    car_loan_monthly = Column(Float, nullable=True)
    utilities_monthly = Column(Float, nullable=True)
    fuel_weekly = Column(Float, nullable=True)
    savings_monthly_target = Column(Float, nullable=True)

    extra_debt_target = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class MonthlySnapshot(Base):
    __tablename__ = "monthly_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    month = Column(String, index=True, nullable=False)

    total_spent = Column(Float, default=0.0)
    debt_paid = Column(Float, default=0.0)
    top_category = Column(String, nullable=True)

    category_totals_json = Column(Text, default="{}")

    interest_charged = Column(Float, default=0.0)
    new_balance = Column(Float, default=0.0)

    adherence_score = Column(Integer, default=0)
    summary_message = Column(Text, default="")

    created_at = Column(DateTime, default=datetime.utcnow)


class AdviceLog(Base):
    __tablename__ = "advice_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    period_start = Column(DateTime, nullable=False)
    period_end = Column(DateTime, nullable=False)

    advice_type = Column(String, nullable=False)
    advice_payload_json = Column(Text, default="{}")

    compliance_score = Column(Integer, default=0)
    outcome_json = Column(Text, default="{}")

    created_at = Column(DateTime, default=datetime.utcnow)


# --- Cash (Bank) models: Checking/Savings statements + transactions ---

class CashAccount(Base):
    __tablename__ = "cash_accounts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    institution = Column(String, default="CapitalOne", nullable=False)
    account_label = Column(String, default="CapitalOne Bank", nullable=False)

    # optional identifiers (masked)
    account_last4 = Column(String, nullable=True)
    account_name = Column(String, nullable=True)   # e.g., "360 Checking", "Performance Savings"

    # statement metadata
    statement_period = Column(String, nullable=True)  # "Dec 01, 2025 to Dec 31, 2025"
    statement_end_date = Column(String, nullable=True)  # "YYYY-MM-DD" (optional helper)
    filename = Column(String, nullable=True)

    # balances (some PDFs show both checking+savings; store what parser provides)
    checking_begin_balance = Column(Float, nullable=True)
    checking_end_balance = Column(Float, nullable=True)
    savings_begin_balance = Column(Float, nullable=True)
    savings_end_balance = Column(Float, nullable=True)

    fingerprint = Column(String, index=True, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    transactions = relationship(
        "CashTransaction",
        back_populates="cash_account",
        cascade="all, delete-orphan",
    )


class CashTransaction(Base):
    __tablename__ = "cash_transactions"

    id = Column(Integer, primary_key=True, index=True)
    cash_account_id = Column(Integer, ForeignKey("cash_accounts.id"), index=True, nullable=False)

    posted_date = Column(String, nullable=True)     # "YYYY-MM-DD"
    description = Column(String, nullable=True, index=True)
    amount = Column(Float, nullable=True)

    # optional bank-specific fields
    txn_type = Column(String, nullable=True)        # "debit" / "credit" / "fee" etc (if parser provides)
    category = Column(String, nullable=True)        # editable category

    created_at = Column(DateTime, default=datetime.utcnow)

    cash_account = relationship("CashAccount", back_populates="transactions")


class PlaidItem(Base):
    __tablename__ = "plaid_items"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    plaid_item_id = Column(String, unique=True, index=True, nullable=False)
    institution_name = Column(String, nullable=True)
    access_token = Column(Text, nullable=False)
    access_token_encrypted = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="linked")
    available_products_json = Column(Text, nullable=True)
    billed_products_json = Column(Text, nullable=True)
    consent_expiration_time = Column(String, nullable=True)
    last_accounts_sync_at = Column(DateTime, nullable=True)
    last_balances_sync_at = Column(DateTime, nullable=True)
    last_transactions_sync_at = Column(DateTime, nullable=True)
    last_sync_error = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    accounts = relationship(
        "PlaidAccount",
        back_populates="item",
        cascade="all, delete-orphan",
    )
    transactions = relationship(
        "PlaidTransaction",
        back_populates="item",
        cascade="all, delete-orphan",
    )


class PlaidAccount(Base):
    __tablename__ = "plaid_accounts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    plaid_item_id = Column(Integer, ForeignKey("plaid_items.id"), index=True, nullable=False)
    plaid_account_id = Column(String, unique=True, index=True, nullable=False)
    institution_name = Column(String, nullable=True)
    name = Column(String, nullable=False)
    official_name = Column(String, nullable=True)
    mask = Column(String, nullable=True)
    type = Column(String, nullable=True)
    subtype = Column(String, nullable=True)
    current_balance = Column(Float, nullable=True)
    available_balance = Column(Float, nullable=True)
    iso_currency_code = Column(String, nullable=True)
    unofficial_currency_code = Column(String, nullable=True)
    is_cash_like = Column(Boolean, default=False)
    is_liability = Column(Boolean, default=False)
    sync_status = Column(String, nullable=False, default="linked")
    last_synced_at = Column(DateTime, nullable=True)
    last_balance_sync_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    item = relationship("PlaidItem", back_populates="accounts")
    transactions = relationship(
        "PlaidTransaction",
        back_populates="account",
        cascade="all, delete-orphan",
    )


class PlaidTransaction(Base):
    __tablename__ = "plaid_transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)
    plaid_item_id = Column(Integer, ForeignKey("plaid_items.id"), index=True, nullable=False)
    plaid_account_id = Column(Integer, ForeignKey("plaid_accounts.id"), index=True, nullable=False)
    plaid_transaction_id = Column(String, unique=True, index=True, nullable=False)
    posted_date = Column(String, nullable=True)
    authorized_date = Column(String, nullable=True)
    name = Column(String, nullable=True)
    merchant_name = Column(String, nullable=True)
    amount = Column(Float, nullable=True)
    iso_currency_code = Column(String, nullable=True)
    unofficial_currency_code = Column(String, nullable=True)
    pending = Column(Boolean, default=False)
    payment_channel = Column(String, nullable=True)
    category_primary = Column(String, nullable=True)
    category_detailed = Column(String, nullable=True)
    raw_json = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    item = relationship("PlaidItem", back_populates="transactions")
    account = relationship("PlaidAccount", back_populates="transactions")


# =========================================================
# Financial OS (Phase 1) — NEW TABLES (additive, no breaks)
# =========================================================

class Bill(Base):
    """
    Manual bills (rent, utilities, subscriptions) + confirmed recurring bills.
    Drives: upcoming bills window, essentials cap, alerts.
    """
    __tablename__ = "bills"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    name = Column(String, nullable=False)                 # "Rent", "Car Insurance"
    amount = Column(Float, nullable=False, default=0.0)

    # schedule
    frequency = Column(String, nullable=False, default="monthly")  # monthly|weekly|biweekly|annual|once
    due_day = Column(Integer, nullable=True)              # for monthly bills: 1..31
    next_due_date = Column(String, nullable=True)         # ISO "YYYY-MM-DD" (optional override)
    autopay = Column(Boolean, default=False)

    # classification
    category = Column(String, nullable=True)              # optional for reporting
    essentials = Column(Boolean, default=True)            # essentials cap inclusion
    notes = Column(Text, nullable=True)

    active = Column(Boolean, default=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class Debt(Base):
    """
    Debt registry: cards/loans.
    Drives: utilization, weighted debt cost rate, minimums, optimizer (avalanche/snowball).
    """
    __tablename__ = "debts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    kind = Column(String, nullable=False, default="credit_card")  # credit_card|loan|other
    lender = Column(String, nullable=True)                        # "Capital One"
    name = Column(String, nullable=False)                         # "Savor One", "Car Loan"
    last4 = Column(String, nullable=True, index=True)

    apr = Column(Float, nullable=True)                            # APR %
    balance = Column(Float, nullable=False, default=0.0)
    credit_limit = Column(Float, nullable=True)                   # for utilization

    minimum_due = Column(Float, nullable=True)                    # min payment amount
    due_day = Column(Integer, nullable=True)                      # day-of-month due (1..31)
    due_date = Column(String, nullable=True)                      # ISO override, if you want

    statement_day = Column(Integer, nullable=True)                # optional: statement close day
    active = Column(Boolean, default=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class ManualBill(Base):
    """
    User-entered manual bills (separate from detected/confirmed `bills`).
    """
    __tablename__ = "manual_bills"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    name = Column(String, nullable=False)
    amount = Column(Float, nullable=False, default=0.0)

    # schedule: weekly|biweekly|monthly|quarterly|yearly|one_time
    frequency = Column(String, nullable=False, default="monthly")
    due_day = Column(Integer, nullable=True)          # 1..31 for monthly-style
    due_date = Column(String, nullable=True)          # ISO date for one_time

    category = Column(String, default="Essentials")
    autopay = Column(Boolean, default=False)
    active = Column(Boolean, default=True)
    notes = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class ManualTransaction(Base):
    """
    User-entered cash/manual activity stored separately from Plaid/PDF imports.
    """
    __tablename__ = "manual_transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    amount = Column(Float, nullable=False, default=0.0)
    date = Column(String, nullable=False, index=True)  # ISO "YYYY-MM-DD"
    category = Column(String, nullable=True)
    description = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class Goal(Base):
    """
    Goals for Emergency Fund + FI + others.
    Keep flexible using 'key' + value.
    """
    __tablename__ = "goals"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    key = Column(String, nullable=False, index=True)    # emergency_fund_target | fi_target | runway_target_months | etc.
    value = Column(Float, nullable=False, default=0.0)

    notes = Column(Text, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class Paycheck(Base):
    """
    Paycheck schedule (for 'until next paycheck' bills calculation).
    """
    __tablename__ = "paychecks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    employer = Column(String, nullable=True)            # "Rayconnect"
    frequency = Column(String, nullable=False, default="biweekly")  # weekly|biweekly|monthly
    next_pay_date = Column(String, nullable=True)       # ISO "YYYY-MM-DD"
    typical_amount = Column(Float, nullable=True)       # optional
    notes = Column(Text, nullable=True)

    active = Column(Boolean, default=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


class RecurringCandidate(Base):
    """
    Detected recurring patterns from transactions (needs user confirmation -> Bill).
    """
    __tablename__ = "recurring_candidates"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, index=True, nullable=False)

    signature = Column(String, nullable=False, index=True)     # normalized merchant/description signature
    avg_amount = Column(Float, nullable=True)
    cadence = Column(String, nullable=True)                    # monthly|weekly|biweekly
    confidence = Column(Float, nullable=True)                  # 0..1

    last_seen_date = Column(String, nullable=True)             # ISO
    next_predicted_date = Column(String, nullable=True)        # ISO

    suggested_name = Column(String, nullable=True)             # "Spotify", "Rent"
    suggested_category = Column(String, nullable=True)

    confirmed_bill_id = Column(Integer, ForeignKey("bills.id"), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
