import json
import os
from typing import Optional

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from db import SessionLocal
from models import PasswordResetToken, User, UserSession, UserSettings
from security import (
    hash_password_reset_token,
    hash_session_token,
    new_password_reset_token,
    new_session_token,
    password_reset_expiry,
    session_expiry,
    utcnow,
    verify_password,
)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _email_verification_required() -> bool:
    raw = (os.getenv("AUTH_REQUIRE_EMAIL_VERIFICATION", "false") or "false").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


def public_user(user: User) -> dict:
    email_verification_required = _email_verification_required()
    email_verification_status = "verification_not_configured"
    if email_verification_required:
        email_verification_status = "verified" if user.email_verified_at else "not_verified"

    return {
        "id": user.id,
        "email": user.email,
        "username": getattr(user, "username", None),
        "display_name": user.display_name,
        "auth_enabled": bool(user.auth_enabled),
        "email_verified": bool(user.email_verified_at) if email_verification_required else False,
        "email_verified_at": user.email_verified_at.isoformat() if user.email_verified_at else None,
        "email_verification_required": email_verification_required,
        "email_verification_status": email_verification_status,
        "can_resend_verification": False,
        "beta_access_approved": bool(user.beta_access_approved),
        "password_changed_at": user.password_changed_at.isoformat() if user.password_changed_at else None,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
    }


def ensure_user_settings(db: Session, user_id: str) -> UserSettings:
    row = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if row:
        return row
    row = UserSettings(
        user_id=user_id,
        settings_json="{}",
        category_rules_json="{}",
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def authenticate_user(db: Session, email: str, password: str) -> Optional[User]:
    user = db.query(User).filter(User.email == email).first()
    if not user or not user.auth_enabled or not user.password_hash:
        return None
    if _email_verification_required() and not user.email_verified_at:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def create_session(db: Session, user: User, user_agent: Optional[str] = None) -> tuple[str, UserSession]:
    token = new_session_token()
    session_version = int(getattr(user, "session_version", 1) or 1)
    row = UserSession(
        user_id=user.id,
        token_hash=hash_session_token(token),
        user_agent=(user_agent or "")[:255] or None,
        session_version=session_version,
        expires_at=session_expiry(),
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return token, row


def revoke_session(db: Session, token: str) -> None:
    token_hash = hash_session_token(token)
    row = db.query(UserSession).filter(UserSession.token_hash == token_hash).first()
    if not row or row.revoked_at is not None:
        return
    row.revoked_at = utcnow()
    row.updated_at = utcnow()
    db.commit()


def revoke_all_sessions(db: Session, user_id: str) -> None:
    now = utcnow()
    (
        db.query(UserSession)
        .filter(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .update(
            {
                UserSession.revoked_at: now,
                UserSession.updated_at: now,
            },
            synchronize_session=False,
        )
    )
    db.commit()


def bump_session_version(db: Session, user: User) -> User:
    user.session_version = int(getattr(user, "session_version", 1) or 1) + 1
    user.updated_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def current_user_from_token(db: Session, token: str) -> User:
    token_hash = hash_session_token(token)
    row = db.query(UserSession).filter(UserSession.token_hash == token_hash).first()
    if not row or row.revoked_at is not None or row.expires_at <= utcnow():
        raise HTTPException(status_code=401, detail="Session expired or invalid.")

    user = db.query(User).filter(User.id == row.user_id).first()
    if not user or not user.auth_enabled:
        raise HTTPException(status_code=401, detail="User account is unavailable.")
    if _email_verification_required() and not user.email_verified_at:
        raise HTTPException(status_code=401, detail="Email verification is required before signing in.")
    if int(getattr(row, "session_version", 1) or 1) != int(getattr(user, "session_version", 1) or 1):
        raise HTTPException(status_code=401, detail="Session expired or invalid.")
    return user


def require_current_user(
    authorization: Optional[str] = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = _bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return current_user_from_token(db, token)


def resolve_user_id(current_user: User, requested_user_id: Optional[str] = None) -> str:
    if requested_user_id and requested_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="You cannot access another user's data.")
    return current_user.id


def parse_settings_json(value: Optional[str]) -> dict:
    if not value:
        return {}
    try:
        data = json.loads(value)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def create_password_reset(db: Session, user: User, requested_by_ip: Optional[str]) -> str:
    now = utcnow()
    (
        db.query(PasswordResetToken)
        .filter(
            PasswordResetToken.user_id == user.id,
            PasswordResetToken.used_at.is_(None),
        )
        .update(
            {
                PasswordResetToken.used_at: now,
                PasswordResetToken.updated_at: now,
            },
            synchronize_session=False,
        )
    )
    token = new_password_reset_token()
    row = PasswordResetToken(
        user_id=user.id,
        token_hash=hash_password_reset_token(token),
        expires_at=password_reset_expiry(),
        requested_by_ip=(requested_by_ip or "")[:64] or None,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.commit()
    return token


def consume_password_reset(db: Session, token: str) -> User:
    token_hash = hash_password_reset_token(token)
    row = db.query(PasswordResetToken).filter(PasswordResetToken.token_hash == token_hash).first()
    if not row or row.used_at is not None or row.expires_at <= utcnow():
        raise HTTPException(status_code=400, detail="This password reset link is invalid or expired.")

    user = db.query(User).filter(User.id == row.user_id).first()
    if not user or not user.auth_enabled:
        raise HTTPException(status_code=400, detail="This password reset link is invalid or expired.")

    row.used_at = utcnow()
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(user)
    return user
