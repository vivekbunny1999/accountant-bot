import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base


def _normalize_database_url(url: str) -> str:
    """
    Keep local SQLite as the default, but make staging/prod Postgres URLs easy to drop in.
    SQLAlchemy expects `postgresql+psycopg2://` rather than legacy `postgres://`.
    """
    if not url:
        return "sqlite:///./accountant_bot.db"
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg2://", 1)
    return url


DATABASE_URL = _normalize_database_url(
    os.getenv("DATABASE_URL", "sqlite:///./accountant_bot.db")
)

engine_kwargs = {
    "pool_pre_ping": True,
}

if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_kwargs)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()
