# capitalone_parser.py
from __future__ import annotations

import os
import re
from datetime import datetime, date
from typing import Any, Dict, List, Optional, Tuple

import pdfplumber

# ========= Money helpers =========
_MONEY_CAPTURE = r"([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)"

def money_to_float(s: Optional[str]) -> Optional[float]:
    if s is None:
        return None
    try:
        return float(str(s).replace("$", "").replace(",", "").strip())
    except Exception:
        return None


def normalize_text(full_text: str) -> str:
    t = full_text or ""
    t = t.replace("–", "-").replace("—", "-")
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ========= Meta extraction (balances, minimum, etc.) =========
def extract_new_balance_and_min_payment(text_norm: str) -> Tuple[Optional[float], Optional[float]]:
    """
    Capital One PDFs often render a block like:
        "New Balance Minimum Payment Due $572.16 $25.00"
    or with line breaks that become spaces.
    This is the MOST reliable way to get both values.
    """
    if not text_norm:
        return (None, None)

    # Strong paired pattern
    m = re.search(
        rf"\bNew\s+Balance\s+Minimum\s+Payment\s+Due\s+\$?\s*{_MONEY_CAPTURE}\s+\$?\s*{_MONEY_CAPTURE}\b",
        text_norm,
        re.IGNORECASE
    )
    if m:
        nb = money_to_float(m.group(1))
        mp = money_to_float(m.group(2))
        return (nb, mp)

    # More flexible paired fallback
    m2 = re.search(
        rf"\bNew\s+Balance\b.*?\$?\s*{_MONEY_CAPTURE}.*?\bMinimum\s+Payment\s+Due\b.*?\$?\s*{_MONEY_CAPTURE}\b",
        text_norm,
        re.IGNORECASE | re.DOTALL
    )
    if m2:
        nb = money_to_float(m2.group(1))
        mp = money_to_float(m2.group(2))
        return (nb, mp)

    return (None, None)


def extract_new_balance(text_norm: str) -> Optional[float]:
    if not text_norm:
        return None

    matches = re.findall(
        rf"\bNew\s+Balance\s*(?:=)?\s*\$?\s*{_MONEY_CAPTURE}\b",
        text_norm,
        flags=re.IGNORECASE
    )
    if matches:
        return money_to_float(matches[-1])
    return None


def extract_min_payment(text_norm: str) -> Optional[float]:
    if not text_norm:
        return None

    matches = re.findall(
        rf"\bMinimum\s+Payment\s+Due\s*\$?\s*{_MONEY_CAPTURE}\b",
        text_norm,
        flags=re.IGNORECASE
    )
    if matches:
        return money_to_float(matches[-1])
    return None


def extract_interest_charged(text_norm: str) -> Optional[float]:
    """
    Capital One: reliable places are:
      - "Total Interest for This Period $15.67"
      - sometimes: "Interest Charged + $15.67"
    """
    if not text_norm:
        return None

    m = re.findall(
        rf"\bTotal\s+Interest\s+for\s+This\s+Period\s*\$?\s*{_MONEY_CAPTURE}\b",
        text_norm,
        flags=re.IGNORECASE
    )
    if m:
        return money_to_float(m[-1])

    m2 = re.findall(
        rf"\bInterest\s+Charged\s*\+?\s*\$?\s*{_MONEY_CAPTURE}\b",
        text_norm,
        flags=re.IGNORECASE
    )
    if m2:
        return money_to_float(m2[-1])

    return None


def extract_due_date(text_norm: str) -> Optional[str]:
    m = re.findall(
        r"Payment\s+Due\s+Date\s*[:\-]?\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})",
        text_norm,
        flags=re.IGNORECASE
    )
    if m:
        due = m[-1].strip()
        try:
            return datetime.strptime(due, "%b %d, %Y").date().isoformat()
        except Exception:
            return None
    return None


def extract_statement_period(text_norm: str) -> Optional[str]:
    m = re.findall(
        r"([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*\|\s*\d+\s+days\s+in\s+Billing\s+Cycle",
        text_norm,
        flags=re.IGNORECASE
    )
    if m:
        start, end = m[-1]
        return f"{start} to {end}"

    m2 = re.findall(
        r"([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})",
        text_norm
    )
    if m2:
        start, end = m2[-1]
        return f"{start} to {end}"

    return None


def extract_card_meta(text_norm: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"card_last4": None, "card_name": None}

    m = re.search(r"\bending\s+in\s+(\d{4})\b", text_norm, re.IGNORECASE)
    if m:
        out["card_last4"] = m.group(1)

    lower = (text_norm or "").lower()
    if "savor" in lower:
        out["card_name"] = "Savor"
    elif "venture" in lower:
        out["card_name"] = "Venture"
    elif "quicksilver" in lower:
        out["card_name"] = "Quicksilver"
    elif "platinum" in lower:
        out["card_name"] = "Platinum"

    return out


def find_apr(text_norm: str) -> Optional[float]:
    matches = re.findall(r"\bPurchases\s+(\d{1,2}\.\d{2})\s*%", text_norm, re.IGNORECASE)
    if matches:
        try:
            return float(matches[-1])
        except Exception:
            return None

    matches = re.findall(r"(?:Purchase\s+)?APR\s+(\d{1,2}\.\d{2})\s*%", text_norm, re.IGNORECASE)
    if matches:
        try:
            return float(matches[-1])
        except Exception:
            return None

    return None


# ========= Transactions parsing =========
MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
}

