from db import Base, engine
import models  # noqa: F401
from sqlalchemy import text


def ensure_column(table: str, col_name: str, col_sql: str):
    with engine.connect() as conn:
        cols = conn.execute(text(f"PRAGMA table_info({table});")).fetchall()
        col_names = [c[1] for c in cols]
        if col_name not in col_names:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col_sql};"))
            conn.commit()
            print(f"✅ Added {col_name} column to {table}")
        else:
            print(f"✅ {table}.{col_name} already exists")


def main():
    Base.metadata.create_all(bind=engine)

    # transactions.posted_date (already used in your code)
    ensure_column("transactions", "posted_date", "posted_date TEXT")

    # ✅ statements card identity
    ensure_column("statements", "card_name", "card_name TEXT")
    ensure_column("statements", "card_last4", "card_last4 TEXT")

    print("✅ DB initialized/updated")


if __name__ == "__main__":
    main()
