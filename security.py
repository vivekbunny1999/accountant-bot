import base64
import hashlib
import hmac
import os
import secrets
import re
from datetime import datetime, timedelta
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


SESSION_TTL_DAYS = int(os.getenv("SESSION_TTL_DAYS", "30") or "30")
PASSWORD_RESET_TTL_MINUTES = int(os.getenv("PASSWORD_RESET_TTL_MINUTES", "30") or "30")
PASSWORD_MIN_LENGTH = int(os.getenv("AUTH_PASSWORD_MIN_LENGTH", "8") or "8")
USERNAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{2,30}[a-z0-9])?$")
PLAID_KEY_PLACEHOLDERS = {
    "",
    "replace_with_a_long_random_secret_or_fernet_key",
}


def utcnow() -> datetime:
    return datetime.utcnow()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def normalize_username(username: str) -> str:
    return (username or "").strip().lower()


def username_is_valid(username: str) -> bool:
    return bool(USERNAME_PATTERN.fullmatch(normalize_username(username)))


def password_policy() -> dict:
    return {
        "min_length": PASSWORD_MIN_LENGTH,
        "requires_uppercase": False,
        "requires_lowercase": False,
        "requires_number": False,
        "requires_special": False,
    }


def validate_password_rules(password: str) -> list[str]:
    errors: list[str] = []
    policy = password_policy()
    value = password or ""

    if len(value) < policy["min_length"]:
        errors.append(f"Password must be at least {policy['min_length']} characters.")
    if policy["requires_uppercase"] and not any(ch.isupper() for ch in value):
        errors.append("Password must include at least one uppercase letter.")
    if policy["requires_lowercase"] and not any(ch.islower() for ch in value):
        errors.append("Password must include at least one lowercase letter.")
    if policy["requires_number"] and not any(ch.isdigit() for ch in value):
        errors.append("Password must include at least one number.")
    if policy["requires_special"] and not any(not ch.isalnum() for ch in value):
        errors.append("Password must include at least one special character.")

    return errors


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=64,
    )
    return f"scrypt${_b64url(salt)}${_b64url(derived)}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algo, salt_b64, hash_b64 = (stored_hash or "").split("$", 2)
        if algo != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_b64 + "=" * (-len(salt_b64) % 4))
        expected = base64.urlsafe_b64decode(hash_b64 + "=" * (-len(hash_b64) % 4))
    except Exception:
        return False

    actual = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=2**14,
        r=8,
        p=1,
        dklen=len(expected),
    )
    return hmac.compare_digest(actual, expected)


def new_user_id() -> str:
    return f"user_{secrets.token_urlsafe(12)}"


def new_session_token() -> str:
    return f"ab_{secrets.token_urlsafe(32)}"


def new_password_reset_token() -> str:
    return f"abr_{secrets.token_urlsafe(32)}"


def hash_session_token(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def hash_password_reset_token(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def session_expiry() -> datetime:
    return utcnow() + timedelta(days=SESSION_TTL_DAYS)


def password_reset_expiry() -> datetime:
    return utcnow() + timedelta(minutes=PASSWORD_RESET_TTL_MINUTES)


def plaid_encryption_key_ready() -> bool:
    raw = (os.getenv("PLAID_TOKEN_ENCRYPTION_KEY") or "").strip()
    if raw in PLAID_KEY_PLACEHOLDERS:
        return False
    return len(raw) >= 16


def _raw_fernet_key() -> bytes:
    raw = (os.getenv("PLAID_TOKEN_ENCRYPTION_KEY") or "").strip()
    if not plaid_encryption_key_ready():
        raise RuntimeError("PLAID_TOKEN_ENCRYPTION_KEY must be set to a real secret before linking Plaid accounts.")
    try:
        if len(raw) == 44:
            base64.urlsafe_b64decode(raw.encode("utf-8"))
            return raw.encode("utf-8")
        digest = hashlib.sha256(raw.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest)
    except Exception as exc:
        raise RuntimeError("Invalid PLAID_TOKEN_ENCRYPTION_KEY.") from exc


def _fernet() -> Fernet:
    return Fernet(_raw_fernet_key())


def encrypt_secret(value: str) -> str:
    if not value:
        raise ValueError("Cannot encrypt an empty secret.")
    return _fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_secret(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Unable to decrypt stored Plaid access token.") from exc
