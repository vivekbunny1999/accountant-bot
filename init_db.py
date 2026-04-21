from db import ensure_column, initialize_database
import models  # noqa: F401


def main():
    initialize_database()

    # transactions.posted_date (already used in your code)
    ensure_column("transactions", "posted_date", "posted_date TEXT")

    # statements card identity
    ensure_column("statements", "card_name", "card_name TEXT")
    ensure_column("statements", "card_last4", "card_last4 TEXT")

    print("DB initialized/updated")


if __name__ == "__main__":
    main()
