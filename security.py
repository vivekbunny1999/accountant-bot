import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


SESSION_TTL_DAYS = int(os.getenv("SESSION_TTL_DAYS", "30") or "30")
PASSWORD_RESET_TTL_MINUTES = int(os.getenv("PASSWORD_RESET_TTL_MINUTES", "30") or "30")
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
