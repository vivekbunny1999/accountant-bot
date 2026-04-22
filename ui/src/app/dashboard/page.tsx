"use client";

import {
  getCashAccounts,
  getCashAccountTransactions,
  getNextBestDollar,
  getOsState,
  NextBestDollarResponse,
  OsStateResponse,
} from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";
import type { CashTxn, CashAccount } from "@/types/cash";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  listStatements,
  listStatementTransactions,
  Statement,
  Transaction,
} from "@/lib/api";


/** =========================
 * Money / date helpers
 * ========================= */
function fmtMoney(n: number) {
  const v = Number(n || 0);
  return `$${v.toFixed(2)}`;
}

function safeTime(s?: string | null) {
  const t = new Date(s ?? "").getTime();
  return Number.isFinite(t) ? t : 0;
}

// robust date parsing for YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, "Jan 4"
function parseDateLoose(s?: string | null): Date | null {
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = /^(\d{4})[-\/](\d{2})[-\/](\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // MM/DD/YYYY
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));

  // fallback to Date parsing
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;

  return null;
}

function isSameMonth(d: Date, y: number, m0: number) {
  return d.getFullYear() === y && d.getMonth() === m0;
}

function fmtMonthLabel(y: number, m0: number) {
  const d = new Date(y, m0, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** =========================
 * Trend bucketing
 * ========================= */
// We bucket trend by "statement end month" (from period like: "Dec 09, 2025 to Jan 08, 2026")
function bucketKeyFromPeriod(statement_period: string) {
  const parts = statement_period.split(" to ");
  const end = parts[1]?.trim() ?? "";
  const d = new Date(end);
  if (Number.isNaN(d.getTime())) return statement_period;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`; // YYYY-MM
}

function labelFromBucketKey(key: string) {
  // key = YYYY-MM
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** =========================
 * Categories
 * ========================= */
type Category =
  | "Uncategorized"
  | "Housing"
  | "Utilities"
  | "Groceries"
  | "Dining"
  | "Fuel"
  | "Transport"
  | "Insurance"
  | "Medical"
  | "Personal Care"
  | "Subscriptions"
  | "Shopping"
  | "Debt Payment"
  | "Fees & Interest"
  | "Income"
  | "Loan"
  | "Entertainment"
  | "Travel"
  | "Education"
  | "Gifts/Donations"
  | "Kids/Family"
  | "Business"
  | "Taxes"
  | "Other";

const CATEGORY_OPTIONS: Category[] = [
  "Uncategorized",
  "Housing",
  "Utilities",
  "Groceries",
  "Dining",
  "Fuel",
  "Transport",
  "Insurance",
  "Medical",
  "Personal Care",
  "Subscriptions",
  "Shopping",
  "Debt Payment",
  "Fees & Interest",
  "Income",
  "Loan",
  "Entertainment",
  "Travel",
  "Education",
  "Gifts/Donations",
  "Kids/Family",
  "Business",
  "Taxes",
  "Other",
];

/** =========================
 * localStorage category rules
 * ========================= */
const RULES_KEY = "accountantbot_category_rules_v1";

function loadRules(): Record<string, Category> {
  try {
    const s = localStorage.getItem(RULES_KEY);
    if (!s) return {};
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function signatureFor(t: Transaction): string {
  const raw = `${(t as any).merchant ?? ""} ${(t as any).description ?? ""}`
    .trim()
    .toLowerCase();
  return (
    raw.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() || "unknown"
  );
}

function defaultCategoryFor(t: Transaction): Category {
  const text = `${(t as any).description ?? ""} ${(t as any).merchant ?? ""}`.toLowerCase();

  if (text.includes("pymt") || text.includes("payment")) return "Debt Payment";

  if (
    text.includes("interest") ||
    text.includes("late fee") ||
    text.includes("annual fee") ||
    text.includes("fee")
  )
    return "Fees & Interest";

  // crude income detection (will be better once checking/savings import exists)
  if (
    text.includes("payroll") ||
    text.includes("direct dep") ||
    text.includes("salary") ||
    text.includes("paycheck")
  )
    return "Income";

  return "Uncategorized";
}

function categoryFor(t: Transaction, rules: Record<string, Category>): Category {
  const sig = signatureFor(t);
  return (rules as any)[sig] ?? defaultCategoryFor(t);
}

function amountAbs(t: Transaction) {
  return Math.abs(Number((t as any).amount) || 0);
}

// Spend vs credit (dashboard category grid should focus on spend)
function isCreditLike(t: Transaction) {
  const a = Number((t as any).amount);
  const text = `${(t as any).description ?? ""} ${(t as any).merchant ?? ""}`.toLowerCase();
  return (
    a < 0 ||
    text.includes("pymt") ||
    text.includes("payment") ||
    text.includes("refund") ||
    text.includes("reversal") ||
    text.includes("credit")
  );
}

/** =========================
 * Week bucketing (4 buckets)
 * ========================= */
function weekBucketIndex(dayOfMonth: number) {
  if (dayOfMonth <= 7) return 0; // W1
  if (dayOfMonth <= 14) return 1; // W2
  if (dayOfMonth <= 21) return 2; // W3
  return 3; // W4 (22-end)
}

function weekRangeLabel(y: number, m0: number, idx: number) {
  const lastDay = new Date(y, m0 + 1, 0).getDate();
  const ranges: Array<[number, number]> = [
    [1, Math.min(7, lastDay)],
    [8, Math.min(14, lastDay)],
    [15, Math.min(21, lastDay)],
    [22, lastDay],
  ];

  const [a, b] = ranges[idx];
  const start = new Date(y, m0, a);
  const end = new Date(y, m0, b);

  const s = start.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  const e = end.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  return `${s}–${e}`;
}

/** =========================
 * Settings (Financial OS)
 * ========================= */
const SETTINGS_KEY = "accountantbot_settings_v1";

type DebtStrategy = "Avalanche" | "Snowball";
type Stage =
  | "Crisis"
  | "Stabilize"
  | "Attack Debt"
  | "Build Security"
  | "Build Wealth";

type PaycheckSplitMode = "3-Buckets" | "Custom";

type DashboardSettings = {
  buffer_enabled?: boolean;
  buffer_amount?: number;

  target_runway_months?: number;
  target_debt_free_date?: string | null;

  paycheck_split_mode?: PaycheckSplitMode;
  paycheck_split_bills_pct?: number;
  paycheck_split_spend_pct?: number;
  paycheck_split_extra_pct?: number;

  debt_strategy?: DebtStrategy;

  alerts_enabled?: boolean;
  alert_if_buffer_breached?: boolean;
  alert_if_spend_cap_exceeded?: boolean;

  cap_monthly_spend?: number;
  cap_discretionary_spend?: number;

  show_financial_os_panels?: boolean;
};

function loadSettings(): DashboardSettings {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return {};
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function clampPct(n: any, fallback: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100, v));
}

function clampMoney(n: any, fallback: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, v);
}

function resolveSettings(raw: DashboardSettings): Required<DashboardSettings> {
  const bills = clampPct(raw.paycheck_split_bills_pct, 55);
  const spend = clampPct(raw.paycheck_split_spend_pct, 35);
  const extra = clampPct(raw.paycheck_split_extra_pct, 10);

  const sum = bills + spend + extra;
  const nb = sum ? (bills / sum) * 100 : 55;
  const ns = sum ? (spend / sum) * 100 : 35;
  const ne = sum ? (extra / sum) * 100 : 10;

  return {
    buffer_enabled: raw.buffer_enabled ?? true,
    buffer_amount: clampMoney(raw.buffer_amount, 150),

    target_runway_months: clampMoney(raw.target_runway_months, 3),
    target_debt_free_date: raw.target_debt_free_date ?? null,

    paycheck_split_mode: raw.paycheck_split_mode ?? "3-Buckets",
    paycheck_split_bills_pct: nb,
    paycheck_split_spend_pct: ns,
    paycheck_split_extra_pct: ne,

    debt_strategy: raw.debt_strategy ?? "Avalanche",

    alerts_enabled: raw.alerts_enabled ?? true,
    alert_if_buffer_breached: raw.alert_if_buffer_breached ?? true,
    alert_if_spend_cap_exceeded: raw.alert_if_spend_cap_exceeded ?? true,

    cap_monthly_spend: clampMoney(raw.cap_monthly_spend, 0),
    cap_discretionary_spend: clampMoney(raw.cap_discretionary_spend, 0),

    show_financial_os_panels: raw.show_financial_os_panels ?? true,
  };
}

function getStageV1(opts: {
  monthSpend: number;
  monthIncome: number;
  buffer: number;
  capMonthlySpend: number;
}): Stage {
  const { monthSpend, monthIncome, buffer, capMonthlySpend } = opts;

  if (monthIncome <= 0) return "Stabilize";

  const surplus = monthIncome - monthSpend;

  if (surplus < 0) return "Crisis";
  if (surplus < buffer) return "Stabilize";

  if (capMonthlySpend > 0 && monthSpend > capMonthlySpend) return "Stabilize";

  if (surplus >= buffer) return "Attack Debt";
  return "Stabilize";
}

function stageBadge(stage: Stage) {
  switch (stage) {
    case "Crisis":
      return { cls: "text-red-300 bg-red-500/10 border-red-500/20", label: "Crisis" };
    case "Stabilize":
      return { cls: "text-amber-300 bg-amber-500/10 border-amber-500/20", label: "Stabilize" };
    case "Attack Debt":
      return { cls: "text-sky-300 bg-sky-500/10 border-sky-500/20", label: "Attack Debt" };
    case "Build Security":
      return { cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", label: "Build Security" };
    case "Build Wealth":
      return { cls: "text-violet-300 bg-violet-500/10 border-violet-500/20", label: "Build Wealth" };
    default:
      return { cls: "text-zinc-300 bg-white/5 border-white/10", label: stage };
  }
}

/** =========================
 * Latest statement per card helpers
 * ========================= */
function getStatementEndTime(s: Statement) {
  if (!(s as any).statement_period) return 0;
  const parts = String((s as any).statement_period).split(" to ");
  const end = parts[1]?.trim();
  if (!end) return 0;
  const d = new Date(end);
  return Number.isFinite(d.getTime()) ? d.getTime() : 0;
}

/** =========================
 * Cash latest import helpers
 * ========================= */
function getCashImportEndTime(a: any) {
  const s = String(a?.statement_end_date ?? "");
  const d = s ? new Date(s) : null;
  const t = d && Number.isFinite(d.getTime()) ? d.getTime() : 0;
  // fallback to created_at
  return Math.max(t, safeTime(a?.created_at));
}

function cashEndBalance(a: any) {
  const checking = Number(a?.checking_end_balance ?? 0);
  const savings = Number(a?.savings_end_balance ?? 0);
  return (Number.isFinite(checking) ? checking : 0) + (Number.isFinite(savings) ? savings : 0);
}

export default function DashboardPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const [data, setData] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [settings, setSettings] = useState<Required<DashboardSettings>>(() =>
    resolveSettings({})
  );

  useEffect(() => {
    setSettings(resolveSettings(loadSettings()));

    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) {
        setSettings(resolveSettings(loadSettings()));
      }
    };
    window.addEventListener("storage", onStorage);

    const onCustom = () => setSettings(resolveSettings(loadSettings()));
    window.addEventListener("accountantbot:settings", onCustom as any);

    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("accountantbot:settings", onCustom as any);
    };
  }, []);


useEffect(() => {
  if (!userId) return;
  let cancelled = false;

  (async () => {
    try {
      setBillsLoading(true);
      setBillsErr(null);

      // use /os/state to get upcoming items + manual bills
      const st = await getOsState({ user_id: userId, window_days: 21 } as any);
      if (cancelled) return;

      setBills((st?.manual_bills as any) || []);
      // note: upcoming items are consumed from the `upcomingBills` memo below
    } catch (e: any) {
      if (!cancelled) setBillsErr(e?.message || "Failed to load bills");
    } finally {
      if (!cancelled) setBillsLoading(false);
    }
  })();

  return () => {
    cancelled = true;
  };
}, [userId]);


// ===== Bills (Upcoming window) =====
type Bill = {
  id: number;
  user_id: string;
  name: string;
  amount: number;
  due_date: string; // "YYYY-MM-DD" (recommended)
  frequency?: string | null;
  is_active?: boolean;
  autopay?: boolean;
  category?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
};

   const [bills, setBills] = useState<Bill[]>([]);
   const [billsLoading, setBillsLoading] = useState(false);
   const [billsErr, setBillsErr] = useState<string | null>(null);

const upcomingWindowDays = 21; // Phase 1 default; later we’ll read from settings if you want

const [upcomingItems, setUpcomingItems] = useState<any[]>([]);
const [upcomingTotal, setUpcomingTotal] = useState(0);

// map backend upcoming_items into client-friendly list (already filtered by window)
useEffect(() => {
  if (!userId) return;
  let cancelled = false;
  (async () => {
    try {
      const st = await getOsState({ user_id: userId, window_days: upcomingWindowDays } as any);
      if (cancelled) return;
      setUpcomingItems(st?.upcoming_items || []);
      setUpcomingTotal(Number(st?.upcoming_total || 0));
    } catch (e) {
      if (!cancelled) {
        setUpcomingItems([]);
        setUpcomingTotal(0);
      }
    }
  })();
  return () => {
    cancelled = true;
  };
}, [bills, upcomingWindowDays, userId]);

  // current month (dashboard fixed)
  const now = useMemo(() => new Date(), []);
  const cy = now.getFullYear();
  const cm0 = now.getMonth();

  // txns state for dashboard month analytics
  const [monthTxns, setMonthTxns] = useState<Transaction[]>([]);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [cashMonthTxns, setCashMonthTxns] = useState<CashTxn[]>([]);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashErr, setCashErr] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const [osCashTotal, setOsCashTotal] = useState(0);
  const [osCashSources, setOsCashSources] = useState<OsStateResponse["cash_sources"] | null>(null);
  const [nextBestDollar, setNextBestDollar] = useState<NextBestDollarResponse | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    listStatements()
      .then(setData)
      .catch((e) => setErr(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const latestPerCard = useMemo(() => {
    const map = new Map<string, Statement>();

    for (const s of data) {
      const key =
        ((s as any).account_label ?? "Account") +
        "|" +
        ((s as any).card_last4 ?? (s as any).card_name ?? (s as any).statement_code);

      const prev = map.get(key);

      if (!prev) {
        map.set(key, s);
        continue;
      }

      if (getStatementEndTime(s) > getStatementEndTime(prev)) {
        map.set(key, s);
      }
    }

    return Array.from(map.values()).sort(
      (a, b) => getStatementEndTime(b) - getStatementEndTime(a)
    );
  }, [data]);

  const totals = useMemo(() => {
    const totalOutstanding = latestPerCard.reduce(
      (sum, s) => sum + Number((s as any).new_balance || 0),
      0
    );
    const totalInterestAllTime = data.reduce(
      (sum, s) => sum + Number((s as any).interest_charged || 0),
      0
    );

    return {
      totalOutstanding,
      totalInterestAllTime,
      cardsCount: latestPerCard.length,
      statementsCount: data.length,
    };
  }, [data, latestPerCard]);

  /** =========================
   * Load cash accounts + month txns
   * ========================= */
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      try {
        setCashLoading(true);
        setCashErr(null);

        const accs = await getCashAccounts({ user_id: userId, limit: 100 });
        if (cancelled) return;

        setCashAccounts(accs as any);

        // load txns for all cash accounts and filter to current month
        const all = await Promise.all(
          (accs as any[]).map(async (a) => {
            try {
              const tx = await getCashAccountTransactions(a.id, { user_id: userId, limit: 500 });
              return tx as any[];
            } catch {
              return [] as any[];
            }
          })
        );

        if (cancelled) return;

        const flattened = all.flat();

        const filtered = flattened.filter((t: any) => {
          const d = parseDateLoose(t.posted_date ?? t.transaction_date ?? t.date);
          if (!d) return false;
          return isSameMonth(d, cy, cm0);
        });

        setCashMonthTxns(filtered as any);
      } catch (e: any) {
        if (!cancelled) setCashErr(e?.message || "Failed to load cash accounts/transactions");
      } finally {
        if (!cancelled) setCashLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cy, cm0, userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      try {
        const [stateRes, nbdRes] = await Promise.all([
          getOsState({ user_id: userId, window_days: upcomingWindowDays }),
          getNextBestDollar({
            user_id: userId,
            window_days: upcomingWindowDays,
            buffer: settings.buffer_enabled ? settings.buffer_amount : 0,
          }),
        ]);
        if (cancelled) return;
        setOsCashTotal(Number(stateRes?.cash_total || 0));
        setOsCashSources(stateRes?.cash_sources || null);
        setNextBestDollar(nbdRes || null);
      } catch {
        if (cancelled) return;
        setOsCashTotal(0);
        setOsCashSources(null);
        setNextBestDollar(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, upcomingWindowDays, settings.buffer_amount, settings.buffer_enabled]);

  /** =========================
   * Cash totals (latest import)
   * ========================= */
  const cashTotals = useMemo(() => {
    const list = (cashAccounts || []) as any[];
    if (!list.length) {
      return {
        hasCash: false,
        latest: null as any,
        totalCash: 0,
        label: "No cash import yet",
      };
    }

    const latest = [...list].sort((a, b) => getCashImportEndTime(b) - getCashImportEndTime(a))[0];
    const totalCash = cashEndBalance(latest);

    const endDate = latest?.statement_end_date
      ? String(latest.statement_end_date)
      : (latest?.statement_period ? String(latest.statement_period) : "—");

    return {
      hasCash: true,
      latest,
      totalCash: osCashTotal > 0 ? osCashTotal : totalCash,
      label:
        osCashTotal > 0
          ? `PDF ${fmtMoney(Number(osCashSources?.pdf_cash_total || 0))} • Plaid ${fmtMoney(Number(osCashSources?.plaid_cash_total || 0))}`
          : endDate,
    };
  }, [cashAccounts, osCashSources, osCashTotal]);

  const netWorthV1 = useMemo(() => {
    return cashTotals.totalCash - totals.totalOutstanding;
  }, [cashTotals.totalCash, totals.totalOutstanding]);

  /** =========================
   * Trend: sum balances by statement end-month
   * ========================= */
  const trend = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const s of data) {
      const sp = String((s as any).statement_period ?? "");
      if (!sp) continue;
      const k = bucketKeyFromPeriod(sp);
      buckets.set(k, (buckets.get(k) ?? 0) + Number((s as any).new_balance || 0));
    }

    const sorted = Array.from(buckets.entries()).sort((a, b) =>
      a[0].localeCompare(b[0])
    );

    return sorted.slice(-8);
  }, [data]);

  const recent = useMemo(() => {
    return [...data]
      .sort((a, b) => safeTime((b as any).created_at) - safeTime((a as any).created_at))
      .slice(0, 12);
  }, [data]);

  /** =========================
   * Dashboard month txns fetch (credit cards)
   * ========================= */
  useEffect(() => {
    if (!data.length) {
      setMonthTxns([]);
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        setTxLoading(true);
        setTxErr(null);

        const rules = loadRules();

        const all = await Promise.all(
          data.map(async (s) => {
            try {
              const t = await listStatementTransactions((s as any).id);
              return t.map((x: any) => ({
                ...x,
                category: categoryFor(x, rules),
              }));
            } catch {
              return [] as Transaction[];
            }
          })
        );

        const flattened = all.flat();

        const filtered = flattened.filter((t: any) => {
          const d = parseDateLoose(t.posted_date ?? t.date);
          if (!d) return false;
          return isSameMonth(d, cy, cm0);
        });

        if (!cancelled) setMonthTxns(filtered);
      } catch (e: any) {
        if (!cancelled)
          setTxErr(e?.message || "Failed to load dashboard transactions");
      } finally {
        if (!cancelled) setTxLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data, cy, cm0]);

  /** =========================
   * Category totals for current month (spend only)
   * ========================= */
  const categoryTiles = useMemo(() => {
    const spends = monthTxns.filter((t) => !isCreditLike(t));

    const totalsMap = new Map<Category, { total: number; count: number }>();
    for (const c of CATEGORY_OPTIONS) totalsMap.set(c, { total: 0, count: 0 });

    for (const t of spends) {
      const c = ((t as any).category as Category) ?? "Uncategorized";
      const prev = totalsMap.get(c) ?? { total: 0, count: 0 };
      prev.total += amountAbs(t);
      prev.count += 1;
      totalsMap.set(c, prev);
    }

    const tiles = Array.from(totalsMap.entries())
      .map(([cat, v]) => ({ cat, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);

    return tiles.slice(0, 15);
  }, [monthTxns]);

  function rarityLabel(count: number) {
    if (count >= 8)
      return {
        label: "Common",
        cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
      };
    if (count >= 3)
      return {
        label: "Uncommon",
        cls: "text-sky-300 bg-sky-500/10 border-sky-500/20",
      };
    if (count >= 1)
      return {
        label: "Rare",
        cls: "text-amber-300 bg-amber-500/10 border-amber-500/20",
      };
    return { label: "—", cls: "text-zinc-400 bg-white/5 border-white/10" };
  }

  /** =========================
   * Weekly spend bars (4 bars)
   * ========================= */
  const weekly = useMemo(() => {
    const spends = monthTxns.filter((t) => !isCreditLike(t));

    const buckets = [0, 0, 0, 0];
    for (const t of spends) {
      const d = parseDateLoose((t as any).posted_date ?? (t as any).date);
      if (!d) continue;
      const idx = weekBucketIndex(d.getDate());
      buckets[idx] += amountAbs(t);
    }

    const max = Math.max(1, ...buckets);
    return { buckets, max };
  }, [monthTxns]);

  /** =========================
   * Financial OS metrics from month txns (V1)
   * ========================= */
  const monthMetrics = useMemo(() => {
    // ===== Credit Card (existing behavior) =====
    const ccSpends = monthTxns.filter((t) => !isCreditLike(t));
    const ccCredits = monthTxns.filter((t: any) => isCreditLike(t));

    const ccMonthSpend = ccSpends.reduce((s, t) => s + amountAbs(t), 0);

    const ccMonthIncome = ccCredits.reduce((acc, t: any) => {
      const cat = (t.category as Category) ?? "Uncategorized";
      const text = `${t.description ?? ""} ${t.merchant ?? ""}`.toLowerCase();
      const isIncome =
        cat === "Income" ||
        text.includes("payroll") ||
        text.includes("direct dep") ||
        text.includes("salary") ||
        text.includes("paycheck");
      if (!isIncome) return acc;
      return acc + Math.abs(Number(t.amount) || 0);
    }, 0);

    // ===== Cash Accounts (new) =====
    const cashSpend = (cashMonthTxns || []).reduce((acc, t: any) => {
      const amt = Number(t.amount ?? 0);
      if (amt < 0) return acc + Math.abs(amt);
      return acc;
    }, 0);

    const cashIncome = (cashMonthTxns || []).reduce((acc, t: any) => {
      const amt = Number(t.amount ?? 0);
      if (amt <= 0) return acc;

      const cat = String(t.category ?? "");
      const text = `${t.description ?? ""} ${t.merchant ?? ""} ${t.name ?? ""}`.toLowerCase();
      const isIncome =
        cat === "Income" ||
        text.includes("payroll") ||
        text.includes("direct dep") ||
        text.includes("salary") ||
        text.includes("paycheck");

      return isIncome ? acc + amt : acc;
    }, 0);

    const effectiveIncome = cashIncome > 0 ? cashIncome : ccMonthIncome;
    const effectiveSpend = ccMonthSpend + cashSpend;

    const discretionaryCats: Category[] = [
      "Dining",
      "Entertainment",
      "Shopping",
      "Travel",
      "Subscriptions",
      "Personal Care",
    ];

    const ccDiscretionary = ccSpends.reduce((acc, t: any) => {
      const cat = (t.category as Category) ?? "Uncategorized";
      if (discretionaryCats.includes(cat)) return acc + amountAbs(t);
      return acc;
    }, 0);

    const cashDiscretionary = (cashMonthTxns || []).reduce((acc, t: any) => {
      const amt = Number(t.amount ?? 0);
      if (amt >= 0) return acc;
      const cat = String(t.category ?? "Uncategorized") as Category;
      if (discretionaryCats.includes(cat)) return acc + Math.abs(amt);
      return acc;
    }, 0);

    const discretionarySpend = ccDiscretionary + cashDiscretionary;

    const buffer = settings.buffer_enabled ? settings.buffer_amount : 0;

    const sts =
      effectiveIncome > 0 ? Math.max(0, effectiveIncome - effectiveSpend - buffer) : 0;

    const stage = getStageV1({
      monthSpend: effectiveSpend,
      monthIncome: effectiveIncome,
      buffer,
      capMonthlySpend: settings.cap_monthly_spend,
    });

    const base = effectiveIncome;
    const splitBills = (base * settings.paycheck_split_bills_pct) / 100;
    const splitSpend = (base * settings.paycheck_split_spend_pct) / 100;
    const splitExtra = (base * settings.paycheck_split_extra_pct) / 100;

    const alerts: Array<{ kind: "warn" | "danger"; title: string; body: string }> = [];

    if (settings.alerts_enabled) {
      if (
        settings.alert_if_spend_cap_exceeded &&
        settings.cap_monthly_spend > 0 &&
        effectiveSpend > settings.cap_monthly_spend
      ) {
        alerts.push({
          kind: "danger",
          title: "Spend cap exceeded",
          body: `You spent ${fmtMoney(effectiveSpend)} this month, above your cap of ${fmtMoney(
            settings.cap_monthly_spend
          )}.`,
        });
      }

      if (
        settings.alert_if_buffer_breached &&
        settings.buffer_enabled &&
        effectiveIncome > 0 &&
        effectiveIncome - effectiveSpend < settings.buffer_amount
      ) {
        alerts.push({
          kind: "warn",
          title: "Buffer at risk",
          body: `Your buffer is ${fmtMoney(
            settings.buffer_amount
          )}. Current cushion is ${fmtMoney(effectiveIncome - effectiveSpend)}.`,
        });
      }

      if (
        settings.cap_discretionary_spend > 0 &&
        discretionarySpend > settings.cap_discretionary_spend
      ) {
        alerts.push({
          kind: "warn",
          title: "Discretionary cap exceeded",
          body: `Discretionary spend is ${fmtMoney(
            discretionarySpend
          )}, above your cap of ${fmtMoney(settings.cap_discretionary_spend)}.`,
        });
      }
    }

    return {
      monthSpend: effectiveSpend,
      monthIncome: effectiveIncome,

      discretionarySpend,
      buffer,
      sts,
      stage,
      splitBills,
      splitSpend,
      splitExtra,
      alerts,

      ccMonthSpend,
      ccMonthIncome,
      cashSpend,
      cashIncome,

      cashAccountsCount: (cashAccounts || []).length,
      cashTotalBalance: cashTotals.totalCash,
      cashLoading,
      cashErr,
    };
  }, [monthTxns, cashMonthTxns, cashAccounts, cashTotals.totalCash, cashLoading, cashErr, settings]);

  const stageUi = useMemo(() => stageBadge(monthMetrics.stage), [monthMetrics.stage]);

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">Dashboard</div>
              <div className="mt-1 text-sm text-zinc-400">
                Quick overview across your cards •{" "}
                <span className="text-zinc-200">{fmtMonthLabel(cy, cm0)}</span>
              </div>
            </div>

            {settings.show_financial_os_panels && (
              <div
                className={[
                  "inline-flex items-center rounded-full border px-3 py-1 text-xs",
                  stageUi.cls,
                ].join(" ")}
                title="Your current Financial OS stage (V1 estimate)"
              >
                Stage: {stageUi.label}
              </div>
            )}
          </div>
        </div>

        {/* ===== Financial OS alerts ===== */}
        {settings.show_financial_os_panels && monthMetrics.alerts.length > 0 && (
          <div className="space-y-3">
            {monthMetrics.alerts.map((a, i) => (
              <div
                key={i}
                className={[
                  "rounded-2xl border p-4",
                  a.kind === "danger"
                    ? "border-red-500/20 bg-red-500/10"
                    : "border-amber-500/20 bg-amber-500/10",
                ].join(" ")}
              >
                <div
                  className={[
                    "text-sm font-semibold",
                    a.kind === "danger" ? "text-red-200" : "text-amber-200",
                  ].join(" ")}
                >
                  {a.title}
                </div>
                <div className="mt-1 text-sm text-zinc-200/90">{a.body}</div>
              </div>
            ))}
          </div>
        )}

        {/* ===== Financial OS control panels ===== */}
        {settings.show_financial_os_panels && (
          <div className="grid gap-3 lg:grid-cols-3">
            {/* Safe-to-Spend */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">
                  Safe to Spend
                </div>
                <div className="text-xs text-zinc-400">Settings-driven</div>
              </div>

              <div className="mt-3 text-3xl font-semibold text-zinc-100">
                {nextBestDollar ? fmtMoney(Number(nextBestDollar.safe_to_spend_today || 0)) : (monthMetrics.monthIncome > 0 ? fmtMoney(monthMetrics.sts) : "—")}
              </div>

              <div className="mt-2 text-xs text-zinc-500">
                Buffer rule:{" "}
                <span className="text-zinc-200">
                  {settings.buffer_enabled ? fmtMoney(settings.buffer_amount) : "Off"}
                </span>
                {" • "}
                Cash total:{" "}
                <span className="text-zinc-200">{fmtMoney(cashTotals.totalCash)}</span>
                {" • "}
                Upcoming bills:{" "}
                <span className="text-zinc-200">
                  {nextBestDollar ? fmtMoney(Number(nextBestDollar.upcoming_total || 0)) : fmtMoney(upcomingTotal)}
                </span>
                {" • "}
                Month spend:{" "}
                <span className="text-zinc-200">{fmtMoney(monthMetrics.monthSpend)}</span>
                {" • "}
                Detected income:{" "}
                <span className="text-zinc-200">
                  {monthMetrics.monthIncome > 0 ? fmtMoney(monthMetrics.monthIncome) : "Not found yet"}
                </span>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Financial OS uses backend cash totals, including non-duplicate Plaid cash, when available.
              </div>

              {/* Small cash debug line (non-breaking) */}
              <div className="mt-3 text-xs text-zinc-500">
                Cash import:{" "}
                <span className="text-zinc-200">
                  {cashTotals.hasCash ? cashTotals.label : (cashLoading ? "Loading…" : "Not imported")}
                </span>
                {cashErr ? <span className="text-red-300"> • {cashErr}</span> : null}
              </div>
            </div>

            {/* Paycheck splits */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">
                  Paycheck Split
                </div>
                <div className="text-xs text-zinc-400">
                  {settings.paycheck_split_mode}
                </div>
              </div>

              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <div className="text-zinc-300">Bills bucket</div>
                  <div className="font-mono text-zinc-100">
                    {settings.paycheck_split_bills_pct.toFixed(0)}%
                  </div>
                </div>
                <div className="h-2 rounded-full bg-white/5">
                  <div
                    className="h-2 rounded-full bg-white/10"
                    style={{ width: `${settings.paycheck_split_bills_pct}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-sm">
                  <div className="text-zinc-300">Spending allowance</div>
                  <div className="font-mono text-zinc-100">
                    {settings.paycheck_split_spend_pct.toFixed(0)}%
                  </div>
                </div>
                <div className="h-2 rounded-full bg-white/5">
                  <div
                    className="h-2 rounded-full bg-white/10"
                    style={{ width: `${settings.paycheck_split_spend_pct}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-sm">
                  <div className="text-zinc-300">Extra (debt/savings)</div>
                  <div className="font-mono text-zinc-100">
                    {settings.paycheck_split_extra_pct.toFixed(0)}%
                  </div>
                </div>
                <div className="h-2 rounded-full bg-white/5">
                  <div
                    className="h-2 rounded-full bg-white/10"
                    style={{ width: `${settings.paycheck_split_extra_pct}%` }}
                  />
                </div>
              </div>

              <div className="mt-4 text-xs text-zinc-500">
                Preview on detected income:{" "}
                <span className="text-zinc-200">
                  {monthMetrics.monthIncome > 0
                    ? `${fmtMoney(monthMetrics.splitBills)} / ${fmtMoney(
                        monthMetrics.splitSpend
                      )} / ${fmtMoney(monthMetrics.splitExtra)}`
                    : "Import checking/savings to calculate accurately."}
                </span>
              </div>
            </div>
            {/* ===== Upcoming Bills (Phase 1) ===== */}
<div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
  <div className="flex items-center justify-between gap-3">
    <div>
      <div className="text-sm font-semibold text-zinc-100">Upcoming Bills</div>
        <div className="mt-1 text-xs text-zinc-400">
        Next {upcomingWindowDays} days • total needed{" "}
        <span className="text-zinc-100 font-mono">{fmtMoney(upcomingTotal)}</span>
      </div>
    </div>

    <Link
      href="/settings"
      className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
      title="Manage bills in Settings"
    >
      Manage →
    </Link>
  </div>

  {billsLoading && <div className="mt-4 text-sm text-zinc-400">Loading bills…</div>}
  {billsErr && <div className="mt-4 text-sm text-red-400">Error: {billsErr}</div>}

  {!billsLoading && !billsErr && (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-400">
          <tr className="border-b border-white/10">
            <th className="py-3 pr-4">bill</th>
            <th className="py-3 pr-4">due</th>
            <th className="py-3 pr-4">frequency</th>
            <th className="py-3 pr-0 text-right">amount</th>
          </tr>
        </thead>
        <tbody className="text-zinc-200">
          {upcomingItems.map((b: any) => (
            <tr key={b.id} className="border-b border-white/5 hover:bg-white/5">
              <td className="py-3 pr-4">
                <div className="text-zinc-100">{b.name}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {b.type === "debt_minimum" ? "Debt minimum" : (b.autopay ? "Autopay" : "Manual")}
                  {b.category ? ` • ${b.category}` : ""}
                </div>
              </td>
              <td className="py-3 pr-4 text-zinc-300">{b.due_date || "—"}</td>
              <td className="py-3 pr-4 text-zinc-300">{b.frequency || "—"}</td>
              <td className="py-3 pr-0 text-right font-mono text-zinc-100">
                {fmtMoney(Number(b.amount || 0))}
              </td>
            </tr>
          ))}

          {upcomingItems.length === 0 && (
            <tr>
              <td className="py-6 text-zinc-400" colSpan={4}>
                No bills due in the next {upcomingWindowDays} days.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )}

  <div className="mt-3 text-xs text-zinc-500">
    Phase 1: Bills are manual entries from Settings. Next step we’ll add minimum payments + recurring detection
    and compute “money needed until next paycheck”.
  </div>
</div>
            {/* Debt strategy + caps */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">
                  Debt & Controls
                </div>
                <div className="text-xs text-zinc-400">Preferences</div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Debt strategy</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {settings.debt_strategy}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    We’ll use this for Next Best Dollar decisions.
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Runway target</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {Number(settings.target_runway_months || 0).toFixed(0)} months
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Used to classify stages.
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Monthly spend cap</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {settings.cap_monthly_spend > 0 ? fmtMoney(settings.cap_monthly_spend) : "Off"}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Alerts when exceeded.
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Discretionary cap</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {settings.cap_discretionary_spend > 0
                      ? fmtMoney(settings.cap_discretionary_spend)
                      : "Off"}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Dining/Shopping/Travel etc.
                  </div>
                </div>

                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3 col-span-2">
                  <div className="text-xs text-zinc-400">Next Best Dollar</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">
                    {nextBestDollar?.recommendation?.name
                      ? `${nextBestDollar.recommendation.name} • ${fmtMoney(Number(nextBestDollar.recommendation.recommended_extra_payment || 0))}`
                      : "No extra payment recommendation yet"}
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    {nextBestDollar?.recommendation?.why || "This card updates from backend Financial OS cash after bills and buffer."}
                  </div>
                </div>
              </div>

              <div className="mt-4 text-xs text-zinc-500">
                Plaid cash feeds these backend Financial OS calculations without mixing into PDF transaction tables.
              </div>
            </div>
          </div>
        )}

        {/* Stat cards (now includes cash + net worth) */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Total Cash</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {cashLoading ? "…" : fmtMoney(cashTotals.totalCash)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Financial OS cash • {cashTotals.hasCash ? cashTotals.label : "—"}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Total Outstanding</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {fmtMoney(totals.totalOutstanding)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Latest statement per card
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Net Worth (V1)</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {cashLoading ? "…" : fmtMoney(netWorthV1)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Cash − credit balances
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Total Interest Paid</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {fmtMoney(totals.totalInterestAllTime)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">Across all statements</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Cards</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {totals.cardsCount}
            </div>
            <div className="mt-1 text-xs text-zinc-500">Via card last4/name</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Statements</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {totals.statementsCount}
            </div>
            <div className="mt-1 text-xs text-zinc-500">Total imported</div>
          </div>
        </div>

        {/* ===== Current month spend by week (4 bars) ===== */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              This Month Spend • Weekly
            </div>
            <div className="text-xs text-zinc-400">4 buckets</div>
          </div>

          {txLoading && (
            <div className="mt-4 text-sm text-zinc-400">
              Loading monthly transactions…
            </div>
          )}
          {txErr && (
            <div className="mt-4 text-sm text-red-400">Error: {txErr}</div>
          )}

          {!txLoading && !txErr && (
            <div className="mt-5 grid grid-cols-4 gap-3">
              {weekly.buckets.map((v, idx) => {
                const pct = Math.max(0.06, Math.min(1, v / weekly.max));
                return (
                  <div key={idx} className="flex flex-col gap-2">
                    <div className="h-36 rounded-xl border border-white/10 bg-[#0B0F14] p-2 flex items-end">
                      <div
                        className="w-full rounded-lg border border-white/10 bg-white/10"
                        style={{ height: `${pct * 100}%` }}
                        title={`Week ${idx + 1} • ${fmtMoney(v)}`}
                      />
                    </div>
                    <div className="text-center text-[11px] text-zinc-400">
                      W{idx + 1} • {weekRangeLabel(cy, cm0, idx)}
                    </div>
                    <div className="text-center text-[11px] font-mono text-zinc-300">
                      {fmtMoney(v)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-3 text-xs text-zinc-500">
            Spend only (excludes payments/refunds). Week buckets are 1–7, 8–14,
            15–21, 22–end.
          </div>
        </div>

        {/* ===== Category grid (3x5) ===== */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              This Month Categories
            </div>
            <div className="text-xs text-zinc-400">
              click a category to drill down
            </div>
          </div>

          {txLoading && (
            <div className="mt-4 text-sm text-zinc-400">
              Loading category totals…
            </div>
          )}
          {txErr && (
            <div className="mt-4 text-sm text-red-400">Error: {txErr}</div>
          )}

          {!txLoading && !txErr && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {categoryTiles.map((t) => {
                const rare = rarityLabel(t.count);

                const monthKey = `${cy}-${String(cm0 + 1).padStart(2, "0")}`;
                const href = `/dashboard/category/${encodeURIComponent(
                  t.cat
                )}?month=${encodeURIComponent(monthKey)}`;

                return (
                  <Link
                    key={t.cat}
                    href={href}
                    className="rounded-2xl border border-white/10 bg-[#0B0F14] p-4 hover:bg-white/5"
                    title="Open category transactions"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-100">
                          {t.cat}
                        </div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {t.count} txns • this month
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="font-mono text-sm text-zinc-200">
                          {fmtMoney(t.total)}
                        </div>
                        <div
                          className={[
                            "mt-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]",
                            rare.cls,
                          ].join(" ")}
                        >
                          {rare.label}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}

          <div className="mt-3 text-xs text-zinc-500">
            Common/Uncommon/Rare is based on how often you spent in that category
            this month (frequency). We’ll refine to merchant-based rarity next.
          </div>
        </div>

        {/* Trend (line) */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              Balance Trend
            </div>
            <div className="text-xs text-zinc-400">
              {trend.length ? `last ${trend.length} periods` : "—"}
            </div>
          </div>

          {!loading && !err && trend.length > 0 && (
            <div className="mt-6">
              <svg viewBox="0 0 600 200" className="w-full h-56">
                {(() => {
                  const padding = 40;
                  const width = 600;
                  const height = 200;

                  const maxVal = Math.max(...trend.map(([, v]) => v), 1);
                  const stepX = (width - padding * 2) / (trend.length - 1 || 1);

                  const points = trend.map(([k, v], i) => {
                    const x = padding + i * stepX;
                    const y =
                      height - padding - (v / maxVal) * (height - padding * 2);
                    return `${x},${y}`;
                  });

                  return (
                    <>
                      <polyline
                        fill="none"
                        stroke="#60a5fa"
                        strokeWidth="3"
                        points={points.join(" ")}
                      />

                      {trend.map(([k, v], i) => {
                        const x = padding + i * stepX;
                        const y =
                          height -
                          padding -
                          (v / maxVal) * (height - padding * 2);
                        return (
                          <circle key={k} cx={x} cy={y} r="4" fill="#60a5fa" />
                        );
                      })}
                    </>
                  );
                })()}
              </svg>

              <div className="mt-4 flex justify-between text-[11px] text-zinc-400">
                {trend.map(([k]) => (
                  <div key={k}>{labelFromBucketKey(k)}</div>
                ))}
              </div>
            </div>
          )}

          {trend.length === 0 && (
            <div className="mt-4 text-sm text-zinc-400">No trend data yet.</div>
          )}

          <div className="mt-3 text-xs text-zinc-500">
            Note: This uses statement balances as a proxy. In V2 we’ll compute
            real spend trends from transactions.
          </div>
        </div>

        {/* Latest statement per card */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="text-sm font-semibold text-zinc-100">
            Latest Statement Per Card
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr className="border-b border-white/10">
                  <th className="py-3 pr-4">card</th>
                  <th className="py-3 pr-4">period</th>
                  <th className="py-3 pr-4">due_date</th>
                  <th className="py-3 pr-4">balance</th>
                  <th className="py-3 pr-4">apr</th>
                  <th className="py-3 pr-0 text-right">open</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {latestPerCard.map((s: any) => (
                  <tr
                    key={s.statement_code}
                    className="border-b border-white/5 hover:bg-white/5"
                  >
                    <td className="py-3 pr-4">
                      <div className="text-zinc-100">{s.account_label}</div>
                      <div className="mt-1 text-xs text-zinc-400">
                        {s.card_name ? s.card_name : "—"}
                        {s.card_last4 ? ` • ${s.card_last4}` : ""}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">{s.statement_period}</td>
                    <td className="py-3 pr-4 text-zinc-300">{s.due_date}</td>
                    <td className="py-3 pr-4 text-zinc-300">
                      {fmtMoney(s.new_balance)}
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">{s.apr}%</td>
                    <td className="py-3 pr-0 text-right">
                      <Link
                        href={`/statements/${encodeURIComponent(s.statement_code)}`}
                        className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}

                {latestPerCard.length === 0 && (
                  <tr>
                    <td className="py-6 text-zinc-400" colSpan={6}>
                      No statements yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent statements */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              Recent Statements
            </div>
            <Link
              href="/statements"
              className="text-xs text-zinc-300 hover:text-zinc-100"
            >
              Go to Statements →
            </Link>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr className="border-b border-white/10">
                  <th className="py-3 pr-4">statement_code</th>
                  <th className="py-3 pr-4">card</th>
                  <th className="py-3 pr-4">period</th>
                  <th className="py-3 pr-4">balance</th>
                  <th className="py-3 pr-0 text-right">open</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {recent.map((s: any) => (
                  <tr
                    key={`${s.id}-${s.statement_code}`}
                    className="border-b border-white/5 hover:bg-white/5"
                  >
                    <td className="py-3 pr-4 font-mono text-xs text-zinc-100">
                      {s.statement_code}
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">
                      {s.card_name ? s.card_name : "—"}
                      {s.card_last4 ? ` • ${s.card_last4}` : ""}
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">{s.statement_period}</td>
                    <td className="py-3 pr-4 text-zinc-300">
                      {fmtMoney(s.new_balance)}
                    </td>
                    <td className="py-3 pr-0 text-right">
                      <Link
                        href={`/statements/${encodeURIComponent(s.statement_code)}`}
                        className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}

                {recent.length === 0 && (
                  <tr>
                    <td className="py-6 text-zinc-400" colSpan={5}>
                      No statements yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
