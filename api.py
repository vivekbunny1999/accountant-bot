# FastAPI core
from fastapi import FastAPI, UploadFile, HTTPException, File, Depends, Body, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Database
from db import SessionLocal, engine, ensure_column, ensure_unique_index, initialize_database

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# SQLAlchemy
from sqlalchemy import func
from sqlalchemy import and_
from sqlalchemy import or_
from sqlalchemy.orm import Session
from models import Bill, Debt, Goal, Paycheck, RecurringCandidate, ManualBill, ManualTransaction

# Models
from models import (
    Statement,
    Transaction,
    MerchantRule,
    Profile,
    MonthlySnapshot,
    AdviceLog,
    CashAccount,
    CashTransaction,
    PlaidItem,
    PlaidAccount,
    PlaidTransaction,
    User,
    UserSession,
    UserSettings,
    PasswordResetToken,
)

# Pydantic
from pydantic import BaseModel

# Standard library
import os
import tempfile
import json
import secrets
import time
import threading
import logging
from datetime import date, datetime, timedelta
from typing import Optional, List
from calendar import monthrange

# Parsers
from capitalone_parser import parse_capitalone_pdf
from capitalone_bank_parser import parse_capitalone_bank_pdf
from auth import (
    authenticate_user,
    bump_session_version,
    create_password_reset,
    create_session,
    current_user_from_token,
    consume_password_reset,
    ensure_user_settings,
    parse_settings_json,
    public_user,
    require_current_user,
    revoke_all_sessions,
    resolve_user_id,
    revoke_session,
)
from security import (
    decrypt_secret,
    encrypt_secret,
    hash_password,
    new_user_id,
    normalize_email,
    normalize_username,
    password_policy,
    plaid_encryption_key_ready,
    utcnow,
    username_is_valid,
    validate_password_rules,
    verify_password,
)



WEEKLY_BUFFER = 25.0          # safety cushion
EXTRA_DEBT_TARGET = 50.0     # suggested extra payment

app = FastAPI()
logger = logging.getLogger("accountant_bot.plaid")

def _is_placeholder(v: str) -> bool:
    if v is None:
        return True
    s = str(v).strip().strip('"').strip("'").lower()
    return s in ("", "string", "null", "none", "undefined")

import re

def normalize_merchant(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)     # remove symbols
    s = re.sub(r"\s+", " ", s).strip()     # collapse spaces
    return s



class TransactionIn(BaseModel):
    posted_date: Optional[str] = None   # "YYYY-MM-DD" for now
    description: Optional[str] = None
    amount: Optional[float] = None
    txn_type: Optional[str] = None
    category: Optional[str] = None

class ProfileIn(BaseModel):
    rent_monthly: Optional[float] = None
    car_loan_monthly: Optional[float] = None
    utilities_monthly: Optional[float] = None
    fuel_weekly: Optional[float] = None
    savings_monthly_target: Optional[float] = None
    extra_debt_target: Optional[float] = None


class SignupIn(BaseModel):
    email: str
    password: str
    display_name: Optional[str] = None


class LoginIn(BaseModel):
    email: str
    password: str


class PasswordResetRequestIn(BaseModel):
    email: str


class PasswordResetConfirmIn(BaseModel):
    token: str
    password: str


class AccountProfileUpdateIn(BaseModel):
    display_name: Optional[str] = None
    username: Optional[str] = None
    email: Optional[str] = None
    current_password: Optional[str] = None


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


class SettingsIn(BaseModel):
    settings: dict = {}
    category_rules: dict = {}


class PlaidLinkTokenIn(BaseModel):
    user_id: str = "demo"


class PlaidPublicTokenExchangeIn(BaseModel):
    public_token: str
    user_id: str = "demo"
    institution_name: Optional[str] = None


class PlaidSyncIn(BaseModel):
    user_id: str = "demo"
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    lookback_days: int = 30


from sqlalchemy import text

_AUTH_RATE_LIMITS = {
    "login_ip": (10, 15 * 60),
    "login_email": (8, 15 * 60),
    "signup_ip": (5, 60 * 60),
    "signup_email": (3, 60 * 60),
    "reset_request_ip": (5, 60 * 60),
    "reset_request_email": (3, 60 * 60),
    "reset_confirm_ip": (10, 60 * 60),
}
_rate_limit_state: dict[str, list[float]] = {}
_rate_limit_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    if request.client and request.client.host:
        return request.client.host[:64]
    return "unknown"


def _enforce_rate_limit(bucket: str, key: str) -> None:
    limit, window = _AUTH_RATE_LIMITS[bucket]
    now = time.time()
    state_key = f"{bucket}:{key}"
    with _rate_limit_lock:
        hits = [ts for ts in _rate_limit_state.get(state_key, []) if now - ts < window]
        if len(hits) >= limit:
            retry_after = max(1, int(window - (now - hits[0])))
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait a bit and try again.",
                headers={"Retry-After": str(retry_after)},
            )
        hits.append(now)
        _rate_limit_state[state_key] = hits


def _beta_signup_mode() -> str:
    raw = (os.getenv("BETA_SIGNUP_MODE", "allowlist") or "allowlist").strip().lower()
    if raw not in {"open", "allowlist", "closed"}:
        return "allowlist"
    return raw


def _beta_allowed_emails() -> set[str]:
    raw = os.getenv("BETA_ALLOWED_EMAILS", "")
    return {normalize_email(value) for value in raw.split(",") if normalize_email(value)}


