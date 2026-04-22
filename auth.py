import json
from datetime import datetime
from typing import Optional

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from db import SessionLocal
from models import User, UserSession, UserSettings
from security import (
    hash_password,
    hash_session_token,
    new_session_token,
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


def _bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip()


def public_user(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "auth_enabled": bool(user.auth_enabled),
        "created_at": user.created_at.isoformat() if user.created_at else None,
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


def create_user(db: Session, email: str, password: str, display_name: Optional[str]) -> User:
    user = User(
        id=None,
        email=email,
        password_hash=hash_password(password),
        display_name=(display_name or "").strip() or email.split("@", 1)[0],
        auth_enabled=True,
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    return user


def persist_user(db: Session, user: User, user_id: str) -> User:
    user.id = user_id
    db.add(user)
    db.commit()
    db.refresh(user)
    ensure_user_settings(db, user.id)
    return user


def authenticate_user(db: Session, email: str, password: str) -> Optional[User]:
    user = db.query(User).filter(User.email == email).first()
    if not user or not user.auth_enabled or not user.password_hash:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def create_session(db: Session, user: User, user_agent: Optional[str] = None) -> tuple[str, UserSession]:
    token = new_session_token()
    row = UserSession(
        user_id=user.id,
        token_hash=hash_session_token(token),
        user_agent=(user_agent or "")[:255] or None,
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


def current_user_from_token(db: Session, token: str) -> User:
    token_hash = hash_session_token(token)
    row = (
        db.query(UserSession)
        .filter(UserSession.token_hash == token_hash)
        .first()
    )
    if not row or row.revoked_at is not None or row.expires_at <= utcnow():
        raise HTTPException(status_code=401, detail="Session expired or invalid.")

    user = db.query(User).filter(User.id == row.user_id).first()
    if not user or not user.auth_enabled:
        raise HTTPException(status_code=401, detail="User account is unavailable.")
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