TXN_LINE = re.compile(
    r"""^\s*
    (?P<tran_date>
        (?:\d{1,2}/\d{1,2}(?:/\d{2,4})?) |
        (?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})
    )
    \s+
    (?P<post_date>
        (?:\d{1,2}/\d{1,2}(?:/\d{2,4})?) |
        (?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})
    )
    \s+
    (?P<desc>.+?)
    \s+
    (?P<amt>
        -?\s*\$?[\d,]+\.\d{2} |
        \(\s*\$?[\d,]+\.\d{2}\s*\)
    )
    \s*$""",
    re.IGNORECASE | re.VERBOSE,
)

def txn_money_to_float(s: str) -> Optional[float]:
    if not s:
        return None
    s = str(s).strip()
    neg = False

    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1].strip()

    if s.startswith("-"):
        neg = True
        s = s[1:].strip()

    s = s.replace("$", "").replace(",", "").strip()
    try:
        v = float(s)
        return -v if neg else v
    except ValueError:
        return None


def infer_txn_type(desc: str, amount: Optional[float]) -> str:
    d = (desc or "").lower()
    if "payment" in d or "pymt" in d or "thank you" in d:
        return "payment"
    if "interest" in d:
        return "interest"
    if "fee" in d:
        return "fee"
    if amount is not None and amount < 0:
        return "credit"
    return "purchase"


def parse_date(date_str: str, year_hint: int) -> Optional[str]:
    if not date_str:
        return None
    s = str(date_str).strip()

    if "/" in s:
        parts = s.split("/")
        try:
            mm = int(parts[0])
            dd = int(parts[1])
            yyyy = year_hint
            if len(parts) >= 3:
                y = int(parts[2])
                if y < 100:
                    y += 2000
                yyyy = y
            return datetime(yyyy, mm, dd).date().isoformat()
        except Exception:
            return None

    m = re.match(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})$", s, re.IGNORECASE)
    if m:
        mon = MONTHS[m.group(1).lower()]
        dd = int(m.group(2))
        try:
            return datetime(year_hint, mon, dd).date().isoformat()
        except Exception:
            return None

    return None


def parse_statement_period_bounds(statement_period: Optional[str]) -> Optional[Tuple[date, date]]:
    if not statement_period or not isinstance(statement_period, str):
        return None
    parts = statement_period.split(" to ")
    if len(parts) != 2:
        return None
    a = parts[0].strip()
    b = parts[1].strip()
    try:
        start = datetime.strptime(a, "%b %d, %Y").date()
        end = datetime.strptime(b, "%b %d, %Y").date()
        return (start, end)
    except Exception:
        return None


def month_from_date_str(date_str: str) -> Optional[int]:
    if not date_str:
        return None
    s = str(date_str).strip()

    if "/" in s:
        try:
            mm = int(s.split("/")[0])
            if 1 <= mm <= 12:
                return mm
        except Exception:
            return None

    m = re.match(r"^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b", s, re.IGNORECASE)
    if m:
        return MONTHS[m.group(1).lower()]
    return None


def year_hint_for_txn(date_str: str, bounds: Optional[Tuple[date, date]], fallback_year: int) -> int:
    if not bounds:
        return fallback_year
    start, end = bounds
    mm = month_from_date_str(date_str)
    if not mm:
        return fallback_year

    if start.year != end.year:
        return start.year if mm > end.month else end.year

    return end.year


def parse_capitalone_pdf(pdf_path: str) -> Dict[str, Any]:
    with pdfplumber.open(pdf_path) as pdf:
        texts = [(p.extract_text() or "") for p in pdf.pages]
        full_text_raw = "\n".join(texts)

    text_norm = normalize_text(full_text_raw)

    out: Dict[str, Any] = {}
    out["filename"] = os.path.basename(pdf_path)

    meta = extract_card_meta(text_norm)
    out["card_last4"] = meta.get("card_last4")
    out["card_name"] = meta.get("card_name")

    out["statement_period"] = extract_statement_period(text_norm)
    out["due_date"] = extract_due_date(text_norm)
    out["apr"] = find_apr(text_norm)

    # --- FIX: always prefer paired extraction for new_balance + minimum_payment ---
    nb, mp = extract_new_balance_and_min_payment(text_norm)
    if nb is None:
        nb = extract_new_balance(text_norm)
    if mp is None:
        mp = extract_min_payment(text_norm)

    out["new_balance"] = nb
    out["minimum_payment"] = mp

    # interest extraction (separate)
    out["interest_charged"] = extract_interest_charged(text_norm)

    # Safety: if mp accidentally equals nb AND mp is suspiciously high/identical often,
    # keep it as-is ONLY if we truly parsed mp, else leave None.
    # (We don't have enough info to "correct" it without lying.)
    # This prevents the buggy "copy nb into mp" behavior.
    if out["minimum_payment"] is not None and out["new_balance"] is not None:
        # no forced overwrite here; just ensuring we never assign mp from nb.
        pass

    # Year hint fallback from statement period
    fallback_year = datetime.utcnow().year
    sp = out.get("statement_period")
    if isinstance(sp, str):
        y = re.findall(r"\b(20\d{2})\b", sp)
        if y:
            fallback_year = int(y[-1])

    bounds = parse_statement_period_bounds(out.get("statement_period"))

    txns: List[Dict[str, Any]] = []
    for line in full_text_raw.splitlines():
        line = (line or "").strip()
        if not line:
            continue

        m = TXN_LINE.match(line)
        if not m:
            continue

        post_raw = m.group("post_date").strip()
        desc = m.group("desc").strip()
        amt_raw = m.group("amt").strip()

        amount = txn_money_to_float(amt_raw)

        year_hint = year_hint_for_txn(post_raw, bounds, fallback_year)
        posted_iso = parse_date(post_raw, year_hint)

        txn_type = infer_txn_type(desc, amount)

        txns.append(
            {
                "posted_date": posted_iso,
                "description": desc,
                "amount": amount,
                "txn_type": txn_type,
            }
        )

    out["transactions"] = txns
    return out