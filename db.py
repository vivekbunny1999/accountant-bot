import os
import re

from sqlalchemy import create_engine, inspect, text
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


def is_sqlite() -> bool:
    return engine.dialect.name == "sqlite"


_BOOLEAN_DEFAULT_PATTERN = re.compile(
    r"(\bBOOLEAN\b[^,]*\bDEFAULT\s+)(0|1)(\b)",
    re.IGNORECASE,
)


def _postgres_safe_column_sql(col_sql: str) -> str:
    """
    Postgres BOOLEAN defaults must use TRUE/FALSE rather than 0/1.
    SQLite accepts TRUE/FALSE too, so only rewrite for Postgres callers.
    """
    if engine.dialect.name != "postgresql":
        return col_sql

    def _replace(match: re.Match[str]) -> str:
        boolean_default = "TRUE" if match.group(2) == "1" else "FALSE"
        return f"{match.group(1)}{boolean_default}{match.group(3)}"

    return _BOOLEAN_DEFAULT_PATTERN.sub(_replace, col_sql)


def ensure_column(table: str, col_name: str, col_sql: str) -> bool:
    """
    Small additive schema helper for legacy databases.
    Works for both SQLite and Postgres by using SQLAlchemy inspection instead of PRAGMA.
    """
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if table not in table_names:
        return False

    col_names = {col["name"] for col in inspector.get_columns(table)}
    if col_name in col_names:
        return False

    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {_postgres_safe_column_sql(col_sql)}"))
    return True


def ensure_unique_index(table: str, index_name: str, columns: list[str]) -> bool:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if table not in table_names:
        return False

    for index in inspector.get_indexes(table):
        if index["name"] == index_name:
            return False
        if index.get("unique") and list(index.get("column_names") or []) == columns:
            return False

    for constraint in inspector.get_unique_constraints(table):
        if constraint.get("name") == index_name:
            return False
        if list(constraint.get("column_names") or []) == columns:
            return False

    cols_sql = ", ".join(columns)
    with engine.begin() as conn:
        conn.execute(text(f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {table} ({cols_sql})"))
    return True


def initialize_database() -> None:
    Base.metadata.create_all(bind=engine)