def _email_verification_required() -> bool:
    raw = (os.getenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false") or "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _email_verification_configured() -> bool:
    return False


def _password_reset_delivery_mode() -> str:
    return (os.getenv("AUTH_PASSWORD_RESET_DELIVERY", "manual_beta") or "manual_beta").strip().lower()


def _password_reset_debug_links_enabled() -> bool:
    raw = (os.getenv("AUTH_PASSWORD_RESET_DEBUG_LINKS", "false") or "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _trim_display_name(value: Optional[str], fallback: Optional[str] = None) -> str:
    trimmed = (value or "").strip()
    if trimmed:
        return trimmed[:80]
    fallback_trimmed = (fallback or "").strip()
    if fallback_trimmed:
        return fallback_trimmed[:80]
    return "Accountant Bot User"


def _username_seed(email: str, display_name: Optional[str] = None) -> str:
    local_part = (email or "").split("@", 1)[0]
    source = display_name or local_part or "user"
    candidate = normalize_username(re.sub(r"[^a-zA-Z0-9._-]+", "", source))
    candidate = candidate.strip("._-")
    if len(candidate) < 3:
        candidate = normalize_username(re.sub(r"[^a-zA-Z0-9]+", "", local_part or "user")) or "user"
    candidate = candidate[:32].strip("._-") or "user"
    if not username_is_valid(candidate):
        candidate = f"user{secrets.token_hex(2)}"
    return candidate[:32]


def _next_available_username(db: Session, email: str, display_name: Optional[str], current_user_id: Optional[str] = None) -> str:
    base = _username_seed(email, display_name)
    for attempt in range(0, 100):
        suffix = "" if attempt == 0 else str(attempt + 1)
        max_base_len = 32 - len(suffix)
        candidate = f"{base[:max_base_len]}{suffix}"
        existing = db.query(User).filter(User.username == candidate).first()
        if not existing or existing.id == current_user_id:
            return candidate
    return f"user{secrets.token_hex(4)}"


def _enforce_beta_signup_gate(email: str) -> bool:
    mode = _beta_signup_mode()
    if mode == "open":
        return True
    if mode == "closed":
        raise HTTPException(status_code=403, detail="Signup is currently closed for this limited beta.")
    if email not in _beta_allowed_emails():
        raise HTTPException(status_code=403, detail="This beta is invite-only right now.")
    return True

def _cors_origins_from_env() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000").strip()
    origins: list[str] = []
    if raw:
        if raw == "*":
            allow_all = (os.getenv("CORS_ALLOW_ALL", "false") or "false").strip().lower() in {"1", "true", "yes", "on"}
            if allow_all:
                return ["*"]
            origins.extend(["http://127.0.0.1:3000", "http://localhost:3000"])
        else:
            origins.extend([origin.strip() for origin in raw.split(",") if origin.strip()])

    frontend_url = (os.getenv("FRONTEND_URL") or "").strip()
    if frontend_url:
        origins.append(frontend_url.rstrip("/"))

    if not origins:
        origins = ["http://127.0.0.1:3000", "http://localhost:3000"]

    deduped: list[str] = []
    seen = set()
    for origin in origins:
        if origin not in seen:
            deduped.append(origin)
            seen.add(origin)
    return deduped


def _cors_origin_regex_from_env() -> Optional[str]:
    raw = (os.getenv("CORS_ORIGIN_REGEX") or "").strip()
    return raw or None

def ensure_statement_card_columns():
    ensure_column("statements", "card_name", "card_name TEXT")
    ensure_column("statements", "card_last4", "card_last4 TEXT")
    ensure_column("plaid_items", "access_token_encrypted", "access_token_encrypted TEXT")
    ensure_column("users", "username", "username TEXT")
    ensure_column("users", "email_verified_at", "email_verified_at TIMESTAMP")
    ensure_column("users", "beta_access_approved", "beta_access_approved BOOLEAN NOT NULL DEFAULT FALSE")
    ensure_column("users", "session_version", "session_version INTEGER NOT NULL DEFAULT 1")
    ensure_column("users", "password_changed_at", "password_changed_at TIMESTAMP")
    ensure_column("user_sessions", "session_version", "session_version INTEGER NOT NULL DEFAULT 1")
    ensure_unique_index("users", "ix_users_username_unique", ["username"])


def _require_plaid_encryption_ready() -> None:
    if not plaid_encryption_key_ready():
        raise HTTPException(
            status_code=500,
            detail="PLAID_TOKEN_ENCRYPTION_KEY must be configured with a real secret before using Plaid in beta.",
        )


def _scrub_plaintext_plaid_tokens() -> None:
    if not plaid_encryption_key_ready():
        return
    db = SessionLocal()
    try:
        rows = (
            db.query(PlaidItem)
            .filter(PlaidItem.access_token != None)
            .all()
        )
        updated = False
        for row in rows:
            plaintext = (row.access_token or "").strip()
            if not plaintext:
                continue
            if not getattr(row, "access_token_encrypted", None):
                row.access_token_encrypted = encrypt_secret(plaintext)
            row.access_token = ""
            row.updated_at = utcnow()
            db.add(row)
            updated = True
        if updated:
            db.commit()
    finally:
        db.close()


def ensure_auth_seed_rows():
    models_with_users = [
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
        ManualTransaction,
        Goal,
        Paycheck,
        RecurringCandidate,
    ]

    db = SessionLocal()
    try:
        seen = set()
        for model in models_with_users:
            for (user_id,) in db.query(model.user_id).distinct().all():
                if user_id:
                    seen.add(user_id)

        for user_id in sorted(seen):
            if not db.query(User).filter(User.id == user_id).first():
                db.add(
                    User(
                        id=user_id,
                        email=None,
                        password_hash=None,
                        display_name=user_id,
                        auth_enabled=False,
                        email_verified_at=None,
                        beta_access_approved=False,
                        session_version=1,
                        created_at=utcnow(),
                        updated_at=utcnow(),
                    )
                )
            if not db.query(UserSettings).filter(UserSettings.user_id == user_id).first():
                db.add(
                    UserSettings(
                        user_id=user_id,
                        settings_json="{}",
                        category_rules_json="{}",
                        created_at=utcnow(),
                        updated_at=utcnow(),
                    )
                )
        db.commit()
    finally:
        db.close()

initialize_database()
ensure_statement_card_columns()
ensure_auth_seed_rows()
_scrub_plaintext_plaid_tokens()


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins_from_env(),
    allow_origin_regex=_cors_origin_regex_from_env(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path != "/health":
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
    return response


import re
from datetime import datetime, date

def _parse_statement_end_date(period: str):
    """
    Extracts end date from:
    "Dec 09, 2025 to Jan 08, 2026"
    Returns datetime.date or None
    """
    if not period:
        return None

    m = re.findall(r"\b([A-Za-z]{3})\s+(\d{1,2}),\s*(20\d{2})\b", period)
    if not m:
        return None

    mon_str, day_str, year_str = m[-1]

    months = {
        "jan":1,"feb":2,"mar":3,"apr":4,"may":5,"jun":6,
        "jul":7,"aug":8,"sep":9,"oct":10,"nov":11,"dec":12
    }

    mon = months.get(mon_str.lower())
    if not mon:
        return None

    try:
        return datetime(int(year_str), mon, int(day_str))
    except:
        return None


@app.get("/health")
def health():
    return {"ok": True}


def _safe_database_url() -> str:
    try:
        return engine.url.render_as_string(hide_password=True)
    except Exception:
        return f"{engine.dialect.name}://<unavailable>"


def _plaid_table_counts(db: Session, user_id: Optional[str] = None) -> dict:
    filters = []
    if user_id:
        filters.append(PlaidItem.user_id == user_id)
    item_q = db.query(func.count(PlaidItem.id))
    if filters:
        item_q = item_q.filter(*filters)

    account_q = db.query(func.count(PlaidAccount.id))
    transaction_q = db.query(func.count(PlaidTransaction.id))
    if user_id:
        account_q = account_q.filter(PlaidAccount.user_id == user_id)
        transaction_q = transaction_q.filter(PlaidTransaction.user_id == user_id)

    return {
        "plaid_items": int(item_q.scalar() or 0),
        "plaid_accounts": int(account_q.scalar() or 0),
        "plaid_transactions": int(transaction_q.scalar() or 0),
    }


def _plaid_log(event: str, **fields) -> None:
    try:
        logger.info("plaid_sync.%s %s", event, json.dumps(fields, default=str, sort_keys=True))
    except Exception:
        logger.info("plaid_sync.%s %s", event, fields)


@app.get("/debug/runtime-db")
def debug_runtime_db(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    Temporary deployment diagnostic. Does not expose secrets; database URL is password-masked.
    """
    user_id = _coerce_user_id(current_user, user_id)
    return {
        "ok": True,
        "user_id": user_id,
        "database": {
            "dialect": engine.dialect.name,
            "driver": engine.dialect.driver,
            "url": _safe_database_url(),
            "database": engine.url.database,
            "host": engine.url.host,
        },
        "plaid_env": _plaid_env_name(),
        "plaid_products": _plaid_products(),
        "plaid_configured": bool((os.getenv("PLAID_CLIENT_ID") or "").strip() and (os.getenv("PLAID_SECRET") or "").strip()),
        "plaid_token_encryption_ready": plaid_encryption_key_ready(),
        "table_counts_for_user": _plaid_table_counts(db, user_id),
        "table_counts_all_users": _plaid_table_counts(db),
    }


def _coerce_user_id(current_user: User, requested_user_id: Optional[str] = None) -> str:
    return resolve_user_id(current_user, requested_user_id)


def _get_plaid_access_token(item_row: PlaidItem, db: Session) -> str:
    _require_plaid_encryption_ready()
    encrypted = getattr(item_row, "access_token_encrypted", None)
    if encrypted:
        token = decrypt_secret(encrypted)
        if token:
            return token

    legacy_token = (getattr(item_row, "access_token", None) or "").strip()
    if not legacy_token:
        raise HTTPException(status_code=500, detail="Plaid access token is unavailable.")

    item_row.access_token_encrypted = encrypt_secret(legacy_token)
    item_row.access_token = ""
    item_row.updated_at = utcnow()
    db.add(item_row)
    db.commit()
    db.refresh(item_row)
    return legacy_token


@app.post("/auth/signup")
def auth_signup(payload: SignupIn, request: Request, db: Session = Depends(get_db)):
    email = normalize_email(payload.email)
    password = payload.password or ""
    _enforce_rate_limit("signup_ip", _client_ip(request))
    _enforce_rate_limit("signup_email", email or "unknown")
    if "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email address is required.")
    password_errors = validate_password_rules(password)
    if password_errors:
        raise HTTPException(status_code=400, detail=password_errors[0])
    _enforce_beta_signup_gate(email)
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(status_code=409, detail="An account with this email already exists.")

    display_name = _trim_display_name(payload.display_name, email.split("@", 1)[0])
    user = User(
        id=new_user_id(),
        email=email,
        username=_next_available_username(db, email, display_name),
        password_hash=hash_password(password),
        display_name=display_name,
        auth_enabled=True,
        email_verified_at=None,
        beta_access_approved=True,
        session_version=1,
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    ensure_user_settings(db, user.id)

    token, session = create_session(db, user, request.headers.get("user-agent"))
    return {
        "ok": True,
        "token": token,
        "expires_at": session.expires_at.isoformat(),
        "user": public_user(user),
    }


@app.get("/auth/password-policy")
def auth_password_policy():
    return {
        "ok": True,
        "policy": password_policy(),
        "guidance": {
            "recommended_mix": ["uppercase", "lowercase", "number", "special"],
        },
    }


@app.post("/auth/login")
def auth_login(payload: LoginIn, request: Request, db: Session = Depends(get_db)):
    email = normalize_email(payload.email)
    _enforce_rate_limit("login_ip", _client_ip(request))
    _enforce_rate_limit("login_email", email or "unknown")
    user = authenticate_user(db, email, payload.password or "")
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    ensure_user_settings(db, user.id)
    token, session = create_session(db, user, request.headers.get("user-agent"))
    return {
        "ok": True,
        "token": token,
        "expires_at": session.expires_at.isoformat(),
        "user": public_user(user),
    }


@app.post("/auth/logout")
def auth_logout(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    _ = current_user
    token = None
    if authorization:
        parts = authorization.split(" ", 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            token = parts[1].strip()
    if token:
        revoke_session(db, token)
    return {"ok": True}


@app.post("/auth/password-reset/request")
def auth_password_reset_request(payload: PasswordResetRequestIn, request: Request, db: Session = Depends(get_db)):
    email = normalize_email(payload.email)
    _enforce_rate_limit("reset_request_ip", _client_ip(request))
    _enforce_rate_limit("reset_request_email", email or "unknown")

    response = {
        "ok": True,
        "message": "If that account exists, password reset instructions have been queued.",
        "delivery_mode": _password_reset_delivery_mode(),
    }

    if "@" not in email:
        return response

    user = db.query(User).filter(User.email == email).first()
    if not user or not user.auth_enabled:
        return response

    token = create_password_reset(db, user, _client_ip(request))
    if _password_reset_debug_links_enabled():
        response["reset_token"] = token
        response["reset_path"] = f"/reset-password?token={token}"
    return response


@app.post("/auth/password-reset/confirm")
def auth_password_reset_confirm(payload: PasswordResetConfirmIn, request: Request, db: Session = Depends(get_db)):
    _enforce_rate_limit("reset_confirm_ip", _client_ip(request))
    password = payload.password or ""
    password_errors = validate_password_rules(password)
    if password_errors:
        raise HTTPException(status_code=400, detail=password_errors[0])

    user = consume_password_reset(db, payload.token or "")
    user.password_hash = hash_password(password)
    user.password_changed_at = utcnow()
    user.updated_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    revoke_all_sessions(db, user.id)
    user = bump_session_version(db, user)
    token, session = create_session(db, user, request.headers.get("user-agent"))
    return {
        "ok": True,
        "token": token,
        "expires_at": session.expires_at.isoformat(),
        "user": public_user(user),
    }


@app.get("/auth/me")
def auth_me(current_user: User = Depends(require_current_user), db: Session = Depends(get_db)):
    settings = ensure_user_settings(db, current_user.id)
    return {
        "ok": True,
        "user": public_user(current_user),
        "settings": parse_settings_json(settings.settings_json),
        "category_rules": parse_settings_json(settings.category_rules_json),
        "beta": {
            "signup_mode": _beta_signup_mode(),
            "email_verification_required": _email_verification_required(),
            "password_reset_delivery": _password_reset_delivery_mode(),
            "email_verification_configured": _email_verification_configured(),
        },
    }


@app.patch("/auth/profile")
def auth_update_profile(
    payload: AccountProfileUpdateIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="No profile changes were provided.")

    if "display_name" in data:
        current_user.display_name = _trim_display_name(data.get("display_name"), current_user.display_name or current_user.email)

    if "username" in data:
        raw_username = normalize_username(data.get("username") or "")
        if raw_username:
            if not username_is_valid(raw_username):
                raise HTTPException(
                    status_code=400,
                    detail="Username must be 3-32 characters and use only letters, numbers, dots, dashes, or underscores.",
                )
            existing_username = db.query(User).filter(User.username == raw_username).first()
            if existing_username and existing_username.id != current_user.id:
                raise HTTPException(status_code=409, detail="That username is already taken.")
            current_user.username = raw_username
        else:
            current_user.username = None

    if "email" in data:
        email = normalize_email(data.get("email") or "")
        if "@" not in email:
            raise HTTPException(status_code=400, detail="A valid email address is required.")
        if email != (current_user.email or ""):
            password = data.get("current_password") or ""
            if not current_user.password_hash or not verify_password(password, current_user.password_hash):
                raise HTTPException(status_code=400, detail="Current password is required to change your email.")
            existing_email = db.query(User).filter(User.email == email).first()
            if existing_email and existing_email.id != current_user.id:
                raise HTTPException(status_code=409, detail="An account with this email already exists.")
            current_user.email = email
            if _email_verification_required():
                current_user.email_verified_at = None

    current_user.updated_at = utcnow()
    db.add(current_user)
    db.commit()
    db.refresh(current_user)

    return {
        "ok": True,
        "user": public_user(current_user),
    }


@app.post("/auth/password/change")
def auth_change_password(
    payload: PasswordChangeIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    current_password = payload.current_password or ""
    new_password = payload.new_password or ""

    if not current_user.password_hash or not verify_password(current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    password_errors = validate_password_rules(new_password)
    if password_errors:
        raise HTTPException(status_code=400, detail=password_errors[0])
    if verify_password(new_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Choose a new password that is different from your current password.")

    current_user.password_hash = hash_password(new_password)
    current_user.password_changed_at = utcnow()
    current_user.updated_at = utcnow()
    db.add(current_user)
    db.commit()
    db.refresh(current_user)

    revoke_all_sessions(db, current_user.id)
    current_user = bump_session_version(db, current_user)
    token, session = create_session(db, current_user, request.headers.get("user-agent"))
    return {
        "ok": True,
        "token": token,
        "expires_at": session.expires_at.isoformat(),
        "user": public_user(current_user),
    }


@app.get("/user/settings")
def get_user_settings(current_user: User = Depends(require_current_user), db: Session = Depends(get_db)):
    row = ensure_user_settings(db, current_user.id)
    return {
        "ok": True,
        "user_id": current_user.id,
        "settings": parse_settings_json(row.settings_json),
        "category_rules": parse_settings_json(row.category_rules_json),
    }


@app.put("/user/settings")
def put_user_settings(
    payload: SettingsIn,
    current_user: User = Depends(require_current_user),
    db: Session = Depends(get_db),
):
    row = ensure_user_settings(db, current_user.id)
    row.settings_json = json.dumps(payload.settings or {})
    row.category_rules_json = json.dumps(payload.category_rules or {})
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "ok": True,
        "user_id": current_user.id,
        "settings": parse_settings_json(row.settings_json),
        "category_rules": parse_settings_json(row.category_rules_json),
    }


def _plaid_env_name() -> str:
    return (os.getenv("PLAID_ENV", "sandbox") or "sandbox").strip().lower()


def _plaid_products() -> list[str]:
    raw = os.getenv("PLAID_PRODUCTS", "transactions")
    products = [value.strip().lower() for value in raw.split(",") if value.strip()]
    return products or ["transactions"]


def _plaid_country_codes() -> list[str]:
    raw = os.getenv("PLAID_COUNTRY_CODES", "US")
    countries = [value.strip().upper() for value in raw.split(",") if value.strip()]
    return countries or ["US"]


def _load_plaid_sdk():
    try:
        import plaid
        from plaid.api import plaid_api
        from plaid.model.accounts_get_request import AccountsGetRequest
        from plaid.model.transactions_get_request import TransactionsGetRequest
        from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
        from plaid.model.country_code import CountryCode
        from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
        from plaid.model.link_token_create_request import LinkTokenCreateRequest
        from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
        from plaid.model.products import Products
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Plaid SDK is not installed on the backend. Install requirements.txt on staging first.",
        ) from exc

    return {
        "plaid": plaid,
        "plaid_api": plaid_api,
        "AccountsGetRequest": AccountsGetRequest,
        "TransactionsGetRequest": TransactionsGetRequest,
        "TransactionsGetRequestOptions": TransactionsGetRequestOptions,
        "CountryCode": CountryCode,
        "ItemPublicTokenExchangeRequest": ItemPublicTokenExchangeRequest,
        "LinkTokenCreateRequest": LinkTokenCreateRequest,
        "LinkTokenCreateRequestUser": LinkTokenCreateRequestUser,
        "Products": Products,
    }


def _get_plaid_client():
    client_id = (os.getenv("PLAID_CLIENT_ID") or "").strip()
    secret = (os.getenv("PLAID_SECRET") or "").strip()
    if not client_id or not secret:
        raise HTTPException(
            status_code=503,
            detail="Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET on the backend.",
        )

    sdk = _load_plaid_sdk()
    plaid = sdk["plaid"]
    env_name = _plaid_env_name()

    env_map = {}

    sandbox_host = getattr(plaid.Environment, "Sandbox", None)
    if sandbox_host is not None:
        env_map["sandbox"] = sandbox_host

    development_host = getattr(plaid.Environment, "Development", None)
    if development_host is not None:
        env_map["development"] = development_host

    production_host = getattr(plaid.Environment, "Production", None)
    if production_host is not None:
        env_map["production"] = production_host

    host = env_map.get(env_name)
    if host is None:
        raise HTTPException(
            status_code=500,
            detail=f"Unsupported PLAID_ENV '{env_name}'. Use sandbox, development, or production.",
        )

    configuration = plaid.Configuration(
        host=host,
        api_key={
            "clientId": client_id,
            "secret": secret,
            "plaidVersion": "2020-09-14",
        },
    )
    api_client = plaid.ApiClient(configuration)
    client = sdk["plaid_api"].PlaidApi(api_client)
    return client, sdk


def _raise_plaid_http_error(exc, fallback_status: int = 502):
    detail = "Plaid request failed."
    status_code = getattr(exc, "status", None) or fallback_status

    body = getattr(exc, "body", None)
    if body:
        try:
            parsed = json.loads(body)
            error_message = parsed.get("error_message") or parsed.get("display_message")
            error_code = parsed.get("error_code")
            if error_message and error_code:
                detail = f"{error_message} ({error_code})"
            elif error_message:
                detail = error_message
        except Exception:
            detail = str(body)
    elif str(exc):
        detail = str(exc)

    raise HTTPException(status_code=status_code, detail=detail) from exc


def _plaid_to_dict(value):
    if isinstance(value, dict):
        return value
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    return dict(value)


def _plaid_now() -> datetime:
    return datetime.utcnow()


def _plaid_sort_ts(*values: Optional[datetime]) -> float:
    for value in values:
        if value is not None:
            return value.timestamp()
    return 0.0


def _plaid_item_is_active(item_row: Optional[PlaidItem]) -> bool:
    if item_row is None:
        return False
    return (item_row.status or "linked") != "superseded"


def _plaid_sync_item_query(db: Session, user_id: str):
    return (
        db.query(PlaidItem)
        .filter(
            PlaidItem.user_id == user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
        )
    )


def _plaid_logical_item_key(institution_name: Optional[str]) -> str:
    return _norm_text(institution_name)


def _plaid_canonical_item_sort_key(item_row: PlaidItem) -> tuple[int, float, int]:
    status = (item_row.status or "linked").lower()
    linked_score = 1 if status == "linked" else 0
    sync_score = _plaid_sort_ts(
        item_row.last_transactions_sync_at,
        item_row.last_balances_sync_at,
        item_row.last_accounts_sync_at,
        item_row.updated_at,
        item_row.created_at,
    )
    return (linked_score, sync_score, item_row.id or 0)


def _plaid_select_canonical_items(item_rows: list[PlaidItem]) -> tuple[list[PlaidItem], list[PlaidItem]]:
    if not _plaid_should_merge_relinks():
        return sorted(
            item_rows,
            key=lambda row: (
                row.created_at or datetime.min,
                row.id or 0,
            ),
            reverse=True,
        ), []

    canonical_by_key: dict[str, PlaidItem] = {}
    duplicates: list[PlaidItem] = []

    for item_row in item_rows:
        key = _plaid_logical_item_key(item_row.institution_name) or f"item:{item_row.id}"
        current = canonical_by_key.get(key)
        if current is None or _plaid_canonical_item_sort_key(item_row) > _plaid_canonical_item_sort_key(current):
            if current is not None:
                duplicates.append(current)
            canonical_by_key[key] = item_row
        else:
            duplicates.append(item_row)

    canonical_items = sorted(
        canonical_by_key.values(),
        key=lambda row: (
            row.created_at or datetime.min,
            row.id or 0,
        ),
        reverse=True,
    )
    return canonical_items, duplicates


def _plaid_account_label(name: Optional[str], official_name: Optional[str], subtype: Optional[str]) -> str:
    return _norm_text(official_name or name or subtype)


def _plaid_logical_account_key_from_parts(
    institution_name: Optional[str],
    mask: Optional[str],
    name: Optional[str],
    official_name: Optional[str],
    account_type: Optional[str],
    subtype: Optional[str],
) -> str:
    inst = _norm_text(institution_name)
    acct_mask = (mask or "").strip()
    label = _plaid_account_label(name, official_name, subtype)
    acct_type = (account_type or "").strip().lower()
    acct_subtype = (subtype or "").strip().lower()
    return "|".join([inst, acct_mask, label, acct_type, acct_subtype])


def _plaid_logical_account_key_for_payload(item_row: PlaidItem, account_payload: dict) -> str:
    return _plaid_logical_account_key_from_parts(
        item_row.institution_name,
        account_payload.get("mask"),
        account_payload.get("name"),
        account_payload.get("official_name"),
        account_payload.get("type"),
        account_payload.get("subtype"),
    )


def _plaid_logical_account_key_for_row(row: PlaidAccount) -> str:
    return _plaid_logical_account_key_from_parts(
        row.institution_name or (row.item.institution_name if row.item else None),
        row.mask,
        row.name,
        row.official_name,
        row.type,
        row.subtype,
    )


def _plaid_canonical_account_sort_key(row: PlaidAccount) -> tuple[int, int, float, int]:
    account_score = 1 if (row.sync_status or "").lower() == "synced" else 0
    item_score = 1 if _plaid_item_is_active(row.item) and (row.item.status or "linked") == "linked" else 0
    sync_score = _plaid_sort_ts(
        row.last_balance_sync_at,
        row.last_synced_at,
    )
    return (account_score, item_score, sync_score, -(row.id or 0))


def _plaid_select_canonical_accounts(account_rows: list[PlaidAccount]) -> tuple[list[PlaidAccount], list[PlaidAccount]]:
    canonical_by_key: dict[str, PlaidAccount] = {}
    duplicates: list[PlaidAccount] = []

    for row in account_rows:
        if not _plaid_item_is_active(row.item):
            duplicates.append(row)
            continue

        key = _plaid_logical_account_key_for_row(row) or f"account:{row.id}"
        current = canonical_by_key.get(key)
        if current is None or _plaid_canonical_account_sort_key(row) > _plaid_canonical_account_sort_key(current):
            if current is not None:
                duplicates.append(current)
            canonical_by_key[key] = row
        else:
            duplicates.append(row)

    canonical_rows = sorted(
        canonical_by_key.values(),
        key=lambda row: (
            not bool(row.is_cash_like),
            row.institution_name or (row.item.institution_name if row.item else ""),
            row.name or "",
            row.id or 0,
        ),
    )
    return canonical_rows, duplicates


def _plaid_find_existing_account_candidate(db: Session, item_row: PlaidItem, account_payload: dict) -> Optional[PlaidAccount]:
    logical_key = _plaid_logical_account_key_for_payload(item_row, account_payload)
    if not logical_key.replace("|", "").strip():
        return None

    candidates = (
        db.query(PlaidAccount)
        .join(PlaidItem, PlaidAccount.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidAccount.user_id == item_row.user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
        )
        .all()
    )
    matches = [row for row in candidates if _plaid_logical_account_key_for_row(row) == logical_key]
    if not matches:
        return None
    return max(matches, key=_plaid_canonical_account_sort_key)


def _plaid_should_merge_relinks() -> bool:
    return _plaid_env_name() == "sandbox"


def _plaid_find_existing_item_candidate(db: Session, user_id: str, institution_name: Optional[str]) -> Optional[PlaidItem]:
    if not _plaid_should_merge_relinks():
        return None

    logical_key = _plaid_logical_item_key(institution_name)
    if not logical_key:
        return None

    items = _plaid_sync_item_query(db, user_id).all()
    matches = [row for row in items if _plaid_logical_item_key(row.institution_name) == logical_key]
    if not matches:
        return None
    return max(matches, key=_plaid_canonical_item_sort_key)


def _plaid_merge_duplicate_items(db: Session, canonical_item: PlaidItem, synced_at: datetime) -> None:
    if not _plaid_should_merge_relinks():
        return

    logical_key = _plaid_logical_item_key(canonical_item.institution_name)
    if not logical_key:
        return

    duplicate_items = [
        row
        for row in _plaid_sync_item_query(db, canonical_item.user_id).all()
        if row.id != canonical_item.id and _plaid_logical_item_key(row.institution_name) == logical_key
    ]

    for duplicate in duplicate_items:
        db.query(PlaidAccount).filter(PlaidAccount.plaid_item_id == duplicate.id).update(
            {
                PlaidAccount.plaid_item_id: canonical_item.id,
                PlaidAccount.user_id: canonical_item.user_id,
                PlaidAccount.institution_name: canonical_item.institution_name,
                PlaidAccount.updated_at: synced_at,
            },
            synchronize_session=False,
        )
        db.query(PlaidTransaction).filter(PlaidTransaction.plaid_item_id == duplicate.id).update(
            {
                PlaidTransaction.plaid_item_id: canonical_item.id,
                PlaidTransaction.user_id: canonical_item.user_id,
                PlaidTransaction.updated_at: synced_at,
            },
            synchronize_session=False,
        )
        duplicate.status = "superseded"
        duplicate.updated_at = synced_at
        duplicate.last_sync_error = f"Superseded by relinked item {canonical_item.plaid_item_id}."

    db.flush()


def _plaid_mark_duplicate_accounts_superseded(db: Session, user_id: str, synced_at: datetime) -> None:
    account_rows = (
        db.query(PlaidAccount)
        .join(PlaidItem, PlaidAccount.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidAccount.user_id == user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
        )
        .all()
    )
    canonical_rows, duplicates = _plaid_select_canonical_accounts(account_rows)
    canonical_by_key = {_plaid_logical_account_key_for_row(row): row for row in canonical_rows}

    for duplicate in duplicates:
        canonical = canonical_by_key.get(_plaid_logical_account_key_for_row(duplicate))
        if canonical is None or canonical.id == duplicate.id:
            continue

        db.query(PlaidTransaction).filter(PlaidTransaction.plaid_account_id == duplicate.id).update(
            {
                PlaidTransaction.plaid_account_id: canonical.id,
                PlaidTransaction.plaid_item_id: canonical.plaid_item_id,
                PlaidTransaction.user_id: canonical.user_id,
                PlaidTransaction.updated_at: synced_at,
            },
            synchronize_session=False,
        )
        duplicate.sync_status = "superseded"
        duplicate.plaid_item_id = canonical.plaid_item_id
        duplicate.updated_at = synced_at

    db.flush()


def _plaid_is_cash_like(account_type: Optional[str], subtype: Optional[str]) -> bool:
    account_type = (account_type or "").lower()
    subtype = (subtype or "").lower()
    if account_type == "depository":
        return True
    return subtype in {"checking", "savings", "cash management", "paypal", "prepaid"}


def _plaid_is_liability(account_type: Optional[str], subtype: Optional[str]) -> bool:
    account_type = (account_type or "").lower()
    subtype = (subtype or "").lower()
    if account_type in {"credit", "loan"}:
        return True
    return subtype in {"credit card", "student", "mortgage", "auto", "personal"}


def _norm_text(value: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def _plaid_matches_pdf_cash_account(plaid_row: PlaidAccount, pdf_rows: list[CashAccount]) -> bool:
    """
    Conservative duplicate heuristic only.
    TODO: replace this with stable source-level dedupe once we have canonical external account identities.
    """
    plaid_institution = _norm_text(plaid_row.institution_name or (plaid_row.item.institution_name if plaid_row.item else None))
    plaid_name = _norm_text(plaid_row.name)
    plaid_official = _norm_text(plaid_row.official_name)
    plaid_mask = (plaid_row.mask or "").strip()
    plaid_subtype = _norm_text(plaid_row.subtype)

    for pdf_row in pdf_rows:
        pdf_institution = _norm_text(pdf_row.institution)
        pdf_name = _norm_text(pdf_row.account_name or pdf_row.account_label)
        pdf_last4 = (pdf_row.account_last4 or "").strip()

        same_institution = bool(plaid_institution and pdf_institution and plaid_institution == pdf_institution)
        same_last4 = bool(plaid_mask and pdf_last4 and plaid_mask == pdf_last4)
        name_overlap = bool(pdf_name and (pdf_name in plaid_name or pdf_name in plaid_official))

        subtype_overlap = False
        if plaid_subtype and pdf_name:
            subtype_overlap = plaid_subtype in pdf_name or pdf_name in plaid_subtype

        if same_institution and (same_last4 or name_overlap or subtype_overlap):
            return True

    return False


def _plaid_cash_breakdown(db: Session, user_id: str) -> dict:
    pdf_rows = (
        db.query(CashAccount)
        .filter(CashAccount.user_id == user_id)
        .order_by(CashAccount.created_at.desc(), CashAccount.id.desc())
        .limit(25)
        .all()
    )
    plaid_rows = (
        db.query(PlaidAccount)
        .join(PlaidItem, PlaidAccount.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidAccount.user_id == user_id,
            PlaidItem.user_id == user_id,
            PlaidAccount.is_cash_like == True,
            or_(PlaidItem.status == "linked", PlaidItem.status.is_(None), PlaidItem.status == "partial"),
            or_(PlaidAccount.sync_status != "superseded", PlaidAccount.sync_status.is_(None)),
        )
        .all()
    )
    plaid_rows, plaid_duplicates = _plaid_select_canonical_accounts(plaid_rows)

    included = []
    skipped = list(plaid_duplicates)
    total = 0.0
    for row in plaid_rows:
        if _plaid_matches_pdf_cash_account(row, pdf_rows):
            skipped.append(row)
            continue
        included.append(row)
        total += _to_float(row.current_balance, 0.0)

    return {
        "included": included,
        "skipped": skipped,
        "included_total": round(float(total), 2),
    }


def _plaid_assert_user_ownership(kind: str, existing_user_id: Optional[str], requested_user_id: str, external_id: Optional[str]) -> None:
    if existing_user_id and existing_user_id != requested_user_id:
        suffix = f" {external_id}" if external_id else ""
        raise HTTPException(
            status_code=409,
            detail=f"{kind}{suffix} is already linked to another user.",
        )


def _serialize_plaid_cash_source_account(row: PlaidAccount) -> dict:
    return {
        "id": row.id,
        "account_id": row.plaid_account_id,
        "item_id": row.item.plaid_item_id if row.item else None,
        "institution_name": row.institution_name or (row.item.institution_name if row.item else None),
        "name": row.name,
        "official_name": row.official_name,
        "mask": row.mask,
        "type": row.type,
        "subtype": row.subtype,
        "current_balance": round(_to_float(row.current_balance, 0.0), 2),
        "available_balance": row.available_balance,
        "counted_balance": round(_to_float(row.current_balance, 0.0), 2),
        "last_balance_sync_at": row.last_balance_sync_at.isoformat() if row.last_balance_sync_at else None,
        "sync_status": row.sync_status,
    }


def _summarize_upcoming_items(items: list[dict]) -> dict:
    summary = {
        "bill_total": 0.0,
        "manual_bill_total": 0.0,
        "debt_minimum_total": 0.0,
        "bill_count": 0,
        "manual_bill_count": 0,
        "debt_minimum_count": 0,
    }

    for item in items:
        item_type = (item.get("type") or "").strip()
        amount = round(_to_float(item.get("amount"), 0.0), 2)
        if item_type == "bill":
            summary["bill_total"] += amount
            summary["bill_count"] += 1
        elif item_type == "manual_bill":
            summary["manual_bill_total"] += amount
            summary["manual_bill_count"] += 1
        elif item_type == "debt_minimum":
            summary["debt_minimum_total"] += amount
            summary["debt_minimum_count"] += 1

    return {
        key: (round(value, 2) if isinstance(value, float) else value)
        for key, value in summary.items()
    }


def _active_financial_os_clause(model):
    """
    Treat NULL as active so older rows created before defaults were enforced
    still participate in Financial OS calculations.
    """
    return or_(model.active == True, model.active.is_(None))


def _cash_account_row_total(row: CashAccount) -> float:
    return round(
        _to_float(getattr(row, "checking_end_balance", None), 0.0)
        + _to_float(getattr(row, "savings_end_balance", None), 0.0),
        2,
    )


def _cash_account_sort_value(row: CashAccount) -> tuple:
    statement_end = _iso_to_date(getattr(row, "statement_end_date", None))
    created_at = getattr(row, "created_at", None)
    return (
        statement_end or date.min,
        created_at or datetime.min,
        getattr(row, "id", 0) or 0,
    )


def _cash_account_group_key(row: CashAccount) -> str:
    institution = _norm_text(getattr(row, "institution", None))
    label = _norm_text(getattr(row, "account_label", None))
    account_name = _norm_text(getattr(row, "account_name", None))
    last4 = (getattr(row, "account_last4", None) or "").strip()

    # Imported bank snapshots can represent a combined checking+savings statement.
    # Group by the most stable source-level identifiers we have, then keep the latest row.
    if account_name or last4:
        return "|".join([institution, label, account_name, last4])
    return "|".join([institution, label or "imported-cash"])


def _latest_imported_cash_rows(db: Session, user_id: str) -> list[CashAccount]:
    rows = (
        db.query(CashAccount)
        .filter(CashAccount.user_id == user_id)
        .order_by(CashAccount.created_at.desc(), CashAccount.id.desc())
        .all()
    )
    latest_by_key: dict[str, CashAccount] = {}
    for row in rows:
        key = _cash_account_group_key(row)
        current = latest_by_key.get(key)
        if current is None or _cash_account_sort_value(row) > _cash_account_sort_value(current):
            latest_by_key[key] = row
    return list(latest_by_key.values())


def _imported_cash_total_latest(db: Session, user_id: str) -> Optional[float]:
    rows = _latest_imported_cash_rows(db, user_id)
    if not rows:
        return None
    total = sum(_cash_account_row_total(row) for row in rows)
    return round(float(total), 2)


def _sum_account_balances(rows: list[dict], field: str) -> float:
    return round(sum(_to_float(row.get(field), 0.0) for row in rows), 2)


def _build_financial_os_breakdown(
    *,
    cash_total: float,
    cash_sources: dict,
    upcoming_summary: dict,
    upcoming_total: float,
    buffer: float,
    final_safe_to_spend: float,
) -> dict:
    duplicates = cash_sources.get("plaid_duplicate_accounts_skipped") or []
    return {
        "total_cash": round(float(cash_total), 2),
        "pdf_cash": round(_to_float(cash_sources.get("pdf_cash_total"), 0.0), 2),
        "plaid_cash_counted": round(_to_float(cash_sources.get("plaid_cash_total"), 0.0), 2),
        "duplicates_skipped": len(duplicates),
        "duplicates_skipped_balance": _sum_account_balances(duplicates, "current_balance"),
        "upcoming_total": round(float(upcoming_total), 2),
        "upcoming_bills_total": round(_to_float(upcoming_summary.get("bill_total"), 0.0), 2),
        "manual_obligations_total": round(_to_float(upcoming_summary.get("manual_bill_total"), 0.0), 2),
        "bills_manual_obligations_total": round(
            _to_float(upcoming_summary.get("bill_total"), 0.0) + _to_float(upcoming_summary.get("manual_bill_total"), 0.0),
            2,
        ),
        "debt_minimums_total": round(_to_float(upcoming_summary.get("debt_minimum_total"), 0.0), 2),
        "protected_obligations_total": round(float(upcoming_total), 2),
        "buffer": round(float(buffer), 2),
        "final_safe_to_spend": round(float(final_safe_to_spend), 2),
    }


def _resolve_schedule_due_date(
    *,
    frequency: Optional[str],
    due_day: Optional[int] = None,
    due_date_value: Optional[str] = None,
    created_at: Optional[datetime] = None,
    today: Optional[date] = None,
):
    """
    Resolve the next due date for recurring bills/manual obligations.
    If a stored ISO due date is stale, fall back to cadence math instead of
    silently excluding the obligation from planning.
    """
    today = today or date.today()
    freq = (frequency or "monthly").strip().lower()
    parsed_due = _iso_to_date(due_date_value) if due_date_value else None

    if freq in ("once", "one_time"):
        return parsed_due if parsed_due and parsed_due >= today else None

    if parsed_due and parsed_due >= today:
        return parsed_due

    anchor = parsed_due
    try:
        if not anchor and created_at:
            anchor = created_at.date()
    except Exception:
        anchor = None

    if freq in ("weekly", "biweekly"):
        if not anchor:
            return None
        step_days = 7 if freq == "weekly" else 14
        if anchor >= today:
            return anchor
        delta_days = (today - anchor).days
        jumps = delta_days // step_days
        candidate = anchor + timedelta(days=jumps * step_days)
        if candidate < today:
            candidate = candidate + timedelta(days=step_days)
        return candidate

    if freq in ("monthly", "quarterly", "yearly", "annual"):
        step_months = 1
        if freq == "quarterly":
            step_months = 3
        elif freq in ("yearly", "annual"):
            step_months = 12

        day = due_day
        if not day and parsed_due:
            day = parsed_due.day
        if not day and anchor:
            day = anchor.day
        if not day:
            return None

        start_year = today.year
        start_month = today.month
        for i in range(0, 24):
            month_value = start_month + i
            year_value = start_year + (month_value - 1) // 12
            month_mod = ((month_value - 1) % 12) + 1
            last_day = monthrange(year_value, month_mod)[1]
            candidate = date(year_value, month_mod, min(int(day), last_day))
            if candidate < today:
                continue
            if step_months == 1 or not anchor:
                return candidate
            months_diff = (candidate.year - anchor.year) * 12 + (candidate.month - anchor.month)
            if months_diff % step_months == 0:
                return candidate
        return None

    return parsed_due


def _plaid_cash_sources_payload(db: Session, user_id: str, cash_total: Optional[float] = None) -> dict:
    cash_breakdown = _plaid_cash_breakdown(db, user_id)
    plaid_cash_total = round(float(cash_breakdown["included_total"]), 2)
    pdf_cash_total = _pdf_cash_total_latest(db, user_id)

    return {
        "pdf_cash_total": pdf_cash_total,
        "plaid_cash_total": plaid_cash_total,
        "plaid_accounts_included": [
            _serialize_plaid_cash_source_account(row) for row in cash_breakdown["included"]
        ],
        "plaid_duplicate_accounts_skipped": [
            {
                "account_id": row.plaid_account_id,
                "name": row.name,
                "mask": row.mask,
                "institution_name": row.institution_name or (row.item.institution_name if row.item else None),
                "current_balance": round(_to_float(row.current_balance, 0.0), 2),
                "available_balance": row.available_balance,
                "last_balance_sync_at": row.last_balance_sync_at.isoformat() if row.last_balance_sync_at else None,
            }
            for row in cash_breakdown["skipped"]
        ],
    }


def _plaid_sync_window(start_date: Optional[date], end_date: Optional[date], lookback_days: int) -> tuple[date, date]:
    today = datetime.utcnow().date()
    safe_lookback = max(1, min(int(lookback_days or 30), 365))
    end_value = end_date or today
    start_value = start_date or (today - timedelta(days=safe_lookback))
    return start_value, end_value


def _serialize_plaid_account(row: PlaidAccount) -> dict:
    return {
        "id": row.id,
        "account_id": row.plaid_account_id,
        "item_id": row.item.plaid_item_id if row.item else None,
        "institution_name": row.institution_name or (row.item.institution_name if row.item else None),
        "name": row.name,
        "official_name": row.official_name,
        "mask": row.mask,
        "type": row.type,
        "subtype": row.subtype,
        "current_balance": row.current_balance,
        "available_balance": row.available_balance,
        "iso_currency_code": row.iso_currency_code,
        "unofficial_currency_code": row.unofficial_currency_code,
        "is_cash_like": bool(row.is_cash_like),
        "is_liability": bool(row.is_liability),
        "sync_status": row.sync_status,
        "last_synced_at": row.last_synced_at.isoformat() if row.last_synced_at else None,
        "last_balance_sync_at": row.last_balance_sync_at.isoformat() if row.last_balance_sync_at else None,
    }


def _serialize_plaid_transaction(row: PlaidTransaction) -> dict:
    return {
        "id": row.id,
        "transaction_id": row.plaid_transaction_id,
        "account_id": row.account.plaid_account_id if row.account else None,
        "item_id": row.item.plaid_item_id if row.item else None,
        "account_name": row.account.name if row.account else None,
        "account_mask": row.account.mask if row.account else None,
        "institution_name": (
            row.account.institution_name
            if row.account and row.account.institution_name
            else (row.item.institution_name if row.item else None)
        ),
        "posted_date": row.posted_date,
        "authorized_date": row.authorized_date,
        "name": row.name,
        "merchant_name": row.merchant_name,
        "amount": row.amount,
        "iso_currency_code": row.iso_currency_code,
        "unofficial_currency_code": row.unofficial_currency_code,
        "pending": bool(row.pending),
        "payment_channel": row.payment_channel,
        "category_primary": row.category_primary,
        "category_detailed": row.category_detailed,
    }


def _summarize_sync_exception(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        detail = exc.detail
        return detail if isinstance(detail, str) and detail.strip() else "Plaid sync failed."
    return str(exc) or "Plaid sync failed."


def _recent_plaid_transactions_for_item(db: Session, item_row: PlaidItem, limit: int = 25) -> list[dict]:
    rows = (
        db.query(PlaidTransaction)
        .join(PlaidAccount, PlaidTransaction.plaid_account_id == PlaidAccount.id)
        .filter(PlaidTransaction.plaid_item_id == item_row.id)
        .order_by(PlaidTransaction.posted_date.desc(), PlaidTransaction.id.desc())
        .limit(max(1, min(int(limit or 25), 100)))
        .all()
    )
    return [_serialize_plaid_transaction(row) for row in rows]


def _fetch_plaid_transactions(db: Session, client, sdk, item_row: PlaidItem, start_date: date, end_date: date) -> tuple[list[dict], dict]:
    page_size = 500
    offset = 0
    transactions: list[dict] = []
    page_count = 0
    total_transactions = 0

    while True:
        options = sdk["TransactionsGetRequestOptions"](count=page_size, offset=offset)
        request = sdk["TransactionsGetRequest"](
            access_token=_get_plaid_access_token(item_row, db),
            start_date=start_date,
            end_date=end_date,
            options=options,
        )
        response = _plaid_to_dict(client.transactions_get(request))
        batch = [_plaid_to_dict(txn) for txn in response.get("transactions", [])]
        page_count += 1
        transactions.extend(batch)

        total_transactions = int(response.get("total_transactions") or len(transactions))
        _plaid_log(
            "transactions_page",
            item_id=item_row.plaid_item_id,
            page=page_count,
            offset=offset,
            batch_count=len(batch),
            total_transactions=total_transactions,
        )
        offset += len(batch)
        if not batch or offset >= total_transactions:
            break

    meta = {
        "page_count": page_count,
        "returned_count": len(transactions),
        "reported_total_transactions": total_transactions,
    }
    _plaid_log("transactions_fetch_complete", item_id=item_row.plaid_item_id, **meta)
    return transactions, meta


def _sync_plaid_item_resilient(
    db: Session,
    client,
    sdk,
    item_row: PlaidItem,
    start_date: date,
    end_date: date,
    include_transactions: bool = True,
) -> dict:
    warnings = []
    synced_at = _plaid_now()
    account_rows = []
    synced_transactions = 0

    try:
        account_rows = _sync_plaid_accounts_for_item(db, client, sdk, item_row, update_balances=True)
    except Exception as exc:
        message = _summarize_sync_exception(exc)
        item_row.status = "error"
        item_row.last_sync_error = message
        item_row.updated_at = synced_at
        db.flush()
        warnings.append(f"Accounts sync failed for {item_row.institution_name or item_row.plaid_item_id}: {message}")

    if include_transactions:
        if account_rows:
            try:
                synced_transactions = _sync_plaid_transactions_for_item(db, client, sdk, item_row, start_date, end_date)
            except Exception as exc:
                message = _summarize_sync_exception(exc)
                item_row.status = "partial"
                item_row.last_sync_error = message
                item_row.updated_at = synced_at
                db.flush()
                warnings.append(f"Transaction sync failed for {item_row.institution_name or item_row.plaid_item_id}: {message}")
        else:
            warnings.append(
                f"Transaction sync skipped for {item_row.institution_name or item_row.plaid_item_id} because no Plaid accounts were available."
            )

    db.flush()
    db.refresh(item_row)

    refreshed_accounts = (
        db.query(PlaidAccount)
        .filter(PlaidAccount.plaid_item_id == item_row.id)
        .order_by(PlaidAccount.is_cash_like.desc(), PlaidAccount.name.asc(), PlaidAccount.id.asc())
        .all()
    )
    last_sync_at = max(
        [dt for dt in [item_row.last_accounts_sync_at, item_row.last_balances_sync_at, item_row.last_transactions_sync_at] if dt],
        default=None,
    )

    return {
        "item_id": item_row.plaid_item_id,
        "institution_name": item_row.institution_name,
        "sync_status": item_row.status,
        "last_sync_at": last_sync_at.isoformat() if last_sync_at else None,
        "last_accounts_sync_at": item_row.last_accounts_sync_at.isoformat() if item_row.last_accounts_sync_at else None,
        "last_balances_sync_at": item_row.last_balances_sync_at.isoformat() if item_row.last_balances_sync_at else None,
        "last_transactions_sync_at": item_row.last_transactions_sync_at.isoformat() if item_row.last_transactions_sync_at else None,
        "last_sync_error": item_row.last_sync_error,
        "accounts_synced": len(account_rows),
        "transactions_synced": synced_transactions,
        "accounts": [_serialize_plaid_account(row) for row in refreshed_accounts],
        "recent_transactions": _recent_plaid_transactions_for_item(db, item_row),
        "warnings": warnings,
    }


def _upsert_plaid_account(
    db: Session,
    item_row: PlaidItem,
    account_payload: dict,
    synced_at: datetime,
) -> PlaidAccount:
    plaid_account_id = account_payload.get("account_id")
    if not plaid_account_id:
        raise HTTPException(status_code=502, detail="Plaid account payload missing account_id.")

    row = (
        db.query(PlaidAccount)
        .filter(PlaidAccount.plaid_account_id == plaid_account_id)
        .one_or_none()
    )
    if row is not None:
        _plaid_assert_user_ownership("Plaid account", row.user_id, item_row.user_id, plaid_account_id)
    if row is None:
        row = _plaid_find_existing_account_candidate(db, item_row, account_payload)
    if row is None:
        row = PlaidAccount(
            user_id=item_row.user_id,
            plaid_item_id=item_row.id,
            plaid_account_id=plaid_account_id,
            created_at=synced_at,
        )
        db.add(row)

    balances = _plaid_to_dict(account_payload.get("balances") or {})
    account_type = account_payload.get("type")
    subtype = account_payload.get("subtype")

    row.user_id = item_row.user_id
    row.plaid_item_id = item_row.id
    row.plaid_account_id = plaid_account_id
    row.institution_name = item_row.institution_name
    row.name = account_payload.get("name") or row.name or "Plaid account"
    row.official_name = account_payload.get("official_name")
    row.mask = account_payload.get("mask")
    row.type = account_type
    row.subtype = subtype
    row.current_balance = balances.get("current")
    row.available_balance = balances.get("available")
    row.iso_currency_code = balances.get("iso_currency_code")
    row.unofficial_currency_code = balances.get("unofficial_currency_code")
    row.is_cash_like = _plaid_is_cash_like(account_type, subtype)
    row.is_liability = _plaid_is_liability(account_type, subtype)
    row.sync_status = "synced"
    row.last_synced_at = synced_at
    row.last_balance_sync_at = synced_at
    row.updated_at = synced_at
    return row


def _sync_plaid_accounts_for_item(
    db: Session,
    client,
    sdk,
    item_row: PlaidItem,
    update_balances: bool = True,
) -> list[PlaidAccount]:
    synced_at = _plaid_now()
    try:
        accounts_request = sdk["AccountsGetRequest"](access_token=_get_plaid_access_token(item_row, db))
        accounts_response = _plaid_to_dict(client.accounts_get(accounts_request))
    except sdk["plaid"].ApiException as exc:
        item_row.status = "error"
        item_row.last_sync_error = str(getattr(exc, "body", None) or exc)
        item_row.updated_at = synced_at
        db.flush()
        _raise_plaid_http_error(exc)

    rows = []
    for account in accounts_response.get("accounts", []):
        account_data = _plaid_to_dict(account)
        rows.append(_upsert_plaid_account(db, item_row, account_data, synced_at))

    item_data = _plaid_to_dict(accounts_response.get("item") or {})
    item_row.status = "linked"
    item_row.last_sync_error = None
    item_row.available_products_json = json.dumps(accounts_response.get("available_products") or [])
    item_row.billed_products_json = json.dumps(accounts_response.get("billed_products") or [])
    item_row.consent_expiration_time = item_data.get("consent_expiration_time")
    item_row.last_accounts_sync_at = synced_at
    if update_balances:
        item_row.last_balances_sync_at = synced_at
    item_row.updated_at = synced_at
    _plaid_mark_duplicate_accounts_superseded(db, item_row.user_id, synced_at)
    db.flush()
    return rows


def _sync_plaid_transactions_for_item(
    db: Session,
    client,
    sdk,
    item_row: PlaidItem,
    start_date: date,
    end_date: date,
) -> int:
    synced_at = _plaid_now()
    fetch_meta = {}
    try:
        transactions, fetch_meta = _fetch_plaid_transactions(db, client, sdk, item_row, start_date, end_date)
    except sdk["plaid"].ApiException as exc:
        item_row.status = "error"
        item_row.last_sync_error = str(getattr(exc, "body", None) or exc)
        item_row.updated_at = synced_at
        db.flush()
        _raise_plaid_http_error(exc)

    account_map = {
        row.plaid_account_id: row
        for row in db.query(PlaidAccount).filter(PlaidAccount.plaid_item_id == item_row.id).all()
    }

    synced = 0
    inserted = 0
    updated = 0
    skipped_missing_account = 0
    skipped_missing_transaction_id = 0
    for txn_data in transactions:
        account_row = account_map.get(txn_data.get("account_id"))
        if account_row is None:
            skipped_missing_account += 1
            continue

        plaid_transaction_id = txn_data.get("transaction_id")
        if not plaid_transaction_id:
            skipped_missing_transaction_id += 1
            continue

        row = (
            db.query(PlaidTransaction)
            .filter(PlaidTransaction.plaid_transaction_id == plaid_transaction_id)
            .one_or_none()
        )
        if row is not None:
            _plaid_assert_user_ownership("Plaid transaction", row.user_id, item_row.user_id, plaid_transaction_id)
            updated += 1
        if row is None:
            row = PlaidTransaction(
                user_id=item_row.user_id,
                plaid_item_id=item_row.id,
                plaid_account_id=account_row.id,
                plaid_transaction_id=plaid_transaction_id,
                created_at=synced_at,
            )
            db.add(row)
            inserted += 1

        categories = txn_data.get("personal_finance_category") or {}
        if not isinstance(categories, dict):
            categories = _plaid_to_dict(categories)

        row.user_id = item_row.user_id
        row.plaid_item_id = item_row.id
        row.plaid_account_id = account_row.id
        row.posted_date = txn_data.get("date")
        row.authorized_date = txn_data.get("authorized_date")
        row.name = txn_data.get("name")
        row.merchant_name = txn_data.get("merchant_name")
        row.amount = txn_data.get("amount")
        row.iso_currency_code = txn_data.get("iso_currency_code")
        row.unofficial_currency_code = txn_data.get("unofficial_currency_code")
        row.pending = bool(txn_data.get("pending"))
        row.payment_channel = txn_data.get("payment_channel")
        row.category_primary = categories.get("primary")
        row.category_detailed = categories.get("detailed")
        row.raw_json = json.dumps(
            txn_data,
            default=lambda value: value.isoformat() if isinstance(value, (date, datetime)) else str(value),
        )
        row.updated_at = synced_at
        synced += 1

    item_row.status = "linked"
    item_row.last_sync_error = None
    item_row.last_transactions_sync_at = synced_at
    item_row.updated_at = synced_at
    _plaid_mark_duplicate_accounts_superseded(db, item_row.user_id, synced_at)
    db.flush()
    db_count = (
        db.query(func.count(PlaidTransaction.id))
        .filter(PlaidTransaction.user_id == item_row.user_id, PlaidTransaction.plaid_item_id == item_row.id)
        .scalar()
        or 0
    )
    _plaid_log(
        "transactions_db_flush",
        item_id=item_row.plaid_item_id,
        returned_count=fetch_meta.get("returned_count"),
        reported_total_transactions=fetch_meta.get("reported_total_transactions"),
        page_count=fetch_meta.get("page_count"),
        inserted_count=inserted,
        updated_count=updated,
        upserted_count=synced,
        skipped_missing_account=skipped_missing_account,
        skipped_missing_transaction_id=skipped_missing_transaction_id,
        db_count_for_item=int(db_count),
    )
    return synced


@app.post("/plaid/link-token")
def create_plaid_link_token(
    payload: PlaidLinkTokenIn,
    current_user: User = Depends(require_current_user),
):
    _require_plaid_encryption_ready()
    client, sdk = _get_plaid_client()
    user_id = _coerce_user_id(current_user, payload.user_id)

    products = [sdk["Products"](value) for value in _plaid_products()]
    country_codes = [sdk["CountryCode"](value) for value in _plaid_country_codes()]

    request_kwargs = {
        "user": sdk["LinkTokenCreateRequestUser"](client_user_id=user_id),
        "client_name": "Accountant Bot",
        "products": products,
        "country_codes": country_codes,
        "language": "en",
    }

    redirect_uri = (os.getenv("PLAID_REDIRECT_URI") or "").strip()
    webhook_url = (os.getenv("PLAID_WEBHOOK_URL") or "").strip()
    if redirect_uri:
        request_kwargs["redirect_uri"] = redirect_uri
    if webhook_url:
        request_kwargs["webhook"] = webhook_url

    try:
        request = sdk["LinkTokenCreateRequest"](**request_kwargs)
        response = _plaid_to_dict(client.link_token_create(request))
    except sdk["plaid"].ApiException as exc:
        _raise_plaid_http_error(exc)

    return {
        "link_token": response["link_token"],
        "expiration": response.get("expiration"),
        "request_id": response.get("request_id"),
    }


@app.post("/plaid/exchange-public-token")
def exchange_plaid_public_token(
    payload: PlaidPublicTokenExchangeIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    _require_plaid_encryption_ready()
    client, sdk = _get_plaid_client()
    user_id = _coerce_user_id(current_user, payload.user_id)

    try:
        exchange_request = sdk["ItemPublicTokenExchangeRequest"](
            public_token=payload.public_token,
        )
        exchange_response = _plaid_to_dict(client.item_public_token_exchange(exchange_request))
    except sdk["plaid"].ApiException as exc:
        _raise_plaid_http_error(exc)

    synced_at = _plaid_now()
    plaid_item_id = exchange_response.get("item_id")
    access_token = exchange_response.get("access_token")
    if not plaid_item_id or not access_token:
        raise HTTPException(status_code=502, detail="Plaid exchange response was missing item data.")

    item_row = (
        db.query(PlaidItem)
        .filter(PlaidItem.plaid_item_id == plaid_item_id)
        .one_or_none()
    )
    if item_row is not None:
        _plaid_assert_user_ownership("Plaid item", item_row.user_id, user_id, plaid_item_id)
    if item_row is None:
        item_row = _plaid_find_existing_item_candidate(db, user_id, payload.institution_name)
    if item_row is None:
        item_row = PlaidItem(
            user_id=user_id,
            plaid_item_id=plaid_item_id,
            created_at=synced_at,
        )
        db.add(item_row)

    item_row.user_id = user_id
    item_row.institution_name = payload.institution_name
    item_row.access_token = ""
    item_row.access_token_encrypted = encrypt_secret(access_token)
    item_row.status = "linked"
    item_row.last_sync_error = None
    item_row.updated_at = synced_at
    db.flush()
    _plaid_merge_duplicate_items(db, item_row, synced_at)

    db.commit()
    db.refresh(item_row)
    _plaid_log(
        "exchange_initial_commit_success",
        item_id=item_row.plaid_item_id,
        table_counts_for_user=_plaid_table_counts(db, user_id),
    )

    start_date, end_date = _plaid_sync_window(None, None, 30)
    sync_result = _sync_plaid_item_resilient(
        db,
        client,
        sdk,
        item_row,
        start_date,
        end_date,
        include_transactions=True,
    )
    db.commit()
    db.refresh(item_row)
    table_counts = _plaid_table_counts(db, user_id)
    _plaid_log(
        "exchange_sync_commit_success",
        item_id=item_row.plaid_item_id,
        transactions_synced=sync_result["transactions_synced"],
        table_counts_for_user=table_counts,
    )

    return {
        "ok": True,
        "item_id": item_row.plaid_item_id,
        "request_id": exchange_response.get("request_id"),
        "institution_name": item_row.institution_name,
        "accounts": sync_result["accounts"],
        "persisted": True,
        "recent_transactions": sync_result["recent_transactions"],
        "synced_transactions": sync_result["transactions_synced"],
        "sync_status": sync_result["sync_status"],
        "sync_warning": "; ".join(sync_result["warnings"]) if sync_result["warnings"] else None,
        "last_sync_at": sync_result["last_sync_at"],
        "last_accounts_sync_at": sync_result["last_accounts_sync_at"],
        "last_balances_sync_at": sync_result["last_balances_sync_at"],
        "last_transactions_sync_at": sync_result["last_transactions_sync_at"],
        "table_counts_for_user": table_counts,
    }


@app.get("/plaid/accounts")
def list_plaid_accounts(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    rows = (
        db.query(PlaidAccount)
        .join(PlaidItem, PlaidAccount.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidAccount.user_id == user_id,
            PlaidItem.user_id == user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
            or_(PlaidAccount.sync_status != "superseded", PlaidAccount.sync_status.is_(None)),
        )
        .order_by(PlaidAccount.is_cash_like.desc(), PlaidAccount.institution_name.asc(), PlaidAccount.name.asc())
        .all()
    )
    rows, _ = _plaid_select_canonical_accounts(rows)
    items = _plaid_sync_item_query(db, user_id).order_by(PlaidItem.created_at.desc(), PlaidItem.id.desc()).all()
    items, _ = _plaid_select_canonical_items(items)
    return {
        "ok": True,
        "user_id": user_id,
        "accounts": [_serialize_plaid_account(row) for row in rows],
        "items": [
            {
                "item_id": item.plaid_item_id,
                "institution_name": item.institution_name,
                "status": item.status,
                "last_accounts_sync_at": item.last_accounts_sync_at.isoformat() if item.last_accounts_sync_at else None,
                "last_balances_sync_at": item.last_balances_sync_at.isoformat() if item.last_balances_sync_at else None,
                "last_transactions_sync_at": item.last_transactions_sync_at.isoformat() if item.last_transactions_sync_at else None,
                "last_sync_error": item.last_sync_error,
            }
            for item in items
        ],
    }


@app.post("/plaid/sync")
def sync_plaid_data(
    payload: PlaidSyncIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    _require_plaid_encryption_ready()
    client, sdk = _get_plaid_client()
    user_id = _coerce_user_id(current_user, payload.user_id)
    start_date, end_date = _plaid_sync_window(payload.start_date, payload.end_date, payload.lookback_days)

    items = _plaid_sync_item_query(db, user_id).order_by(PlaidItem.created_at.asc(), PlaidItem.id.asc()).all()
    if not items:
        raise HTTPException(status_code=404, detail="No Plaid-linked items found for this user.")

    synced_accounts = []
    total_transactions = 0
    item_results = []
    warnings = []
    for item_row in items:
        result = _sync_plaid_item_resilient(db, client, sdk, item_row, start_date, end_date, include_transactions=True)
        item_results.append(result)
        synced_accounts.extend(result["accounts"])
        total_transactions += int(result["transactions_synced"] or 0)
        warnings.extend(result["warnings"])

    db.commit()
    table_counts = _plaid_table_counts(db, user_id)
    _plaid_log(
        "sync_commit_success",
        user_id=user_id,
        items_synced=len(items),
        accounts_synced=len(synced_accounts),
        transactions_synced=total_transactions,
        table_counts_for_user=table_counts,
    )
    return {
        "ok": True,
        "user_id": user_id,
        "items_synced": len(items),
        "accounts_synced": len(synced_accounts),
        "transactions_synced": total_transactions,
        "start_date": start_date,
        "end_date": end_date,
        "item_results": item_results,
        "warnings": warnings,
        "last_sync_at": max((result["last_sync_at"] for result in item_results if result.get("last_sync_at")), default=None),
        "table_counts_for_user": table_counts,
    }


@app.post("/plaid/sync/balances")
def sync_plaid_balances(
    payload: PlaidSyncIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    _require_plaid_encryption_ready()
    client, sdk = _get_plaid_client()
    user_id = _coerce_user_id(current_user, payload.user_id)
    items = _plaid_sync_item_query(db, user_id).order_by(PlaidItem.created_at.asc(), PlaidItem.id.asc()).all()
    if not items:
        raise HTTPException(status_code=404, detail="No Plaid-linked items found for this user.")

    synced_accounts = []
    for item_row in items:
        synced_accounts.extend(_sync_plaid_accounts_for_item(db, client, sdk, item_row, update_balances=True))

    db.commit()
    return {
        "ok": True,
        "user_id": user_id,
        "items_synced": len(items),
        "accounts_synced": len(synced_accounts),
        "balances": [_serialize_plaid_account(row) for row in synced_accounts],
    }


@app.post("/plaid/sync/transactions")
def sync_plaid_transactions(
    payload: PlaidSyncIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    _require_plaid_encryption_ready()
    client, sdk = _get_plaid_client()
    user_id = _coerce_user_id(current_user, payload.user_id)
    start_date, end_date = _plaid_sync_window(payload.start_date, payload.end_date, payload.lookback_days)
    items = _plaid_sync_item_query(db, user_id).order_by(PlaidItem.created_at.asc(), PlaidItem.id.asc()).all()
    if not items:
        raise HTTPException(status_code=404, detail="No Plaid-linked items found for this user.")

    total_transactions = 0
    for item_row in items:
        total_transactions += _sync_plaid_transactions_for_item(db, client, sdk, item_row, start_date, end_date)

    db.commit()
    table_counts = _plaid_table_counts(db, user_id)
    _plaid_log(
        "transactions_commit_success",
        user_id=user_id,
        items_synced=len(items),
        transactions_synced=total_transactions,
        table_counts_for_user=table_counts,
    )
    return {
        "ok": True,
        "user_id": user_id,
        "items_synced": len(items),
        "transactions_synced": total_transactions,
        "start_date": start_date,
        "end_date": end_date,
        "table_counts_for_user": table_counts,
    }


@app.get("/plaid/transactions")
def list_plaid_transactions(
    user_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 200,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    q = (
        db.query(PlaidTransaction)
        .join(PlaidAccount, PlaidTransaction.plaid_account_id == PlaidAccount.id)
        .join(PlaidItem, PlaidTransaction.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidTransaction.user_id == user_id,
            PlaidAccount.user_id == user_id,
            PlaidItem.user_id == user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
            or_(PlaidAccount.sync_status != "superseded", PlaidAccount.sync_status.is_(None)),
        )
    )
    if start_date:
        q = q.filter(PlaidTransaction.posted_date >= start_date)
    if end_date:
        q = q.filter(PlaidTransaction.posted_date <= end_date)

    rows = (
        q.order_by(PlaidTransaction.posted_date.desc(), PlaidTransaction.id.desc())
        .limit(max(1, min(int(limit or 200), 1000)))
        .all()
    )
    return {
        "ok": True,
        "user_id": user_id,
        "transactions": [_serialize_plaid_transaction(row) for row in rows],
    }


def _match_category_from_rules(db, user_id: str, description: str):
    if not description:
        return None

    rules = db.query(Rule).filter(Rule.user_id == user_id).all()  # assumes you have Rule model/table
    desc_lower = description.lower()

    for r in rules:
        # if your rule uses "contains"
        if r.match_text and r.match_text.lower() in desc_lower:
            return r.category

    return None


def _apply_rules_for_category(db, user_id: str, description: str):
    """
    If you already have a Rules table/model in your project, use it here.
    If no rules match, fallback is keyword-based.
    """
    desc = (description or "").lower()

    # --- Fallback keywords (works even if rules table is empty) ---
    if "walmart" in desc or "aldi" in desc or "kroger" in desc:
        return "Groceries"
    if "shell" in desc or "chevron" in desc or "bp " in desc or "gas" in desc:
        return "Fuel"
    if "roadhouse" in desc or "restaurant" in desc or "grill" in desc:
        return "Dining"

    return None



from fastapi import File, UploadFile, HTTPException
from datetime import datetime
import os
import tempfile

import hashlib
import tempfile
import os
from datetime import datetime
from fastapi import UploadFile, File

# --- put these imports near top of api.py (dedupe if already there) ---
import hashlib
import re
from datetime import datetime
from fastapi import UploadFile, File
import tempfile
import os

from capitalone_parser import parse_capitalone_pdf
from db import SessionLocal
from models import Statement, Transaction
# -----------------------------
# Helpers (Fingerprint + Code)
# -----------------------------
_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
}

def _clean_label(label: str) -> str:
    s = (label or "").upper().strip()
    s = re.sub(r"[^A-Z0-9]+", "", s)
    return s[:16] if s else "CARD"

def _extract_end_date_iso(statement_period: str) -> str:
    """
    statement_period like: "Dec 09, 2025 to Jan 08, 2026"
    returns "2026-01-08" if possible, else ""
    """
    if not statement_period:
        return ""
    m = re.findall(r"\b([A-Za-z]{3})\s+(\d{1,2}),\s*(20\d{2})\b", statement_period)
    if not m:
        return ""
    mon_str, dd_str, yyyy_str = m[-1]
    mon = _MONTHS.get(mon_str.lower())
    if not mon:
        return ""
    try:
        dt = datetime(int(yyyy_str), mon, int(dd_str))
        return dt.date().isoformat()
    except Exception:
        return ""

def make_statement_code(account_label: str, statement_period: str, fingerprint: str) -> str:
    end_iso = _extract_end_date_iso(statement_period)
    yyyymm = "UNKNOWN"
    if end_iso:
        yyyymm = end_iso[:7].replace("-", "")  # YYYYMM

    short = (fingerprint or "")
    short = re.sub(r"[^a-fA-F0-9]", "", short)[:6].upper()
    if not short:
        seed = f"{account_label}|{statement_period}|{yyyymm}"
        short = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:6].upper()

    return f"CO-{_clean_label(account_label)}-{yyyymm}-{short}"

def make_fingerprint_v3(user_id: str, account_label: str, parsed: dict) -> str:
    """
    Strong fingerprint:
      user + issuer + card_last4 + statement_end + new_balance + tx_count + tx_total
    This ensures a new month won't collide even if a field extraction fails.
    """
    card_last4 = (parsed.get("card_last4") or "").strip()
    statement_period = (parsed.get("statement_period") or "").strip()
    stmt_end = _extract_end_date_iso(statement_period)

    new_balance = parsed.get("new_balance")
    try:
        nb = f"{float(new_balance):.2f}"
    except Exception:
        nb = ""

    txns = parsed.get("transactions") or []
    tx_count = len(txns)

    tx_total = 0.0
    for t in txns:
        try:
            tx_total += float(t.get("amount") or 0.0)
        except Exception:
            pass

    base = "|".join([
        "v3",
        str(user_id).strip(),
        str(account_label).strip().lower(),
        card_last4,
        stmt_end,
        nb,
        str(tx_count),
        f"{tx_total:.2f}",
    ])

    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:12].upper()


@app.post("/upload/capitalone-pdf")
def upload_capitalone_pdf(
    file: UploadFile = File(...),
    user_id: Optional[str] = None,
    account_label: str = "CapitalOne",
    import_txns: bool = True,
    replace: bool = False,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    tmp_path = None

    try:
        # 1) Save uploaded PDF to temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(file.file.read())
            tmp_path = tmp.name

        # 2) Parse PDF
        parsed = parse_capitalone_pdf(tmp_path)
        parsed["filename"] = file.filename

        # 3) Cleanup temp file
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        tmp_path = None

        # 4) Fingerprint / dedupe (FORCE V3)
        fingerprint = make_fingerprint_v3(user_id, account_label, parsed)
        parsed["fingerprint"] = fingerprint

        existing = db.query(Statement).filter(
            Statement.user_id == user_id,
            Statement.account_label == account_label,
            Statement.fingerprint == fingerprint
        ).first()

        # If already exists and not replacing → return early
        if existing and not replace:
            return {
                "ok": True,
                "already_exists": True,
                "statement_id": existing.id,
                "statement_code": existing.statement_code,
                "imported_txns": 0,
                "meta": {
                    "filename": existing.filename,
                    "statement_period": existing.statement_period,
                    "due_date": existing.due_date,
                    "minimum_payment": existing.minimum_payment,
                    "new_balance": existing.new_balance,
                    "interest_charged": existing.interest_charged,
                    "apr": existing.apr,
                    "card_name": existing.card_name,
                    "card_last4": existing.card_last4,
                    "fingerprint": existing.fingerprint,
                }
            }

        already_exists = False

        # Replace: update same Statement row (no new ID)
        if existing and replace:
            already_exists = True

            # delete old transactions for that statement
            db.query(Transaction).filter(
                Transaction.statement_id == existing.id
            ).delete(synchronize_session=False)
            db.commit()

            stmt = existing
        else:
            stmt = Statement(user_id=user_id)
            db.add(stmt)

        # 5) Update fields
        stmt.user_id = user_id
        stmt.account_label = account_label
        stmt.card_name = parsed.get("card_name")
        stmt.card_last4 = parsed.get("card_last4")
        stmt.statement_period = parsed.get("statement_period")
        stmt.due_date = parsed.get("due_date")
        stmt.minimum_payment = parsed.get("minimum_payment")
        stmt.new_balance = parsed.get("new_balance")
        stmt.interest_charged = parsed.get("interest_charged")
        stmt.apr = parsed.get("apr")
        stmt.filename = parsed.get("filename")
        stmt.fingerprint = fingerprint

        # statement_code stable (generate only once)
        if not getattr(stmt, "statement_code", None):
            stmt.statement_code = make_statement_code(account_label, stmt.statement_period or "", fingerprint)

        # created_at stable (set only once)
        if not getattr(stmt, "created_at", None):
            stmt.created_at = datetime.utcnow()

        db.commit()
        db.refresh(stmt)

        imported = 0

        # 6) Import transactions
        if import_txns:
            for tx in parsed.get("transactions", []):
                t = Transaction(
                    statement_id=stmt.id,
                    posted_date=tx.get("posted_date"),
                    description=tx.get("description"),
                    amount=tx.get("amount") if tx.get("amount") is not None else 0.0,
                    txn_type=tx.get("txn_type"),
                    category=tx.get("category"),
                )
                db.add(t)
                imported += 1
            db.commit()

        return {
            "ok": True,
            "already_exists": already_exists,
            "statement_id": stmt.id,
            "statement_code": stmt.statement_code,
            "imported_txns": imported,
            "meta": {
                "filename": stmt.filename,
                "statement_period": stmt.statement_period,
                "due_date": stmt.due_date,
                "minimum_payment": stmt.minimum_payment,
                "new_balance": stmt.new_balance,
                "interest_charged": stmt.interest_charged,
                "apr": stmt.apr,
                "card_name": stmt.card_name,
                "card_last4": stmt.card_last4,
                "fingerprint": stmt.fingerprint,
            }
        }

    finally:
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass
        db.close()


import hashlib
from sqlalchemy import text

def ensure_cash_columns():
    """
    If you already have cash tables, ensure new columns exist with additive ALTER TABLE updates.
    If tables don't exist yet, initialize_database() will create them once models are imported.
    """
    ensure_column("cash_accounts", "institution", "institution TEXT")
    ensure_column("cash_accounts", "account_label", "account_label TEXT")
    ensure_column("cash_accounts", "account_last4", "account_last4 TEXT")
    ensure_column("cash_accounts", "account_name", "account_name TEXT")
    ensure_column("cash_accounts", "statement_period", "statement_period TEXT")
    ensure_column("cash_accounts", "statement_end_date", "statement_end_date TEXT")
    ensure_column("cash_accounts", "filename", "filename TEXT")
    ensure_column("cash_accounts", "checking_begin_balance", "checking_begin_balance REAL")
    ensure_column("cash_accounts", "checking_end_balance", "checking_end_balance REAL")
    ensure_column("cash_accounts", "savings_begin_balance", "savings_begin_balance REAL")
    ensure_column("cash_accounts", "savings_end_balance", "savings_end_balance REAL")
    ensure_column("cash_accounts", "fingerprint", "fingerprint TEXT")

    ensure_column("cash_transactions", "txn_type", "txn_type TEXT")
    ensure_column("cash_transactions", "category", "category TEXT")

# ensure once at startup
ensure_cash_columns()


def _extract_end_date_iso_from_period(period: str) -> str:
    """
    "Dec 01, 2025 to Dec 31, 2025" -> "2025-12-31"
    """
    if not period:
        return ""
    m = re.findall(r"\b([A-Za-z]{3})\s+(\d{1,2}),\s*(20\d{2})\b", period)
    if not m:
        return ""
    mon_str, dd_str, yyyy_str = m[-1]
    months = {
        "jan":1,"feb":2,"mar":3,"apr":4,"may":5,"jun":6,
        "jul":7,"aug":8,"sep":9,"oct":10,"nov":11,"dec":12
    }
    mon = months.get(mon_str.lower())
    if not mon:
        return ""
    try:
        return datetime(int(yyyy_str), mon, int(dd_str)).date().isoformat()
    except Exception:
        return ""


def make_cash_fingerprint_v1(user_id: str, account_label: str, parsed: dict) -> str:
    """
    Stable-ish dedupe key for bank statements.
    Uses: user, label, end-date, end balances, tx_count, tx_total.
    """
    period = (parsed.get("statement_period") or "").strip()
    end_iso = _extract_end_date_iso_from_period(period)

    cb = parsed.get("checking_end_balance")
    sb = parsed.get("savings_end_balance")

    txns = parsed.get("transactions") or []
    tx_count = len(txns)

    tx_total = 0.0
    for t in txns:
        try:
            tx_total += float(t.get("amount") or 0.0)
        except Exception:
            pass

    base = "|".join([
        "cash_v1",
        str(user_id).strip(),
        str(account_label).strip().lower(),
        (parsed.get("institution") or "capitalone").strip().lower(),
        (parsed.get("account_last4") or "").strip(),
        end_iso,
        f"{float(cb) if cb is not None else 0.0:.2f}",
        f"{float(sb) if sb is not None else 0.0:.2f}",
        str(tx_count),
        f"{tx_total:.2f}",
    ])
    return hashlib.sha256(base.encode("utf-8")).hexdigest()[:12].upper()


@app.post("/upload/capitalone-bank-pdf")
def upload_capitalone_bank_pdf(
    file: UploadFile = File(...),
    user_id: Optional[str] = None,
    account_label: str = "CapitalOne Bank",
    import_txns: bool = True,
    replace: bool = False,
    current_user: User = Depends(require_current_user),
):
    """
    Upload Capital One bank statement PDF (Checking + Savings balances may be present in same PDF).
    Saves into CashAccount + CashTransaction.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    tmp_path = None

    try:
        # 1) Save uploaded PDF to temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(file.file.read())
            tmp_path = tmp.name

        # 2) Parse PDF (your new parser file)
        parsed = parse_capitalone_bank_pdf(tmp_path)
        parsed["filename"] = file.filename

        # 3) Cleanup temp file
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        tmp_path = None

        # 4) Fingerprint / dedupe
        parsed["institution"] = parsed.get("institution") or "CapitalOne"
        parsed["account_label"] = account_label

        fingerprint = make_cash_fingerprint_v1(user_id, account_label, parsed)
        parsed["fingerprint"] = fingerprint

        existing = db.query(CashAccount).filter(
            CashAccount.user_id == user_id,
            CashAccount.account_label == account_label,
            CashAccount.fingerprint == fingerprint
        ).first()

        # If already exists and not replacing → return early
        if existing and not replace:
            return {
                "ok": True,
                "already_exists": True,
                "cash_account_id": existing.id,
                "imported_txns": 0,
                "meta": {
                    "filename": existing.filename,
                    "institution": existing.institution,
                    "account_label": existing.account_label,
                    "account_name": existing.account_name,
                    "account_last4": existing.account_last4,
                    "statement_period": existing.statement_period,
                    "checking_begin_balance": existing.checking_begin_balance,
                    "checking_end_balance": existing.checking_end_balance,
                    "savings_begin_balance": existing.savings_begin_balance,
                    "savings_end_balance": existing.savings_end_balance,
                    "fingerprint": existing.fingerprint,
                }
            }

        already_exists = False

        # Replace: update same row and delete its txns
        if existing and replace:
            already_exists = True
            db.query(CashTransaction).filter(
                CashTransaction.cash_account_id == existing.id
            ).delete(synchronize_session=False)
            db.commit()
            acc = existing
        else:
            acc = CashAccount(user_id=user_id)
            db.add(acc)

        # 5) Update fields
        acc.user_id = user_id
        acc.institution = parsed.get("institution") or "CapitalOne"
        acc.account_label = account_label
        acc.account_name = parsed.get("account_name")
        acc.account_last4 = parsed.get("account_last4")
        acc.statement_period = parsed.get("statement_period")
        acc.statement_end_date = _extract_end_date_iso_from_period(acc.statement_period or "")
        acc.filename = parsed.get("filename")

        acc.checking_begin_balance = parsed.get("checking_begin_balance")
        acc.checking_end_balance = parsed.get("checking_end_balance")
        acc.savings_begin_balance = parsed.get("savings_begin_balance")
        acc.savings_end_balance = parsed.get("savings_end_balance")

        acc.fingerprint = fingerprint

        if not getattr(acc, "created_at", None):
            acc.created_at = datetime.utcnow()

        db.commit()
        db.refresh(acc)

        imported = 0

        # 6) Transactions
        if import_txns:
            txns = parsed.get("transactions") or []
            for t in txns:
                db.add(CashTransaction(
                    cash_account_id=acc.id,
                    posted_date=t.get("posted_date"),
                    description=t.get("description"),
                    amount=t.get("amount"),
                    txn_type=t.get("txn_type"),
                    category=t.get("category"),
                    created_at=datetime.utcnow(),
                ))
            db.commit()
            imported = len(txns)

        return {
            "ok": True,
            "already_exists": already_exists,
            "cash_account_id": acc.id,
            "imported_txns": imported,
            "meta": {
                "filename": acc.filename,
                "institution": acc.institution,
                "account_label": acc.account_label,
                "account_name": acc.account_name,
                "account_last4": acc.account_last4,
                "statement_period": acc.statement_period,
                "checking_begin_balance": acc.checking_begin_balance,
                "checking_end_balance": acc.checking_end_balance,
                "savings_begin_balance": acc.savings_begin_balance,
                "savings_end_balance": acc.savings_end_balance,
                "fingerprint": acc.fingerprint,
            }
        }

    except Exception as e:
        # best effort cleanup
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass
        raise HTTPException(status_code=400, detail=f"Bank PDF parse failed: {str(e)}")
    finally:
        db.close()


@app.get("/cash-accounts")
def list_cash_accounts(
    user_id: Optional[str] = None,
    limit: int = 50,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        rows = (
            db.query(CashAccount)
            .filter(CashAccount.user_id == user_id)
            .order_by(CashAccount.created_at.desc(), CashAccount.id.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": r.id,
                "user_id": r.user_id,
                "institution": r.institution,
                "account_label": r.account_label,
                "account_name": r.account_name,
                "account_last4": r.account_last4,
                "statement_period": r.statement_period,
                "statement_end_date": r.statement_end_date,
                "checking_begin_balance": r.checking_begin_balance,
                "checking_end_balance": r.checking_end_balance,
                "savings_begin_balance": r.savings_begin_balance,
                "savings_end_balance": r.savings_end_balance,
                "filename": r.filename,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    finally:
        db.close()


@app.get("/cash-accounts/{cash_account_id}/transactions")
def list_cash_transactions(
    cash_account_id: int,
    user_id: Optional[str] = None,
    limit: int = 500,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        acc = db.query(CashAccount).filter(
            CashAccount.id == cash_account_id,
            CashAccount.user_id == user_id
        ).first()
        if not acc:
            raise HTTPException(status_code=404, detail="Cash account not found")

        txns = (
            db.query(CashTransaction)
            .filter(CashTransaction.cash_account_id == acc.id)
            .order_by(CashTransaction.id.asc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": t.id,
                "posted_date": t.posted_date,
                "description": t.description,
                "amount": t.amount,
                "txn_type": t.txn_type,
                "category": t.category,
            }
            for t in txns
        ]
    finally:
        db.close()


# =============================
# CASH TRANSACTIONS - UPDATE APIs
# =============================

from pydantic import BaseModel
from typing import Optional
from fastapi import HTTPException

class CashTransactionPatch(BaseModel):
    category: Optional[str] = None

@app.patch("/cash-transactions/{cash_transaction_id}")
def patch_cash_transaction(
    cash_transaction_id: int,
    payload: CashTransactionPatch,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    Update a cash transaction (currently: category only)
    Safe: scoped by user_id by joining CashTransaction -> CashAccount.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        # Join to ensure the transaction belongs to this user
        row = (
            db.query(CashTransaction)
            .join(CashAccount, CashTransaction.cash_account_id == CashAccount.id)
            .filter(
                CashTransaction.id == cash_transaction_id,
                CashAccount.user_id == user_id
            )
            .first()
        )

        if not row:
            raise HTTPException(status_code=404, detail="Cash transaction not found")

        # Apply updates
        if payload.category is not None:
            row.category = payload.category.strip() if payload.category else None

        db.commit()
        db.refresh(row)

        return {
            "ok": True,
            "id": row.id,
            "cash_account_id": row.cash_account_id,
            "posted_date": row.posted_date,
            "description": row.description,
            "amount": row.amount,
            "txn_type": row.txn_type,
            "category": row.category,
        }
    finally:
        db.close()



# =========================
# Cash Transaction Updates
# =========================
from pydantic import BaseModel
from typing import Optional

class CashTxnPatch(BaseModel):
    category: Optional[str] = None
    txn_type: Optional[str] = None

@app.patch("/cash-transactions/{cash_transaction_id}")
def patch_cash_transaction(
    cash_transaction_id: int,
    payload: CashTxnPatch,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    Update a cash transaction (category and/or txn_type).
    Scoped by user_id via CashAccount join.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        txn = (
            db.query(CashTransaction)
            .join(CashAccount, CashTransaction.cash_account_id == CashAccount.id)
            .filter(CashTransaction.id == cash_transaction_id)
            .filter(CashAccount.user_id == user_id)
            .first()
        )

        if not txn:
            raise HTTPException(status_code=404, detail="Cash transaction not found")

        if payload.category is not None:
            txn.category = payload.category

        if payload.txn_type is not None:
            txn.txn_type = payload.txn_type

        db.commit()

        return {
            "ok": True,
            "id": txn.id,
            "category": txn.category,
            "txn_type": txn.txn_type,
        }
    finally:
        db.close()


from fastapi import HTTPException

@app.delete("/cash-accounts/{cash_account_id}")
def delete_cash_account(
    cash_account_id: int,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    Deletes a cash account statement row + all of its cash transactions.
    Safe: scoped by user_id.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        acc = db.query(CashAccount).filter(
            CashAccount.id == cash_account_id,
            CashAccount.user_id == user_id
        ).first()

        if not acc:
            raise HTTPException(status_code=404, detail="Cash account not found")

        # delete transactions first
        deleted_txns = (
            db.query(CashTransaction)
            .filter(CashTransaction.cash_account_id == acc.id)
            .delete(synchronize_session=False)
        )

        # delete account row
        db.delete(acc)
        db.commit()

        return {
            "ok": True,
            "deleted_cash_account_id": cash_account_id,
            "deleted_transactions": int(deleted_txns or 0),
        }
    finally:
        db.close()


@app.delete("/cash-accounts/by-fingerprint/{fingerprint}")
def delete_cash_account_by_fingerprint(
    fingerprint: str,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        fp = (fingerprint or "").strip().upper()

        acc = db.query(CashAccount).filter(
            CashAccount.user_id == user_id,
            CashAccount.fingerprint == fp
        ).first()

        if not acc:
            raise HTTPException(status_code=404, detail="Cash account not found for fingerprint")

        deleted_txns = (
            db.query(CashTransaction)
            .filter(CashTransaction.cash_account_id == acc.id)
            .delete(synchronize_session=False)
        )

        deleted_id = acc.id
        db.delete(acc)
        db.commit()

        return {
            "ok": True,
            "deleted_cash_account_id": deleted_id,
            "deleted_transactions": int(deleted_txns or 0),
            "fingerprint": fp,
        }
    finally:
        db.close()


import re
import os
import hashlib
from datetime import datetime
from typing import Optional

# -----------------------------
# Fingerprint (dedupe key)
# -----------------------------
def make_statement_fingerprint(user_id: str, account_label: str, parsed: dict) -> str:
    txns = parsed.get("transactions") or []

    dates = []
    total = 0.0
    for t in txns:
        d = t.get("posted_date") or ""
        if d:
            dates.append(d)

        amt = t.get("amount") or 0.0
        try:
            total += float(amt)
        except Exception:
            pass

    dates = sorted(dates)
    min_date = dates[0] if dates else ""
    max_date = dates[-1] if dates else ""

    raw = "|".join([
        user_id,
        (account_label or "").lower().strip(),
        str(parsed.get("statement_period") or "").strip(),
        str(parsed.get("due_date") or "").strip(),
        str(parsed.get("new_balance") or ""),
        str(len(txns)),
        f"{total:.2f}",
        min_date,
        max_date,
    ])

    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# -----------------------------
# URL-safe statement_code
# -----------------------------
_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
}

def _clean_label(label: str) -> str:
    s = (label or "").upper().strip()
    s = re.sub(r"[^A-Z0-9]+", "", s)
    return s[:16] if s else "CARD"

def _extract_end_date_iso(period_end: str) -> Optional[str]:
    if not period_end:
        return None

    s = period_end.strip().replace("–", "-").replace("—", "-")

    iso_matches = re.findall(r"\b(20\d{2}-\d{2}-\d{2})\b", s)
    if iso_matches:
        return iso_matches[-1]

    m = re.findall(r"\b([A-Za-z]{3})\s+(\d{1,2}),\s*(20\d{2})\b", s)
    if m:
        mon_str, dd_str, yyyy_str = m[-1]
        mon = _MONTHS.get(mon_str.lower())
        if mon:
            try:
                dt = datetime(int(yyyy_str), mon, int(dd_str))
                return dt.date().isoformat()
            except Exception:
                return None

    return None

def make_statement_code(account_label: str, period_end: str, fingerprint: str) -> str:
    end_iso = _extract_end_date_iso(period_end)
    yyyymm = "UNKNOWN"
    if end_iso:
        yyyymm = end_iso[:7].replace("-", "")  # YYYYMM

    short = (fingerprint or "")
    short = re.sub(r"[^a-fA-F0-9]", "", short)[:6].upper()

    if not short:
        seed = f"{account_label}|{period_end}|{yyyymm}"
        short = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:6].upper()

    return f"CO-{_clean_label(account_label)}-{yyyymm}-{short}"



# =============================
# CASH ACCOUNTS - DELETE APIs
# =============================
from fastapi import HTTPException

@app.delete("/cash-accounts/{cash_account_id}")
def delete_cash_account(
    cash_account_id: int,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    Deletes a CashAccount + all its CashTransactions (manual cascade).
    Safe for SQLite even if relationship cascade isn't configured.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        acc = db.query(CashAccount).filter(
            CashAccount.id == cash_account_id,
            CashAccount.user_id == user_id
        ).first()

        if not acc:
            raise HTTPException(status_code=404, detail="Cash account not found")

        # delete txns first (no reliance on ORM cascade)
        db.query(CashTransaction).filter(
            CashTransaction.cash_account_id == acc.id
        ).delete(synchronize_session=False)

        db.delete(acc)
        db.commit()

        return {"ok": True, "deleted_cash_account_id": cash_account_id}
    finally:
        db.close()


@app.delete("/cash-accounts/by-fingerprint/{fingerprint}")
def delete_cash_account_by_fingerprint(
    fingerprint: str,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    Convenience delete if UI only has fingerprint.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        acc = db.query(CashAccount).filter(
            CashAccount.user_id == user_id,
            CashAccount.fingerprint == fingerprint
        ).first()

        if not acc:
            raise HTTPException(status_code=404, detail="Cash account not found")

        cid = acc.id

        db.query(CashTransaction).filter(
            CashTransaction.cash_account_id == cid
        ).delete(synchronize_session=False)

        db.delete(acc)
        db.commit()

        return {"ok": True, "deleted_cash_account_id": cid, "fingerprint": fingerprint}
    finally:
        db.close()


from datetime import datetime, date
import re

def _yyyy_mm(dt: date) -> str:
    return f"{dt.year:04d}-{dt.month:02d}"

def _parse_posted_date(s: str):
    # Your cash page shows "29 Jan 2026" style in UI; DB may store similar.
    # Return a date() if parseable, else None.
    if not s:
        return None
    s = str(s).strip()
    # Try ISO first
    try:
        return datetime.fromisoformat(s[:10]).date()
    except Exception:
        pass
    # Try "29 Jan 2026"
    try:
        return datetime.strptime(s, "%d %b %Y").date()
    except Exception:
        pass
    # Try "Jan 29, 2026" (if ever present)
    try:
        return datetime.strptime(s, "%b %d, %Y").date()
    except Exception:
        pass
    return None

def _looks_like_income(desc: str) -> bool:
    d = (desc or "").lower()
    keywords = [
        "payroll", "salary", "direct deposit", "deposit from",
        "interest paid", "refund", "reimbursement"
    ]
    return any(k in d for k in keywords)

@app.get("/dashboard/financial-os")
def dashboard_financial_os(
    user_id: Optional[str] = None,
    month: str = "",
    current_user: User = Depends(require_current_user),
):
    """
    Minimal Financial OS summary:
    - detected_income (from cash txns)
    - month_spend (cash outflow)
    - net (income - spend)
    This is enough to power the Dashboard income + OS tiles.
    """
    db = SessionLocal()
    try:
        target_month = (month or "").strip()
        if not re.match(r"^\d{4}-\d{2}$", target_month):
            target_month = _yyyy_mm(date.today())

        # Pull all cash txns for this user (across all imported cash accounts)
        rows = (
            db.query(CashTransaction, CashAccount)
            .join(CashAccount, CashTransaction.cash_account_id == CashAccount.id)
            .filter(CashAccount.user_id == user_id)
            .all()
        )

        income = 0.0
        spend = 0.0

        for (t, acc) in rows:
            dt = _parse_posted_date(getattr(t, "posted_date", None))
            if not dt:
                continue
            if _yyyy_mm(dt) != target_month:
                continue

            amt = float(getattr(t, "amount", 0.0) or 0.0)
            txn_type = (getattr(t, "txn_type", "") or "").lower()
            desc = getattr(t, "description", "") or ""

            # Income rule: positive amounts that are deposits/credits OR look like payroll/deposit text
            if amt > 0 and (txn_type in ["deposit", "credit", "inflow"] or _looks_like_income(desc)):
                income += amt
                continue

            # Spend rule: negative amounts = outflow
            if amt < 0:
                spend += abs(amt)

        net = income - spend

        # Simple stage heuristic (placeholder until your full get_stage engine is wired)
        # If net < 0 => "Stabilize", else "Build Security"
        stage = "Stabilize" if net < 0 else "Build Security"

        return {
            "ok": True,
            "user_id": user_id,
            "month": target_month,
            "detected_income": round(income, 2),
            "month_spend": round(spend, 2),
            "net": round(net, 2),
            "stage": stage,
        }
    finally:
        db.close()


from fastapi import Body

# ============================
# Financial OS — Bills
# ============================

@app.get("/bills")
def list_bills(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    q = db.query(Bill).filter(Bill.user_id == user_id).order_by(Bill.active.desc(), Bill.due_day.asc().nullslast(), Bill.name.asc())
    return q.all()


@app.post("/bills")
def create_bill(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    b = Bill(
        user_id=_coerce_user_id(current_user, payload.get("user_id")),
        name=payload.get("name") or "Bill",
        amount=float(payload.get("amount") or 0),
        frequency=payload.get("frequency") or "monthly",
        due_day=payload.get("due_day"),
        next_due_date=payload.get("next_due_date"),
        autopay=bool(payload.get("autopay") or False),
        category=payload.get("category"),
        essentials=bool(payload.get("essentials") if payload.get("essentials") is not None else True),
        notes=payload.get("notes"),
        active=bool(payload.get("active") if payload.get("active") is not None else True),
    )
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


@app.patch("/bills/{bill_id}")
def update_bill(
    bill_id: int,
    user_id: Optional[str] = None,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    b = db.query(Bill).filter(and_(Bill.id == bill_id, Bill.user_id == user_id)).first()
    if not b:
        raise HTTPException(status_code=404, detail="Bill not found")

    for k in ["name", "frequency", "next_due_date", "category", "notes"]:
        if k in payload:
            setattr(b, k, payload[k])

    for k in ["amount"]:
        if k in payload and payload[k] is not None:
            setattr(b, k, float(payload[k]))

    for k in ["due_day"]:
        if k in payload:
            setattr(b, k, payload[k])

    for k in ["autopay", "essentials", "active"]:
        if k in payload:
            setattr(b, k, bool(payload[k]))

    b.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(b)
    return b


@app.delete("/bills/{bill_id}")
def delete_bill(
    bill_id: int,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    b = db.query(Bill).filter(and_(Bill.id == bill_id, Bill.user_id == user_id)).first()
    if not b:
        raise HTTPException(status_code=404, detail="Bill not found")
    db.delete(b)
    db.commit()
    return {"ok": True}


# ----------------------------
# Manual Bills (Financial OS)
# ----------------------------


@app.get("/os/manual-bills")
def os_list_manual_bills(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    q = db.query(ManualBill).filter(ManualBill.user_id == user_id).order_by(ManualBill.active.desc(), ManualBill.name.asc())
    return q.all()


@app.post("/os/manual-bills")
def os_create_manual_bill(
    payload: dict = Body(...),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    mb = ManualBill(
        user_id=user_id,
        name=payload.get("name") or "Manual Bill",
        amount=float(payload.get("amount") or 0),
        frequency=payload.get("frequency") or "monthly",
        due_day=payload.get("due_day"),
        due_date=payload.get("due_date"),
        category=payload.get("category") or "Essentials",
        autopay=bool(payload.get("autopay") or False),
        active=bool(payload.get("active") if payload.get("active") is not None else True),
        notes=payload.get("notes"),
    )
    db.add(mb)
    db.commit()
    db.refresh(mb)
    return mb


@app.patch("/os/manual-bills/{mb_id}")
def os_update_manual_bill(
    mb_id: int,
    payload: dict = Body(...),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    mb = db.query(ManualBill).filter(and_(ManualBill.id == mb_id, ManualBill.user_id == user_id)).first()
    if not mb:
        raise HTTPException(status_code=404, detail="Manual bill not found")

    for k in ["name", "frequency", "due_date", "category", "notes"]:
        if k in payload:
            setattr(mb, k, payload[k])

    if "amount" in payload and payload["amount"] is not None:
        mb.amount = float(payload["amount"])

    if "due_day" in payload:
        mb.due_day = payload["due_day"]

    for k in ["autopay", "active"]:
        if k in payload:
            setattr(mb, k, bool(payload[k]))

    mb.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(mb)
    return mb


@app.delete("/os/manual-bills/{mb_id}")
def os_delete_manual_bill(
    mb_id: int,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    mb = db.query(ManualBill).filter(and_(ManualBill.id == mb_id, ManualBill.user_id == user_id)).first()
    if not mb:
        raise HTTPException(status_code=404, detail="Manual bill not found")
    # soft delete
    mb.active = False
    mb.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(mb)
    return {"ok": True}


# ----------------------------
# Manual Transactions
# ----------------------------


@app.get("/manual-transactions")
def list_manual_transactions(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    q = (
        db.query(ManualTransaction)
        .filter(ManualTransaction.user_id == user_id)
        .order_by(ManualTransaction.date.desc(), ManualTransaction.created_at.desc())
    )
    return q.all()


@app.post("/manual-transactions")
def create_manual_transaction(
    payload: dict = Body(...),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id or payload.get("user_id"))
    row = ManualTransaction(
        user_id=user_id,
        amount=float(payload.get("amount") or 0),
        date=(payload.get("date") or date.today().isoformat()),
        category=payload.get("category") or "Other",
        description=payload.get("description") or "",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@app.patch("/manual-transactions/{transaction_id}")
def update_manual_transaction(
    transaction_id: int,
    payload: dict = Body(...),
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    row = (
        db.query(ManualTransaction)
        .filter(and_(ManualTransaction.id == transaction_id, ManualTransaction.user_id == user_id))
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Manual transaction not found")

    if "amount" in payload and payload["amount"] is not None:
        row.amount = float(payload["amount"])

    for key in ["date", "category", "description"]:
        if key in payload:
            setattr(row, key, payload[key])

    row.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return row


@app.delete("/manual-transactions/{transaction_id}")
def delete_manual_transaction(
    transaction_id: int,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    row = (
        db.query(ManualTransaction)
        .filter(and_(ManualTransaction.id == transaction_id, ManualTransaction.user_id == user_id))
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Manual transaction not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


# ============================
# Financial OS — Debts
# ============================

@app.get("/debts")
def list_debts(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    q = db.query(Debt).filter(Debt.user_id == user_id).order_by(Debt.active.desc(), Debt.apr.desc().nullslast(), Debt.name.asc())
    return q.all()


@app.post("/debts")
def create_debt(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    d = Debt(
        user_id=_coerce_user_id(current_user, payload.get("user_id")),
        kind=payload.get("kind") or "credit_card",
        lender=payload.get("lender"),
        name=payload.get("name") or "Debt",
        last4=payload.get("last4"),
        apr=payload.get("apr"),
        balance=float(payload.get("balance") or 0),
        credit_limit=payload.get("credit_limit"),
        minimum_due=payload.get("minimum_due"),
        due_day=payload.get("due_day"),
        due_date=payload.get("due_date"),
        statement_day=payload.get("statement_day"),
        active=bool(payload.get("active") if payload.get("active") is not None else True),
    )
    db.add(d)
    db.commit()
    db.refresh(d)
    return d


@app.patch("/debts/{debt_id}")
def update_debt(
    debt_id: int,
    user_id: Optional[str] = None,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    d = db.query(Debt).filter(and_(Debt.id == debt_id, Debt.user_id == user_id)).first()
    if not d:
        raise HTTPException(status_code=404, detail="Debt not found")

    for k in ["kind", "lender", "name", "last4", "due_date"]:
        if k in payload:
            setattr(d, k, payload[k])

    for k in ["apr", "balance", "credit_limit", "minimum_due"]:
        if k in payload and payload[k] is not None:
            setattr(d, k, float(payload[k]))

    for k in ["due_day", "statement_day"]:
        if k in payload:
            setattr(d, k, payload[k])

    if "active" in payload:
        d.active = bool(payload["active"])

    d.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(d)
    return d


@app.delete("/debts/{debt_id}")
def delete_debt(
    debt_id: int,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    d = db.query(Debt).filter(and_(Debt.id == debt_id, Debt.user_id == user_id)).first()
    if not d:
        raise HTTPException(status_code=404, detail="Debt not found")
    db.delete(d)
    db.commit()
    return {"ok": True}


# ============================
# Financial OS — Goals
# ============================

@app.get("/goals")
def list_goals(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    return db.query(Goal).filter(Goal.user_id == user_id).order_by(Goal.key.asc()).all()


@app.patch("/goals/{key}")
def upsert_goal(
    key: str,
    user_id: Optional[str] = None,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    value = float(payload.get("value") or 0)
    notes = payload.get("notes")

    g = db.query(Goal).filter(and_(Goal.user_id == user_id, Goal.key == key)).first()
    if not g:
        g = Goal(user_id=user_id, key=key, value=value, notes=notes)
        db.add(g)
    else:
        g.value = value
        if notes is not None:
            g.notes = notes
        g.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(g)
    return g


# ============================
# Financial OS — Paychecks
# ============================

@app.get("/paychecks")
def list_paychecks(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    return db.query(Paycheck).filter(Paycheck.user_id == user_id).order_by(Paycheck.active.desc(), Paycheck.next_pay_date.asc().nullslast()).all()


@app.post("/paychecks")
def create_paycheck(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    p = Paycheck(
        user_id=_coerce_user_id(current_user, payload.get("user_id")),
        employer=payload.get("employer"),
        frequency=payload.get("frequency") or "biweekly",
        next_pay_date=payload.get("next_pay_date"),
        typical_amount=payload.get("typical_amount"),
        notes=payload.get("notes"),
        active=bool(payload.get("active") if payload.get("active") is not None else True),
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@app.patch("/paychecks/{paycheck_id}")
def update_paycheck(
    paycheck_id: int,
    user_id: Optional[str] = None,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    p = db.query(Paycheck).filter(and_(Paycheck.id == paycheck_id, Paycheck.user_id == user_id)).first()
    if not p:
        raise HTTPException(status_code=404, detail="Paycheck not found")

    for k in ["employer", "frequency", "next_pay_date", "notes"]:
        if k in payload:
            setattr(p, k, payload[k])

    if "typical_amount" in payload and payload["typical_amount"] is not None:
        p.typical_amount = float(payload["typical_amount"])

    if "active" in payload:
        p.active = bool(payload["active"])

    p.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(p)
    return p


@app.delete("/paychecks/{paycheck_id}")
def delete_paycheck(
    paycheck_id: int,
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    p = db.query(Paycheck).filter(and_(Paycheck.id == paycheck_id, Paycheck.user_id == user_id)).first()
    if not p:
        raise HTTPException(status_code=404, detail="Paycheck not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


@app.get("/statements")
def list_statements(
    user_id: Optional[str] = None,
    limit: int = 50,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    user_id = _coerce_user_id(current_user, user_id)
    user_id = _coerce_user_id(current_user, user_id)
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        rows = (
            db.query(Statement)
            .filter(Statement.user_id == user_id)
            .order_by(Statement.created_at.desc(), Statement.id.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": r.id,
                "user_id": r.user_id,
                "account_label": r.account_label,
                "card_name": getattr(r, "card_name", None),
                "card_last4": getattr(r, "card_last4", None),
                "statement_period": r.statement_period,
                "due_date": r.due_date,
                "minimum_payment": r.minimum_payment,
                "new_balance": r.new_balance,
                "interest_charged": r.interest_charged,
                "apr": r.apr,
                "statement_code": r.statement_code,
                "filename": r.filename,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ]
    finally:
        db.close()

  # (only if you want to raise errors later)


@app.get("/statements/by-code/{statement_code}/transactions")
def get_transactions_by_code(
    statement_code: str,
    user_id: Optional[str] = None,
    limit: int = 200,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        st = db.query(Statement).filter(
            Statement.user_id == user_id,
            Statement.statement_code == statement_code
        ).first()
        if not st:
            raise HTTPException(status_code=404, detail="Statement not found")

        txns = (
            db.query(Transaction)
            .filter(Transaction.statement_id == st.id)
            .order_by(Transaction.id.asc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": t.id,
                "posted_date": t.posted_date,
                "description": t.description,
                "amount": t.amount,
                "txn_type": t.txn_type,
                "category": t.category,
            }
            for t in txns
        ]
    finally:
        db.close()


class RuleIn(BaseModel):
    pattern: str
    category: str
    priority: int = 100


@app.delete("/statements/{statement_id}")
def delete_statement(
    statement_id: int,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        stmt = db.query(Statement).filter(
            Statement.id == statement_id,
            Statement.user_id == user_id
        ).first()

        if not stmt:
            raise HTTPException(status_code=404, detail="Statement not found")

        db.delete(stmt)   # will cascade delete-orphan transactions
        db.commit()

        return {"ok": True, "deleted_statement_id": statement_id}
    finally:
        db.close()


from fastapi import HTTPException

@app.delete("/statements/by-code/{statement_code}")
def delete_statement_by_code(
    statement_code: str,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        stmt = db.query(Statement).filter(
            Statement.statement_code == statement_code,
            Statement.user_id == user_id
        ).first()

        if not stmt:
            raise HTTPException(status_code=404, detail="Statement not found")

        sid = stmt.id
        db.delete(stmt)
        db.commit()

        return {"ok": True, "deleted_statement_id": sid, "statement_code": statement_code}
    finally:
        db.close()



@app.post("/rules")
def upsert_rule(
    payload: RuleIn,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        pattern = payload.pattern.strip().lower()
        category = payload.category.strip()

        existing = (
            db.query(MerchantRule)
            .filter(MerchantRule.user_id == user_id, MerchantRule.pattern == pattern)
            .first()
        )

        if existing:
            existing.category = category
            existing.priority = payload.priority
            existing.updated_at = datetime.utcnow()
        else:
            db.add(
                MerchantRule(
                    user_id=user_id,
                    pattern=pattern,
                    category=category,
                    priority=payload.priority,
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
            )

        db.commit()
        return {"ok": True, "pattern": pattern, "category": category, "priority": payload.priority}
    finally:
        db.close()


@app.get("/rules")
def list_rules(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        rules = (
            db.query(MerchantRule)
            .filter(MerchantRule.user_id == user_id)
            .order_by(MerchantRule.priority.asc(), MerchantRule.pattern.asc())
            .all()
        )

        return [
            {
                "id": r.id,
                "pattern": r.pattern,
                "category": r.category,
                "priority": r.priority,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rules
        ]
    finally:
        db.close()


@app.get("/merchants/needs-category")
def merchants_needs_category(
    user_id: Optional[str] = None,
    limit: int = 50,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        rows = (
            db.query(Transaction.description)
            .join(Statement)
            .filter(Statement.user_id == user_id, Transaction.category.is_(None))
            .distinct()
            .limit(limit)
            .all()
        )
        return {"merchants": [r[0] for r in rows if r[0]]}
    finally:
        db.close()


from pydantic import BaseModel

class MerchantLabelIn(BaseModel):
    merchant: str
    category: str
    priority: int = 50

@app.post("/merchants/label")
def label_merchant(
    payload: MerchantLabelIn,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        merchant = payload.merchant.strip()
        category = payload.category.strip()

        merchant_norm = normalize_merchant(merchant)

        # upsert rule
        existing_rule = (
            db.query(MerchantRule)
            .filter(MerchantRule.user_id == user_id, MerchantRule.normalized == merchant_norm)
            .first()
        )

        if existing_rule:
            existing_rule.category = category
            existing_rule.priority = payload.priority
            existing_rule.updated_at = datetime.utcnow()
        else:
            db.add(MerchantRule(
                user_id=user_id,
                pattern=merchant.lower(),
                normalized=merchant_norm,
                category=category,
                match_type="contains",
                priority=payload.priority,
                created_at=datetime.utcnow(),
                updated_at=datetime.utcnow(),
            ))

        db.commit()

        # backfill all matching uncategorized txns
        txns = (
            db.query(Transaction)
            .join(Statement)
            .filter(Statement.user_id == user_id)
            .all()
        )

        updated = 0
        for t in txns:
            if t.category:
                continue
            desc_norm = normalize_merchant(t.description)
            if merchant_norm in desc_norm:
                t.category = category
                updated += 1

        db.commit()
        return {"ok": True, "rule_saved": True, "updated_transactions": updated}
    finally:
        db.close()


from datetime import datetime
from typing import List, Optional

def _is_placeholder(v) -> bool:
    if v is None:
        return True
    s = str(v).strip().strip('"').strip("'").lower()
    return s in ("", "string", "null", "none", "undefined")

def normalize_merchant(s: str) -> str:
    import re
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


from datetime import datetime

def _import_transactions_from_parsed(db, statement_id: int, user_id: str, parsed: dict) -> int:
    txs = parsed.get("transactions") or []
    if not isinstance(txs, list):
        return 0

    inserted = 0

    for tx in txs:
        # tx is likely a dict from parser
        posted_date_raw = (tx.get("posted_date") if isinstance(tx, dict) else None)
        desc_raw = (tx.get("description") if isinstance(tx, dict) else None)
        amount = (tx.get("amount") if isinstance(tx, dict) else None)
        txn_type_raw = (tx.get("txn_type") if isinstance(tx, dict) else None)
        category_raw = (tx.get("category") if isinstance(tx, dict) else None)

        # --- sanitize like your Step-2 guardrails ---
        if not txn_type_raw or str(txn_type_raw).strip().lower() == "string":
            continue

        posted_date = None
        if posted_date_raw and str(posted_date_raw).strip().lower() != "string":
            posted_date = datetime.fromisoformat(str(posted_date_raw)).date()

        description = None
        if desc_raw and str(desc_raw).strip().lower() != "string":
            description = str(desc_raw).strip()

        txn_type = str(txn_type_raw).strip().lower()

        category = None
        if category_raw and str(category_raw).strip().lower() != "string":
            category = str(category_raw).strip()

        # OPTIONAL (recommended): if you already have “rules” logic, apply it here
        # Example idea:
        # category = category or _match_rule_category(db, user_id, description)

        new_tx = Transaction(
            statement_id=statement_id,
            posted_date=posted_date,
            description=description,
            amount=amount,
            txn_type=txn_type,
            category=category,
        )
        db.add(new_tx)
        inserted += 1

    return inserted



@app.post("/statements/{statement_id}/transactions")
def add_transactions(
    statement_id: int,
    txns: List[TransactionIn],
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        st = db.query(Statement).filter(
            Statement.id == statement_id,
            Statement.user_id == user_id
        ).first()
        if not st:
            raise HTTPException(status_code=404, detail="Statement not found for this user_id")

        # Load merchant rules (if you have them)
        rules = (
            db.query(MerchantRule)
            .filter(MerchantRule.user_id == user_id)
            .order_by(MerchantRule.priority.asc())
            .all()
        )

        inserted = 0
        skipped = 0
        created_ids = []

        for t in txns:
            # 1) Skip Swagger dummy row / placeholders
            if _is_placeholder(t.txn_type) or _is_placeholder(t.description):
                skipped += 1
                continue

            # 2) posted_date -> datetime (or None)
            posted_dt = None
            if not _is_placeholder(t.posted_date):
                try:
                    # allow "YYYY-MM-DD" or full ISO "YYYY-MM-DDTHH:MM:SS"
                    posted_dt = datetime.fromisoformat(t.posted_date)
                except Exception:
                    skipped += 1
                    continue

            # 3) Clean fields
            desc = None if _is_placeholder(t.description) else t.description.strip()
            txn_type = None if _is_placeholder(t.txn_type) else t.txn_type.strip().lower()
            category = None if _is_placeholder(t.category) else t.category.strip()

            amount = float(t.amount) if t.amount is not None else None

            # 4) Auto-category using rules if category missing
            if not category and desc:
                nd = normalize_merchant(desc)
                for r in rules:
                    pat = normalize_merchant(r.pattern or "")
                    if not pat:
                        continue

                    if (r.match_type == "startswith" and nd.startswith(pat)) or (r.match_type != "startswith" and pat in nd):
                        category = r.category
                        break

            # 5) Dedupe check (THIS is where your crash was: existing must be assigned)
            existing = db.query(Transaction).filter(
                Transaction.statement_id == statement_id,
                Transaction.posted_date == posted_dt,
                Transaction.amount == amount,
                Transaction.description == desc
            ).first()

            if existing:
                skipped += 1
                continue

            row = Transaction(
                statement_id=statement_id,
                posted_date=posted_dt,
                description=desc,
                amount=amount,
                txn_type=txn_type,
                category=category,
            )
            db.add(row)
            db.flush()

            inserted += 1
            created_ids.append(row.id)

        db.commit()
        return {
            "statement_id": statement_id,
            "inserted": inserted,
            "skipped": skipped,
            "created_transaction_ids": created_ids
        }

    finally:
        db.close()


from datetime import datetime, date

@app.get("/statements/{statement_id}/transactions")
def list_transactions(
    statement_id: int,
    user_id: Optional[str] = None,
    limit: int = 200,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        st = (
            db.query(Statement)
            .filter(Statement.id == statement_id, Statement.user_id == user_id)
            .first()
        )
        if not st:
            raise HTTPException(status_code=404, detail="Statement not found for this user_id")

        rows = (
            db.query(Transaction)
            .filter(Transaction.statement_id == statement_id)
            .order_by(Transaction.id.desc())
            .limit(limit)
            .all()
        )

        def clean_date_str(s: str):
            """Return None for demo placeholders, otherwise return original string."""
            if s is None:
                return None
            if not isinstance(s, str):
                # if it ever becomes a date/datetime type
                if isinstance(s, (datetime, date)):
                    return s.isoformat()
                return str(s)

            v = s.strip().strip("'").strip('"')
            if v.lower() in ("", "string", "none", "null"):
                return None
            return v  # keep as string, don't force ISO parsing

        def clean_dt(x):
            """Return ISO string if datetime, else None/str."""
            if x is None:
                return None
            if isinstance(x, datetime):
                return x.isoformat()
            # if somehow a string got stored, avoid crashing
            s = str(x).strip().strip("'").strip('"')
            if s.lower() in ("", "string", "none", "null"):
                return None
            return s

        return [
            {
                "id": r.id,
                "statement_id": r.statement_id,
                "posted_date": clean_date_str(r.posted_date),
                "description": r.description,
                "amount": r.amount,
                "txn_type": r.txn_type,
                "category": r.category,
                "created_at": clean_dt(r.created_at),
            }
            for r in rows
        ]

    finally:
        db.close()



def _summarize_transactions(db, user_id: str, start_dt, end_dt):
    date_col = func.coalesce(Transaction.posted_date, Transaction.created_at)

    txns = (
     db.query(Transaction)
     .join(Statement)
     .filter(
        Statement.user_id == user_id,
        date_col >= start_dt,
        date_col < end_dt,
    )
    .all()
    )


    total_spent = 0.0
    debt_paid = 0.0
    category_totals = {}

    for t in txns:
        if t.amount is None:
            continue

        ttype = (t.txn_type or "").lower()
        amt = float(t.amount)

        if ttype in ("debt_payment", "payment"):
            debt_paid += abs(amt)
        elif ttype == "spend":
            total_spent += amt
            cat = t.category or "Uncategorized"
            category_totals[cat] = category_totals.get(cat, 0.0) + amt

    top_category = None
    if category_totals:
        top_category = max(category_totals, key=category_totals.get)

    return {
        "count": len(txns),
        "total_spent": round(total_spent, 2),
        "debt_paid": round(debt_paid, 2),
        "category_totals": {k: round(v, 2) for k, v in category_totals.items()},
        "top_category": top_category,
    }


def _month_start_end(year: int, month: int):
    start = datetime(year, month, 1)
    last_day = monthrange(year, month)[1]
    end = datetime(year, month, last_day, 23, 59, 59)
    return start, end


def _summarize_month(db, user_id: str, start: datetime, end: datetime):
    """
    Uses posted_date if your Transaction has it; otherwise uses created_at.
    If your transactions are being grouped weirdly, we will switch to posted_date later.
    """
    # Try posted_date first if it exists on the model
    date_col = func.coalesce(Transaction.posted_date, Transaction.created_at)

    txns = (
       db.query(Transaction)
       .filter(Transaction.user_id == user_id)
       .filter(date_col >= start)
       .filter(date_col <= end)
       .all()
)



def _compute_adherence(this_month, prev_month):
    """
    Simple, motivating score:
    - spend down vs prev month (0-50)
    - debt up vs prev month (0-30)
    - top-category reduced (0-20)
    """
    score = 0

    # Spend improvement (0-50)
    if prev_month and prev_month["total_spent"] > 0:
        if this_month["total_spent"] < prev_month["total_spent"]:
            score += 50
        else:
            # partial credit if not too worse
            ratio = prev_month["total_spent"] / max(this_month["total_spent"], 1e-6)
            score += int(50 * min(ratio, 1.0))
    else:
        score += 25  # no baseline

    # Debt improvement (0-30)
    if prev_month:
        if this_month["debt_paid"] > prev_month["debt_paid"]:
            score += 30
        elif this_month["debt_paid"] == prev_month["debt_paid"] and this_month["debt_paid"] > 0:
            score += 18
        elif this_month["debt_paid"] > 0:
            score += 12
    else:
        if this_month["debt_paid"] > 0:
            score += 20

    # Top category reduction (0-20)
    if prev_month and prev_month["top_category"]:
        tc = prev_month["top_category"]
        prev_tc = prev_month["category_totals"].get(tc, 0.0)
        this_tc = this_month["category_totals"].get(tc, 0.0)
        if prev_tc > 0 and this_tc < prev_tc:
            score += 20
        elif prev_tc > 0:
            ratio = prev_tc / max(this_tc, 1e-6)
            score += int(20 * min(ratio, 1.0))
    else:
        score += 10

    return max(0, min(100, int(score)))


class ProfileIn(BaseModel):
    rent_monthly: Optional[float] = None
    car_loan_monthly: Optional[float] = None
    utilities_monthly: Optional[float] = None  # WiFi + electricity
    fuel_weekly: Optional[float] = None
    savings_monthly_target: Optional[float] = None
    extra_debt_target: Optional[float] = None


class RuleIn(BaseModel):
    pattern: str
    category: str
    priority: int = 100


@app.get("/profile")
def get_profile(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        p = db.query(Profile).filter(Profile.user_id == user_id).first()
        if not p:
            return {"user_id": user_id, "profile": None}

        return {
            "user_id": user_id,
            "profile": {
                "rent_monthly": p.rent_monthly,
                "car_loan_monthly": p.car_loan_monthly,
                "utilities_monthly": p.utilities_monthly,
                "fuel_weekly": p.fuel_weekly,
                "savings_monthly_target": p.savings_monthly_target,
                "extra_debt_target": p.extra_debt_target,
            },
        }
    finally:
        db.close()


@app.post("/profile")
def upsert_profile(
    payload: ProfileIn,
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        p = db.query(Profile).filter(Profile.user_id == user_id).first()

        if not p:
            p = Profile(user_id=user_id)
            db.add(p)

        data = payload.model_dump()
        for field, value in data.items():
            if value is not None:
                setattr(p, field, value)

        p.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(p)

        return {"ok": True, "user_id": user_id}
    finally:
        db.close()


@app.get("/coach/weekly")
def weekly_coach(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        now = datetime.utcnow()

        this_start = now - timedelta(days=7)
        this_end = now

        last_start = now - timedelta(days=14)
        last_end = now - timedelta(days=7)

        prev_advice = (
            db.query(AdviceLog)
            .filter(AdviceLog.user_id == user_id)
            .order_by(AdviceLog.created_at.desc())
            .first()
        )


        this_week = _summarize_transactions(db, user_id, this_start, this_end)
        last_week = _summarize_transactions(db, user_id, last_start, last_end)

        # Latest statement (for interest + balance context)
        rows = (
    db.query(Statement)
    .filter(Statement.user_id == user_id)
    .all()
)

        stmt = max(
         rows,
         key=lambda s: _parse_statement_end_date(s.statement_period) or datetime.min
        ) if rows else None

        # --- Fetch user profile ---
        profile = db.query(Profile).filter(Profile.user_id == user_id).first()

        rent = float(profile.rent_monthly) if (profile and profile.rent_monthly is not None) else 0.0
        car_loan = float(profile.car_loan_monthly) if (profile and profile.car_loan_monthly is not None) else 0.0
        utilities = float(profile.utilities_monthly) if (profile and profile.utilities_monthly is not None) else 0.0
        fuel_weekly_budget = float(profile.fuel_weekly) if (profile and profile.fuel_weekly is not None) else 0.0
        savings_target = float(profile.savings_monthly_target) if (profile and profile.savings_monthly_target is not None) else 0.0
        extra_debt_target = float(profile.extra_debt_target) if (profile and profile.extra_debt_target is not None) else 0.0

        interest = float(stmt.interest_charged) if (stmt and stmt.interest_charged is not None) else 0.0
        balance = float(stmt.new_balance) if (stmt and stmt.new_balance is not None) else 0.0

        # Deltas
        spend_delta = round(this_week["total_spent"] - last_week["total_spent"], 2)
        debt_delta = round(this_week["debt_paid"] - last_week["debt_paid"], 2)

        # Category deltas
        cats = set(this_week["category_totals"].keys()) | set(last_week["category_totals"].keys())
        category_deltas = {}
        for c in cats:
            category_deltas[c] = round(
                this_week["category_totals"].get(c, 0.0) - last_week["category_totals"].get(c, 0.0),
                2
            )

        compliance = None
        compliance_note = ""

        if prev_advice:
            payload = json.loads(prev_advice.advice_payload_json or "{}")
            prev_type = prev_advice.advice_type

            # Default: based on spend improvement
            compliance = 50

            if prev_type == "cut_top_category":
                target_cat = payload.get("category")
                # Did spending in that category go down vs last week?
                prev_cat_spend = last_week["category_totals"].get(target_cat, 0.0)
                this_cat_spend = this_week["category_totals"].get(target_cat, 0.0)

                if prev_cat_spend > 0 and this_cat_spend < prev_cat_spend:
                    compliance = 90
                    compliance_note = f"You reduced spending in {target_cat} (good follow-through). "
                elif prev_cat_spend > 0 and this_cat_spend == prev_cat_spend:
                    compliance = 60
                    compliance_note = f"You kept {target_cat} spending flat. "
                else:
                    compliance = 25
                    compliance_note = f"You did not reduce {target_cat} spending. "

            elif prev_type == "pay_extra_debt":
                target_amount = float(payload.get("extra_debt_target", 0.0))
                if this_week["debt_paid"] >= target_amount and target_amount > 0:
                    compliance = 95
                    compliance_note = "You hit your extra debt payment target. "
                elif this_week["debt_paid"] > 0:
                    compliance = 60
                    compliance_note = "You paid debt, but below target. "
                else:
                    compliance = 20
                    compliance_note = "No debt payment recorded this week. "

            # Save compliance back into previous advice row
            prev_advice.compliance_score = int(compliance)
            prev_advice.outcome_json = json.dumps({
                "spend_delta": spend_delta,
                "debt_paid_delta": debt_delta,
                "category_deltas": category_deltas,
            })
            db.commit()


        # Coach message
        msg = (
            f"This week you spent ${this_week['total_spent']:.2f} "
            f"({spend_delta:+.2f} vs last week). "
            f"You paid ${this_week['debt_paid']:.2f} toward debt "
            f"({debt_delta:+.2f} vs last week). "
        )

        if this_week["top_category"]:
            msg += f"Top category: {this_week['top_category']}. "

        if interest > 0:
            msg += f"Interest charged this cycle: ${interest:.2f}. "

        # --- Goal 12: Safe-to-spend (profile-aware) ---
        today = datetime.utcnow()
        week_end = today + timedelta(days=(6 - today.weekday()))  # Sunday end
        days_left = max((week_end.date() - today.date()).days, 0)

        baseline_weekly_spend = last_week["total_spent"] if last_week["total_spent"] > 0 else this_week["total_spent"]

        weekly_fixed_costs = (rent + car_loan + utilities + savings_target) / 4.0

        protected_amount = (
            weekly_fixed_costs
            + fuel_weekly_budget
            + extra_debt_target
            + WEEKLY_BUFFER
        )

        safe_to_spend = max(baseline_weekly_spend - this_week["total_spent"] - protected_amount, 0.0)
        over_pace = this_week["total_spent"] > baseline_weekly_spend

        if safe_to_spend <= 0:
            msg += " You are at or over your safe spending limit for this week."
        else:
            msg += f" After fixed costs and savings, you can safely spend up to ${safe_to_spend:.2f} for the rest of the week."


        # Decide this week's advice (and store it)
        advice_type = "pay_extra_debt"
        advice_payload = {"extra_debt_target": extra_debt_target}

        if this_week["top_category"]:
            advice_type = "cut_top_category"
            advice_payload = {"category": this_week["top_category"]}

        # coach text includes compliance note from last advice
        if compliance_note:
            msg += " " + compliance_note

        if advice_type == "cut_top_category":
            msg += f"Action for Friday: reduce spending in {advice_payload['category']} and move that amount to your highest-APR debt."
        else:
            msg += f"Action for Friday: pay an extra ${extra_debt_target:.2f} toward your highest-APR debt."

        # Save new advice for the NEXT week to evaluate
        new_advice = AdviceLog(
            user_id=user_id,
            period_start=this_start,
            period_end=this_end,
            advice_type=advice_type,
            advice_payload_json=json.dumps(advice_payload),
            compliance_score=0,
            outcome_json="{}",
        )
        db.add(new_advice)
        db.commit()


        # --- Goal 13: Progress Score ---
        score = 0

        # Spending discipline (0-50)
        if safe_to_spend > 0:
            score += 50
        else:
            if baseline_weekly_spend > 0:
                ratio = max(0.0, 1.0 - (this_week["total_spent"] / (baseline_weekly_spend + 1e-6)))
                score += int(50 * ratio)
            else:
                score += 10

        # Debt action (0-25)
        if this_week["debt_paid"] > 0:
            score += 25

        # Improvement vs last week spending (0-15)
        if spend_delta < 0:
            score += 15
        elif spend_delta == 0:
            score += 8

        # Interest awareness (0-10)
        if interest > 0:
            score += 8 if interest <= 20 else 4
        else:
            score += 10

        progress_score = max(0, min(100, int(score)))

        if progress_score >= 85:
            score_label = "Excellent"
        elif progress_score >= 70:
            score_label = "Good"
        elif progress_score >= 50:
            score_label = "Needs Improvement"
        else:
            score_label = "Off Track"

        msg += f" Progress score: {progress_score}/100 ({score_label})."

        result = {
            "this_week_range": {"start": this_start.date().isoformat(), "end": this_end.date().isoformat()},
            "last_week_range": {"start": last_start.date().isoformat(), "end": last_end.date().isoformat()},
            "this_week": this_week,
            "last_week": last_week,
            "deltas": {
                "spend_delta": spend_delta,
                "debt_paid_delta": debt_delta,
                "category_deltas": category_deltas,
            },
            "current_balance": round(balance, 2),
            "interest_charged": round(interest, 2),
            "safe_to_spend": round(safe_to_spend, 2),
            "days_left_in_week": days_left,
            "over_spending_pace": over_pace,
            "progress_score": progress_score,
            "score_label": score_label,
            "profile_context": {
                "weekly_fixed_costs": round(weekly_fixed_costs, 2),
                "fuel_weekly_budget": round(fuel_weekly_budget, 2),
                "savings_monthly_target": round(savings_target, 2),
                "extra_debt_target": round(extra_debt_target, 2),
            },
            "coach_message": msg,
        }
        return result
    finally:
        db.close()

@app.post("/month/close")
def close_month(
    user_id: Optional[str] = None,
    month: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    month format: "YYYY-MM"
    If not provided, closes PREVIOUS calendar month.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        now = datetime.utcnow()

        if month:
            year, mon = month.split("-")
            year = int(year)
            mon = int(mon)
        else:
            # previous month
            year = now.year
            mon = now.month - 1
            if mon == 0:
                mon = 12
                year -= 1
            month = f"{year:04d}-{mon:02d}"

        start, end = _month_start_end(year, mon)

        this_summary = _summarize_month(db, user_id, start, end)

        # find previous snapshot (for adherence)
        prev = (
            db.query(MonthlySnapshot)
            .filter(MonthlySnapshot.user_id == user_id)
            .order_by(MonthlySnapshot.month.desc())
            .first()
        )

        prev_summary = None
        if prev:
            prev_summary = {
                "total_spent": float(prev.total_spent),
                "debt_paid": float(prev.debt_paid),
                "top_category": prev.top_category,
                "category_totals": json.loads(prev.category_totals_json or "{}"),
            }

        score = _compute_adherence(this_summary, prev_summary)

        # statement context (latest statement, not month-specific yet)
        rows = (
         db.query(Statement)
         .filter(Statement.user_id == user_id)
         .all()
        )

        stmt = max(
         rows,
         key=lambda s: _parse_statement_end_date(s.statement_period) or datetime.min
        ) if rows else None
        interest = float(stmt.interest_charged) if (stmt and stmt.interest_charged is not None) else 0.0
        balance = float(stmt.new_balance) if (stmt and stmt.new_balance is not None) else 0.0

        msg = f"Month {month}: spent ${this_summary['total_spent']:.2f}, debt paid ${this_summary['debt_paid']:.2f}. "
        if this_summary["top_category"]:
            msg += f"Top category: {this_summary['top_category']}. "
        msg += f"Adherence score: {score}/100."

        # upsert snapshot
        snap = (
            db.query(MonthlySnapshot)
            .filter(MonthlySnapshot.user_id == user_id)
            .filter(MonthlySnapshot.month == month)
            .first()
        )
        if not snap:
            snap = MonthlySnapshot(user_id=user_id, month=month)
            db.add(snap)

        snap.total_spent = float(this_summary["total_spent"])
        snap.debt_paid = float(this_summary["debt_paid"])
        snap.top_category = this_summary["top_category"]
        snap.category_totals_json = json.dumps(this_summary["category_totals"])
        snap.interest_charged = interest
        snap.new_balance = balance
        snap.adherence_score = score
        snap.summary_message = msg

        db.commit()

        return {
            "ok": True,
            "month": month,
            "summary": this_summary,
            "adherence_score": score,
            "summary_message": msg,
        }
    finally:
        db.close()


@app.get("/month/snapshots")
def list_snapshots(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        rows = (
            db.query(MonthlySnapshot)
            .filter(MonthlySnapshot.user_id == user_id)
            .order_by(MonthlySnapshot.month.desc())
            .all()
        )

        return {
            "user_id": user_id,
            "snapshots": [
                {
                    "month": r.month,
                    "total_spent": r.total_spent,
                    "debt_paid": r.debt_paid,
                    "top_category": r.top_category,
                    "adherence_score": r.adherence_score,
                    "summary_message": r.summary_message,
                }
                for r in rows
            ],
        }
    finally:
        db.close()


@app.get("/month/compare")
def compare_months(
    user_id: Optional[str] = None,
    month_a: Optional[str] = None,
    month_b: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    """
    Compares two saved snapshots.
    If not provided, compares latest vs previous.
    """
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        snaps = (
            db.query(MonthlySnapshot)
            .filter(MonthlySnapshot.user_id == user_id)
            .order_by(MonthlySnapshot.month.desc())
            .all()
        )

        if len(snaps) < 1:
            return {"error": "No monthly snapshots yet. Run POST /month/close first."}

        def find(month_str):
            for s in snaps:
                if s.month == month_str:
                    return s
            return None

        if month_a and month_b:
            a = find(month_a)
            b = find(month_b)
        else:
            a = snaps[0]
            b = snaps[1] if len(snaps) > 1 else None

        if not b:
            return {"error": "Need at least 2 snapshots to compare. Close another month first."}

        a_cats = json.loads(a.category_totals_json or "{}")
        b_cats = json.loads(b.category_totals_json or "{}")

        all_cats = set(a_cats.keys()) | set(b_cats.keys())
        cat_deltas = {c: round(a_cats.get(c, 0.0) - b_cats.get(c, 0.0), 2) for c in all_cats}

        return {
            "month_a": a.month,
            "month_b": b.month,
            "total_spent_delta": round(a.total_spent - b.total_spent, 2),
            "debt_paid_delta": round(a.debt_paid - b.debt_paid, 2),
            "interest_delta": round(a.interest_charged - b.interest_charged, 2),
            "top_category_a": a.top_category,
            "top_category_b": b.top_category,
            "category_deltas": cat_deltas,
            "adherence_a": a.adherence_score,
            "adherence_b": b.adherence_score,
        }
    finally:
        db.close()

@app.get("/advice/latest")
def latest_advice(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        a = (
            db.query(AdviceLog)
            .filter(AdviceLog.user_id == user_id)
            .order_by(AdviceLog.created_at.desc())
            .first()
        )
        if not a:
            return {"user_id": user_id, "latest": None}

        return {
            "user_id": user_id,
            "latest": {
                "period_start": a.period_start.isoformat(),
                "period_end": a.period_end.isoformat(),
                "advice_type": a.advice_type,
                "advice_payload": json.loads(a.advice_payload_json or "{}"),
                "compliance_score": a.compliance_score,
                "outcome": json.loads(a.outcome_json or "{}"),
                "created_at": a.created_at.isoformat(),
            },
        }
    finally:
        db.close()


@app.get("/advice/history")
def advice_history(
    user_id: Optional[str] = None,
    limit: int = 10,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        rows = (
            db.query(AdviceLog)
            .filter(AdviceLog.user_id == user_id)
            .order_by(AdviceLog.created_at.desc())
            .limit(limit)
            .all()
        )
        return {
            "user_id": user_id,
            "items": [
                {
                    "period_start": r.period_start.isoformat(),
                    "period_end": r.period_end.isoformat(),
                    "advice_type": r.advice_type,
                    "advice_payload": json.loads(r.advice_payload_json or "{}"),
                    "compliance_score": r.compliance_score,
                    "created_at": r.created_at.isoformat(),
                }
                for r in rows
            ],
        }
    finally:
        db.close()

from collections import defaultdict

def _range_week(now: datetime):
    start = now - timedelta(days=7)
    end = now
    return start, end

def _range_prev_week(now: datetime):
    start = now - timedelta(days=14)
    end = now - timedelta(days=7)
    return start, end

def _month_range(year: int, month: int):
    last_day = monthrange(year, month)[1]
    start = datetime(year, month, 1)
    end = datetime(year, month, last_day, 23, 59, 59)
    return start, end

def _txns_in_range(db, user_id: str, start: datetime, end: datetime):
    # posted_date is stored as ISO string like "2026-01-16T00:00:00"
    rows = (
        db.query(Transaction)
        .join(Statement, Statement.id == Transaction.statement_id)
        .filter(Statement.user_id == user_id)
        .all()
    )

    out = []
    for r in rows:
        if not r.posted_date:
            continue
        try:
            dt = datetime.fromisoformat(str(r.posted_date))
        except Exception:
            continue
        if start <= dt <= end:
            out.append(r)
    return out

def _sum_by_category(rows):
    totals = defaultdict(float)
    total_spent = 0.0
    for r in rows:
        if r.txn_type == "purchase" and r.amount and r.amount > 0:
            total_spent += float(r.amount)
            cat = r.category or "Uncategorized"
            totals[cat] += float(r.amount)
    return round(total_spent, 2), {k: round(v, 2) for k, v in totals.items()}

def _top_n_merchants(rows, n=5):
    totals = defaultdict(float)
    for r in rows:
        if r.txn_type == "purchase" and r.amount and r.amount > 0:
            name = (r.description or "Unknown").strip()
            totals[name] += float(r.amount)
    items = sorted(totals.items(), key=lambda x: x[1], reverse=True)[:n]
    return [{"merchant": k, "total": round(v, 2)} for k, v in items]

def _recurring_guess(rows):
    # Very simple heuristic:
    # same description appears 2+ times AND amounts within ~10%
    by_desc = defaultdict(list)
    for r in rows:
        if r.txn_type == "purchase" and r.amount and r.amount > 0 and r.description:
            by_desc[r.description.strip()].append(float(r.amount))

    recurring = []
    for desc, amts in by_desc.items():
        if len(amts) < 2:
            continue
        avg = sum(amts) / len(amts)
        ok = all(abs(a - avg) <= avg * 0.10 for a in amts)  # within 10%
        if ok:
            recurring.append({
                "merchant": desc,
                "count": len(amts),
                "avg_amount": round(avg, 2),
                "total": round(sum(amts), 2),
            })
    recurring.sort(key=lambda x: x["total"], reverse=True)
    return recurring[:10]


@app.get("/insights/week")
def insights_week(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        w_start, w_end = _range_week(now)
        p_start, p_end = _range_prev_week(now)

        w_rows = _txns_in_range(db, user_id, w_start, w_end)
        p_rows = _txns_in_range(db, user_id, p_start, p_end)

        w_total, w_cats = _sum_by_category(w_rows)
        p_total, p_cats = _sum_by_category(p_rows)

        delta = round(w_total - p_total, 2)

        top_cat = None
        if w_cats:
            top_cat = max(w_cats.items(), key=lambda x: x[1])[0]

        # Simple suggestion: if spending went up, suggest moving 20% of delta to debt
        move_to_debt = 0.0
        if delta > 0:
            move_to_debt = round(delta * 0.20, 2)

        return {
            "range": {"start": w_start.date().isoformat(), "end": w_end.date().isoformat()},
            "total_spent": w_total,
            "delta_vs_last_week": delta,
            "top_category": top_cat,
            "category_totals": w_cats,
            "suggestion": (
                f"Spending is up by ${delta:.2f}. Consider moving ${move_to_debt:.2f} to debt repayment."
                if delta > 0 else
                "Nice — spending is not higher than last week. Keep the discipline."
            ),
        }
    finally:
        db.close()


@app.get("/insights/month")
def insights_month(
    user_id: Optional[str] = None,
    year: Optional[int] = None,
    month: Optional[int] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        y = year or now.year
        m = month or now.month

        start, end = _month_range(y, m)
        rows = _txns_in_range(db, user_id, start, end)

        total_spent, cats = _sum_by_category(rows)
        top_merchants = _top_n_merchants(rows, n=7)
        recurring = _recurring_guess(rows)

        top_cat = None
        if cats:
            top_cat = max(cats.items(), key=lambda x: x[1])[0]

        return {
            "month": f"{y:04d}-{m:02d}",
            "range": {"start": start.date().isoformat(), "end": end.date().isoformat()},
            "total_spent": total_spent,
            "top_category": top_cat,
            "category_totals": cats,
            "top_merchants": top_merchants,
            "recurring_guess": recurring,
        }
    finally:
        db.close()


@app.get("/insights/recurring")
def insights_recurring(
    user_id: Optional[str] = None,
    months_back: int = 3,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        now = datetime.utcnow()
        start = now - timedelta(days=30 * max(1, months_back))
        end = now

        rows = _txns_in_range(db, user_id, start, end)
        recurring = _recurring_guess(rows)

        return {
            "range": {"start": start.date().isoformat(), "end": end.date().isoformat()},
            "months_back": months_back,
            "recurring": recurring,
        }
    finally:
        db.close()

@app.get("/insights/coach")
def insights_coach(
    user_id: Optional[str] = None,
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    db = SessionLocal()
    try:
        now = datetime.utcnow()

        # ranges
        this_w_start, this_w_end = _range_week(now)
        prev_w_start, prev_w_end = _range_prev_week(now)

        # pull txns
        this_rows = _txns_in_range(db, user_id, this_w_start, this_w_end)
        prev_rows = _txns_in_range(db, user_id, prev_w_start, prev_w_end)

        # totals
        this_total, this_cats = _sum_by_category(this_rows)
        prev_total, prev_cats = _sum_by_category(prev_rows)
        delta = round(this_total - prev_total, 2)

        # top category shift
        def top_cat(cats: dict):
            if not cats:
                return None, 0.0
            k, v = max(cats.items(), key=lambda x: x[1])
            return k, float(v)

        this_top, this_top_amt = top_cat(this_cats)
        prev_top, prev_top_amt = top_cat(prev_cats)

        # merchant spikes (top merchants this week)
        top_merchants = _top_n_merchants(this_rows, n=5)

        # simple anomaly: big single purchase
        biggest = None
        biggest_amt = 0.0
        for r in this_rows:
            if r.txn_type == "purchase" and r.amount and float(r.amount) > biggest_amt:
                biggest_amt = float(r.amount)
                biggest = r

        big_purchase = None
        if biggest and biggest_amt >= 100:  # threshold
            big_purchase = {
                "merchant": biggest.description or "Unknown",
                "amount": round(biggest_amt, 2),
                "posted_date": datetime.fromisoformat(str(biggest.posted_date)).date().isoformat()
                if biggest.posted_date else None
            }

        # profile context
        profile = db.query(Profile).filter(Profile.user_id == user_id).first()
        extra_debt_target = float(profile.extra_debt_target) if (profile and profile.extra_debt_target) else 0.0

        # latest statement context
        stmt = (
            db.query(Statement)
            .filter(Statement.user_id == user_id)
            .order_by(Statement.created_at.desc())
            .first()
        )
        interest = float(stmt.interest_charged) if (stmt and stmt.interest_charged is not None) else 0.0
        balance = float(stmt.new_balance) if (stmt and stmt.new_balance is not None) else 0.0
        apr = float(stmt.apr) if (stmt and stmt.apr is not None) else None

        # generate "smart" message
        if prev_total == 0 and this_total == 0:
            headline = "No purchase spending detected in the last 2 weeks."
        elif delta > 0:
            headline = f"Spending increased by ${delta:.2f} vs last week."
        elif delta < 0:
            headline = f"Spending decreased by ${abs(delta):.2f} vs last week."
        else:
            headline = "Spending is flat vs last week."

        # next best action
        action = None
        if delta > 0 and this_top:
            action = {
                "type": "cut_top_category",
                "text": f"Cut {this_top} by ${round(delta,2):.2f} this week and move it to debt.",
                "suggested_amount": round(delta, 2),
                "category": this_top
            }
        elif extra_debt_target > 0:
            action = {
                "type": "pay_extra_debt",
                "text": f"Pay an extra ${extra_debt_target:.2f} toward your highest-APR debt on Friday.",
                "suggested_amount": round(extra_debt_target, 2),
            }
        else:
            action = {
                "type": "track_spend",
                "text": "Log your purchases and keep categories clean so insights stay accurate."
            }

        # confidence score (how much real purchase data exists)
        purchase_count = sum(1 for r in this_rows if r.txn_type == "purchase" and r.amount and float(r.amount) > 0)
        confidence = "Low"
        if purchase_count >= 10:
            confidence = "High"
        elif purchase_count >= 3:
            confidence = "Medium"

        return {
            "range": {"start": this_w_start.date().isoformat(), "end": this_w_end.date().isoformat()},
            "headline": headline,
            "this_week_total_spent": this_total,
            "last_week_total_spent": prev_total,
            "top_category": this_top,
            "top_merchants": top_merchants,
            "big_purchase_alert": big_purchase,
            "debt_context": {
                "balance": round(balance, 2),
                "interest_charged": round(interest, 2),
                "apr": apr
            },
            "next_best_action": action,
            "confidence": confidence
        }

    finally:
        db.close()


# ==========================================================
# Financial OS Phase 2 — Debt Registry + Utilization + Recurring
# ==========================================================
from collections import defaultdict
from datetime import date

def _iso_to_date(s: str):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s)[:10]).date()
    except Exception:
        return None

def _next_monthly_due_from_day(day: int, today: date = None):
    """
    Compute the next monthly occurrence for a day-of-month anchor.
    Clamps to the month's last valid day (e.g. 31 -> 30/28 when needed).
    """
    if not day:
        return None

    today = today or date.today()
    try:
        day = int(day)
    except Exception:
        return None

    if day < 1:
        return None

    y, m = today.year, today.month
    for i in range(0, 24):
        mm = m + i
        yy = y + (mm - 1) // 12
        mm_mod = ((mm - 1) % 12) + 1
        last = monthrange(yy, mm_mod)[1]
        candidate = date(yy, mm_mod, min(day, last))
        if candidate >= today:
            return candidate

    return None

def _resolve_debt_due_date_for_planning(d, today: date = None):
    """
    Prefer the explicit due_date when it's still upcoming.
    If that imported statement due_date is stale or missing, fall back to the
    recurring due_day so planning doesn't undercount debt minimums.
    """
    today = today or date.today()
    due = _iso_to_date(getattr(d, "due_date", None))
    if due and due >= today:
        return due

    if getattr(d, "due_day", None):
        return _next_monthly_due_from_day(d.due_day, today=today)

    return due

def _to_float(x, default=0.0):
    try:
        if x is None:
            return default
        return float(x)
    except Exception:
        return default

def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"

def _normalize_merchant_local(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _latest_statement_per_card(db: Session, user_id: str):
    """
    Return latest Statement per (card_name + card_last4) based on statement_period end date.
    Falls back to account_label when card_name is missing so older rows still group safely.
    """
    rows = db.query(Statement).filter(Statement.user_id == user_id).all()
    by_key = {}
    for st in rows:
        card_name = getattr(st, "card_name", None) or st.account_label or "Card"
        key = (card_name, getattr(st, "card_last4", None) or "")
        end_dt = _parse_statement_end_date(st.statement_period) or datetime.min
        prev = by_key.get(key)
        if not prev:
            by_key[key] = (st, end_dt)
        else:
            if end_dt > prev[1]:
                by_key[key] = (st, end_dt)
    return [v[0] for v in by_key.values()]

@app.post("/os/debts/refresh-from-statements")
def os_refresh_debts_from_statements(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    Phase 2: Build/refresh Debt registry from credit card Statements.
    - For each latest statement per card, upsert a Debt row.
    - Sets: balance=new_balance, minimum_due, apr, due_date, last4.
    """
    user_id = _coerce_user_id(current_user, user_id)
    latest = _latest_statement_per_card(db, user_id)

    upserted = 0
    created = 0

    for st in latest:
        last4 = getattr(st, "card_last4", None) or None
        name = getattr(st, "card_name", None) or (st.account_label or "Card")
        lender = st.account_label or "Issuer"

        # Find existing debt row by (user_id + last4 + lender) if possible
        q = db.query(Debt).filter(Debt.user_id == user_id)

        if last4:
            q = q.filter(Debt.last4 == last4)
        # also match on name/lender loosely
        existing = q.filter(Debt.name == name).first() if last4 else q.filter(Debt.name == name).first()

        if not existing:
            existing = Debt(user_id=user_id, kind="credit_card", lender=lender, name=name, last4=last4, active=True)
            db.add(existing)
            created += 1

        existing.kind = "credit_card"
        existing.lender = lender
        existing.name = name
        existing.last4 = last4

        existing.apr = _to_float(getattr(st, "apr", None), default=None)
        existing.balance = _to_float(getattr(st, "new_balance", 0.0), default=0.0)
        existing.minimum_due = _to_float(getattr(st, "minimum_payment", None), default=None)
        existing.due_date = getattr(st, "due_date", None)

        # If due_date exists like "02/15/2026" you can optionally compute due_day later.
        # Keep simple: if it's ISO, we can set due_day.
        dd = _iso_to_date(existing.due_date)
        if dd:
            existing.due_day = dd.day

        existing.updated_at = datetime.utcnow()
        upserted += 1

    db.commit()

    return {"ok": True, "user_id": user_id, "upserted": upserted, "created": created}


@app.get("/os/debts/utilization")
def os_debt_utilization(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    Utilization per debt (if credit_limit provided) + totals.
    """
    user_id = _coerce_user_id(current_user, user_id)
    debts = _active_debt_rows(db, user_id)

    items = []
    total_bal = 0.0
    total_limit = 0.0

    for d in debts:
        bal = _to_float(d.balance, 0.0)
        lim = _to_float(d.credit_limit, 0.0) if d.credit_limit is not None else 0.0

        util = None
        if lim > 0:
            util = round((bal / lim) * 100.0, 2)

        items.append({
            "id": d.id,
            "name": d.name,
            "lender": d.lender,
            "last4": d.last4,
            "apr": d.apr,
            "balance": round(bal, 2),
            "credit_limit": round(lim, 2) if lim > 0 else None,
            "utilization_pct": util,
            "minimum_due": d.minimum_due,
            "due_date": d.due_date,
            "due_day": d.due_day,
        })

        total_bal += bal
        if lim > 0:
            total_limit += lim

    total_util = None
    if total_limit > 0:
        total_util = round((total_bal / total_limit) * 100.0, 2)

    return {
        "ok": True,
        "user_id": user_id,
        "total_balance": round(total_bal, 2) if debts else None,
        "total_limit": round(total_limit, 2) if total_limit > 0 else None,
        "total_utilization_pct": total_util,
        "items": items,
    }


def _pull_all_txns_for_recurring(db: Session, user_id: str, months_back: int = 4):
    """
    Pull card + cash transactions into a normalized list:
    {source, posted_date(date), merchant_norm, merchant, amount_abs}
    """
    cutoff = date.today() - timedelta(days=30 * max(1, months_back))
    out = []

    # Card txns
    card_rows = (
        db.query(Transaction, Statement)
        .join(Statement, Statement.id == Transaction.statement_id)
        .filter(Statement.user_id == user_id)
        .all()
    )
    for (t, st) in card_rows:
        dt = None
        if getattr(t, "posted_date", None):
            try:
                dt = datetime.fromisoformat(str(t.posted_date)[:10]).date()
            except Exception:
                dt = None
        if not dt or dt < cutoff:
            continue

        desc = (t.description or "").strip()
        amt = _to_float(t.amount, 0.0)
        if amt == 0 or not desc:
            continue

        out.append({
            "source": "card",
            "posted_date": dt,
            "merchant": desc,
            "merchant_norm": _normalize_merchant_local(desc),
            "amount_abs": abs(float(amt)),
        })

    # Cash txns
    cash_rows = (
        db.query(CashTransaction, CashAccount)
        .join(CashAccount, CashAccount.id == CashTransaction.cash_account_id)
        .filter(CashAccount.user_id == user_id)
        .all()
    )
    for (t, acc) in cash_rows:
        dt = _parse_posted_date(getattr(t, "posted_date", None))
        if not dt or dt < cutoff:
            continue

        desc = (t.description or "").strip()
        amt = _to_float(t.amount, 0.0)
        if amt == 0 or not desc:
            continue

        out.append({
            "source": "cash",
            "posted_date": dt,
            "merchant": desc,
            "merchant_norm": _normalize_merchant_local(desc),
            "amount_abs": abs(float(amt)),
        })

    return out


def _detect_monthly_candidates(rows):
    """
    Heuristic monthly recurring:
    - same merchant_norm appears >=2 times
    - amounts within 10%
    - spacing typically 25..35 days between occurrences (rough)
    """
    by_m = defaultdict(list)
    for r in rows:
        by_m[r["merchant_norm"]].append(r)

    candidates = []
    for mnorm, items in by_m.items():
        if len(items) < 2:
            continue

        items = sorted(items, key=lambda x: x["posted_date"])
        amts = [x["amount_abs"] for x in items]
        avg = sum(amts) / len(amts)
        if avg <= 0:
            continue

        # amount stability
        stable = all(abs(a - avg) <= avg * 0.10 for a in amts)
        if not stable:
            continue

        # spacing
        deltas = []
        for i in range(1, len(items)):
            deltas.append((items[i]["posted_date"] - items[i-1]["posted_date"]).days)
        monthly_like = any(25 <= d <= 35 for d in deltas)

        if not monthly_like:
            continue

        last = items[-1]["posted_date"]
        next_guess = last + timedelta(days=30)

        # confidence
        conf = 0.55
        if len(items) >= 3:
            conf += 0.15
        if any(28 <= d <= 32 for d in deltas):
            conf += 0.15
        conf = min(0.95, conf)

        candidates.append({
            "merchant_norm": mnorm,
            "merchant": items[-1]["merchant"],
            "avg_amount": round(avg, 2),
            "last_seen": last.isoformat(),
            "next_due_guess": next_guess.isoformat(),
            "frequency": "monthly",
            "confidence": conf,
            "source": items[-1]["source"],
        })

    # sort biggest first
    candidates.sort(key=lambda x: x["avg_amount"], reverse=True)
    return candidates


@app.post("/os/recurring/detect")
def os_detect_recurring(
    user_id: Optional[str] = None,
    months_back: int = 4,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    Detect recurring candidates and upsert into recurring_candidates table.
    """
    user_id = _coerce_user_id(current_user, user_id)
    rows = _pull_all_txns_for_recurring(db, user_id, months_back=months_back)
    cands = _detect_monthly_candidates(rows)

    upserted = 0
    for c in cands:
        existing = (
            db.query(RecurringCandidate)
            .filter(
                RecurringCandidate.user_id == user_id,
                RecurringCandidate.merchant_norm == c["merchant_norm"],
            )
            .first()
        )
        if not existing:
            existing = RecurringCandidate(
                user_id=user_id,
                merchant=c["merchant"],
                merchant_norm=c["merchant_norm"],
                accepted=False,
            )
            db.add(existing)

        existing.merchant = c["merchant"]
        existing.frequency_guess = c["frequency"]
        existing.avg_amount = _to_float(c["avg_amount"], default=None)
        existing.last_seen_date = c["last_seen"]
        existing.next_due_date_guess = c["next_due_guess"]
        existing.confidence = float(c["confidence"] or 0.0)
        existing.source = c.get("source")
        existing.updated_at = datetime.utcnow()

        upserted += 1

    db.commit()
    return {"ok": True, "user_id": user_id, "months_back": months_back, "detected": len(cands), "upserted": upserted}


@app.get("/os/recurring")
def os_list_recurring(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    rows = (
        db.query(RecurringCandidate)
        .filter(RecurringCandidate.user_id == user_id)
        .order_by(RecurringCandidate.confidence.desc(), RecurringCandidate.avg_amount.desc().nullslast())
        .all()
    )
    return [
        {
            "id": r.id,
            "merchant": r.merchant,
            "merchant_norm": r.merchant_norm,
            "frequency_guess": r.frequency_guess,
            "avg_amount": r.avg_amount,
            "last_seen_date": r.last_seen_date,
            "next_due_date_guess": r.next_due_date_guess,
            "confidence": r.confidence,
            "source": r.source,
            "accepted": r.accepted,
            "essentials_guess": r.essentials_guess,
        }
        for r in rows
    ]


@app.patch("/os/recurring/{recurring_id}")
def os_update_recurring(
    recurring_id: int,
    user_id: Optional[str] = None,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    r = db.query(RecurringCandidate).filter(
        RecurringCandidate.id == recurring_id,
        RecurringCandidate.user_id == user_id
    ).first()
    if not r:
        raise HTTPException(status_code=404, detail="Recurring candidate not found")

    # allowed fields
    if "accepted" in payload:
        r.accepted = bool(payload["accepted"])
    if "essentials_guess" in payload:
        r.essentials_guess = bool(payload["essentials_guess"])
    if "next_due_date_guess" in payload:
        r.next_due_date_guess = payload["next_due_date_guess"]
    if "avg_amount" in payload and payload["avg_amount"] is not None:
        r.avg_amount = float(payload["avg_amount"])

    r.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(r)

    return {"ok": True, "id": r.id}


def _sum_essentials_monthly(db: Session, user_id: str):
    """
    Essentials cap (monthly):
    - sum active bills where essentials=True
    - plus sum minimum_due across active debts (as baseline obligations)
    """
    bills = db.query(Bill).filter(Bill.user_id == user_id, _active_financial_os_clause(Bill), Bill.essentials == True).all()
    # include manual bills (monthly-equivalent) in essentials total
    manual_bills = db.query(ManualBill).filter(ManualBill.user_id == user_id, _active_financial_os_clause(ManualBill)).all()
    debts = db.query(Debt).filter(Debt.user_id == user_id, _active_financial_os_clause(Debt)).all()

    bills_total = sum(_to_float(b.amount, 0.0) for b in bills)

    def _monthly_equivalent(mb):
        amt = _to_float(mb.amount, 0.0)
        freq = (mb.frequency or "monthly").lower()
        if freq == "weekly":
            return amt * (52.0 / 12.0)
        if freq == "biweekly":
            return amt * (26.0 / 12.0)
        if freq == "monthly":
            return amt
        if freq == "quarterly":
            return amt * (4.0 / 12.0)
        if freq == "yearly":
            return amt / 12.0
        if freq == "one_time":
            return amt / 12.0
        return amt

    # sum only manual bills categorized as Essentials (default)
    mb_total = sum(_monthly_equivalent(mb) for mb in manual_bills if (mb.category or "Essentials") == "Essentials")

    bills_total = bills_total + mb_total

    debt_mins = 0.0
    for d in debts:
        if d.minimum_due is not None:
            debt_mins += _to_float(d.minimum_due, 0.0)

    return round(bills_total, 2), round(debt_mins, 2), round(bills_total + debt_mins, 2)


@app.get("/os/essentials-cap")
def os_essentials_cap(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    bills_total, debt_mins_total, total = _sum_essentials_monthly(db, user_id)
    return {
        "ok": True,
        "user_id": user_id,
        "monthly": {
            "essentials_bills_total": bills_total,
            "debt_minimums_total": debt_mins_total,
            "essentials_cap_total": total
        }
    }


def _cash_total_latest(db: Session, user_id: str) -> Optional[float]:
    """
    Use latest imported/manual cash balances plus non-duplicate Plaid cash-like balances.
    """
    imported_cash_total = _imported_cash_total_latest(db, user_id)
    plaid_breakdown = _plaid_cash_breakdown(db, user_id)
    plaid_cash_total = round(float(plaid_breakdown["included_total"]), 2)

    if imported_cash_total is None and not plaid_breakdown["included"]:
        return None

    total = _to_float(imported_cash_total, 0.0) + plaid_cash_total
    return round(float(total), 2)


def _financial_os_source_counts(db: Session, user_id: str) -> dict:
    linked_cash_count = (
        db.query(PlaidAccount.id)
        .join(PlaidItem, PlaidAccount.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidAccount.user_id == user_id,
            PlaidItem.user_id == user_id,
            PlaidAccount.is_cash_like == True,
            or_(PlaidItem.status == "linked", PlaidItem.status.is_(None), PlaidItem.status == "partial"),
            or_(PlaidAccount.sync_status != "superseded", PlaidAccount.sync_status.is_(None)),
        )
        .count()
    )
    imported_cash_count = len(_latest_imported_cash_rows(db, user_id))
    bill_count = db.query(Bill.id).filter(Bill.user_id == user_id, _active_financial_os_clause(Bill)).count()
    manual_bill_count = (
        db.query(ManualBill.id)
        .filter(ManualBill.user_id == user_id, _active_financial_os_clause(ManualBill))
        .count()
    )
    debt_count = db.query(Debt.id).filter(Debt.user_id == user_id, _active_financial_os_clause(Debt)).count()
    debt_with_minimum_count = (
        db.query(Debt.id)
        .filter(
            Debt.user_id == user_id,
            _active_financial_os_clause(Debt),
            Debt.minimum_due.isnot(None),
            Debt.minimum_due > 0,
        )
        .count()
    )

    return {
        "imported_cash_sources": int(imported_cash_count or 0),
        "linked_cash_sources": int(linked_cash_count or 0),
        "cash_sources_total": int((imported_cash_count or 0) + (linked_cash_count or 0)),
        "bill_registry_count": int(bill_count or 0),
        "manual_obligation_count": int(manual_bill_count or 0),
        "tracked_debt_count": int(debt_count or 0),
        "tracked_debt_minimum_count": int(debt_with_minimum_count or 0),
    }


def _financial_os_data_status(source_counts: dict) -> dict:
    cash_ready = (source_counts.get("cash_sources_total") or 0) > 0
    obligations_ready = (
        (source_counts.get("bill_registry_count") or 0)
        + (source_counts.get("manual_obligation_count") or 0)
        + (source_counts.get("tracked_debt_minimum_count") or 0)
    ) > 0
    debt_ready = (source_counts.get("tracked_debt_count") or 0) > 0
    return {
        "cash": "ready" if cash_ready else "empty",
        "obligations": "ready" if obligations_ready else "empty",
        "debt_registry": "ready" if debt_ready else "empty",
    }


def _pdf_cash_total_latest(db: Session, user_id: str) -> Optional[float]:
    """
    Latest imported/manual checking + savings balances across unique imported cash sources.
    Kept separate so Financial OS can explain the combined cash total cleanly.
    """
    return _imported_cash_total_latest(db, user_id)


def _has_schedule_fallback_obligation(
    *,
    frequency: Optional[str],
    due_date_value: Optional[str],
    today: Optional[date] = None,
) -> bool:
    today = today or date.today()
    freq = (frequency or "monthly").strip().lower()
    parsed_due = _iso_to_date(due_date_value) if due_date_value else None

    if freq in ("once", "one_time"):
        return False
    if parsed_due and parsed_due < today:
        return False
    return True


def _active_debt_rows(db: Session, user_id: str) -> list[Debt]:
    return (
        db.query(Debt)
        .filter(Debt.user_id == user_id, _active_financial_os_clause(Debt))
        .all()
    )


def _upcoming_window_items(db: Session, user_id: str, days: int = 21):
    """
    Combine:
    - bills due within window
    - manual bills due within window
    - debt minimums due within window
    """
    today = date.today()
    horizon = today + timedelta(days=days)

    items = []
    has_data = False

    # Bills
    bills = db.query(Bill).filter(Bill.user_id == user_id, _active_financial_os_clause(Bill)).all()
    for b in bills:
        has_data = True
        due = _resolve_schedule_due_date(
            frequency=b.frequency,
            due_day=b.due_day,
            due_date_value=b.next_due_date,
            created_at=b.created_at,
            today=today,
        )

        if due and today <= due <= horizon:
            items.append({
                "type": "bill",
                "source": "bill_registry",
                "name": b.name,
                "amount": round(_to_float(b.amount, 0.0), 2),
                "due_date": due.isoformat(),
                "frequency": b.frequency,
                "category": b.category,
                "autopay": bool(b.autopay),
                "id": b.id,
            })
        elif due is None and _has_schedule_fallback_obligation(
            frequency=b.frequency,
            due_date_value=b.next_due_date,
            today=today,
        ):
            items.append({
                "type": "bill",
                "source": "bill_registry",
                "name": b.name,
                "amount": round(_to_float(b.amount, 0.0), 2),
                "due_date": None,
                "frequency": b.frequency,
                "category": b.category,
                "autopay": bool(b.autopay),
                "id": b.id,
                "planning_fallback": True,
            })

    # Manual bills (user-entered)
    manual_bills = db.query(ManualBill).filter(ManualBill.user_id == user_id, _active_financial_os_clause(ManualBill)).all()
    for mb in manual_bills:
        has_data = True
        due = _resolve_schedule_due_date(
            frequency=mb.frequency,
            due_day=mb.due_day,
            due_date_value=mb.due_date,
            created_at=mb.created_at,
            today=today,
        )

        # final inclusion
        if due and today <= due <= horizon:
            items.append({
                "type": "manual_bill",
                "source": "manual_bills",
                "name": mb.name,
                "amount": round(_to_float(mb.amount, 0.0), 2),
                "due_date": due.isoformat(),
                "frequency": mb.frequency,
                "category": mb.category,
                "autopay": bool(mb.autopay),
                "id": mb.id,
            })
        elif due is None and _has_schedule_fallback_obligation(
            frequency=mb.frequency,
            due_date_value=mb.due_date,
            today=today,
        ):
            items.append({
                "type": "manual_bill",
                "source": "manual_bills",
                "name": mb.name,
                "amount": round(_to_float(mb.amount, 0.0), 2),
                "due_date": None,
                "frequency": mb.frequency,
                "category": mb.category,
                "autopay": bool(mb.autopay),
                "id": mb.id,
                "planning_fallback": True,
            })

    # Debts minimums
    debts = _active_debt_rows(db, user_id)
    for d in debts:
        minimum_due = _to_float(d.minimum_due, default=None)
        if minimum_due is None:
            continue
        has_data = True
        due = _resolve_debt_due_date_for_planning(d, today=today)
        if due and today <= due <= horizon:
            items.append({
                "type": "debt_minimum",
                "source": "debt_registry",
                "name": f"{d.name} minimum",
                "amount": round(minimum_due, 2),
                "due_date": due.isoformat(),
                "frequency": "monthly",
                "category": "Debt",
                "autopay": None,
                "apr": d.apr,
                "last4": d.last4,
                "id": d.id,
            })
        elif due is None or due < today:
            items.append({
                "type": "debt_minimum",
                "source": "debt_registry",
                "name": f"{d.name} minimum",
                "amount": round(minimum_due, 2),
                "due_date": None,
                "frequency": "monthly",
                "category": "Debt",
                "autopay": None,
                "apr": d.apr,
                "last4": d.last4,
                "id": d.id,
                "planning_fallback": True,
            })

    items.sort(key=lambda x: (x["due_date"] is None, x["due_date"] or "", x["name"] or ""))
    total = round(sum(_to_float(i["amount"], 0.0) for i in items), 2)

    return items, (total if has_data else None)


@app.get("/os/next-best-dollar")
def os_next_best_dollar(
    user_id: Optional[str] = None,
    window_days: int = 21,
    buffer: float = 100.0,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    Next Best Dollar (Phase 2 minimal engine):
    1) Cash total (latest cash statement end balances)
    2) Upcoming obligations in next N days (bills + manual obligations + debt minimums)
    3) Safe-to-Spend = cash - upcoming
    4) If surplus > 0 => recommend extra payment to highest APR debt (avalanche)
    """
    user_id = _coerce_user_id(current_user, user_id)
    source_counts = _financial_os_source_counts(db, user_id)
    data_status = _financial_os_data_status(source_counts)
    cash_total = _cash_total_latest(db, user_id)
    items, upcoming_total = _upcoming_window_items(db, user_id, days=window_days)
    cash_sources = _plaid_cash_sources_payload(db, user_id, cash_total)
    upcoming_summary = _summarize_upcoming_items(items)
    financial_os_v2 = _compute_financial_os_v2(db, user_id, window_days=window_days)

    sts_today = round(_to_float(financial_os_v2.get("current_period_safe_to_spend"), 0.0), 2)
    available_sts = round(_to_float(financial_os_v2.get("current_period_safe_to_spend"), 0.0), 2)
    breakdown = _build_financial_os_breakdown(
        cash_total=_to_float(cash_total, 0.0),
        cash_sources=cash_sources,
        upcoming_summary=upcoming_summary,
        upcoming_total=_to_float(upcoming_total, 0.0),
        buffer=buffer,
        final_safe_to_spend=sts_today,
    )

    stage = _financial_os_v2_stage(financial_os_v2)
    rec = None
    target_debt_id = ((financial_os_v2.get("debt_payoff_projection") or {}).get("target_debt_id"))
    for item in (financial_os_v2.get("debt_payoff_projection") or {}).get("debts") or []:
        if target_debt_id and item.get("debt_id") == target_debt_id and _to_float(item.get("recommended_extra_payment"), 0.0) > 0:
            rec = {
                "debt_id": item.get("debt_id"),
                "name": item.get("name"),
                "last4": None,
                "apr": item.get("apr"),
                "available_sts": available_sts,
                "recommended_extra_payment": round(_to_float(item.get("recommended_extra_payment"), 0.0), 2),
                "why": "Highest APR debt first after due-soon obligations, runway, and the discretionary cap are protected.",
            }
            break

    return {
        "ok": True,
        "user_id": user_id,
        "window_days": window_days,
        "buffer": round(float(buffer), 2),
        "cash_total": round(float(cash_total), 2) if cash_total is not None else None,
        "upcoming_total": round(float(upcoming_total), 2) if upcoming_total is not None else None,
        "safe_to_spend_today": sts_today,
        "available_sts": available_sts,
        "stage": stage,
        "upcoming_items": items,
        "cash_sources": cash_sources,
        "source_counts": source_counts,
        "data_status": data_status,
        "upcoming_summary": upcoming_summary,
        "breakdown": breakdown,
        "financial_os_v2": financial_os_v2,
        "calculation": {
            "formula": "safe_to_spend_today now comes from Financial OS V2 and is capped by protected reserves plus the remaining discretionary plan.",
            "cash_total": round(float(cash_total), 2) if cash_total is not None else None,
            "upcoming_total": round(float(upcoming_total), 2) if upcoming_total is not None else None,
            "buffer": round(float(buffer), 2),
            "safe_to_spend_today": sts_today,
            "available_sts": available_sts,
            "recommended_extra_payment": round(_to_float((rec or {}).get("recommended_extra_payment"), 0.0), 2),
        },
        "recommendation": rec,
    }


@app.get("/os/state")
def os_state(
    user_id: Optional[str] = None,
    window_days: int = 21,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    One endpoint your UI can call to power Settings + Dashboard panels.
    """
    user_id = _coerce_user_id(current_user, user_id)
    source_counts = _financial_os_source_counts(db, user_id)
    data_status = _financial_os_data_status(source_counts)
    cash_total = _cash_total_latest(db, user_id)
    upcoming_items, upcoming_total = _upcoming_window_items(db, user_id, days=window_days)
    financial_os_v2 = _compute_financial_os_v2(db, user_id, window_days=window_days)

    bills_total, debt_mins_total, essentials_total = _sum_essentials_monthly(db, user_id)

    # include active manual bills list for UI
    manual_bills_list = db.query(ManualBill).filter(ManualBill.user_id == user_id, _active_financial_os_clause(ManualBill)).order_by(ManualBill.name.asc()).all()

    util = os_debt_utilization(user_id=user_id, db=db, current_user=current_user)
    cash_sources = _plaid_cash_sources_payload(db, user_id, cash_total)
    upcoming_summary = _summarize_upcoming_items(upcoming_items)
    decision_plan = _build_decision_plan(financial_os_v2, upcoming_items)
    return {
        "ok": True,
        "user_id": user_id,
        "cash_total": round(float(cash_total), 2) if cash_total is not None else None,
        "cash_sources": cash_sources,
        "source_counts": source_counts,
        "data_status": data_status,
        "upcoming_window_days": window_days,
        "upcoming_total": round(float(upcoming_total), 2) if upcoming_total is not None else None,
        "upcoming_items": upcoming_items,
        "upcoming_summary": upcoming_summary,
        "manual_bills": manual_bills_list,
        "decision_plan": decision_plan,
        "financial_os_v2": financial_os_v2,
        "setup_status": (financial_os_v2 or {}).get("setup_status") or {
            "state": "ready",
            "reasons": [],
            "overall_status": "complete",
            "trust_level": "high",
            "completed_count": 0,
            "total_count": 0,
            "items": [],
        },
        "essentials_cap_monthly": {
            "essentials_bills_total": bills_total,
            "debt_minimums_total": debt_mins_total,
            "essentials_cap_total": essentials_total,
        },
        "calculation": {
            "cash_total": round(float(cash_total), 2) if cash_total is not None else None,
            "upcoming_total": round(float(upcoming_total), 2) if upcoming_total is not None else None,
            "safe_to_spend_formula": "Use financial_os_v2.current_period_safe_to_spend for the reserve-aware discretionary allowance.",
        },
        "debt_utilization": util,
    }


@app.get("/os/v2/state")
def os_v2_state(
    user_id: Optional[str] = None,
    window_days: int = 21,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    user_id = _coerce_user_id(current_user, user_id)
    source_counts = _financial_os_source_counts(db, user_id)
    data_status = _financial_os_data_status(source_counts)
    upcoming_items, upcoming_total = _upcoming_window_items(db, user_id, days=window_days)
    return {
        "ok": True,
        "user_id": user_id,
        "window_days": window_days,
        "upcoming_total": round(float(upcoming_total), 2) if upcoming_total is not None else None,
        "upcoming_items": upcoming_items,
        "source_counts": source_counts,
        "data_status": data_status,
        "financial_os_v2": _compute_financial_os_v2(db, user_id, window_days=window_days),
    }


def _goal_value_map(db: Session, user_id: str) -> dict:
    rows = db.query(Goal).filter(Goal.user_id == user_id).all()
    out = {}
    for row in rows:
        out[row.key] = _to_float(row.value, 0.0)
    return out


def _goal_value(goals: dict, key: str, default: Optional[float] = None) -> Optional[float]:
    raw = goals.get(key)
    value = _to_float(raw, default if default is not None else 0.0)
    if value <= 0:
        return default
    return value


ESSENTIAL_SPEND_CATEGORIES = {
    "Housing",
    "Utilities",
    "Groceries",
    "Fuel",
    "Transport",
    "Insurance",
    "Medical",
    "Kids/Family",
    "Education",
    "Taxes",
    "Loan",
}

DISCRETIONARY_SPEND_CATEGORIES = {
    "Dining",
    "Subscriptions",
    "Shopping",
    "Entertainment",
    "Travel",
    "Personal Care",
    "Gifts/Donations",
    "Other",
}


def _monthly_equivalent_amount(amount: float, frequency: Optional[str], include_one_time: bool = False) -> float:
    amt = _to_float(amount, 0.0)
    freq = (frequency or "monthly").strip().lower()
    if freq == "weekly":
        return amt * (52.0 / 12.0)
    if freq == "biweekly":
        return amt * (26.0 / 12.0)
    if freq == "monthly":
        return amt
    if freq == "quarterly":
        return amt * (4.0 / 12.0)
    if freq in {"yearly", "annual"}:
        return amt / 12.0
    if freq in {"one_time", "once"}:
        return (amt / 12.0) if include_one_time else 0.0
    return amt


def _profile_monthly_essentials_baseline(db: Session, user_id: str) -> float:
    profile = db.query(Profile).filter(Profile.user_id == user_id).order_by(Profile.updated_at.desc(), Profile.id.desc()).first()
    if not profile:
        return 0.0
    return round(
        _to_float(profile.rent_monthly, 0.0)
        + _to_float(profile.car_loan_monthly, 0.0)
        + _to_float(profile.utilities_monthly, 0.0)
        + (_to_float(profile.fuel_weekly, 0.0) * (52.0 / 12.0)),
        2,
    )


def _registry_monthly_cash_flow_baseline(db: Session, user_id: str) -> dict:
    essential_total = 0.0
    discretionary_total = 0.0

    bills = db.query(Bill).filter(Bill.user_id == user_id, _active_financial_os_clause(Bill)).all()
    for bill in bills:
        amount = _monthly_equivalent_amount(_to_float(bill.amount, 0.0), getattr(bill, "frequency", None))
        category = (getattr(bill, "category", None) or "").strip().lower()
        is_discretionary = category == "discretionary" or getattr(bill, "essentials", True) is False
        if is_discretionary:
            discretionary_total += amount
        else:
            essential_total += amount

    manual_bills = db.query(ManualBill).filter(ManualBill.user_id == user_id, _active_financial_os_clause(ManualBill)).all()
    for manual_bill in manual_bills:
        amount = _monthly_equivalent_amount(
            _to_float(manual_bill.amount, 0.0),
            getattr(manual_bill, "frequency", None),
        )
        category = (getattr(manual_bill, "category", None) or "Essentials").strip().lower()
        if category == "discretionary":
            discretionary_total += amount
        else:
            essential_total += amount

    debt_minimums_monthly = round(
        sum(
            _to_float(getattr(debt, "minimum_due", None), 0.0)
            for debt in _active_debt_rows(db, user_id)
            if _to_float(getattr(debt, "balance", None), 0.0) > 0
        ),
        2,
    )

    return {
        "essential_monthly": round(essential_total, 2),
        "discretionary_monthly": round(discretionary_total, 2),
        "debt_minimums_monthly": debt_minimums_monthly,
    }


def _flatten_spend_rows(source_activity: dict[str, list[dict]]) -> list[dict]:
    out: list[dict] = []
    for rows in source_activity.values():
        out.extend(rows or [])
    return out


def _is_essential_spend_category(category: Optional[str]) -> bool:
    normalized = _normalize_insight_category(category)
    return normalized in ESSENTIAL_SPEND_CATEGORIES


def _is_discretionary_spend_category(category: Optional[str]) -> bool:
    normalized = _normalize_insight_category(category)
    if not normalized:
        return True
    if normalized in ESSENTIAL_SPEND_CATEGORIES:
        return False
    return normalized in DISCRETIONARY_SPEND_CATEGORIES or normalized not in {"Income", "Debt Payment", "Fees & Interest"}


def _month_start_and_end(today: date) -> tuple[date, date]:
    last_day = monthrange(today.year, today.month)[1]
    return date(today.year, today.month, 1), date(today.year, today.month, last_day)


def _average_monthly_spend(rows: list[dict], *, category_filter) -> float:
    eligible = []
    for row in rows:
        posted = row.get("date")
        if not isinstance(posted, date):
            continue
        if _to_float(row.get("amount"), 0.0) <= 0:
            continue
        if not category_filter(row.get("category")):
            continue
        eligible.append(row)

    if not eligible:
        return 0.0

    latest_date = max(row["date"] for row in eligible)
    window_start = latest_date - timedelta(days=89)
    monthly_totals: dict[str, float] = defaultdict(float)
    for row in eligible:
        posted = row["date"]
        if posted < window_start or posted > latest_date:
            continue
        monthly_totals[_month_key(posted)] += _to_float(row.get("amount"), 0.0)

    if not monthly_totals:
        return 0.0

    return round(sum(monthly_totals.values()) / len(monthly_totals), 2)


def _month_to_date_spend(rows: list[dict], *, today: date, category_filter) -> float:
    month_start, _ = _month_start_and_end(today)
    total = 0.0
    for row in rows:
        posted = row.get("date")
        if not isinstance(posted, date):
            continue
        if posted < month_start or posted > today:
            continue
        if not category_filter(row.get("category")):
            continue
        total += _to_float(row.get("amount"), 0.0)
    return round(total, 2)


def _looks_like_income_flow(description: Optional[str], category: Optional[str], txn_type: Optional[str]) -> bool:
    text = f"{description or ''} {category or ''} {txn_type or ''}".strip().lower()
    if not text:
        return False
    if any(token in text for token in ["transfer", "zelle", "withdrawal from", "withdrawal to", "deposit from 360", "interest paid"]):
        return False
    return any(token in text for token in ["payroll", "paycheck", "salary", "direct dep", "direct deposit", "income"])


def _income_rows(db: Session, user_id: str) -> list[dict]:
    out: list[dict] = []

    cash_rows = (
        db.query(CashTransaction, CashAccount)
        .join(CashAccount, CashAccount.id == CashTransaction.cash_account_id)
        .filter(CashAccount.user_id == user_id)
        .all()
    )
    for txn, account in cash_rows:
        posted = _parse_posted_date(getattr(txn, "posted_date", None))
        amount = _to_float(getattr(txn, "amount", None), 0.0)
        description = getattr(txn, "description", None)
        category = getattr(txn, "category", None)
        txn_type = getattr(txn, "txn_type", None)
        if not posted or amount <= 0:
            continue
        if not _looks_like_income_flow(description, category, txn_type):
            continue
        out.append({
            "date": posted,
            "amount": round(amount, 2),
            "source": getattr(account, "account_name", None) or getattr(account, "account_label", None) or "Cash",
        })

    manual_rows = db.query(ManualTransaction).filter(ManualTransaction.user_id == user_id).all()
    for txn in manual_rows:
        posted = _iso_to_date(getattr(txn, "date", None))
        amount = _to_float(getattr(txn, "amount", None), 0.0)
        if not posted or amount >= 0:
            continue
        out.append({
            "date": posted,
            "amount": round(abs(amount), 2),
            "source": "Manual",
        })

    plaid_rows = (
        db.query(PlaidTransaction, PlaidAccount, PlaidItem)
        .join(PlaidAccount, PlaidTransaction.plaid_account_id == PlaidAccount.id)
        .join(PlaidItem, PlaidTransaction.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidTransaction.user_id == user_id,
            PlaidAccount.user_id == user_id,
            PlaidItem.user_id == user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
            or_(PlaidAccount.sync_status != "superseded", PlaidAccount.sync_status.is_(None)),
        )
        .all()
    )
    for txn, account, item in plaid_rows:
        posted = _iso_to_date(getattr(txn, "posted_date", None))
        amount = _to_float(getattr(txn, "amount", None), 0.0)
        merchant = getattr(txn, "merchant_name", None) or getattr(txn, "name", None)
        if not posted or amount <= 0 or getattr(txn, "pending", False):
            continue
        if not _looks_like_income_flow(merchant, getattr(txn, "category_primary", None), None):
            continue
        out.append({
            "date": posted,
            "amount": round(amount, 2),
            "source": getattr(account, "name", None) or getattr(item, "institution_name", None) or "Plaid",
        })

    return out


def _estimate_monthly_income_baseline(db: Session, user_id: str) -> Optional[float]:
    rows = _income_rows(db, user_id)
    if not rows:
        return None

    latest_date = max(row["date"] for row in rows)
    window_start = latest_date - timedelta(days=89)
    monthly_totals: dict[str, float] = defaultdict(float)
    for row in rows:
        posted = row["date"]
        if posted < window_start or posted > latest_date:
            continue
        monthly_totals[_month_key(posted)] += _to_float(row.get("amount"), 0.0)

    usable = [value for value in monthly_totals.values() if value > 0]
    if not usable:
        return None
    return round(sum(usable) / len(usable), 2)


def _resolve_runway_target_months(settings: dict, goals: dict) -> float:
    goal_value = _goal_value(goals, "runway_target_months", None)
    if goal_value is not None and goal_value > 0:
        return round(goal_value, 2)

    settings_candidates = [
        _settings_value(settings, ["financialOS", "stageTargets", "runwayMonthsSecurityGoal"], None),
        _settings_value(settings, ["financialOS", "savings", "emergencyFundGoalMonths"], None),
    ]
    for candidate in settings_candidates:
        value = _to_float(candidate, 0.0)
        if value > 0:
            return round(value, 2)

    return 3.0


def _resolve_monthly_discretionary_cap(
    *,
    settings: dict,
    monthly_income_baseline: Optional[float],
    discretionary_baseline: float,
    discretionary_registry_monthly: float,
) -> dict:
    explicit_paths = [
        ["financialOS", "sts", "monthlyDiscretionaryCap"],
        ["financialOS", "paycheck", "monthlyDiscretionaryCap"],
        ["financialOS", "spending", "monthlyDiscretionaryCap"],
    ]
    for path in explicit_paths:
        configured = _to_float(_settings_value(settings, path, None), 0.0)
        if configured > 0:
            return {
                "cap": round(configured, 2),
                "source": ".".join(path),
                "mode": "explicit_monthly_cap",
                "spend_pct": None,
                "fallback_baseline": None,
                "pending_income_cap": False,
            }

    split_mode = str(_settings_value(settings, ["financialOS", "paycheck", "splitMode"], "") or "").strip().lower()
    spend_pct = None
    if split_mode == "manualbuckets":
        spend_pct = _to_float(_settings_value(settings, ["financialOS", "paycheck", "manualBuckets", "spendPct"], None), 0.0)
    else:
        spend_pct = _to_float(_settings_value(settings, ["financialOS", "paycheck", "threeCaps", "discretionaryCapPct"], None), 0.0)

    if monthly_income_baseline and spend_pct and spend_pct > 0:
        return {
            "cap": round(monthly_income_baseline * (spend_pct / 100.0), 2),
            "source": f"paycheck_spend_pct_{round(spend_pct, 2)}",
            "mode": "income_percentage_cap",
            "spend_pct": round(spend_pct, 2),
            "fallback_baseline": None,
            "pending_income_cap": False,
        }

    derived_baseline = max(_to_float(discretionary_baseline, 0.0), _to_float(discretionary_registry_monthly, 0.0))
    if derived_baseline > 0:
        return {
            "cap": round(derived_baseline, 2),
            "source": "recent_discretionary_baseline",
            "mode": "fallback_recent_discretionary_baseline",
            "spend_pct": round(spend_pct, 2) if spend_pct and spend_pct > 0 else None,
            "fallback_baseline": round(derived_baseline, 2),
            "pending_income_cap": bool(spend_pct and spend_pct > 0 and monthly_income_baseline is None),
        }

    return {
        "cap": 0.0,
        "source": "missing_discretionary_plan",
        "mode": "missing_discretionary_plan",
        "spend_pct": round(spend_pct, 2) if spend_pct and spend_pct > 0 else None,
        "fallback_baseline": None,
        "pending_income_cap": bool(spend_pct and spend_pct > 0 and monthly_income_baseline is None),
    }


def _financial_os_setup_reasons(
    *,
    monthly_income_baseline: Optional[float],
    cap_details: dict,
) -> list[dict]:
    reasons: list[dict] = []

    if monthly_income_baseline is None:
        spend_pct = _to_float(cap_details.get("spend_pct"), 0.0)
        if spend_pct > 0:
            detail = (
                f"Discretionary cap is set to {spend_pct:.0f}% in Settings, but there is no monthly income baseline yet "
                "to turn that percentage into a dollar cap."
            )
        else:
            detail = "No monthly income baseline is available yet, so paycheck-based planning stays incomplete."
        reasons.append({
            "code": "missing_monthly_income_baseline",
            "label": "Monthly income baseline missing",
            "detail": detail,
        })

    if str(cap_details.get("mode") or "") == "missing_discretionary_plan":
        reasons.append({
            "code": "missing_discretionary_plan",
            "label": "Discretionary plan missing",
            "detail": "Set a monthly discretionary cap or build enough recent discretionary history to derive one automatically.",
        })

    return reasons

def _build_financial_os_setup_status(
    *,
    db: Session,
    user_id: str,
    settings: dict,
    goals: dict,
    snapshot: dict,
    monthly_income_baseline: Optional[float],
    monthly_essentials: float,
    planned_monthly_discretionary_baseline: float,
    fi_target_amount: float,
    fi_target_source: str,
    legacy_setup_reasons: Optional[list[dict]] = None,
) -> dict:
    active_paychecks = (
        db.query(Paycheck)
        .filter(Paycheck.user_id == user_id, _active_financial_os_clause(Paycheck))
        .all()
    )
    configured_monthly_income = round(
        max(_to_float(_settings_value(settings, ["financialOS", "paycheck", "monthlyIncome"], None), 0.0), 0.0),
        2,
    )
    monthly_income_confirmed = bool(
        _settings_value(settings, ["financialOS", "setupConfirmations", "monthlyIncomeConfirmed"], False)
    )
    has_confirmed_monthly_income = monthly_income_confirmed and configured_monthly_income > 0

    bill_count = db.query(Bill.id).filter(Bill.user_id == user_id, _active_financial_os_clause(Bill)).count()
    manual_bill_count = (
        db.query(ManualBill.id)
        .filter(ManualBill.user_id == user_id, _active_financial_os_clause(ManualBill))
        .count()
    )
    essentials_count = int((bill_count or 0) + (manual_bill_count or 0))

    active_debt_count = db.query(Debt.id).filter(Debt.user_id == user_id, _active_financial_os_clause(Debt)).count()

    runway_target_months = round(max(_to_float(snapshot.get("runway_target_months"), 3.0), 0.0), 2) or 3.0
    runway_target_confirmed = bool(
        _settings_value(settings, ["financialOS", "setupConfirmations", "runwayTargetConfirmed"], False)
    )

    cadence_value = str(
        _settings_value(settings, ["financialOS", "paycheck", "cadence"], None)
        or (getattr(active_paychecks[0], "frequency", None) if active_paychecks else None)
        or "Weekly"
    ).strip() or "Weekly"
    cadence_confirmed = bool(
        _settings_value(settings, ["financialOS", "setupConfirmations", "paycheckCadenceConfirmed"], False)
    )
    cadence_status = "confirmed" if cadence_confirmed else "default"

    debt_strategy_value = str(
        _settings_value(settings, ["financialOS", "debt", "strategy"], None)
        or "Hybrid (Next Best Dollar)"
    ).strip() or "Hybrid (Next Best Dollar)"
    debt_strategy_confirmed = bool(
        _settings_value(settings, ["financialOS", "setupConfirmations", "debtStrategyConfirmed"], False)
    )
    debt_strategy_status = "confirmed" if debt_strategy_confirmed else "default"

    fi_target_status = "missing"
    if fi_target_source == "user_set_goal" and fi_target_amount > 0:
        fi_target_status = "confirmed"
    elif fi_target_amount > 0 and round(monthly_essentials + planned_monthly_discretionary_baseline, 2) > 0:
        fi_target_status = "derived"

    legacy_reasons: list[dict] = list(legacy_setup_reasons or [])
    items = [
        {
            "key": "monthly_income",
            "label": "Monthly income",
            "status": "confirmed" if has_confirmed_monthly_income else ("detected" if monthly_income_baseline is not None else "missing"),
            "value": configured_monthly_income if has_confirmed_monthly_income else monthly_income_baseline,
            "required": True,
            "reason": (
                "Using your confirmed monthly income."
                if has_confirmed_monthly_income
                else "Using detected income. Confirm it for stronger recommendations."
                if monthly_income_baseline is not None
                else "Set and confirm monthly income so spending caps and recommendations stay grounded."
            ),
            "action": "Confirm in Settings" if not has_confirmed_monthly_income else "Review income",
            "href": "/settings#income-paycheck",
        },
        {
            "key": "fixed_essentials",
            "label": "Fixed essentials",
            "status": "confirmed" if essentials_count > 0 else "missing",
            "value": monthly_essentials if monthly_essentials > 0 else None,
            "required": True,
            "reason": (
                f"{essentials_count} essential bill{'s' if essentials_count != 1 else ''} are feeding your plan."
                if essentials_count > 0
                else "Add bills or essential obligations so the dashboard can protect them."
            ),
            "action": "Review bills" if essentials_count > 0 else "Add bills",
            "href": "/bills",
        },
        {
            "key": "debt_registry",
            "label": "Debt registry",
            "status": "confirmed" if active_debt_count > 0 else "missing",
            "value": int(active_debt_count or 0) if active_debt_count > 0 else None,
            "required": True,
            "reason": (
                f"{active_debt_count} active debt account{'s' if active_debt_count != 1 else ''} are tracked."
                if active_debt_count > 0
                else "Add debts so payoff recommendations have a real registry to use."
            ),
            "action": "Review debts" if active_debt_count > 0 else "Add debts",
            "href": "/debts",
        },
        {
            "key": "runway_target",
            "label": "Runway target",
            "status": "confirmed" if runway_target_confirmed else "default",
            "value": runway_target_months,
            "required": False,
            "reason": (
                "Using your saved runway target."
                if runway_target_confirmed
                else "Using the default runway target until you confirm one in Settings."
            ),
            "action": "Confirm in Settings" if not runway_target_confirmed else "Review runway target",
            "href": "/settings#runway-target",
        },
        {
            "key": "fi_target",
            "label": "FI target",
            "status": fi_target_status,
            "value": round(fi_target_amount, 2) if fi_target_amount > 0 else None,
            "required": False,
            "reason": (
                "Using your saved FI target."
                if fi_target_status == "confirmed"
                else "Using annual required spend x 25."
                if fi_target_status == "derived"
                else "FI target is not available yet."
            ),
            "action": "Set FI target" if fi_target_status != "confirmed" else "Review FI target",
            "href": "/settings#fi-target",
        },
        {
            "key": "paycheck_cadence",
            "label": "Paycheck cadence",
            "status": cadence_status,
            "value": cadence_value,
            "required": False,
            "reason": (
                "Using your saved paycheck cadence."
                if cadence_status == "confirmed"
                else "Using the default paycheck cadence until you save your cadence or payday hint."
            ),
            "action": "Confirm in Settings" if cadence_status != "confirmed" else "Review cadence",
            "href": "/settings#income-paycheck",
        },
        {
            "key": "debt_strategy",
            "label": "Debt strategy",
            "status": debt_strategy_status,
            "value": debt_strategy_value,
            "required": False,
            "reason": (
                "Using your saved debt strategy."
                if debt_strategy_status == "confirmed"
                else "Using the default debt strategy until you save your preference."
            ),
            "action": "Confirm in Settings" if debt_strategy_status != "confirmed" else "Review strategy",
            "href": "/settings#debt-strategy",
        },
    ]

    for item in items:
        if item["required"] and item["status"] == "missing":
            legacy_reasons.append({
                "code": f"missing_{item['key']}",
                "label": f"{item['label']} missing",
                "detail": item["reason"],
            })

    required_missing = any(item["required"] and item["status"] == "missing" for item in items)
    review_needed = any(
        (item["required"] and item["status"] != "confirmed")
        or ((not item["required"]) and item["status"] in {"default", "missing"})
        for item in items
    )

    if required_missing:
        overall_status = "missing_required"
        trust_level = "low"
    elif review_needed:
        overall_status = "needs_review"
        trust_level = "medium"
    else:
        overall_status = "complete"
        trust_level = "high"

    completed_count = sum(1 for item in items if item["status"] != "missing")
    if any(item["key"] == "monthly_income" and item["status"] == "detected" for item in items):
        legacy_reasons.append({
            "code": "detected_monthly_income",
            "label": "Monthly income detected",
            "detail": "Income was detected from recent activity, but confirming it will make recommendations more reliable.",
        })

    return {
        "state": "setup_required" if required_missing else "ready",
        "reasons": legacy_reasons,
        "overall_status": overall_status,
        "trust_level": trust_level,
        "completed_count": completed_count,
        "total_count": len(items),
        "items": items,
    }


def _financial_os_sts_reason(
    *,
    obligations_funded: bool,
    runway_funded: bool,
    setup_required: bool,
    monthly_discretionary_cap: float,
    remaining_discretionary_this_month: float,
    remaining_discretionary_this_period: float,
    available_discretionary_cash: float,
    savings_goal_cash: float,
    current_period_safe_to_spend: float,
) -> dict:
    if not obligations_funded:
        return {
            "code": "obligations_not_protected",
            "label": "Obligations not protected",
            "detail": "Bills/manual obligations and debt minimums are not fully covered yet, so discretionary spending stays blocked.",
            "state": "blocked",
        }

    if not runway_funded:
        return {
            "code": "runway_reserve_underfunded",
            "label": "Runway reserve underfunded",
            "detail": "Cash is being held to build the runway reserve before more discretionary spending is allowed.",
            "state": "blocked",
        }

    if setup_required and monthly_discretionary_cap <= 0.01:
        return {
            "code": "no_spending_plan_or_income_baseline",
            "label": "Setup required",
            "detail": "The discretionary spending allowance is $0 because there is not enough income/discretionary-plan data to create a usable monthly cap yet.",
            "state": "setup_required",
        }

    if remaining_discretionary_this_month <= 0.01 or remaining_discretionary_this_period <= 0.01:
        return {
            "code": "discretionary_cap_exhausted",
            "label": "Discretionary cap exhausted",
            "detail": "This month's discretionary plan has already been used, so the discretionary spending allowance stays at $0 until the cap resets or the plan changes.",
            "state": "blocked",
        }

    if available_discretionary_cash <= 0.01 and savings_goal_cash > 0.01:
        return {
            "code": "fi_cash_protected",
            "label": "FI cash protected first",
            "detail": "Runway is funded, but the remaining cash is currently reserved for the planned FI/savings contribution.",
            "state": "blocked",
        }

    if current_period_safe_to_spend > 0.01:
        return {
            "code": "discretionary_room_available",
            "label": "Discretionary room available",
            "detail": "Protected obligations, runway, and planned savings are covered, and the current discretionary plan still has room.",
            "state": "available",
        }

    return {
        "code": "no_reserve_supported_discretionary_room",
        "label": "No reserve-supported discretionary room",
        "detail": "There is no protected discretionary spending room available right now, even though obligations and runway are already covered.",
        "state": "blocked",
    }


def _build_discretionary_explanation(
    *,
    monthly_income_baseline: Optional[float],
    cap_details: dict,
    monthly_discretionary_cap: float,
    discretionary_spend_month_to_date: float,
    remaining_discretionary_this_month: float,
    available_discretionary_cash: float,
    current_period_safe_to_spend: float,
) -> dict:
    income_source = "detected" if monthly_income_baseline is not None else "missing"
    discretionary_cap_percent = round(max(_to_float(cap_details.get("spend_pct"), 0.0), 0.0), 2)
    discretionary_cap_amount = round(monthly_discretionary_cap, 2) if monthly_discretionary_cap > 0.01 else None
    final_allowance = round(max(_to_float(current_period_safe_to_spend, 0.0), 0.0), 2)

    if income_source == "missing":
        limiting_factor = "income_missing"
        reason_short = "Spending cap cannot be calculated yet"
        reason_detail = "No reliable monthly income detected, so discretionary cap is not fully defined."
        action = "Add or confirm income in Settings or connect checking account."
    elif remaining_discretionary_this_month <= 0.01:
        limiting_factor = "cap_exhausted"
        reason_short = "This month's discretionary cap is fully used"
        reason_detail = "Your non-essential spending has reached your planned cap for this month."
        action = "Pause non-essential spending until next month or adjust cap."
    elif available_discretionary_cash <= 0.01:
        limiting_factor = "cash_protected"
        reason_short = "Cash is reserved for obligations and runway"
        reason_detail = "Bills, runway reserve, and planned savings are currently protecting available cash."
        action = "Wait until obligations clear or reduce protection settings."
    elif final_allowance <= 0.01:
        limiting_factor = "period_limit"
        reason_short = "This period's discretionary allowance is used"
        reason_detail = "Your monthly cap still has room, but this period's share has already been allocated."
        action = "Wait for the next allowance window or keep spending paused until the month resets."
    else:
        limiting_factor = "none"
        reason_short = "Allowance is available inside your current plan"
        reason_detail = "Protected cash is covered and your current discretionary plan still has room this period."
        action = "Stay within this allowance and review the breakdown if it changes."

    return {
        "monthly_income_baseline": monthly_income_baseline,
        "income_source": income_source,
        "discretionary_cap_percent": discretionary_cap_percent,
        "discretionary_cap_amount": discretionary_cap_amount,
        "month_to_date_spend": round(max(_to_float(discretionary_spend_month_to_date, 0.0), 0.0), 2),
        "skipped_duplicate_spend": 0.0,
        "remaining_monthly_cap": round(max(_to_float(remaining_discretionary_this_month, 0.0), 0.0), 2),
        "available_cash_after_protection": round(max(_to_float(available_discretionary_cash, 0.0), 0.0), 2),
        "final_allowance": final_allowance,
        "limiting_factor": limiting_factor,
        "reason_short": reason_short,
        "reason_detail": reason_detail,
        "action": action,
    }


def _project_debt_with_extra(balance: float, apr_pct: Optional[float], minimum_due: float, extra_payment: float) -> dict:
    baseline = _project_single_debt_payoff(balance, apr_pct, minimum_due)
    accelerated = _project_single_debt_payoff(balance, apr_pct, minimum_due + max(_to_float(extra_payment, 0.0), 0.0))
    if not baseline.get("ok"):
        return {
            "minimum_only_months": None,
            "with_extra_months": None,
            "months_saved": None,
            "interest_saved": None,
            "payoff_warning": baseline.get("reason") or "minimum_only_projection_unavailable",
        }
    if not accelerated.get("ok"):
        return {
            "minimum_only_months": int(baseline["months"]),
            "with_extra_months": None,
            "months_saved": None,
            "interest_saved": None,
            "payoff_warning": accelerated.get("reason") or "accelerated_projection_unavailable",
        }
    return {
        "minimum_only_months": int(baseline["months"]),
        "with_extra_months": int(accelerated["months"]),
        "months_saved": max(0, int(baseline["months"]) - int(accelerated["months"])),
        "interest_saved": round(max(0.0, _to_float(baseline.get("interest_paid"), 0.0) - _to_float(accelerated.get("interest_paid"), 0.0)), 2),
        "payoff_warning": None,
    }


def _build_debt_payoff_projection(
    *,
    debts: list,
    target_debt_id: Optional[int],
    recurring_extra_payment: float,
) -> dict:
    projection_items = []
    for debt in debts:
        balance = round(max(_to_float(getattr(debt, "balance", None), 0.0), 0.0), 2)
        minimum_due = round(max(_to_float(getattr(debt, "minimum_due", None), 0.0), 0.0), 2)
        apr = getattr(debt, "apr", None)
        recommended_extra = round(recurring_extra_payment, 2) if target_debt_id and debt.id == target_debt_id else 0.0
        if balance <= 0:
            payoff = {
                "minimum_only_months": 0,
                "with_extra_months": 0,
                "months_saved": 0,
                "interest_saved": 0.0,
                "payoff_warning": None,
            }
        elif minimum_due <= 0:
            payoff = {
                "minimum_only_months": None,
                "with_extra_months": None,
                "months_saved": None,
                "interest_saved": None,
                "payoff_warning": "missing_minimum_due",
            }
        else:
            payoff = _project_debt_with_extra(balance, apr, minimum_due, recommended_extra)

        projection_items.append({
            "debt_id": debt.id,
            "name": debt.name,
            "balance": balance,
            "apr": round(_to_float(apr, 0.0), 2) if apr is not None else None,
            "minimum_due": minimum_due,
            "recommended_extra_payment": recommended_extra,
            **payoff,
        })

    portfolio = _project_portfolio_debt_free(debts, recurring_extra_payment=recurring_extra_payment)
    return {
        "strategy": "avalanche",
        "recurring_extra_payment": round(max(_to_float(recurring_extra_payment, 0.0), 0.0), 2),
        "target_debt_id": target_debt_id,
        "debts": projection_items,
        "portfolio_months_with_extra": int(portfolio["months"]) if portfolio.get("ok") else None,
        "portfolio_interest_with_extra": round(_to_float(portfolio.get("interest_paid"), 0.0), 2) if portfolio.get("ok") else None,
        "portfolio_warning": None if portfolio.get("ok") else portfolio.get("reason"),
    }


def _build_financial_os_v2_from_snapshot(snapshot: dict) -> dict:
    as_of_date = snapshot.get("as_of_date") or date.today()
    if not isinstance(as_of_date, date):
        as_of_date = date.today()

    total_cash = round(max(_to_float(snapshot.get("total_cash"), 0.0), 0.0), 2)
    upcoming_obligations = round(max(_to_float(snapshot.get("upcoming_obligations"), 0.0), 0.0), 2)
    debt_minimums = round(max(_to_float(snapshot.get("debt_minimums"), 0.0), 0.0), 2)
    monthly_essentials = round(max(_to_float(snapshot.get("monthly_essentials"), 0.0), 0.0), 2)
    runway_target_months = round(max(_to_float(snapshot.get("runway_target_months"), 3.0), 0.0), 2) or 3.0
    runway_reserve_target = round(monthly_essentials * runway_target_months, 2)
    monthly_discretionary_cap = round(max(_to_float(snapshot.get("monthly_discretionary_cap"), 0.0), 0.0), 2)
    discretionary_spend_month_to_date = round(max(_to_float(snapshot.get("discretionary_spend_month_to_date"), 0.0), 0.0), 2)
    planned_monthly_discretionary_baseline = round(
        max(
            _to_float(snapshot.get("planned_monthly_discretionary_baseline"), 0.0),
            monthly_discretionary_cap,
        ),
        2,
    )
    monthly_income_baseline = snapshot.get("monthly_income_baseline")
    if monthly_income_baseline is not None:
        monthly_income_baseline = round(max(_to_float(monthly_income_baseline, 0.0), 0.0), 2)
    cap_details = snapshot.get("monthly_discretionary_cap_details") or {}
    setup_reasons = _financial_os_setup_reasons(
        monthly_income_baseline=monthly_income_baseline,
        cap_details=cap_details,
    )
    setup_required = bool(setup_reasons)

    month_start, month_end = _month_start_and_end(as_of_date)
    days_remaining_in_month = max((month_end - as_of_date).days + 1, 1)
    period_days = max(1, min(int(snapshot.get("window_days") or 7), days_remaining_in_month))

    cash_after_due_soon = round(max(total_cash - upcoming_obligations - debt_minimums, 0.0), 2)
    runway_reserve_current = round(min(cash_after_due_soon, runway_reserve_target), 2)
    runway_gap = round(max(runway_reserve_target - runway_reserve_current, 0.0), 2)

    high_apr_threshold = round(max(_to_float(snapshot.get("high_apr_threshold"), 18.0), 0.0), 2) or 18.0
    debts = snapshot.get("debts") or []
    active_debts = [debt for debt in debts if _to_float(getattr(debt, "balance", None), 0.0) > 0]
    priority_debt = _priority_debt_for_intelligence(active_debts)
    high_apr_debt = None
    if priority_debt and _to_float(getattr(priority_debt, "apr", None), 0.0) >= high_apr_threshold:
        high_apr_debt = priority_debt

    monthly_required_spend = round(monthly_essentials + planned_monthly_discretionary_baseline, 2)
    annual_required_spend = round(monthly_required_spend * 12.0, 2)
    fi_target = _to_float(snapshot.get("fi_target"), 0.0)
    fi_target_source = "user_set_goal" if fi_target > 0 else "derived_annual_required_spend_x25"
    if fi_target <= 0:
        fi_target = round(annual_required_spend * 25.0, 2)
    setup_status = _build_financial_os_setup_status(
        db=snapshot["db"],
        user_id=str(snapshot.get("user_id") or ""),
        settings=snapshot.get("settings") or {},
        goals=snapshot.get("goals") or {},
        snapshot=snapshot,
        monthly_income_baseline=monthly_income_baseline,
        monthly_essentials=monthly_essentials,
        planned_monthly_discretionary_baseline=planned_monthly_discretionary_baseline,
        fi_target_amount=fi_target,
        fi_target_source=fi_target_source,
        legacy_setup_reasons=setup_reasons,
    )
    fi_progress_amount = round(max(_to_float(snapshot.get("fi_progress_amount"), total_cash), 0.0), 2)
    fi_progress_percent = round((_clamp01(fi_progress_amount / max(fi_target, 1.0)) * 100.0), 2) if fi_target > 0 else 0.0

    monthly_repeatable_surplus = None
    if monthly_income_baseline is not None:
        monthly_repeatable_surplus = round(
            max(
                monthly_income_baseline - monthly_essentials - debt_minimums - planned_monthly_discretionary_baseline,
                0.0,
            ),
            2,
        )

    runway_funded = runway_gap <= 0.01
    obligations_funded = total_cash >= round(upcoming_obligations + debt_minimums, 2)

    monthly_fi_contribution_recommendation = 0.0
    if obligations_funded and runway_funded and not high_apr_debt and monthly_repeatable_surplus is not None and monthly_repeatable_surplus > 0:
        savings_target = round(max(_to_float(snapshot.get("savings_monthly_target"), 0.0), 0.0), 2)
        if savings_target > 0:
            monthly_fi_contribution_recommendation = round(min(savings_target, monthly_repeatable_surplus), 2)
        else:
            monthly_fi_contribution_recommendation = monthly_repeatable_surplus

    minimum_extra_payment_setting = round(max(_to_float(snapshot.get("minimum_extra_payment_setting"), 0.0), 0.0), 2)
    recurring_extra_payment = 0.0
    if obligations_funded and runway_funded and high_apr_debt and monthly_repeatable_surplus is not None and monthly_repeatable_surplus > 0:
        recurring_extra_payment = round(min(monthly_repeatable_surplus, _to_float(getattr(high_apr_debt, "balance", None), 0.0), 500.0), 2)
        if minimum_extra_payment_setting > 0 and monthly_repeatable_surplus >= minimum_extra_payment_setting:
            recurring_extra_payment = round(max(recurring_extra_payment, min(minimum_extra_payment_setting, 500.0, _to_float(getattr(high_apr_debt, "balance", None), 0.0))), 2)

    savings_goal_cash = 0.0
    if monthly_fi_contribution_recommendation > 0:
        cash_after_runway = round(max(cash_after_due_soon - runway_reserve_current, 0.0), 2)
        savings_goal_cash = round(min(cash_after_runway, monthly_fi_contribution_recommendation), 2)

    protected_cash = round(upcoming_obligations + debt_minimums + runway_reserve_current + savings_goal_cash, 2)
    available_discretionary_cash = round(max(total_cash - protected_cash, 0.0), 2)
    protected_obligations_total = round(upcoming_obligations + debt_minimums, 2)

    remaining_discretionary_this_month = round(max(monthly_discretionary_cap - discretionary_spend_month_to_date, 0.0), 2)
    remaining_discretionary_this_period = round(
        remaining_discretionary_this_month if days_remaining_in_month <= 0 else (remaining_discretionary_this_month * (period_days / days_remaining_in_month)),
        2,
    )
    weekly_discretionary_allowance = round(
        remaining_discretionary_this_month if days_remaining_in_month <= 0 else (remaining_discretionary_this_month * (min(7, days_remaining_in_month) / days_remaining_in_month)),
        2,
    )

    weekly_safe_to_spend = round(
        min(weekly_discretionary_allowance, available_discretionary_cash, remaining_discretionary_this_month),
        2,
    )
    current_period_safe_to_spend = round(
        min(remaining_discretionary_this_period, available_discretionary_cash, remaining_discretionary_this_month),
        2,
    )
    discretionary_explanation = _build_discretionary_explanation(
        monthly_income_baseline=monthly_income_baseline,
        cap_details=cap_details,
        monthly_discretionary_cap=monthly_discretionary_cap,
        discretionary_spend_month_to_date=discretionary_spend_month_to_date,
        remaining_discretionary_this_month=remaining_discretionary_this_month,
        available_discretionary_cash=available_discretionary_cash,
        current_period_safe_to_spend=current_period_safe_to_spend,
    )
    sts_status = _financial_os_sts_reason(
        obligations_funded=obligations_funded,
        runway_funded=runway_funded,
        setup_required=setup_required,
        monthly_discretionary_cap=monthly_discretionary_cap,
        remaining_discretionary_this_month=remaining_discretionary_this_month,
        remaining_discretionary_this_period=remaining_discretionary_this_period,
        available_discretionary_cash=available_discretionary_cash,
        savings_goal_cash=savings_goal_cash,
        current_period_safe_to_spend=current_period_safe_to_spend,
    )
    discretionary_spending_paused = bool(
        current_period_safe_to_spend <= 0.01
        and (
            remaining_discretionary_this_month <= 0.01
            or remaining_discretionary_this_period <= 0.01
        )
    )

    if monthly_fi_contribution_recommendation > 0 and fi_target > fi_progress_amount:
        years_to_fi = round((fi_target - fi_progress_amount) / (monthly_fi_contribution_recommendation * 12.0), 1)
    else:
        years_to_fi = None

    if not obligations_funded:
        next_best_action = {
            "priority": "protect_due_soon",
            "action": "Protect cash for upcoming bills and debt minimums.",
            "amount": round(max((upcoming_obligations + debt_minimums) - total_cash, 0.0), 2),
            "reason": "Upcoming obligations and debt minimums are not fully covered yet.",
        }
    elif not runway_funded:
        next_best_action = {
            "priority": "build_runway",
            "action": "Keep cash reserved to build runway.",
            "amount": runway_gap,
            "reason": f"Runway is below the {runway_target_months:.1f}-month target.",
        }
    elif high_apr_debt and recurring_extra_payment > 0:
        next_best_action = {
            "priority": "pay_high_apr_debt",
            "action": (
                f"Pause discretionary spending, but send the planned extra to {high_apr_debt.name}."
                if discretionary_spending_paused
                else f"Send the next planned extra to {high_apr_debt.name}."
            ),
            "amount": recurring_extra_payment,
            "amount_label": "Extra payoff allocation",
            "allocation_source": "planned_surplus_after_protections",
            "allocation_source_label": "Planned surplus allocation",
            "discretionary_spending_paused": discretionary_spending_paused,
            "reason": (
                f"The discretionary spending allowance is exhausted for now, but {high_apr_debt.name} still gets "
                f"the repeatable extra-payment allocation after bills, minimums, runway, and planned savings are protected."
                if discretionary_spending_paused
                else f"{high_apr_debt.name} carries the highest APR at {_to_float(getattr(high_apr_debt, 'apr', None), 0.0):.2f}%, "
                "so the repeatable planned surplus goes there after protections are covered."
            ),
            "debt_id": high_apr_debt.id,
        }
    elif monthly_fi_contribution_recommendation > 0:
        next_best_action = {
            "priority": "fund_fi",
            "action": "Move the next planned surplus into FI/savings.",
            "amount": monthly_fi_contribution_recommendation,
            "amount_label": "Planned FI allocation",
            "allocation_source": "planned_surplus_after_protections",
            "allocation_source_label": "Planned surplus allocation",
            "discretionary_spending_paused": discretionary_spending_paused,
            "reason": "Runway is funded and there is no high-APR debt blocking savings progress.",
        }
    elif current_period_safe_to_spend > 0:
        next_best_action = {
            "priority": "discretionary",
            "action": "Discretionary spending is allowed inside the current period cap.",
            "amount": current_period_safe_to_spend,
            "amount_label": "Discretionary spend allowance",
            "allocation_source": "discretionary_spending_allowance",
            "allocation_source_label": "Discretionary allowance",
            "discretionary_spending_paused": False,
            "reason": "Protected reserves are funded and the spending plan still has room left this period.",
        }
    else:
        next_best_action = {
            "priority": "hold_cash",
            "action": "Hold cash until a clearer surplus or spending plan appears.",
            "amount": 0.0,
            "amount_label": "Discretionary spend allowance",
            "allocation_source": "protected_cash_hold",
            "allocation_source_label": "Cash protection",
            "discretionary_spending_paused": discretionary_spending_paused,
            "reason": sts_status["detail"],
        }

    debt_payoff_projection = _build_debt_payoff_projection(
        debts=active_debts,
        target_debt_id=high_apr_debt.id if high_apr_debt and recurring_extra_payment > 0 else None,
        recurring_extra_payment=recurring_extra_payment,
    )

    return {
        "as_of_date": as_of_date.isoformat(),
        "window_days": int(snapshot.get("window_days") or 7),
        "monthly_essentials": monthly_essentials,
        "planned_monthly_discretionary_baseline": planned_monthly_discretionary_baseline,
        "monthly_income_baseline": monthly_income_baseline,
        "total_cash": total_cash,
        "protected_cash": protected_cash,
        "protected_runway_cash": runway_reserve_current,
        "upcoming_obligations_cash": upcoming_obligations,
        "bills_manual_obligations_total": upcoming_obligations,
        "debt_minimums_cash": debt_minimums,
        "protected_obligations_total": protected_obligations_total,
        "savings_goal_cash": savings_goal_cash,
        "available_discretionary_cash": available_discretionary_cash,
        "runway_reserve_target": runway_reserve_target,
        "runway_reserve_current": runway_reserve_current,
        "runway_reserve_gap": runway_gap,
        "runway_target_months": runway_target_months,
        "upcoming_obligations": upcoming_obligations,
        "debt_minimums": debt_minimums,
        "monthly_discretionary_cap": monthly_discretionary_cap,
        "discretionary_spend_month_to_date": discretionary_spend_month_to_date,
        "remaining_discretionary_this_month": remaining_discretionary_this_month,
        "remaining_discretionary_this_period": remaining_discretionary_this_period,
        "weekly_safe_to_spend": weekly_safe_to_spend,
        "current_period_safe_to_spend": current_period_safe_to_spend,
        "discretionary_spending_allowance": current_period_safe_to_spend,
        "weekly_discretionary_spending_allowance": weekly_safe_to_spend,
        "discretionary_explanation": discretionary_explanation,
        "discretionary_spending_paused": discretionary_spending_paused,
        "extra_payoff_allocation": recurring_extra_payment,
        "fi_target": round(fi_target, 2),
        "fi_progress_amount": fi_progress_amount,
        "fi_progress_percent": fi_progress_percent,
        "monthly_fi_contribution_recommendation": monthly_fi_contribution_recommendation,
        "years_to_fi": years_to_fi,
        "next_best_action": next_best_action,
        "debt_payoff_projection": debt_payoff_projection,
        "setup_status": setup_status,
        "discretionary_cap_details": {
            "mode": cap_details.get("mode"),
            "source": cap_details.get("source"),
            "spend_pct": cap_details.get("spend_pct"),
            "fallback_baseline": cap_details.get("fallback_baseline"),
            "pending_income_cap": bool(cap_details.get("pending_income_cap")),
            "label": (
                "User-set monthly cap"
                if cap_details.get("mode") == "explicit_monthly_cap"
                else "Income percentage cap"
                if cap_details.get("mode") == "income_percentage_cap"
                else "Recent discretionary baseline fallback"
                if cap_details.get("mode") == "fallback_recent_discretionary_baseline"
                else "Missing discretionary plan"
            ),
        },
        "sts_status": sts_status,
        "fi_target_details": {
            "source": fi_target_source,
            "label": "User-set FI target" if fi_target_source == "user_set_goal" else "Derived FI target",
            "monthly_required_spend": monthly_required_spend,
            "annual_required_spend": annual_required_spend,
            "configured_value": round(_to_float(snapshot.get("fi_target"), 0.0), 2) if _to_float(snapshot.get("fi_target"), 0.0) > 0 else None,
            "formula": "annual_required_spend = (monthly_essentials + planned_monthly_discretionary_baseline) * 12; fi_target = annual_required_spend * 25.",
        },
        "formula_notes": {
            "runway": "runway_reserve_target = monthly_essentials * runway_target_months; runway is protected after due-soon obligations and debt minimums.",
            "sts": "discretionary_spending_allowance = min(remaining_discretionary_this_period, available_discretionary_cash, remaining_discretionary_this_month) after protecting bills/manual obligations, debt minimums, runway, and planned FI cash.",
            "weekly_sts": "weekly_safe_to_spend = min(weekly_discretionary_allowance, available_discretionary_cash, remaining_discretionary_this_month).",
            "fi_target": "If no FI target is set, annual_required_spend = (monthly_essentials + planned_monthly_discretionary_baseline) * 12 and fi_target = annual_required_spend * 25.",
            "fi_years": "years_to_fi uses a conservative no-growth estimate and is null when there is no known monthly FI contribution.",
        },
    }


def _compute_financial_os_v2(
    db: Session,
    user_id: str,
    *,
    window_days: int = 21,
    today: Optional[date] = None,
) -> dict:
    today = today or date.today()
    settings = _user_settings_payload(db, user_id)
    goals = _goal_value_map(db, user_id)
    source_activity, _ = _collect_spending_activity_by_source(db, user_id)
    spend_rows = _flatten_spend_rows(source_activity)
    monthly_income_baseline = _estimate_monthly_income_baseline(db, user_id)
    registry_baseline = _registry_monthly_cash_flow_baseline(db, user_id)
    profile_essentials = _profile_monthly_essentials_baseline(db, user_id)
    avg_essential_spend = _average_monthly_spend(spend_rows, category_filter=_is_essential_spend_category)
    avg_discretionary_spend = _average_monthly_spend(spend_rows, category_filter=_is_discretionary_spend_category)
    discretionary_spend_month_to_date = _month_to_date_spend(
        spend_rows,
        today=today,
        category_filter=_is_discretionary_spend_category,
    )
    monthly_essentials = round(
        max(
            registry_baseline["essential_monthly"],
            profile_essentials,
            avg_essential_spend,
        ),
        2,
    )
    cap_details = _resolve_monthly_discretionary_cap(
        settings=settings,
        monthly_income_baseline=monthly_income_baseline,
        discretionary_baseline=avg_discretionary_spend,
        discretionary_registry_monthly=registry_baseline["discretionary_monthly"],
    )
    planned_monthly_discretionary_baseline = round(
        max(
            cap_details["cap"],
            avg_discretionary_spend,
            registry_baseline["discretionary_monthly"],
        ),
        2,
    )
    upcoming_items, _ = _upcoming_window_items(db, user_id, days=window_days)
    upcoming_summary = _summarize_upcoming_items(upcoming_items)
    upcoming_obligations = round(
        _to_float(upcoming_summary.get("bill_total"), 0.0) + _to_float(upcoming_summary.get("manual_bill_total"), 0.0),
        2,
    )
    upcoming_debt_minimums = round(_to_float(upcoming_summary.get("debt_minimum_total"), 0.0), 2)
    debts = _active_debts_for_intelligence(db, user_id)
    debt_snapshot = _debt_totals_snapshot(debts)
    fi_target = _goal_value(goals, "fi_target", None)
    high_apr_threshold = _to_float(
        _settings_value(settings, ["financialOS", "stageTargets", "debtCostRateHighPct"], 18.0),
        18.0,
    )
    profile = db.query(Profile).filter(Profile.user_id == user_id).order_by(Profile.updated_at.desc(), Profile.id.desc()).first()
    snapshot = {
        "db": db,
        "user_id": user_id,
        "settings": settings,
        "goals": goals,
        "as_of_date": today,
        "window_days": window_days,
        "total_cash": _cash_total_latest(db, user_id),
        "upcoming_obligations": upcoming_obligations,
        "debt_minimums": upcoming_debt_minimums,
        "monthly_essentials": monthly_essentials,
        "runway_target_months": _resolve_runway_target_months(settings, goals),
        "monthly_discretionary_cap": cap_details["cap"],
        "monthly_discretionary_cap_details": cap_details,
        "discretionary_spend_month_to_date": discretionary_spend_month_to_date,
        "planned_monthly_discretionary_baseline": planned_monthly_discretionary_baseline,
        "monthly_income_baseline": monthly_income_baseline,
        "savings_monthly_target": _to_float(getattr(profile, "savings_monthly_target", None), 0.0) if profile else 0.0,
        "fi_target": fi_target,
        "fi_progress_amount": _cash_total_latest(db, user_id),
        "high_apr_threshold": high_apr_threshold,
        "debts": debts,
        "minimum_extra_payment_setting": _to_float(_settings_value(settings, ["financialOS", "debt", "minExtraPayment"], 0.0), 0.0),
    }
    result = _build_financial_os_v2_from_snapshot(snapshot)
    result["inputs"] = {
        "monthly_essentials_sources": {
            "registry_essentials_monthly": registry_baseline["essential_monthly"],
            "profile_essentials_monthly": profile_essentials,
            "avg_essential_spend_monthly": avg_essential_spend,
            "selected_monthly_essentials": monthly_essentials,
        },
        "monthly_discretionary_sources": {
            "cap_source": cap_details["source"],
            "avg_discretionary_spend_monthly": avg_discretionary_spend,
            "registry_discretionary_monthly": registry_baseline["discretionary_monthly"],
            "planned_monthly_discretionary_baseline": planned_monthly_discretionary_baseline,
        },
        "monthly_debt_minimums_total": registry_baseline["debt_minimums_monthly"],
        "upcoming_summary": upcoming_summary,
        "debt_total_balance": debt_snapshot["total_balance"],
        "weighted_apr": debt_snapshot["weighted_apr"],
        "high_apr_threshold": high_apr_threshold,
    }
    return result


def _financial_os_v2_stage(financial_os_v2: dict) -> str:
    priority = str(((financial_os_v2 or {}).get("next_best_action") or {}).get("priority") or "").strip().lower()
    if priority in {"protect_due_soon", "build_runway", "hold_cash"}:
        return "Stabilize"
    if priority == "pay_high_apr_debt":
        return "Attack Debt"
    if priority == "fund_fi":
        return "Build Wealth"
    if priority == "discretionary":
        return "Build Security"
    return "Unknown"


def _decision_plan_money(amount: Optional[float]) -> str:
    value = round(max(_to_float(amount, 0.0), 0.0), 2)
    if abs(value - round(value)) <= 0.001:
        return f"${int(round(value)):,}"
    return f"${value:,.2f}"


def _decision_plan_action_confidence(trust_level: str, *, strong: bool = False) -> str:
    level = (trust_level or "").strip().lower()
    if strong:
        return "high"
    if level == "high":
        return "high"
    if level == "medium":
        return "medium"
    return "low"


def _build_decision_plan(financial_os_v2: Optional[dict], upcoming_items: Optional[list[dict]] = None) -> dict:
    os_v2 = financial_os_v2 or {}
    setup_status = (os_v2.get("setup_status") or {}) if isinstance(os_v2, dict) else {}
    trust_level = str(setup_status.get("trust_level") or "").strip().lower()
    status = "blocked" if trust_level == "low" else "limited" if trust_level == "medium" else "ready"

    discretionary_allowance = round(
        max(
            _to_float(os_v2.get("discretionary_spending_allowance"), os_v2.get("current_period_safe_to_spend")),
            0.0,
        ),
        2,
    )
    remaining_this_month = round(max(_to_float(os_v2.get("remaining_discretionary_this_month"), 0.0), 0.0), 2)
    available_discretionary_cash = round(max(_to_float(os_v2.get("available_discretionary_cash"), 0.0), 0.0), 2)
    extra_payoff_allocation = round(max(_to_float(os_v2.get("extra_payoff_allocation"), 0.0), 0.0), 2)
    upcoming_obligations = round(max(_to_float(os_v2.get("upcoming_obligations"), 0.0), 0.0), 2)
    monthly_fi_contribution = round(max(_to_float(os_v2.get("monthly_fi_contribution_recommendation"), 0.0), 0.0), 2)
    window_days = max(int(os_v2.get("window_days") or 21), 1)

    projection = os_v2.get("debt_payoff_projection") or {}
    projection_debts = projection.get("debts") or []
    target_debt_id = projection.get("target_debt_id") or ((os_v2.get("next_best_action") or {}).get("debt_id"))
    priority_debt = None
    if target_debt_id is not None:
        priority_debt = next((item for item in projection_debts if item.get("debt_id") == target_debt_id), None)
    if priority_debt is None:
        priority_debt = next(
            (item for item in projection_debts if _to_float(item.get("recommended_extra_payment"), 0.0) > 0),
            None,
        )
    priority_debt_name = str((priority_debt or {}).get("name") or "").strip() or "your priority debt"

    upcoming_items = upcoming_items or []
    due_soon_item = None
    dated_upcoming_items = []
    for item in upcoming_items:
        due_on = _iso_to_date(item.get("due_date")) if isinstance(item, dict) else None
        if due_on:
            dated_upcoming_items.append((due_on, item))
    if dated_upcoming_items:
        due_soon_item = sorted(dated_upcoming_items, key=lambda row: row[0])[0][1]
    elif upcoming_items:
        due_soon_item = upcoming_items[0]

    due_soon_amount = round(max(_to_float((due_soon_item or {}).get("amount"), 0.0), 0.0), 2)
    due_soon_name = str((due_soon_item or {}).get("name") or "").strip() or "upcoming obligation"
    due_soon_date = _iso_to_date((due_soon_item or {}).get("due_date")) if due_soon_item else None
    due_soon_type = str((due_soon_item or {}).get("type") or "").strip().lower()

    actions = []

    def add_action(
        *,
        sort_order: int,
        action_type: str,
        label: str,
        amount: Optional[float],
        target: Optional[str],
        timing: str,
        reason: str,
        confidence: str,
        cta_label: str,
        href: Optional[str],
        headline_short: str,
    ) -> None:
        actions.append({
            "sort_order": sort_order,
            "type": action_type,
            "label": label,
            "amount": round(amount, 2) if amount is not None else None,
            "target": target,
            "timing": timing,
            "reason": reason,
            "confidence": confidence,
            "cta_label": cta_label,
            "href": href,
            "headline_short": headline_short,
        })

    if trust_level == "low":
        setup_items = setup_status.get("items") or []
        first_setup_item = next(
            (
                item for item in setup_items
                if item.get("required") and str(item.get("status") or "").strip().lower() != "confirmed"
            ),
            None,
        ) or next(
            (
                item for item in setup_items
                if str(item.get("status") or "").strip().lower() not in {"confirmed", "detected", "derived"}
            ),
            None,
        )
        setup_target = str((first_setup_item or {}).get("label") or "").strip() or "Financial OS setup"
        setup_reason = str((first_setup_item or {}).get("reason") or "").strip()
        if not setup_reason:
            setup_reason = "Key setup inputs still need to be confirmed before the plan can be fully trusted."
        add_action(
            sort_order=1,
            action_type="confirm_setup",
            label="Confirm your Financial OS setup",
            amount=None,
            target=setup_target,
            timing="Now",
            reason=setup_reason,
            confidence="high",
            cta_label=str((first_setup_item or {}).get("action") or "Open setup"),
            href=(first_setup_item or {}).get("href") or "/settings",
            headline_short="Confirm setup",
        )

    if discretionary_allowance <= 0.01:
        if remaining_this_month <= 0.01:
            pause_reason = "Your monthly discretionary cap is fully used."
            pause_timing = "Until the monthly cap resets"
        elif available_discretionary_cash <= 0.01:
            pause_reason = "Cash is being protected for bills, debt minimums, runway, or planned savings first."
            pause_timing = "Until protected cash opens back up"
        else:
            pause_reason = "Your current period allowance is used for now."
            pause_timing = "For the rest of this planning window"
        add_action(
            sort_order=2 if trust_level == "low" else 1,
            action_type="pause_spending",
            label="Pause non-essential spending",
            amount=0.0,
            target=None,
            timing=pause_timing,
            reason=pause_reason,
            confidence=_decision_plan_action_confidence(trust_level),
            cta_label="",
            href=None,
            headline_short="Pause spending",
        )

    if extra_payoff_allocation > 0.01 and priority_debt_name:
        add_action(
            sort_order=3 if trust_level == "low" else 2,
            action_type="pay_debt",
            label="Pay extra toward your priority debt",
            amount=extra_payoff_allocation,
            target=priority_debt_name,
            timing="This month",
            reason=(
                f"{priority_debt_name} is still the best use of planned surplus after bills, minimums, runway, "
                "and planned savings protections are covered."
            ),
            confidence=_decision_plan_action_confidence(trust_level),
            cta_label="Review debt plan",
            href="/debts",
            headline_short="Pay high-APR debt",
        )

    if upcoming_obligations > 0.01:
        bill_href = "/debts" if due_soon_type == "debt_minimum" else "/manual-bills" if due_soon_type == "manual_bill" else "/bills"
        protect_amount = due_soon_amount if due_soon_amount > 0.01 else upcoming_obligations
        protect_target = due_soon_name if due_soon_item else "upcoming bills"
        protect_timing = f"Due {due_soon_date.isoformat()}" if due_soon_date else f"Over the next {window_days} days"
        protect_reason = (
            f"{due_soon_name} is inside your near-term planning window, so keep its cash protected before making extra moves."
            if due_soon_item
            else "Upcoming obligations still need protected cash before you make extra moves."
        )
        add_action(
            sort_order=4 if trust_level == "low" else 3,
            action_type="protect_cash",
            label=f"Keep cash protected for {protect_target}" if due_soon_item else "Keep cash protected for upcoming obligations",
            amount=protect_amount,
            target=protect_target if due_soon_item else "Upcoming obligations",
            timing=protect_timing,
            reason=protect_reason,
            confidence="high" if due_soon_item else _decision_plan_action_confidence(trust_level),
            cta_label="Review due items",
            href=bill_href,
            headline_short="Protect cash",
        )

    if monthly_fi_contribution > 0.01 and extra_payoff_allocation <= 0.01:
        add_action(
            sort_order=5 if trust_level == "low" else 4,
            action_type="save_cash",
            label="Move planned surplus into savings",
            amount=monthly_fi_contribution,
            target="FI / savings goal",
            timing="This month",
            reason="Bills, minimums, and runway are covered, so planned surplus can keep building savings.",
            confidence=_decision_plan_action_confidence(trust_level),
            cta_label="Review savings goal",
            href="/settings#fi-target",
            headline_short="Save planned surplus",
        )

    if not actions:
        add_action(
            sort_order=1,
            action_type="protect_cash",
            label="Stay inside your current plan",
            amount=discretionary_allowance if discretionary_allowance > 0.01 else None,
            target="Current Financial OS plan",
            timing="This period",
            reason="Your key protections are in place, so the next step is following the current plan without forcing extra moves.",
            confidence=_decision_plan_action_confidence(trust_level, strong=(trust_level == "high")),
            cta_label="Review dashboard",
            href="/dashboard",
            headline_short="Follow the plan",
        )

    actions = sorted(actions, key=lambda item: item["sort_order"])
    serialized_actions = []
    for idx, action in enumerate(actions, start=1):
        serialized_actions.append({
            "priority": idx,
            "type": action["type"],
            "label": action["label"],
            "amount": action["amount"],
            "target": action["target"],
            "timing": action["timing"],
            "reason": action["reason"],
            "confidence": action["confidence"],
            "cta_label": action["cta_label"],
            "href": action["href"],
        })

    headline_parts = [action["headline_short"] for action in actions[:2] if action.get("headline_short")]
    headline = ", ".join(headline_parts) if headline_parts else "Follow your current Financial OS plan"

    summary_parts = []
    if status == "blocked":
        summary_parts.append("Some setup details still need confirmation, so treat this plan as lower confidence until the checklist is complete.")
    elif status == "limited":
        summary_parts.append("This plan is usable, but a few setup details are still estimated.")

    if discretionary_allowance <= 0.01:
        summary_parts.append("Keep non-essential spending paused for now.")

    if extra_payoff_allocation > 0.01 and priority_debt_name:
        summary_parts.append(
            f"You can still send {_decision_plan_money(extra_payoff_allocation)} to {priority_debt_name} because that payoff plan stays separate from your spending allowance."
        )
    elif monthly_fi_contribution > 0.01:
        summary_parts.append(
            f"Planned surplus can move into savings with {_decision_plan_money(monthly_fi_contribution)} this month."
        )

    if upcoming_obligations > 0.01:
        if due_soon_item and due_soon_amount > 0.01:
            due_phrase = f" due {due_soon_date.isoformat()}" if due_soon_date else ""
            summary_parts.append(
                f"Keep {_decision_plan_money(due_soon_amount)} protected for {due_soon_name}{due_phrase}."
            )
        else:
            summary_parts.append(
                f"Keep {_decision_plan_money(upcoming_obligations)} protected for obligations due over the next {window_days} days."
            )

    summary = " ".join(summary_parts[:4]).strip() or "Your Financial OS has a focused next step ready."

    avoid = []

    def add_avoid(label: str, reason: str) -> None:
        if not label or not reason:
            return
        if any(item["label"] == label for item in avoid):
            return
        avoid.append({
            "label": label,
            "reason": reason,
        })

    add_avoid(
        "Do not treat total cash as fully spendable",
        "Bills, debt minimums, runway, and planned savings protections come out before discretionary spending.",
    )

    if extra_payoff_allocation > 0.01:
        add_avoid(
            "Do not treat debt payoff money as extra spending room",
            "The extra debt payment is a separate planned-surplus move, not part of your discretionary allowance.",
        )

    if trust_level == "low":
        add_avoid(
            "Do not rely on unconfirmed setup assumptions",
            "Finish the missing setup items first so the plan can move from blocked to trusted.",
        )
    elif discretionary_allowance <= 0.01:
        add_avoid(
            "Do not spend protected cash on non-essentials",
            "A $0 discretionary allowance means non-essential spending is paused, not that your total cash disappeared.",
        )

    return {
        "status": status,
        "headline": headline,
        "summary": summary,
        "actions": serialized_actions,
        "avoid": avoid[:3],
    }


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _round_clean(value: float) -> int:
    return int(round(float(value)))


def _active_debts_for_intelligence(db: Session, user_id: str) -> list:
    return (
        db.query(Debt)
        .filter(Debt.user_id == user_id, _active_financial_os_clause(Debt))
        .all()
    )


def _priority_debt_for_intelligence(debts: list) -> Optional[Debt]:
    ranked = []
    for debt in debts:
        balance = _to_float(getattr(debt, "balance", None), 0.0)
        if balance <= 0:
            continue
        apr = getattr(debt, "apr", None)
        apr_rank = _to_float(apr, -1.0) if apr is not None else -1.0
        ranked.append((apr_rank, balance, debt))

    if not ranked:
        return None

    ranked.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return ranked[0][2]


def _priority_debt_snapshot_for_intelligence(items: list[dict]) -> Optional[dict]:
    ranked = []
    for item in items:
        balance = _to_float(item.get("balance"), 0.0)
        if balance <= 0:
            continue
        apr_rank = _to_float(item.get("apr"), -1.0)
        ranked.append((apr_rank, balance, item))

    if not ranked:
        return None

    ranked.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return ranked[0][2]


def _debt_totals_snapshot(debts: list) -> dict:
    total_balance = 0.0
    weighted_numerator = 0.0
    weighted_balance = 0.0
    minimum_total = 0.0
    positive_balance_count = 0
    apr_known_count = 0

    for debt in debts:
        balance = _to_float(getattr(debt, "balance", None), 0.0)
        minimum_due = _to_float(getattr(debt, "minimum_due", None), 0.0)
        apr = getattr(debt, "apr", None)

        if balance > 0:
            positive_balance_count += 1
            total_balance += balance
            if apr is not None:
                apr_known_count += 1
                weighted_numerator += balance * _to_float(apr, 0.0)
                weighted_balance += balance

        if minimum_due > 0:
            minimum_total += minimum_due

    weighted_apr = None
    if weighted_balance > 0:
        weighted_apr = round(weighted_numerator / weighted_balance, 2)

    return {
        "total_balance": round(total_balance, 2),
        "minimum_total": round(minimum_total, 2),
        "weighted_apr": weighted_apr,
        "positive_balance_count": positive_balance_count,
        "apr_known_count": apr_known_count,
    }


def _user_settings_payload(db: Session, user_id: str) -> dict:
    row = ensure_user_settings(db, user_id)
    return parse_settings_json(getattr(row, "settings_json", "{}") or "{}")


def _settings_value(settings: Optional[dict], path: list[str], default=None):
    current = settings or {}
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return current if current is not None else default


def _recommended_extra_payment_details(
    *,
    available_sts: float,
    debt_balance: float,
    minimum_extra_payment: Optional[float] = None,
) -> dict:
    available_sts_value = round(max(_to_float(available_sts, 0.0), 0.0), 2)
    debt_balance_value = round(max(_to_float(debt_balance, 0.0), 0.0), 2)
    minimum_setting = round(max(_to_float(minimum_extra_payment, 0.0), 0.0), 2)

    # Keep extra-pay recommendations intentionally conservative. STS is a liquidity measure,
    # not a promise that the same full amount can be repeated toward debt every month.
    capped_recommendation = 0.0
    if available_sts_value > 0 and debt_balance_value > 0:
        capped_recommendation = round(
            min(available_sts_value * 0.05, debt_balance_value, 500.0),
            2,
        )

    recommended_extra_payment = capped_recommendation

    # Respect the user's minimum-extra preference only when current STS can actually fund it
    # and the hard balance / $500 guardrails still allow it.
    if minimum_setting > 0 and debt_balance_value > 0:
        feasible_floor = round(min(minimum_setting, debt_balance_value, 500.0), 2)
        if feasible_floor > 0 and available_sts_value >= feasible_floor:
            recommended_extra_payment = max(recommended_extra_payment, feasible_floor)

    recommended_extra_payment = round(
        min(
            recommended_extra_payment,
            debt_balance_value,
            available_sts_value if available_sts_value > 0 else 0.0,
            500.0,
        ),
        2,
    )

    return {
        "available_sts": available_sts_value,
        "recommended_extra_payment": recommended_extra_payment,
        "minimum_extra_payment_setting": minimum_setting or None,
        "formula": (
            "recommended_extra_payment = min(max(available_sts, 0) * 0.05, debt_balance, 500), "
            "then raise to the user's minimum extra payment only when current STS can safely fund that floor."
        ),
    }


def _project_single_debt_payoff(balance: float, apr_pct: Optional[float], monthly_payment: float, max_months: int = 600) -> dict:
    balance_remaining = _to_float(balance, 0.0)
    payment = _to_float(monthly_payment, 0.0)
    apr = max(_to_float(apr_pct, 0.0), 0.0)

    if balance_remaining <= 0:
        return {"ok": True, "months": 0, "interest_paid": 0.0}
    if payment <= 0:
        return {"ok": False, "reason": "missing_payment"}

    months = 0
    interest_paid = 0.0

    while balance_remaining > 0.01 and months < max_months:
        starting_balance = balance_remaining
        interest = balance_remaining * (apr / 1200.0)
        interest_paid += interest
        balance_remaining += interest

        actual_payment = min(payment, balance_remaining)
        balance_remaining -= actual_payment
        months += 1

        if balance_remaining >= starting_balance - 0.01:
            return {"ok": False, "reason": "payment_does_not_reduce_principal"}

    if balance_remaining > 0.01:
        return {"ok": False, "reason": "projection_horizon_exceeded"}

    return {
        "ok": True,
        "months": months,
        "interest_paid": round(interest_paid, 2),
    }


def _project_portfolio_debt_free(debts: list, recurring_extra_payment: float, max_months: int = 600) -> dict:
    modeled = []
    excluded = []
    positive_balance_found = False

    for debt in debts:
        balance = _to_float(getattr(debt, "balance", None), 0.0)
        if balance <= 0:
            continue
        positive_balance_found = True

        minimum_due = _to_float(getattr(debt, "minimum_due", None), 0.0)
        if minimum_due <= 0:
            excluded.append({
                "id": debt.id,
                "name": debt.name,
                "reason": "Missing minimum payment",
                "balance": round(balance, 2),
            })
            continue

        modeled.append({
            "id": debt.id,
            "name": debt.name,
            "apr": max(_to_float(getattr(debt, "apr", None), 0.0), 0.0),
            "balance": balance,
            "minimum_due": minimum_due,
        })

    if not positive_balance_found:
        return {
            "ok": True,
            "months": 0,
            "interest_paid": 0.0,
            "modeled_debt_count": 0,
            "excluded_debts": [],
        }

    if not modeled:
        return {
            "ok": False,
            "reason": "no_modelable_debts",
            "modeled_debt_count": 0,
            "excluded_debts": excluded,
        }

    months = 0
    interest_paid = 0.0
    extra_payment = max(_to_float(recurring_extra_payment, 0.0), 0.0)

    while months < max_months:
        remaining_before_month = sum(item["balance"] for item in modeled if item["balance"] > 0.01)
        if remaining_before_month <= 0.01:
            break

        for item in modeled:
            if item["balance"] <= 0.01:
                continue
            interest = item["balance"] * (item["apr"] / 1200.0)
            item["balance"] += interest
            interest_paid += interest

        for item in modeled:
            if item["balance"] <= 0.01:
                continue
            payment = min(item["minimum_due"], item["balance"])
            item["balance"] -= payment

        extra_left = extra_payment
        while extra_left > 0.01:
            target = _priority_debt_snapshot_for_intelligence(
                [item for item in modeled if item["balance"] > 0.01]
            )
            if not target:
                break

            payment = min(extra_left, target["balance"])
            target["balance"] -= payment
            extra_left -= payment

        remaining_after_month = sum(item["balance"] for item in modeled if item["balance"] > 0.01)
        months += 1

        # Assumption: if balances stop shrinking with minimums + recurring extra,
        # the current debt inputs are not enough for a reliable payoff estimate.
        if remaining_after_month >= remaining_before_month - 0.01:
            return {
                "ok": False,
                "reason": "payments_do_not_reduce_portfolio",
                "modeled_debt_count": len(modeled),
                "excluded_debts": excluded,
            }

    if any(item["balance"] > 0.01 for item in modeled):
        return {
            "ok": False,
            "reason": "projection_horizon_exceeded",
            "modeled_debt_count": len(modeled),
            "excluded_debts": excluded,
        }

    return {
        "ok": True,
        "months": months,
        "interest_paid": round(interest_paid, 2),
        "modeled_debt_count": len(modeled),
        "excluded_debts": excluded,
    }


def _insight_priority_rank(severity: str) -> int:
    return {
        "critical": 0,
        "warning": 1,
        "info": 2,
        "success": 3,
    }.get((severity or "info").strip().lower(), 2)


def _build_os_insight(
    *,
    key: str,
    title: str,
    severity: str,
    explanation: str,
    suggested_action: str,
    sources: list[str],
    rule: str,
    score: float = 0.0,
) -> dict:
    return {
        "key": key,
        "title": title,
        "severity": severity,
        "explanation": explanation,
        "suggested_action": suggested_action,
        "sources": sources,
        "rule": rule,
        "_score": round(_to_float(score, 0.0), 2),
    }


def _insight_source_label(source: str) -> str:
    return {
        "statement": "statement transactions",
        "cash": "cash-statement transactions",
        "manual": "manual transactions",
        "plaid": "Plaid transactions",
        "financial_os": "Financial OS cash and obligation data",
    }.get((source or "").strip().lower(), "tracked transactions")


def _insight_recency_note(latest_date: Optional[date]) -> str:
    if not latest_date:
        return ""
    age_days = (date.today() - latest_date).days
    if age_days <= 7:
        return ""
    return f" Based on the latest tracked activity ending {latest_date.isoformat()}."


def _normalize_insight_category(raw_value: Optional[str]) -> str:
    text = (raw_value or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    if lowered in {"other", "uncategorized", "unknown"}:
        return ""
    if "_" in text or text.isupper():
        text = text.replace("_", " ").strip().title()
    return text


def _infer_spend_category(
    *,
    raw_category: Optional[str] = None,
    description: Optional[str] = None,
    merchant: Optional[str] = None,
    plaid_primary: Optional[str] = None,
    plaid_detailed: Optional[str] = None,
) -> str:
    for candidate in (raw_category, plaid_detailed, plaid_primary):
        normalized = _normalize_insight_category(candidate)
        if normalized:
            return normalized

    text = f"{description or ''} {merchant or ''}".strip().lower()
    if not text:
        return "Other"
    if any(token in text for token in ["rent", "lease", "mortgage", "apartment"]):
        return "Housing"
    if any(token in text for token in ["electric", "energy", "water", "internet", "utility", "comcast", "att", "verizon"]):
        return "Utilities"
    if any(token in text for token in ["aldi", "kroger", "meijer", "costco", "grocery", "walmart neighborhood"]):
        return "Groceries"
    if any(token in text for token in ["restaurant", "doordash", "ubereats", "grill", "cafe", "coffee", "starbucks", "arbys", "mcdonald"]):
        return "Dining"
    if any(token in text for token in ["shell", "chevron", "exxon", "bp ", "speedway", "gas"]):
        return "Fuel"
    if any(token in text for token in ["netflix", "spotify", "hulu", "prime", "icloud", "apple.com/bill", "youtube"]):
        return "Subscriptions"
    if any(token in text for token in ["amazon", "target", "best buy", "walmart", "oculus"]):
        return "Shopping"
    if any(token in text for token in ["doctor", "pharmacy", "hospital", "health"]):
        return "Medical"
    if any(token in text for token in ["movie", "theater", "steam", "playstation", "xbox"]):
        return "Entertainment"
    return "Other"


def _looks_like_non_spend(description: Optional[str], category: Optional[str] = None, txn_type: Optional[str] = None) -> bool:
    text = f"{description or ''} {category or ''} {txn_type or ''}".strip().lower()
    if not text:
        return False
    keywords = [
        "payment",
        "pymt",
        "refund",
        "reversal",
        "credit",
        "deposit",
        "payroll",
        "income",
        "transfer",
        "withdrawal to ",
        "deposit from ",
        "internal transfer",
        "interest paid",
    ]
    return any(keyword in text for keyword in keywords)


def _normalize_plaid_duplicate_token(value: Optional[str]) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower())).strip()


def _normalize_plaid_last4(value: Optional[str]) -> str:
    digits = re.sub(r"\D+", "", str(value or ""))
    return digits[-4:] if digits else ""


def _plaid_display_account_fingerprint(
    *,
    account_id: Optional[str] = None,
    account_name: Optional[str] = None,
    account_mask: Optional[str] = None,
) -> str:
    normalized_name = _normalize_plaid_duplicate_token(account_name)
    normalized_last4 = _normalize_plaid_last4(account_mask)
    if normalized_name or normalized_last4:
        parts = []
        if normalized_name:
            parts.append(f"name:{normalized_name}")
        if normalized_last4:
            parts.append(f"last4:{normalized_last4}")
        return "|".join(parts)

    normalized_account_id = _normalize_plaid_duplicate_token(account_id)
    return f"id:{normalized_account_id}" if normalized_account_id else "unknown_account"


def _plaid_display_duplicate_key(
    *,
    institution_name: Optional[str] = None,
    account_id: Optional[str] = None,
    account_name: Optional[str] = None,
    account_mask: Optional[str] = None,
    posted_date: Optional[str] = None,
    authorized_date: Optional[str] = None,
    merchant_name: Optional[str] = None,
    name: Optional[str] = None,
    amount: Optional[float] = None,
) -> str:
    institution = _normalize_plaid_duplicate_token(institution_name) or "plaid"
    account = _plaid_display_account_fingerprint(
        account_id=account_id,
        account_name=account_name,
        account_mask=account_mask,
    )
    posted = _normalize_plaid_duplicate_token(posted_date or authorized_date) or "unknown_date"
    merchant = _normalize_plaid_duplicate_token(merchant_name or name) or "unknown_merchant"
    normalized_amount = f"{_to_float(amount, 0.0):.2f}"
    return "|".join([
        "source:plaid",
        f"institution:{institution}",
        f"account:{account}",
        f"date:{posted}",
        f"merchant:{merchant}",
        f"amount:{normalized_amount}",
    ])


def _classify_suspected_duplicate_plaid_rows(rows: list[dict]) -> list[dict]:
    duplicate_counts: dict[str, int] = defaultdict(int)
    for row in rows:
        duplicate_counts[row["duplicate_key"]] += 1

    seen: dict[str, int] = defaultdict(int)
    classified: list[dict] = []
    for row in rows:
        duplicate_key = row["duplicate_key"]
        duplicate_group_index = seen[duplicate_key]
        seen[duplicate_key] += 1

        enriched = dict(row)
        enriched["counted"] = duplicate_group_index == 0
        enriched["suspected_duplicate"] = duplicate_group_index > 0
        enriched["duplicate_group_index"] = duplicate_group_index
        enriched["duplicate_group_size"] = duplicate_counts[duplicate_key]
        classified.append(enriched)

    return classified


def _source_window(rows: list[dict], days: int) -> tuple[list[dict], Optional[date]]:
    if not rows:
        return [], None
    latest = max((row["date"] for row in rows if row.get("date")), default=None)
    if not latest:
        return [], None
    cutoff = latest - timedelta(days=max(1, int(days or 1)) - 1)
    return [row for row in rows if row.get("date") and row["date"] >= cutoff], latest


def _collect_spending_activity_by_source(db: Session, user_id: str) -> tuple[dict[str, list[dict]], dict[str, dict]]:
    out = {
        "statement": [],
        "cash": [],
        "manual": [],
        "plaid": [],
    }

    card_rows = (
        db.query(Transaction, Statement)
        .join(Statement, Statement.id == Transaction.statement_id)
        .filter(Statement.user_id == user_id)
        .all()
    )
    for txn, stmt in card_rows:
        posted = _parse_posted_date(getattr(txn, "posted_date", None))
        amount = _to_float(getattr(txn, "amount", None), 0.0)
        description = (getattr(txn, "description", None) or "").strip()
        txn_type = (getattr(txn, "txn_type", None) or "").strip()
        if not posted or amount <= 0 or not description or _looks_like_non_spend(description, getattr(txn, "category", None), txn_type):
            continue
        out["statement"].append({
            "source": "statement",
            "date": posted,
            "amount": round(abs(amount), 2),
            "merchant": description,
            "merchant_norm": _normalize_merchant_local(description),
            "category": _infer_spend_category(
                raw_category=getattr(txn, "category", None),
                description=description,
            ),
            "reference": getattr(stmt, "account_label", None) or "Statement",
        })

    cash_rows = (
        db.query(CashTransaction, CashAccount)
        .join(CashAccount, CashAccount.id == CashTransaction.cash_account_id)
        .filter(CashAccount.user_id == user_id)
        .all()
    )
    for txn, account in cash_rows:
        posted = _parse_posted_date(getattr(txn, "posted_date", None))
        raw_amount = _to_float(getattr(txn, "amount", None), 0.0)
        description = (getattr(txn, "description", None) or "").strip()
        raw_category = getattr(txn, "category", None)
        txn_type = getattr(txn, "txn_type", None)
        if not posted or not description or _looks_like_non_spend(description, raw_category, txn_type):
            continue
        is_outflow = raw_amount < 0 or str(txn_type or "").strip().lower() in {"debit", "fee", "withdrawal"}
        if not is_outflow:
            continue
        out["cash"].append({
            "source": "cash",
            "date": posted,
            "amount": round(abs(raw_amount), 2),
            "merchant": description,
            "merchant_norm": _normalize_merchant_local(description),
            "category": _infer_spend_category(
                raw_category=raw_category,
                description=description,
            ),
            "reference": getattr(account, "account_label", None) or "Cash",
        })

    manual_rows = (
        db.query(ManualTransaction)
        .filter(ManualTransaction.user_id == user_id)
        .all()
    )
    for txn in manual_rows:
        posted = _iso_to_date(getattr(txn, "date", None))
        amount = _to_float(getattr(txn, "amount", None), 0.0)
        description = (getattr(txn, "description", None) or "").strip() or "Manual entry"
        raw_category = getattr(txn, "category", None)
        if not posted or amount <= 0 or _looks_like_non_spend(description, raw_category, None):
            continue
        out["manual"].append({
            "source": "manual",
            "date": posted,
            "amount": round(abs(amount), 2),
            "merchant": description,
            "merchant_norm": _normalize_merchant_local(description),
            "category": _infer_spend_category(
                raw_category=raw_category,
                description=description,
            ),
            "reference": "Manual",
        })

    plaid_rows = (
        db.query(PlaidTransaction, PlaidAccount, PlaidItem)
        .join(PlaidAccount, PlaidTransaction.plaid_account_id == PlaidAccount.id)
        .join(PlaidItem, PlaidTransaction.plaid_item_id == PlaidItem.id)
        .filter(
            PlaidTransaction.user_id == user_id,
            PlaidAccount.user_id == user_id,
            PlaidItem.user_id == user_id,
            or_(PlaidItem.status != "superseded", PlaidItem.status.is_(None)),
            or_(PlaidAccount.sync_status != "superseded", PlaidAccount.sync_status.is_(None)),
        )
        .all()
    )
    plaid_candidates = []
    for txn, account, item in plaid_rows:
        posted = _iso_to_date(getattr(txn, "posted_date", None))
        amount = _to_float(getattr(txn, "amount", None), 0.0)
        merchant = (getattr(txn, "merchant_name", None) or getattr(txn, "name", None) or "").strip()
        if not posted or amount <= 0 or not merchant or getattr(txn, "pending", False):
            continue
        if _looks_like_non_spend(merchant, getattr(txn, "category_primary", None), None):
            continue
        plaid_candidates.append({
            "source": "plaid",
            "date": posted,
            "amount": round(abs(amount), 2),
            "merchant": merchant,
            "merchant_norm": _normalize_merchant_local(merchant),
            "category": _infer_spend_category(
                description=merchant,
                merchant=merchant,
                plaid_primary=getattr(txn, "category_primary", None),
                plaid_detailed=getattr(txn, "category_detailed", None),
            ),
            "reference": getattr(account, "name", None) or getattr(item, "institution_name", None) or "Plaid",
            "duplicate_key": _plaid_display_duplicate_key(
                institution_name=getattr(account, "institution_name", None) or getattr(item, "institution_name", None),
                account_id=getattr(account, "plaid_account_id", None),
                account_name=getattr(account, "name", None),
                account_mask=getattr(account, "mask", None),
                posted_date=getattr(txn, "posted_date", None),
                authorized_date=getattr(txn, "authorized_date", None),
                merchant_name=getattr(txn, "merchant_name", None),
                name=getattr(txn, "name", None),
                amount=getattr(txn, "amount", None),
            ),
        })

    for row in _classify_suspected_duplicate_plaid_rows(plaid_candidates):
        if row.get("suspected_duplicate"):
            continue
        cleaned = dict(row)
        cleaned.pop("duplicate_key", None)
        cleaned.pop("duplicate_group_index", None)
        cleaned.pop("duplicate_group_size", None)
        cleaned.pop("counted", None)
        cleaned.pop("suspected_duplicate", None)
        out["plaid"].append(cleaned)

    coverage = {}
    for source, rows in out.items():
        latest = max((row["date"] for row in rows), default=None)
        coverage[source] = {
            "transactions": len(rows),
            "latest_date": latest.isoformat() if latest else None,
            "source_label": _insight_source_label(source),
        }

    return out, coverage


def _leak_severity(
    *,
    leak_total: float,
    source_total_spend: float,
    safe_to_spend: float,
) -> str:
    leak_value = round(max(_to_float(leak_total, 0.0), 0.0), 2)
    source_total = round(max(_to_float(source_total_spend, 0.0), 0.0), 2)
    available_sts = round(max(_to_float(safe_to_spend, 0.0), 0.0), 2)

    # Keep tiny leaks low-noise when liquidity is very strong so the page does not
    # simultaneously say "you have huge cushion" and "panic about $35 of Uber".
    if leak_value < 50 and available_sts > 0 and leak_value < (available_sts * 0.01):
        return "info"

    meaningful_vs_spend = leak_value >= max(60.0, source_total * 0.08)
    meaningful_vs_sts = available_sts <= 0 or leak_value >= max(50.0, available_sts * 0.05)
    severe_vs_spend = leak_value >= max(250.0, source_total * 0.18)
    severe_vs_sts = available_sts <= 0 or leak_value >= max(150.0, available_sts * 0.1)

    if severe_vs_spend and severe_vs_sts:
        return "critical"
    if meaningful_vs_spend or meaningful_vs_sts:
        return "warning"
    return "info"


def _build_spending_leak_insight(
    source_activity: dict[str, list[dict]],
    *,
    safe_to_spend: float,
) -> Optional[dict]:
    candidates = []

    for source, rows in source_activity.items():
        window_rows, latest_date = _source_window(rows, 30)
        if len(window_rows) < 3:
            continue

        total_spend = round(sum(_to_float(row.get("amount"), 0.0) for row in window_rows), 2)
        if total_spend < 60:
            continue

        by_category = defaultdict(float)
        category_counts = defaultdict(int)
        for row in window_rows:
            category = (row.get("category") or "Other").strip() or "Other"
            by_category[category] += _to_float(row.get("amount"), 0.0)
            category_counts[category] += 1

        if by_category:
            top_category = max(by_category.items(), key=lambda item: item[1])[0]
            category_total = round(by_category[top_category], 2)
            category_share = category_total / max(total_spend, 1.0)
            if top_category not in {"Other"} and category_total >= 100 and category_share >= 0.35 and category_counts[top_category] >= 2:
                severity = _leak_severity(
                    leak_total=category_total,
                    source_total_spend=total_spend,
                    safe_to_spend=safe_to_spend,
                )
                if severity != "critical" and category_share < 0.45 and category_total < 180:
                    severity = "info"
                candidates.append(_build_os_insight(
                    key=f"spending_leak_category_{source}",
                    title=f"{top_category} spending is running high.",
                    severity=severity,
                    explanation=(
                        f"Your {_insight_source_label(source)} show {top_category} at ${category_total:.0f} over the latest 30-day window "
                        f"({round(category_share * 100)}% of tracked spend).{_insight_recency_note(latest_date)}"
                    ),
                    suggested_action=f"Cap {top_category.lower()} spending for the next 7 days and redirect that room to bills or buffer.",
                    sources=[source],
                    rule="Trigger when one category is at least $100, at least 35% of the source's latest 30-day spend, and appears 2+ times.",
                    score=category_total * category_share,
                ))

        merchant_groups = defaultdict(list)
        for row in window_rows:
            merchant_groups[row.get("merchant_norm") or "unknown"].append(row)

        for merchant_norm, items in merchant_groups.items():
            count = len(items)
            if count < 3:
                continue
            total = round(sum(_to_float(item.get("amount"), 0.0) for item in items), 2)
            avg_amount = total / max(count, 1)
            if total < 30 or avg_amount < 3 or avg_amount > 25:
                continue
            merchant_name = (items[-1].get("merchant") or "Small charges").strip()
            severity = _leak_severity(
                leak_total=total,
                source_total_spend=total_spend,
                safe_to_spend=safe_to_spend,
            )
            if severity == "critical" and total < 120:
                severity = "warning"
            candidates.append(_build_os_insight(
                key=f"spending_leak_small_{source}_{merchant_norm[:18]}",
                title=f"Small {merchant_name} charges are stacking up.",
                severity=severity,
                explanation=(
                    f"Your {_insight_source_label(source)} show {count} charges totaling ${total:.0f} "
                    f"(about ${avg_amount:.0f} each) in the latest 30-day window.{_insight_recency_note(latest_date)}"
                ),
                suggested_action=f"Pause or bundle {merchant_name} spending this week so the small charges stop leaking cash.",
                sources=[source],
                rule="Trigger when the same merchant appears 3+ times in the latest 30-day window, averages $3-$25, and totals at least $30.",
                score=total + (count * 5),
            ))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (_insight_priority_rank(item["severity"]), -item["_score"], item["title"]))
    return candidates[0]


def _build_burn_rate_insight(
    *,
    source_activity: dict[str, list[dict]],
    window_days: int,
    safe_to_spend: float,
) -> Optional[dict]:
    candidates = []
    normalized_window_days = max(1, int(window_days or 1))

    for source, rows in source_activity.items():
        recent_rows, latest_date = _source_window(rows, 14)
        if len(recent_rows) < 2:
            continue
        recent_spend = round(sum(_to_float(row.get("amount"), 0.0) for row in recent_rows), 2)
        if recent_spend < 25:
            continue

        daily_burn = recent_spend / 14.0
        projected_window_spend = round(daily_burn * normalized_window_days, 2)
        normal_weekly_baseline = round(recent_spend / 2.0, 2)
        conservative_weekly_target = round(min(max(normal_weekly_baseline * 0.9, 50.0), 750.0), 2)

        if safe_to_spend <= 0:
            severity = "warning"
        elif projected_window_spend > safe_to_spend * 1.15:
            severity = "warning"
        elif projected_window_spend > safe_to_spend * 0.75:
            severity = "info"
        else:
            severity = "success"

        candidates.append(_build_os_insight(
            key=f"burn_rate_{source}",
            title=(
                "Current burn rate is outrunning your STS window."
                if severity in {"warning", "critical"}
                else "Current burn rate still fits inside your STS window."
            ),
            severity=severity,
            explanation=(
                f"Based on {_insight_source_label(source)}, the latest 14-day pace is about ${daily_burn:.0f}/day, "
                f"or ${projected_window_spend:.0f} over {normalized_window_days} days, versus STS of ${safe_to_spend:.0f}."
                f"{_insight_recency_note(latest_date)}"
            ),
            suggested_action=(
                f"Trim discretionary spending toward about ${conservative_weekly_target:.0f}/week until the projected pace fits inside STS."
                if severity in {"warning", "critical"}
                else "Your recent pace is affordable, but keep discretionary spending near your normal baseline."
            ),
            sources=[source],
            rule="Use the latest 14-day spend window for one source, convert it to a daily pace, then project it across the STS window. Guidance stays anchored to recent baseline spend instead of raw STS.",
            score=projected_window_spend,
        ))

    if not candidates:
        return None

    candidates.sort(key=lambda item: (_insight_priority_rank(item["severity"]), -item["_score"], item["title"]))
    return candidates[0]


def _build_upcoming_risk_insight(
    *,
    window_days: int,
    cash_total: float,
    upcoming_total: float,
    buffer: float,
    safe_to_spend: float,
    remaining_discretionary_this_month: float,
    discretionary_spending_paused: bool,
    upcoming_debt_minimum_total: float,
    available_for_minimums: float,
) -> dict:
    if safe_to_spend < 0:
        return _build_os_insight(
            key="upcoming_risk_shortfall",
            title=f"Cash is short for the next {window_days} days.",
            severity="critical",
            explanation=(
                f"Cash is ${cash_total:.0f}, but upcoming obligations plus buffer total ${(upcoming_total + buffer):.0f}, "
                f"leaving STS at ${safe_to_spend:.0f}."
            ),
            suggested_action="Pause extra debt payments and protect bills, minimums, and buffer first.",
            sources=["financial_os"],
            rule="Critical when cash_total - upcoming_total - buffer is negative.",
            score=abs(safe_to_spend),
        )

    if upcoming_debt_minimum_total > 0 and available_for_minimums < upcoming_debt_minimum_total:
        gap = round(upcoming_debt_minimum_total - available_for_minimums, 2)
        return _build_os_insight(
            key="upcoming_risk_minimums",
            title="Debt minimum coverage is tight inside the STS window.",
            severity="warning",
            explanation=(
                f"After non-debt obligations and buffer, about ${available_for_minimums:.0f} is left for debt minimums "
                f"against ${upcoming_debt_minimum_total:.0f} due soon."
            ),
            suggested_action=f"Keep at least ${gap:.0f} more in cash before making extra payments.",
            sources=["financial_os"],
            rule="Warning when debt minimums due in the window exceed cash left after non-debt obligations and buffer.",
            score=gap,
        )

    low_cushion = max(50.0, buffer * 0.5)
    liquidity_cushion = round(max(cash_total - upcoming_total - buffer, 0.0), 2)
    if discretionary_spending_paused and liquidity_cushion > low_cushion:
        return _build_os_insight(
            key="upcoming_risk_spending_paused",
            title="Bills are covered; discretionary spending is paused.",
            severity="info",
            explanation=(
                f"Cash still covers ${upcoming_total:.0f} of upcoming obligations plus a ${buffer:.0f} buffer by about ${liquidity_cushion:.0f}, "
                f"but this month's discretionary allowance has been used."
            ),
            suggested_action=(
                "Keep non-essential spending paused until the monthly cap resets; planned extra debt or savings allocations can still continue."
                if remaining_discretionary_this_month <= 0.01
                else "Keep non-essential spending paused until the current discretionary allowance resets."
            ),
            sources=["financial_os"],
            rule="Use a paused-spending message instead of a thin-cushion warning when cash coverage is strong but the discretionary allowance is exhausted.",
            score=remaining_discretionary_this_month,
        )

    if safe_to_spend <= low_cushion:
        return _build_os_insight(
            key="upcoming_risk_low_cushion",
            title="Upcoming bills are covered, but the cushion is thin.",
            severity="warning",
            explanation=(
                f"Upcoming obligations total ${upcoming_total:.0f} and the remaining STS after a ${buffer:.0f} buffer is only ${safe_to_spend:.0f}."
            ),
            suggested_action="Avoid new discretionary spending until the next cash inflow lands.",
            sources=["financial_os"],
            rule="Warning when STS stays positive but is at or below max($50, 50% of buffer).",
            score=low_cushion - safe_to_spend,
        )

    return _build_os_insight(
        key="upcoming_risk_covered",
        title=f"Upcoming obligations are covered for the next {window_days} days.",
        severity="success",
        explanation=(
            f"Cash covers ${upcoming_total:.0f} of upcoming obligations plus a ${buffer:.0f} buffer, "
            f"leaving STS at ${safe_to_spend:.0f}."
        ),
        suggested_action="Keep bills and minimums protected, then use the remaining STS intentionally.",
        sources=["financial_os"],
        rule="Success when cash_total - upcoming_total - buffer stays above the low-cushion threshold and minimums are covered.",
        score=safe_to_spend,
    )


def _build_stability_insight(
    *,
    stability_label: str,
    stability_value: float,
    stability_explanation: str,
    discretionary_spending_paused: bool,
    runway_months: Optional[float],
    runway_target_months: float,
) -> dict:
    label = (stability_label or "Stable").strip()
    lowered = label.lower()
    severity = "success" if lowered in {"strong", "stable"} else "warning"
    if lowered == "cash stable, spending paused":
        severity = "info"
    title = (
        "Cash is stable, but discretionary spending is paused."
        if lowered == "cash stable, spending paused"
        else
        "Debt minimums are covered, but stability is fragile."
        if lowered == "fragile"
        else "Short-term stability is improving, but still needs margin."
        if lowered == "stabilizing"
        else "Short-term stability is holding."
    )
    action = "Hold extra cash in checking until STS and runway improve."
    if lowered in {"strong", "stable"}:
        action = "Keep following the current plan and use surplus deliberately, not reactively."
    elif discretionary_spending_paused or lowered == "cash stable, spending paused":
        action = "Keep discretionary spending paused until the cap resets; planned extra debt or savings allocations can still follow the protected plan."
    elif runway_months is not None and runway_months < runway_target_months:
        action = f"Keep building cash until runway moves closer to {runway_target_months:.1f} months."

    return _build_os_insight(
        key="stability_meter_summary",
        title=title,
        severity=severity,
        explanation=f"{stability_explanation} Stability meter: {stability_value}/100 ({label}).",
        suggested_action=action,
        sources=["financial_os"],
        rule="Uses the existing stability meter: STS safety (40), obligation coverage (30), runway progress (20), and debt-minimum coverage (10).",
        score=100.0 - _to_float(stability_value, 0.0),
    )


def _build_high_apr_drag_insight(
    *,
    stability_label: str,
    stability_value: float,
    weighted_apr: Optional[float],
    high_apr_threshold: float,
    priority_debt: Optional[Debt],
    recurring_extra_payment: float,
) -> Optional[dict]:
    apr_value = _to_float(weighted_apr, 0.0)
    threshold = max(_to_float(high_apr_threshold, 18.0), 1.0)
    if apr_value <= 0 or apr_value < threshold:
        return None

    lowered = (stability_label or "").strip().lower()
    debt_name = priority_debt.name if priority_debt and priority_debt.name else "your highest-cost debt"
    strong_cash = lowered in {"strong", "stable"} and stability_value >= 60

    return _build_os_insight(
        key="high_apr_drag",
        title=(
            "Strong cash position, but high-cost debt is dragging your score."
            if strong_cash
            else "High-cost debt is still expensive to carry."
        ),
        severity="warning" if apr_value >= threshold + 4 else "info",
        explanation=(
            f"Weighted APR is {apr_value:.1f}% across active debts, above the {threshold:.1f}% high-cost threshold."
            + (
                f" Cash is stable enough to press the advantage on {debt_name}."
                if strong_cash
                else ""
            )
        ),
        suggested_action=(
            f"Keep the recommended extra payment on {debt_name} while cash stays steady."
            if recurring_extra_payment > 0
            else f"Prioritize {debt_name} for the next extra payment once cash remains repeatably positive."
        ),
        sources=["financial_os"],
        rule="Show a separate debt-cost insight when weighted APR is above the configured high-cost threshold so strong stability does not hide expensive debt.",
        score=apr_value * 10.0,
    )


def _build_spending_data_insight(source_coverage: dict[str, dict]) -> dict:
    loaded_sources = [
        details.get("source_label")
        for details in source_coverage.values()
        if _to_float(details.get("transactions"), 0.0) > 0
    ]
    loaded_text = ", ".join(loaded_sources) if loaded_sources else "no transaction sources"
    return _build_os_insight(
        key="spending_data_coverage",
        title="Recent spend coaching is waiting on transaction data.",
        severity="info",
        explanation=f"Leak detection and burn-rate coaching only saw {loaded_text}.",
        suggested_action="Import a recent statement, add manual transactions, or sync Plaid to unlock richer coaching.",
        sources=[source for source, details in source_coverage.items() if _to_float(details.get('transactions'), 0.0) > 0],
        rule="Fallback when no spend source has enough recent transactions for leak or burn-rate analysis.",
        score=0.0,
    )


def _build_what_to_do_next_insight(
    *,
    safe_to_spend: float,
    available_sts: float,
    buffer: float,
    upcoming_total: float,
    stability_value: float,
    stability_label: str,
    priority_debt: Optional[Debt],
    recurring_extra_payment: float,
    remaining_discretionary_this_month: float,
    discretionary_spending_paused: bool,
    runway_months: Optional[float],
    runway_target_months: float,
    upcoming_debt_minimum_total: float,
    available_for_minimums: float,
) -> dict:
    if safe_to_spend < 0:
        return _build_os_insight(
            key="what_to_do_next",
            title="Pause extra debt payments and cover bills first.",
            severity="critical",
            explanation=(
                f"STS is ${safe_to_spend:.0f} after ${upcoming_total:.0f} of upcoming obligations and a ${buffer:.0f} buffer."
            ),
            suggested_action="Use available cash for upcoming bills and minimums only until STS turns positive.",
            sources=["financial_os"],
            rule="If STS is negative, the next step is to stop extra paydown and protect obligations first.",
            score=abs(safe_to_spend),
        )

    if upcoming_debt_minimum_total > 0 and available_for_minimums < upcoming_debt_minimum_total:
        return _build_os_insight(
            key="what_to_do_next",
            title="Keep cash reserved for upcoming debt minimums this week.",
            severity="warning",
            explanation=(
                f"Debt minimums due soon total ${upcoming_debt_minimum_total:.0f}, but only about ${available_for_minimums:.0f} is left after other obligations and buffer."
            ),
            suggested_action="Do not make extra payments until the due-soon minimums are fully covered.",
            sources=["financial_os"],
            rule="If debt minimums due soon are not fully covered after non-debt obligations and buffer, hold cash instead of paying extra.",
            score=upcoming_debt_minimum_total - available_for_minimums,
        )

    if runway_months is not None and runway_months < runway_target_months and stability_value < 60:
        keep_amount = max(min(safe_to_spend, max(buffer, 50.0)), 0.0)
        return _build_os_insight(
            key="what_to_do_next",
            title=f"Keep the next ${keep_amount:.0f} in cash this week.",
            severity="info",
            explanation=(
                f"STS is positive, but stability is {stability_label.lower()} and runway is only {runway_months:.1f} of {runway_target_months:.1f} target months."
            ),
            suggested_action="Let cash build before resuming aggressive extra debt payments.",
            sources=["financial_os"],
            rule="If STS is positive but stability is below 60 and runway is below target, prioritize cash retention over extra paydown.",
            score=60.0 - stability_value,
        )

    if priority_debt and recurring_extra_payment > 0:
        debt_name = priority_debt.name or "your highest-APR debt"
        if discretionary_spending_paused:
            return _build_os_insight(
                key="what_to_do_next",
                title=f"Pause discretionary spending, but send the planned extra to {debt_name}.",
                severity="info" if stability_value >= 60 else "warning",
                explanation=(
                    f"Your discretionary spending allowance is ${available_sts:.0f} this period, but cash still covers bills and reserves. "
                    f"The extra ${recurring_extra_payment:.0f} recommendation is a planned surplus allocation, not extra room to spend."
                ),
                suggested_action=f"Keep non-essential spending paused and apply the planned extra payment to {debt_name}.",
                sources=["financial_os"],
                rule="When the discretionary allowance is exhausted but a repeatable surplus still exists, pause discretionary spend while continuing the protected extra debt plan.",
                score=recurring_extra_payment,
            )
        return _build_os_insight(
            key="what_to_do_next",
            title=f"Put an extra ${recurring_extra_payment:.0f} toward {debt_name}.",
            severity="success" if stability_value >= 60 else "info",
            explanation=(
                f"STS is ${available_sts:.0f}, but only ${recurring_extra_payment:.0f} is being treated as a repeatable monthly extra payment so bills and buffer stay protected."
            ),
            suggested_action=f"Apply that extra payment to {debt_name} after bills, minimums, and buffer stay protected.",
            sources=["financial_os"],
            rule="If STS is positive and bills/minimums are covered, direct the capped extra-payment recommendation to the highest-APR active debt.",
            score=recurring_extra_payment,
        )

    if discretionary_spending_paused and remaining_discretionary_this_month <= 0.01:
        return _build_os_insight(
            key="what_to_do_next",
            title="Pause discretionary spending until the monthly cap resets.",
            severity="info",
            explanation=(
                f"Cash coverage is holding, but the discretionary spending allowance is ${safe_to_spend:.0f} because this month's cap is exhausted."
            ),
            suggested_action="Keep bills protected and wait for the next cap reset before new non-essential spending.",
            sources=["financial_os"],
            rule="If protected cash is healthy but the discretionary cap is exhausted and no extra allocation is available, keep discretionary spending paused.",
            score=abs(safe_to_spend),
        )

    return _build_os_insight(
        key="what_to_do_next",
        title="Hold steady and protect your current cash cushion.",
        severity="success" if stability_value >= 60 else "info",
        explanation=f"STS is ${safe_to_spend:.0f} and short-term stability is {stability_label.lower()}.",
        suggested_action="Keep bills protected and avoid adding new fixed spending until the next review cycle.",
        sources=["financial_os"],
        rule="Fallback when no extra debt payment is available and cash coverage is acceptable.",
        score=safe_to_spend,
    )


def _build_coaching_insights_payload(
    *,
    db: Session,
    user_id: str,
    window_days: int,
    buffer: float,
    cash_total: float,
    upcoming_total: float,
    safe_to_spend: float,
    available_sts: float,
    remaining_discretionary_this_month: float,
    discretionary_spending_paused: bool,
    stability_label: str,
    stability_value: float,
    stability_explanation: str,
    runway_months: Optional[float],
    runway_target_months: float,
    priority_debt: Optional[Debt],
    recurring_extra_payment: float,
    upcoming_debt_minimum_total: float,
    available_for_minimums: float,
    weighted_apr: Optional[float],
    high_apr_threshold: float,
) -> dict:
    source_activity, source_coverage = _collect_spending_activity_by_source(db, user_id)

    what_to_do_next = _build_what_to_do_next_insight(
        safe_to_spend=safe_to_spend,
        available_sts=available_sts,
        buffer=buffer,
        upcoming_total=upcoming_total,
        stability_value=stability_value,
        stability_label=stability_label,
        priority_debt=priority_debt,
        recurring_extra_payment=recurring_extra_payment,
        remaining_discretionary_this_month=remaining_discretionary_this_month,
        discretionary_spending_paused=discretionary_spending_paused,
        runway_months=runway_months,
        runway_target_months=runway_target_months,
        upcoming_debt_minimum_total=upcoming_debt_minimum_total,
        available_for_minimums=available_for_minimums,
    )

    candidates = [
        what_to_do_next,
        _build_upcoming_risk_insight(
            window_days=window_days,
            cash_total=cash_total,
            upcoming_total=upcoming_total,
            buffer=buffer,
            safe_to_spend=safe_to_spend,
            remaining_discretionary_this_month=remaining_discretionary_this_month,
            discretionary_spending_paused=discretionary_spending_paused,
            upcoming_debt_minimum_total=upcoming_debt_minimum_total,
            available_for_minimums=available_for_minimums,
        ),
        _build_burn_rate_insight(
            source_activity=source_activity,
            window_days=window_days,
            safe_to_spend=safe_to_spend,
        ),
        _build_spending_leak_insight(
            source_activity,
            safe_to_spend=safe_to_spend,
        ),
        _build_high_apr_drag_insight(
            stability_label=stability_label,
            stability_value=stability_value,
            weighted_apr=weighted_apr,
            high_apr_threshold=high_apr_threshold,
            priority_debt=priority_debt,
            recurring_extra_payment=recurring_extra_payment,
        ),
        _build_stability_insight(
            stability_label=stability_label,
            stability_value=stability_value,
            stability_explanation=stability_explanation,
            discretionary_spending_paused=discretionary_spending_paused,
            runway_months=runway_months,
            runway_target_months=runway_target_months,
        ),
    ]

    deduped = []
    seen_keys = set()
    for item in candidates:
        if not item:
            continue
        if item["key"] in seen_keys:
            continue
        seen_keys.add(item["key"])
        deduped.append(item)

    if len(deduped) < 3:
        deduped.append(_build_spending_data_insight(source_coverage))

    rest = deduped[1:]
    rest.sort(key=lambda item: (_insight_priority_rank(item["severity"]), -item["_score"], item["title"]))
    ordered = [deduped[0]] + rest[:4]

    cleaned_items = []
    for item in ordered:
        cleaned = dict(item)
        cleaned.pop("_score", None)
        cleaned_items.append(cleaned)

    return {
        "what_to_do_next": cleaned_items[0] if cleaned_items else None,
        "items": cleaned_items,
        "source_coverage": source_coverage,
    }


@app.get("/os/intelligence")
def os_intelligence(
    user_id: Optional[str] = None,
    window_days: int = 21,
    buffer: float = 100.0,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_current_user),
):
    """
    Phase 4A intelligence bundle for the dashboard.
    All numbers are backend-computed from current Financial OS state.
    """
    user_id = _coerce_user_id(current_user, user_id)
    settings = _user_settings_payload(db, user_id)
    minimum_extra_payment = _to_float(
        _settings_value(settings, ["financialOS", "debt", "minExtraPayment"], 0.0),
        0.0,
    )
    high_apr_threshold = _to_float(
        _settings_value(settings, ["financialOS", "stageTargets", "debtCostRateHighPct"], 18.0),
        18.0,
    )

    cash_total = _cash_total_latest(db, user_id)
    upcoming_items, upcoming_total = _upcoming_window_items(db, user_id, days=window_days)
    upcoming_summary = _summarize_upcoming_items(upcoming_items)
    bills_total, debt_mins_total, essentials_total = _sum_essentials_monthly(db, user_id)
    utilization = os_debt_utilization(user_id=user_id, db=db, current_user=current_user)
    goals = _goal_value_map(db, user_id)
    debts = _active_debts_for_intelligence(db, user_id)
    debt_snapshot = _debt_totals_snapshot(debts)
    financial_os_v2 = _compute_financial_os_v2(db, user_id, window_days=window_days)

    safe_to_spend = round(_to_float(financial_os_v2.get("current_period_safe_to_spend"), 0.0), 2)
    remaining_discretionary_this_month = round(_to_float(financial_os_v2.get("remaining_discretionary_this_month"), 0.0), 2)
    remaining_discretionary_this_period = round(_to_float(financial_os_v2.get("remaining_discretionary_this_period"), 0.0), 2)
    discretionary_spending_paused = bool(
        safe_to_spend <= 0.01
        and (
            remaining_discretionary_this_month <= 0.01
            or remaining_discretionary_this_period <= 0.01
        )
    )
    runway_target_months = round(_to_float(financial_os_v2.get("runway_target_months"), 3.0), 2) or 3.0
    runway_months = None
    v2_monthly_essentials = round(_to_float(financial_os_v2.get("monthly_essentials"), essentials_total), 2)
    if v2_monthly_essentials > 0:
        runway_months = round(_to_float(financial_os_v2.get("runway_reserve_current"), 0.0) / v2_monthly_essentials, 1)

    emergency_target_amount = round(_to_float(financial_os_v2.get("runway_reserve_target"), 0.0), 2)
    fi_cash_target = round(_to_float(financial_os_v2.get("fi_target"), 0.0), 2)
    fi_target_label = "Configured FI cash target" if _goal_value(goals, "fi_target", None) else "Derived FI cash target"

    non_debt_upcoming_total = round(
        _to_float(financial_os_v2.get("upcoming_obligations"), 0.0),
        2,
    )
    upcoming_debt_minimum_total = round(_to_float(financial_os_v2.get("debt_minimums"), 0.0), 2)
    available_for_minimums = round(max(_to_float(cash_total, 0.0) - non_debt_upcoming_total, 0.0), 2)

    recommendation = None
    priority_debt = _priority_debt_for_intelligence(debts)
    available_sts = safe_to_spend
    recurring_extra_payment = round(_to_float((financial_os_v2.get("debt_payoff_projection") or {}).get("recurring_extra_payment"), 0.0), 2)
    target_debt_id = (financial_os_v2.get("debt_payoff_projection") or {}).get("target_debt_id")
    for projected_debt in (financial_os_v2.get("debt_payoff_projection") or {}).get("debts") or []:
        if target_debt_id and projected_debt.get("debt_id") == target_debt_id:
            recommendation = {
                "debt_id": projected_debt.get("debt_id"),
                "name": projected_debt.get("name"),
                "last4": None,
                "apr": projected_debt.get("apr"),
                "available_sts": available_sts,
                "recommended_extra_payment": round(_to_float(projected_debt.get("recommended_extra_payment"), 0.0), 2),
                "why": (
                    "Highest APR debt first after due-soon obligations, runway, and the discretionary cap are protected. "
                    "This extra payment comes from planned repeatable surplus, not from the discretionary spending allowance."
                ),
            }
            break

    health_components = []

    liquidity_ratio = _clamp01(cash_total / max(upcoming_total + buffer, 1.0))
    liquidity_points = 35.0 * liquidity_ratio
    health_components.append({
        "key": "liquidity",
        "label": "Liquidity and STS",
        "weight": 35,
        "points": round(liquidity_points, 1),
        "included": True,
        "formula": "35 * clamp(cash_total / (upcoming_total + buffer), 0, 1)",
        "explanation": (
            f"Cash covers {round(liquidity_ratio * 100)}% of upcoming obligations plus buffer; "
            f"STS is {safe_to_spend:+.0f}."
        ),
    })

    if runway_months is not None and runway_target_months > 0:
        runway_ratio = _clamp01(runway_months / runway_target_months)
        runway_points = 25.0 * runway_ratio
        health_components.append({
            "key": "runway",
            "label": "Runway progress",
            "weight": 25,
            "points": round(runway_points, 1),
            "included": True,
            "formula": "25 * clamp(runway_months / runway_target_months, 0, 1)",
            "explanation": (
                f"Runway is {runway_months:.1f} months against a {runway_target_months:.1f}-month target."
            ),
        })

    if debt_snapshot["total_balance"] <= 0:
        health_components.append({
            "key": "debt_cost",
            "label": "Debt burden",
            "weight": 20,
            "points": 20.0,
            "included": True,
            "formula": "Full points when active debt balance is zero",
            "explanation": "No active debt balance is currently dragging the score.",
        })
    elif debt_snapshot["weighted_apr"] is not None:
        high_apr_benchmark = 24.0
        debt_cost_ratio = 1.0 - _clamp01(debt_snapshot["weighted_apr"] / high_apr_benchmark)
        debt_cost_points = 20.0 * debt_cost_ratio
        health_components.append({
            "key": "debt_cost",
            "label": "Debt burden",
            "weight": 20,
            "points": round(debt_cost_points, 1),
            "included": True,
            "formula": "20 * (1 - clamp(weighted_apr / 24, 0, 1))",
            "explanation": (
                f"Weighted APR is {debt_snapshot['weighted_apr']:.1f}% across active debt balances."
            ),
        })
    else:
        health_components.append({
            "key": "debt_cost",
            "label": "Debt burden",
            "weight": 20,
            "points": 0.0,
            "included": False,
            "formula": "Skipped until APR is available on active debts",
            "explanation": "Active debt exists, but APR data is incomplete so debt-cost scoring is skipped.",
        })

    if upcoming_debt_minimum_total > 0:
        minimum_ratio = _clamp01(available_for_minimums / upcoming_debt_minimum_total)
        minimum_points = 15.0 * minimum_ratio
        health_components.append({
            "key": "minimums",
            "label": "Minimum payments covered",
            "weight": 15,
            "points": round(minimum_points, 1),
            "included": True,
            "formula": "15 * clamp((cash_total - non_debt_upcoming_total - buffer) / debt_minimums_due_in_window, 0, 1)",
            "explanation": (
                f"{round(minimum_ratio * 100)}% of debt minimums due in the next {window_days} days are covered after non-debt obligations."
            ),
        })
    else:
        health_components.append({
            "key": "minimums",
            "label": "Minimum payments covered",
            "weight": 15,
            "points": 15.0,
            "included": True,
            "formula": "Full points when no debt minimum is due in the current planning window",
            "explanation": f"No debt minimum is due within the next {window_days} days.",
        })

    total_utilization_pct = utilization.get("total_utilization_pct")
    if total_utilization_pct is not None:
        util_ratio = 1.0
        util_value = _to_float(total_utilization_pct, 0.0)
        if util_value > 30:
            util_ratio = 1.0 - _clamp01((util_value - 30.0) / 60.0)
        util_points = 5.0 * util_ratio
        health_components.append({
            "key": "utilization",
            "label": "Utilization risk",
            "weight": 5,
            "points": round(util_points, 1),
            "included": True,
            "formula": "5 when utilization <= 30%; linearly down to 0 at 90%",
            "explanation": f"Tracked revolving utilization is {util_value:.1f}%.",
        })
    else:
        health_components.append({
            "key": "utilization",
            "label": "Utilization risk",
            "weight": 5,
            "points": 0.0,
            "included": False,
            "formula": "Skipped until credit limits are available",
            "explanation": "No credit-limit data is available, so utilization is not counted yet.",
        })

    included_health_components = [item for item in health_components if item["included"]]
    health_points = sum(item["points"] for item in included_health_components)
    health_weights = sum(item["weight"] for item in included_health_components)
    financial_health_score = _round_clean((health_points / health_weights) * 100.0) if health_weights > 0 else 0

    stability_factors = []
    if safe_to_spend < 0:
        sts_factor = max(0.0, 100.0 - min(100.0, (abs(safe_to_spend) / max(buffer, 100.0)) * 100.0))
    elif discretionary_spending_paused:
        sts_factor = 35.0
    else:
        sts_factor = 100.0
    stability_factors.append(("sts", 40, sts_factor))
    obligation_factor = _clamp01(cash_total / max(upcoming_total + buffer, 1.0)) * 100.0
    stability_factors.append(("obligations", 30, obligation_factor))
    if runway_months is not None and runway_target_months > 0:
        stability_factors.append(("runway", 20, _clamp01(runway_months / runway_target_months) * 100.0))
    if upcoming_debt_minimum_total > 0:
        stability_factors.append(("minimums", 10, _clamp01(available_for_minimums / upcoming_debt_minimum_total) * 100.0))
    else:
        stability_factors.append(("minimums", 10, 100.0))

    stability_weight = sum(weight for _, weight, _ in stability_factors)
    stability_value = _round_clean(sum((weight * value) for _, weight, value in stability_factors) / max(stability_weight, 1))
    if discretionary_spending_paused and stability_value >= 60 and obligation_factor >= 90:
        stability_label = "Cash stable, spending paused"
    elif stability_value < 35:
        stability_label = "Fragile"
    elif stability_value < 60:
        stability_label = "Stabilizing"
    elif stability_value < 80:
        stability_label = "Stable"
    else:
        stability_label = "Strong"

    if safe_to_spend < 0:
        stability_explanation = f"Upcoming obligations and buffer currently exceed cash by {abs(safe_to_spend):.0f}."
    elif upcoming_debt_minimum_total > 0 and available_for_minimums < upcoming_debt_minimum_total:
        stability_explanation = "Short-term cash is positive, but upcoming debt minimums are only partially covered after other obligations."
    elif discretionary_spending_paused:
        stability_explanation = (
            "Cash is strong and bills are covered, but discretionary spending is paused because the monthly cap is exhausted."
        )
    elif runway_months is not None and runway_months < runway_target_months:
        stability_explanation = f"Near-term cash is covered, but runway is only {runway_months:.1f} of {runway_target_months:.1f} target months."
    else:
        stability_explanation = "Cash currently covers upcoming obligations, buffer, and runway is on track."

    portfolio_projection = _project_portfolio_debt_free(debts, recurring_extra_payment=recurring_extra_payment)
    if portfolio_projection.get("ok"):
        excluded_count = len(portfolio_projection.get("excluded_debts") or [])
        if portfolio_projection.get("months", 0) == 0 and not priority_debt:
            countdown_explanation = "No active debt balance is on file right now."
        else:
            countdown_explanation = (
                f"Assumes this extra amount can be repeated monthly: ${recurring_extra_payment:.0f}/month on top of current minimums."
                if recurring_extra_payment > 0
                else "Assumes each debt keeps its current minimum payment and rates stay flat."
            )
        if excluded_count > 0:
            countdown_explanation += f" {excluded_count} debt(s) were excluded because minimum payments are missing."
        debt_free_countdown = {
            "estimated_months_remaining": int(portfolio_projection["months"]),
            "priority_debt": {
                "id": priority_debt.id,
                "name": priority_debt.name,
                "apr": priority_debt.apr,
                "balance": round(_to_float(priority_debt.balance, 0.0), 2),
            } if priority_debt else None,
            "modeled_debt_count": portfolio_projection.get("modeled_debt_count", 0),
            "excluded_debts": portfolio_projection.get("excluded_debts", []),
            "is_partial": excluded_count > 0,
            "formula": "Simulated month by month: accrue interest, pay minimums, then apply the capped repeatable extra-payment recommendation to the highest-APR balance.",
            "explanation": countdown_explanation,
        }
    else:
        debt_free_countdown = {
            "estimated_months_remaining": None,
            "priority_debt": {
                "id": priority_debt.id,
                "name": priority_debt.name,
                "apr": priority_debt.apr,
                "balance": round(_to_float(priority_debt.balance, 0.0), 2),
            } if priority_debt else None,
            "modeled_debt_count": portfolio_projection.get("modeled_debt_count", 0),
            "excluded_debts": portfolio_projection.get("excluded_debts", []),
            "is_partial": False,
            "formula": "Needs positive balances plus usable minimum payments on file for simulation.",
            "explanation": "The debt-free countdown could not be estimated reliably from the current debt inputs.",
        }

    fi_components = []
    if fi_cash_target and fi_cash_target > 0:
        cash_progress = _clamp01(_to_float(financial_os_v2.get("fi_progress_amount"), cash_total) / fi_cash_target)
        fi_components.append({
            "label": fi_target_label,
            "weight": 40,
            "progress": round(cash_progress * 100.0, 1),
            "explanation": f"Cash is {round(cash_progress * 100)}% of the ${fi_cash_target:.0f} target.",
        })

    if runway_months is not None and runway_target_months > 0:
        runway_progress = _clamp01(runway_months / runway_target_months)
        fi_components.append({
            "label": "Runway target",
            "weight": 35,
            "progress": round(runway_progress * 100.0, 1),
            "explanation": f"Runway is {runway_months:.1f} months toward a {runway_target_months:.1f}-month resilience target.",
        })

    debt_drag_progress = 1.0 if debt_snapshot["total_balance"] <= 0 else _clamp01(cash_total / (cash_total + debt_snapshot["total_balance"]))
    fi_components.append({
        "label": "Debt drag",
        "weight": 25,
        "progress": round(debt_drag_progress * 100.0, 1),
        "explanation": (
            "No active debt balance is reducing liquidity."
            if debt_snapshot["total_balance"] <= 0
            else f"Cash is {round(debt_drag_progress * 100)}% of cash plus active debt, which is a conservative debt-drag proxy."
        ),
    })

    fi_progress_value = _round_clean(_to_float(financial_os_v2.get("fi_progress_percent"), 0.0))

    impact_payload = {
        "available_sts": available_sts,
        "recommended_extra_payment": recurring_extra_payment,
        "target_debt": {
            "id": priority_debt.id,
            "name": priority_debt.name,
            "apr": priority_debt.apr,
            "balance": round(_to_float(priority_debt.balance, 0.0), 2),
            "minimum_due": round(_to_float(priority_debt.minimum_due, 0.0), 2),
        } if priority_debt else None,
        "estimated_interest_saved": None,
        "estimated_months_faster": None,
        "estimated_payoff_months_with_extra": None,
        "formula": "Compare minimum-only amortization versus minimum plus the reserve-supported repeatable extra payment each month.",
        "assumptions": [
            "APR and minimum payment stay constant.",
            "Assumes this extra amount can be repeated monthly.",
        ],
        "explanation": "No realistic extra debt payment is recommended right now, so the debt-free countdown stays on minimum-only assumptions.",
    }

    for projected_debt in (financial_os_v2.get("debt_payoff_projection") or {}).get("debts") or []:
        if target_debt_id and projected_debt.get("debt_id") == target_debt_id and recurring_extra_payment > 0:
            impact_payload.update({
                "estimated_interest_saved": projected_debt.get("interest_saved"),
                "estimated_months_faster": projected_debt.get("months_saved"),
                "estimated_payoff_months_with_extra": projected_debt.get("with_extra_months"),
                "explanation": (
                    f"Keeping the extra ${recurring_extra_payment:.0f}/month on {projected_debt.get('name')} is estimated to cut "
                    f"{_to_float(projected_debt.get('months_saved'), 0.0):.0f} month(s) and save about ${_to_float(projected_debt.get('interest_saved'), 0.0):.0f}."
                ) if projected_debt.get("with_extra_months") is not None else "The current debt inputs are not strong enough for a reliable accelerated payoff estimate.",
            })
            break

    coaching_insights = _build_coaching_insights_payload(
        db=db,
        user_id=user_id,
        window_days=window_days,
        buffer=buffer,
        cash_total=cash_total,
        upcoming_total=upcoming_total,
        safe_to_spend=safe_to_spend,
        available_sts=available_sts,
        remaining_discretionary_this_month=remaining_discretionary_this_month,
        discretionary_spending_paused=discretionary_spending_paused,
        stability_label=stability_label,
        stability_value=stability_value,
        stability_explanation=stability_explanation,
        runway_months=runway_months,
        runway_target_months=runway_target_months,
        priority_debt=priority_debt,
        recurring_extra_payment=recurring_extra_payment,
        upcoming_debt_minimum_total=upcoming_debt_minimum_total,
        available_for_minimums=available_for_minimums,
        weighted_apr=debt_snapshot["weighted_apr"],
        high_apr_threshold=high_apr_threshold,
    )

    return {
        "ok": True,
        "user_id": user_id,
        "window_days": window_days,
        "buffer": round(float(buffer), 2),
        "context": {
            "cash_total": round(_to_float(cash_total, 0.0), 2),
            "upcoming_total": round(_to_float(upcoming_total, 0.0), 2),
            "safe_to_spend_today": round(float(safe_to_spend), 2),
            "available_sts": available_sts,
            "monthly_essentials_total": round(float(v2_monthly_essentials), 2),
            "monthly_essential_bills_total": round(float(bills_total), 2),
            "monthly_debt_minimums_total": round(float(debt_mins_total), 2),
            "runway_months": runway_months,
            "runway_target_months": runway_target_months,
            "emergency_target_amount": round(float(emergency_target_amount), 2),
            "fi_cash_target_amount": round(float(fi_cash_target), 2),
            "fi_cash_target_label": fi_target_label,
            "debt_total_balance": debt_snapshot["total_balance"],
            "weighted_apr": debt_snapshot["weighted_apr"],
            "high_apr_threshold": high_apr_threshold,
            "total_utilization_pct": utilization.get("total_utilization_pct"),
        },
        "financial_health": {
            "score": financial_health_score,
            "formula": "Weighted average of liquidity (35), runway (25), debt burden (20), minimum coverage (15), and utilization (5 when limits exist).",
            "components": health_components,
        },
        "stability_meter": {
            "label": stability_label,
            "value": stability_value,
            "formula": "Weighted average of STS safety (40), upcoming-obligation coverage (30), runway progress (20), and debt-minimum coverage (10).",
            "explanation": stability_explanation,
        },
        "debt_free_countdown": debt_free_countdown,
        "fi_progress": {
            "percent": fi_progress_value,
            "formula": "Weighted average of cash-target progress (40), runway progress (35), and debt-drag reduction (25).",
            "explanation": "Conservative FI proxy based on resilience and debt drag, not a full retirement model.",
            "components": fi_components,
        },
        "next_best_dollar_impact": impact_payload,
        "recommendation": recommendation,
        "insights": coaching_insights,
        "financial_os_v2": financial_os_v2,
    }
