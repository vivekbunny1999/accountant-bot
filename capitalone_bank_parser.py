# capitalone_bank_parser.py
from __future__ import annotations

import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

import pdfplumber

MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12
}

_MONEY_RE = re.compile(r"\$?\s*([\d,]+\.\d{2})")

_DATE_LINE = re.compile(
    r"^(?P<mon>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(?P<day>\d{1,2})\b",
    re.IGNORECASE
)


def _money_to_float(s: str) -> Optional[float]:
    if s is None:
        return None
    ss = str(s).strip()
    if not ss:
        return None
    ss = ss.replace("$", "").replace(",", "").strip()
    try:
        return float(ss)
    except Exception:
        return None


def _normalize_spaces_keep_lines(full_text: str) -> str:
    # preserve line breaks; normalize within each line
    out_lines = []
    for line in (full_text or "").splitlines():
        line = line.replace("–", "-").replace("—", "-")
        line = re.sub(r"\s+", " ", line).strip()
        if line:
            out_lines.append(line)
    return "\n".join(out_lines)


def _extract_statement_period(raw_text: str) -> Optional[str]:
    """
    PDF shows:
      STATEMENT PERIOD
      Jan 1 - Jan 31, 2026
    Sometimes extracted as one line:
      STATEMENT PERIOD Jan 1 - Jan 31, 2026
    We convert it to: "Jan 01, 2026 to Jan 31, 2026"
    """
    t = raw_text or ""
    t = t.replace("–", "-").replace("—", "-")

    # allow newlines between words
    m = re.search(
        r"STATEMENT\s+PERIOD\s+([A-Za-z]{3}\s+\d{1,2})\s*-\s*([A-Za-z]{3}\s+\d{1,2},\s*20\d{2})",
        t,
        flags=re.IGNORECASE | re.MULTILINE
    )
    if not m:
        return None

    start_md = m.group(1).strip()          # "Jan 1"
    end_mdy = m.group(2).strip()           # "Jan 31, 2026"

    m2 = re.match(r"^([A-Za-z]{3})\s+(\d{1,2})$", start_md, flags=re.IGNORECASE)
    m3 = re.match(r"^([A-Za-z]{3})\s+(\d{1,2}),\s*(20\d{2})$", end_mdy, flags=re.IGNORECASE)
    if not (m2 and m3):
        return None

    s_mon = MONTHS.get(m2.group(1).lower())
    s_day = int(m2.group(2))

    e_mon = MONTHS.get(m3.group(1).lower())
    e_day = int(m3.group(2))
    e_year = int(m3.group(3))

    if not s_mon or not e_mon:
        return None

    # infer start year (handles year-crossing statements)
    s_year = e_year
    if s_mon > e_mon:
        s_year = e_year - 1

    try:
        sdt = datetime(s_year, s_mon, s_day)
        edt = datetime(e_year, e_mon, e_day)
        return f"{sdt.strftime('%b %d, %Y')} to {edt.strftime('%b %d, %Y')}"
    except Exception:
        return None


def _extract_account_name(raw_text: str) -> Optional[str]:
    # In your PDF: "360 Checking...8407"
    # We'll pick checking as the main label for now.
    if re.search(r"\b360\s+Checking\b", raw_text or "", re.IGNORECASE):
        return "360 Checking"
    return None


def _extract_checking_last4(raw_text: str) -> Optional[str]:
    t = raw_text or ""

    # Account Summary line: "360 Checking...8407"
    m = re.search(r"\b360\s+Checking.*?\.{3}\s*(\d{4})\b", t, re.IGNORECASE)
    if m:
        return m.group(1)

    # Another line on page: "360 Checking - 36319018407"
    m = re.search(r"\b360\s+Checking\s*-\s*\d+(\d{4})\b", t, re.IGNORECASE)
    if m:
        return m.group(1)

    # fallback: any "...####" near "360 Checking"
    m = re.search(r"\b360\s+Checking\b[^\n]{0,80}\b(\d{4})\b", t, re.IGNORECASE)
    if m:
        return m.group(1)

    return None


def _extract_begin_end_balances(raw_text: str) -> Dict[str, Optional[float]]:
    """
    Parses Account Summary:
      360 Checking...8407 $1,778.76 $1,055.79
      360 Performance Savings...2778 $1,004.73 $206.38
    """
    out = {
        "checking_begin_balance": None,
        "checking_end_balance": None,
        "savings_begin_balance": None,
        "savings_end_balance": None,
    }

    t = _normalize_spaces_keep_lines(raw_text)

    # Checking summary line
    m = re.search(
        r"\b360\s+Checking.*?\.{3}\s*\d{4}\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\b",
        t,
        flags=re.IGNORECASE
    )
    if m:
        out["checking_begin_balance"] = _money_to_float(m.group(1))
        out["checking_end_balance"] = _money_to_float(m.group(2))

    # Savings summary line (Performance Savings)
    m = re.search(
        r"\b360\s+Performance\s+Savings.*?\.{3}\s*\d{4}\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})\b",
        t,
        flags=re.IGNORECASE
    )
    if m:
        out["savings_begin_balance"] = _money_to_float(m.group(1))
        out["savings_end_balance"] = _money_to_float(m.group(2))

    return out


def _infer_cash_txn_type(line_text: str, sign_hint: Optional[str]) -> str:
    l = (line_text or "").lower()
    if "opening balance" in l:
        return "opening_balance"
    if "deposit" in l or "credit" in l:
        return "credit"
    if "withdrawal" in l or "debit" in l:
        return "debit"
    if sign_hint == "+":
        return "credit"
    if sign_hint == "-":
        return "debit"
    return "debit"


def _parse_cash_transactions(raw_text: str, year_hint: int) -> List[Dict[str, Any]]:
    """
    Handles two patterns from your PDF:
      1) Full line:
         Jan 2 Deposit from ... Credit + $596.21 $2,274.97
      2) Multi-line description BEFORE date line:
         Debit Card Purchase - NETFLIX ...
         CA US
         Jan 6 Debit - $24.99 $929.98
    """
    lines = _normalize_spaces_keep_lines(raw_text).splitlines()
    txns: List[Dict[str, Any]] = []

    pending_desc_parts: List[str] = []

    for line in lines:
        if not line:
            continue

        # If line doesn't start with a date, treat it as description continuation
        dm = _DATE_LINE.match(line)
        if not dm:
            # ignore obvious headers
            low = line.lower()
            if low.startswith("date description") or low.startswith("page "):
                continue
            # collect as pending description
            pending_desc_parts.append(line.strip())
            # keep buffer bounded
            if len(pending_desc_parts) > 4:
                pending_desc_parts = pending_desc_parts[-4:]
            continue

        # We have a date line
        mon = dm.group("mon")
        day = int(dm.group("day"))
        mon_num = MONTHS.get(mon.lower(), None)
        if not mon_num:
            pending_desc_parts = []
            continue

        # remainder after date
        rest = line[dm.end():].strip()

        # Skip opening balance as a "transaction"
        if rest.lower().startswith("opening balance"):
            pending_desc_parts = []
            continue

        # Extract money values on the line
        monies = _MONEY_RE.findall(rest)
        # Example has: amount + balance -> 2 money numbers
        if len(monies) < 2:
            # some lines may not be txns; clear buffer if needed
            # (but keep buffer if this was likely a continuation)
            continue

        amount_str = monies[-2]
        balance_str = monies[-1]

        amount = _money_to_float(amount_str)
        balance = _money_to_float(balance_str)

        # Detect debit/credit sign from text like "Credit + $596.21" or "Debit - $100.00"
        sign_hint = None
        msign = re.search(r"\b(Credit|Debit)\s*([+-])\b", rest, flags=re.IGNORECASE)
        if msign:
            sign_hint = msign.group(2)

        # Apply sign: Debit should be negative, Credit positive
        # (Capital One bank text explicitly gives + / -)
        if amount is not None:
            if sign_hint == "-":
                amount = -abs(amount)
            elif sign_hint == "+":
                amount = abs(amount)
            else:
                # fallback: if "debit" appears, treat negative
                if "debit" in rest.lower():
                    amount = -abs(amount)

        # Build description:
        # If rest contains real description (not just "Debit - $x $y"), use it.
        # Otherwise pull from pending buffer.
        desc = ""
        # remove trailing money pieces to get description-ish content
        rest_wo_money = re.sub(r"\$?\s*[\d,]+\.\d{2}", "", rest).strip()
        rest_wo_money = re.sub(r"\b(Credit|Debit)\b", "", rest_wo_money, flags=re.IGNORECASE).strip()
        rest_wo_money = re.sub(r"\s+[+-]\s*$", "", rest_wo_money).strip()

        if rest_wo_money:
            desc = rest_wo_money
        elif pending_desc_parts:
            desc = " ".join(pending_desc_parts).strip()

        # Clear buffer now that we consumed it
        pending_desc_parts = []

        # Construct posted_date ISO using year_hint (good enough for statement-month)
        try:
            dt = datetime(year_hint, mon_num, day).date().isoformat()
        except Exception:
            dt = None

        txn_type = _infer_cash_txn_type(desc or rest, sign_hint)

        txns.append(
            {
                "posted_date": dt,
                "description": desc or None,
                "amount": amount,
                "balance": balance,
                "txn_type": txn_type,
                "category": None,
            }
        )

    return txns


def parse_capitalone_bank_pdf(pdf_path: str) -> Dict[str, Any]:
    """
    Returns dict with bank statement meta + transactions list.

    Keys returned (used by api.py):
      institution, account_name, account_last4, statement_period,
      checking_begin_balance, checking_end_balance,
      savings_begin_balance, savings_end_balance,
      transactions: List[{posted_date, description, amount, balance, txn_type, category}]
    """
    with pdfplumber.open(pdf_path) as pdf:
        texts = [(p.extract_text() or "") for p in pdf.pages]
        full_text_raw = "\n".join(texts)

    out: Dict[str, Any] = {}
    out["filename"] = os.path.basename(pdf_path)
    out["institution"] = "CapitalOne"

    out["statement_period"] = _extract_statement_period(full_text_raw)

    out["account_name"] = _extract_account_name(full_text_raw)
    out["account_last4"] = _extract_checking_last4(full_text_raw)

    balances = _extract_begin_end_balances(full_text_raw)
    out.update(balances)

    # year_hint from statement period end year if available; else current year
    year_hint = datetime.utcnow().year
    sp = out.get("statement_period") or ""
    y = re.findall(r"\b(20\d{2})\b", sp)
    if y:
        year_hint = int(y[-1])

    out["transactions"] = _parse_cash_transactions(full_text_raw, year_hint=year_hint)
    return out