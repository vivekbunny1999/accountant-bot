"use client";

import {
  FinancialOsIntelligenceResponse,
  getCashAccounts,
  getCashAccountTransactions,
  getFinancialOsIntelligence,
  listManualTransactions,
  getNextBestDollar,
  getOsState,
  getPlaidAccounts,
  getPlaidTransactions,
  ManualTransaction,
  NextBestDollarResponse,
  OsStateResponse,
  PlaidAccountSummary,
  PlaidTransactionSummary,
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
import {
  amountAbs,
  CATEGORY_OPTIONS,
  classifyPlaidDisplayRows,
  categoryForCash,
  categoryForManual,
  categoryForPlaid,
  categoryForStatement,
  isCashSpend,
  isManualSpend,
  isPlaidSpend,
  isStatementCreditLike,
  parseDateLoose,
  signatureForParts,
  SpendingCategory,
  statementsTrackedByDebt,
} from "@/lib/financial-os-display";


/** =========================
 * Money / date helpers
 * ========================= */
function fmtMoney(n: number) {
  const v = Number(n || 0);
  return `$${v.toFixed(2)}`;
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceDashboardMoneyValue(value: unknown): number | null {
  if (hasFiniteNumber(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = Number(trimmed.replace(/[$,\s]/g, ""));
    if (Number.isFinite(normalized)) return normalized;
  }
  return null;
}

function firstDashboardMoneyValue(...values: unknown[]): number | null {
  for (const value of values) {
    const coerced = coerceDashboardMoneyValue(value);
    if (coerced != null) return coerced;
  }
  return null;
}

function formatDashboardMoney(
  value: unknown,
  options?: {
    loading?: boolean;
    unavailable?: boolean;
  }
) {
  if (options?.loading) return "Loading";
  if (options?.unavailable) return "Data unavailable";
  const coerced = coerceDashboardMoneyValue(value);
  if (coerced == null) return "Data unavailable";
  return fmtMoney(coerced);
}

function safeTime(s?: string | null) {
  const t = new Date(s ?? "").getTime();
  return Number.isFinite(t) ? t : 0;
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
type Category = SpendingCategory;

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
  return signatureForParts((t as any).merchant, (t as any).description);
}

function categoryFor(t: Transaction, rules: Record<string, Category>): Category {
  return categoryForStatement(t, rules);
}

// Spend vs credit (dashboard category grid should focus on spend)
function isCreditLike(t: Transaction) {
  return isStatementCreditLike(t);
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

function clamp01(n: number) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function scoreTone(score?: number | null) {
  const value = Number(score ?? 0);
  if (value >= 80) return "text-emerald-300 bg-emerald-500/10 border-emerald-500/20";
  if (value >= 60) return "text-sky-300 bg-sky-500/10 border-sky-500/20";
  if (value >= 40) return "text-amber-300 bg-amber-500/10 border-amber-500/20";
  return "text-red-300 bg-red-500/10 border-red-500/20";
}

function stabilityTone(label?: string | null) {
  switch ((label || "").toLowerCase()) {
    case "strong":
      return "text-emerald-300 bg-emerald-500/10 border-emerald-500/20";
    case "stable":
      return "text-sky-300 bg-sky-500/10 border-sky-500/20";
    case "stabilizing":
      return "text-amber-300 bg-amber-500/10 border-amber-500/20";
    case "fragile":
      return "text-red-300 bg-red-500/10 border-red-500/20";
    default:
      return "text-zinc-300 bg-white/5 border-white/10";
  }
}

function insightTone(severity?: string | null) {
  switch ((severity || "").toLowerCase()) {
    case "critical":
      return "border-red-500/20 bg-red-500/10 text-red-200";
    case "warning":
      return "border-amber-500/20 bg-amber-500/10 text-amber-200";
    case "success":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-200";
    default:
      return "border-sky-500/20 bg-sky-500/10 text-sky-200";
  }
}

function financialOsPrioritySeverity(priority?: string | null) {
  switch ((priority || "").toLowerCase()) {
    case "protect_due_soon":
      return "critical";
    case "build_runway":
    case "pay_high_apr_debt":
      return "warning";
    case "fund_fi":
      return "success";
    default:
      return "info";
  }
}

function financialOsPriorityLabel(priority?: string | null) {
  switch ((priority || "").toLowerCase()) {
    case "protect_due_soon":
      return "Protect Due Soon";
    case "build_runway":
      return "Build Runway";
    case "pay_high_apr_debt":
      return "Pay High-APR Debt";
    case "fund_fi":
      return "Fund FI";
    case "discretionary":
      return "Discretionary";
    case "hold_cash":
      return "Hold Cash";
    default:
      return "Next Step";
  }
}

function financialOsStatusTone(state?: string | null) {
  switch ((state || "").toLowerCase()) {
    case "available":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-200";
    case "setup_required":
      return "border-amber-500/20 bg-amber-500/10 text-amber-200";
    case "blocked":
      return "border-red-500/20 bg-red-500/10 text-red-200";
    default:
      return "border-white/10 bg-white/5 text-zinc-300";
  }
}

function fmtMonthsCompact(months?: number | null) {
  if (months == null) return "Needs data";
  if (months <= 0) return "Debt-free";
  return `${months} mo`;
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

type MonthSpendRow = {
  key: string;
  source: "Statement" | "Imported Cash" | "Plaid" | "Manual";
  category: Category;
  amount: number;
  date: Date;
  title: string;
  subtitle: string;
  counted?: boolean;
  suspectedDuplicate?: boolean;
};

export default function DashboardPage() {
  const { user, status } = useAuth();
  const userId = user?.id ?? "";
  const hasAuthenticatedUser = status === "authenticated" && Boolean(userId);
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


// ===== Bills (Upcoming window) =====

   const [billsLoading, setBillsLoading] = useState(false);
   const [billsErr, setBillsErr] = useState<string | null>(null);
   const [nextBestDollarLoading, setNextBestDollarLoading] = useState(false);
   const [nextBestDollarErr, setNextBestDollarErr] = useState<string | null>(null);

const upcomingWindowDays = 21; // Phase 1 fixed backend window

const [upcomingItems, setUpcomingItems] = useState<OsStateResponse["upcoming_items"]>([]);
const [upcomingTotal, setUpcomingTotal] = useState<number | null>(null);

  // current month (dashboard fixed)
  const now = useMemo(() => new Date(), []);
  const cy = now.getFullYear();
  const cm0 = now.getMonth();

  // txns state for dashboard month analytics
  const [monthTxns, setMonthTxns] = useState<Transaction[]>([]);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [cashMonthTxns, setCashMonthTxns] = useState<CashTxn[]>([]);
  const [manualTransactions, setManualTransactions] = useState<ManualTransaction[]>([]);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashErr, setCashErr] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const [osState, setOsState] = useState<OsStateResponse | null>(null);
  const [nextBestDollar, setNextBestDollar] = useState<NextBestDollarResponse | null>(null);
  const [intelligence, setIntelligence] = useState<FinancialOsIntelligenceResponse | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccountSummary[]>([]);
  const [plaidTransactions, setPlaidTransactions] = useState<PlaidTransactionSummary[]>([]);

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
        const rows = await listManualTransactions({ user_id: userId });
        if (!cancelled) setManualTransactions(rows || []);
      } catch {
        if (!cancelled) setManualTransactions([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!hasAuthenticatedUser) return;
    let cancelled = false;
    const bufferAmount = settings.buffer_enabled ? settings.buffer_amount : 0;

    (async () => {
      setBillsLoading(true);
      setBillsErr(null);

      try {
        const stateValue = await getOsState({ user_id: userId, window_days: upcomingWindowDays });
        if (cancelled) return;

        if (stateValue) {
          setOsState(stateValue);
          setUpcomingItems(stateValue.upcoming_items || []);
          setUpcomingTotal(
            firstDashboardMoneyValue(
              stateValue.upcoming_total,
              stateValue.calculation?.upcoming_total
            )
          );
        }
        setBillsErr(null);
      } catch (error: any) {
        if (!cancelled) {
          setBillsErr(error?.message || "Failed to load Financial OS state.");
        }
      } finally {
        if (!cancelled) setBillsLoading(false);
      }
    })();

    (async () => {
      setNextBestDollarLoading(true);
      setNextBestDollarErr(null);

      try {
        const nbdValue = await getNextBestDollar({
          user_id: userId,
          window_days: upcomingWindowDays,
          buffer: bufferAmount,
        });
        if (cancelled) return;
        if (nbdValue) {
          setNextBestDollar(nbdValue);
        }
        setNextBestDollarErr(null);
      } catch (error: any) {
        if (!cancelled) {
          setNextBestDollarErr(error?.message || "Failed to load safe-to-spend.");
        }
      } finally {
        if (!cancelled) setNextBestDollarLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasAuthenticatedUser, userId, upcomingWindowDays, settings.buffer_amount, settings.buffer_enabled]);

  useEffect(() => {
    if (!hasAuthenticatedUser) return;
    let cancelled = false;
    const bufferAmount = settings.buffer_enabled ? settings.buffer_amount : 0;
    const monthStart = new Date(cy, cm0, 1).toISOString().slice(0, 10);
    const monthEnd = new Date(cy, cm0 + 1, 0).toISOString().slice(0, 10);

    (async () => {
      const [intelligenceRes, plaidAccountsRes, plaidTransactionsRes] = await Promise.allSettled([
        getFinancialOsIntelligence({
          user_id: userId,
          window_days: upcomingWindowDays,
          buffer: bufferAmount,
        }),
        getPlaidAccounts(userId),
        getPlaidTransactions({ user_id: userId, limit: 200, start_date: monthStart, end_date: monthEnd }),
      ]);
      if (cancelled) return;

      if (intelligenceRes.status === "fulfilled" && intelligenceRes.value) {
        setIntelligence(intelligenceRes.value);
      }

      if (plaidAccountsRes.status === "fulfilled" && plaidAccountsRes.value) {
        setPlaidAccounts(plaidAccountsRes.value.accounts || []);
      }

      if (plaidTransactionsRes.status === "fulfilled" && plaidTransactionsRes.value) {
        setPlaidTransactions(plaidTransactionsRes.value.transactions || []);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cy, cm0, hasAuthenticatedUser, userId, upcomingWindowDays, settings.buffer_amount, settings.buffer_enabled]);

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
      totalCash,
      label: endDate,
    };
  }, [cashAccounts]);

  const trackedDebtItems = useMemo<Array<{ balance?: unknown }>>(
    () => (Array.isArray(osState?.debt_utilization?.items) ? osState.debt_utilization.items : []),
    [osState]
  );
  const trackedDebtItemsTotal = useMemo(
    () => {
      if (!trackedDebtItems.length) return null;
      return trackedDebtItems.reduce((sum: number, item) => {
        return sum + (firstDashboardMoneyValue(item?.balance) ?? 0);
      }, 0);
    },
    [trackedDebtItems]
  );
  const osCashSources = osState?.cash_sources || null;
  const stsBreakdown = nextBestDollar?.breakdown || null;
  const upcomingSummary = osState?.upcoming_summary ?? null;
  const upcomingItemsList = upcomingItems ?? [];
  const osStateLoading = !hasAuthenticatedUser || (billsLoading && !osState);
  const nextBestDollarLoadingState = !hasAuthenticatedUser || (nextBestDollarLoading && !nextBestDollar);
  const osStateUnavailable = !osStateLoading && Boolean(billsErr);
  const nextBestDollarUnavailable = !nextBestDollarLoadingState && Boolean(nextBestDollarErr);
  const osStateSettled = hasAuthenticatedUser && !billsLoading && (Boolean(osState) || Boolean(billsErr));
  const nextBestDollarSettled =
    hasAuthenticatedUser &&
    !nextBestDollarLoading &&
    (Boolean(nextBestDollar) || Boolean(nextBestDollarErr));
  const dashboardReady = osStateSettled && nextBestDollarSettled;
  const intelligenceContext = intelligence?.context ?? null;
  const financialOsV2 =
    nextBestDollar?.financial_os_v2
    ?? intelligence?.financial_os_v2
    ?? osState?.financial_os_v2
    ?? null;
  const hasFinancialOsV2 = Boolean(financialOsV2);
  const financialOsCashTotal = firstDashboardMoneyValue(
    financialOsV2?.total_cash,
    osState?.cash_total,
    osState?.calculation?.cash_total
  );
  const financialOsUpcomingTotal = firstDashboardMoneyValue(
    financialOsV2?.protected_obligations_total,
    osState?.upcoming_total,
    osState?.calculation?.upcoming_total,
    upcomingTotal
  );
  const billsManualObligationsTotal = firstDashboardMoneyValue(
    financialOsV2?.bills_manual_obligations_total,
    nextBestDollar?.breakdown?.bills_manual_obligations_total,
    upcomingSummary?.bill_total != null || upcomingSummary?.manual_bill_total != null
      ? Number(upcomingSummary?.bill_total || 0) + Number(upcomingSummary?.manual_bill_total || 0)
      : null
  );
  const debtMinimumsTotal = firstDashboardMoneyValue(
    financialOsV2?.debt_minimums_cash,
    nextBestDollar?.breakdown?.debt_minimums_total,
    upcomingSummary?.debt_minimum_total
  );
  const protectedObligationsTotal = firstDashboardMoneyValue(
    financialOsV2?.protected_obligations_total,
    nextBestDollar?.breakdown?.protected_obligations_total,
    financialOsUpcomingTotal
  );
  const trackedDebtTotal = firstDashboardMoneyValue(
    osState?.debt_utilization?.total_balance,
    trackedDebtItemsTotal
  );
  const safeToSpendToday = firstDashboardMoneyValue(
    financialOsV2?.current_period_safe_to_spend,
    nextBestDollar?.safe_to_spend_today,
    nextBestDollar?.calculation?.safe_to_spend_today,
    stsBreakdown?.final_safe_to_spend,
    intelligenceContext?.safe_to_spend_today
  );
  const weeklySafeToSpend = firstDashboardMoneyValue(
    financialOsV2?.weekly_safe_to_spend,
    safeToSpendToday
  );
  const remainingDiscretionaryThisMonth = firstDashboardMoneyValue(
    financialOsV2?.remaining_discretionary_this_month
  );
  const protectedCash = firstDashboardMoneyValue(
    financialOsV2?.protected_cash
  );
  const savingsGoalCash = firstDashboardMoneyValue(
    financialOsV2?.savings_goal_cash
  );
  const availableDiscretionaryCash = firstDashboardMoneyValue(
    financialOsV2?.available_discretionary_cash,
    intelligenceContext?.available_sts,
    nextBestDollar?.available_sts
  );
  const runwayReserveTarget = firstDashboardMoneyValue(
    financialOsV2?.runway_reserve_target,
    intelligenceContext?.emergency_target_amount
  );
  const runwayReserveCurrent = firstDashboardMoneyValue(
    financialOsV2?.runway_reserve_current,
    financialOsV2?.protected_runway_cash
  );
  const runwayTargetMonths = firstDashboardMoneyValue(
    financialOsV2?.runway_target_months,
    intelligenceContext?.runway_target_months,
    settings.target_runway_months
  );
  const monthlyEssentials = firstDashboardMoneyValue(
    financialOsV2?.monthly_essentials,
    intelligenceContext?.monthly_essentials_total
  );
  const runwayMonths = (() => {
    if (runwayReserveCurrent != null && monthlyEssentials != null && monthlyEssentials > 0) {
      return Math.round((runwayReserveCurrent / monthlyEssentials) * 10) / 10;
    }
    return intelligenceContext?.runway_months ?? null;
  })();
  const fiTargetAmount = firstDashboardMoneyValue(
    financialOsV2?.fi_target,
    intelligenceContext?.fi_cash_target_amount
  );
  const fiProgressAmount = firstDashboardMoneyValue(
    financialOsV2?.fi_progress_amount,
    financialOsCashTotal
  );
  const fiProgressPercent = firstDashboardMoneyValue(
    financialOsV2?.fi_progress_percent,
    intelligence?.fi_progress?.percent
  );
  const fiContributionRecommendation = firstDashboardMoneyValue(
    financialOsV2?.monthly_fi_contribution_recommendation
  );
  const yearsToFi = firstDashboardMoneyValue(
    financialOsV2?.years_to_fi
  );
  const nextBestAction = financialOsV2?.next_best_action ?? null;
  const stsStatus = financialOsV2?.sts_status ?? null;
  const setupStatus = financialOsV2?.setup_status ?? null;
  const setupReasons = setupStatus?.reasons || [];
  const setupRequired = setupStatus?.state === "setup_required" && setupReasons.length > 0;
  const discretionaryCapDetails = financialOsV2?.discretionary_cap_details ?? null;
  const fiTargetDetails = financialOsV2?.fi_target_details ?? null;
  const nextBestActionAmount = firstDashboardMoneyValue(nextBestAction?.amount);
  const coachingSeverity = nextBestAction
    ? financialOsPrioritySeverity(nextBestAction.priority)
    : intelligence?.insights?.what_to_do_next?.severity;
  const coachingTitle = nextBestAction?.action || intelligence?.insights?.what_to_do_next?.title || "What To Do Next";
  const coachingExplanation = nextBestAction?.reason || intelligence?.insights?.what_to_do_next?.explanation || "Waiting for your Financial OS guidance.";
  const coachingSuggestedAction = nextBestAction?.action || intelligence?.insights?.what_to_do_next?.suggested_action || "Review the current plan.";
  const coachingPriorityLabel = nextBestAction
    ? financialOsPriorityLabel(nextBestAction.priority)
    : (intelligence?.insights?.what_to_do_next?.severity || "info");
  const safeToSpendBeforeBuffer = (() => {
    const cash = firstDashboardMoneyValue(
      stsBreakdown?.total_cash,
      nextBestDollar?.calculation?.cash_total,
      nextBestDollar?.cash_total,
      intelligenceContext?.cash_total
    );
    const upcoming = firstDashboardMoneyValue(
      stsBreakdown?.upcoming_total,
      nextBestDollar?.calculation?.upcoming_total,
      nextBestDollar?.upcoming_total,
      intelligenceContext?.upcoming_total
    );
    if (cash == null || upcoming == null) return null;
    return Math.round((cash - upcoming) * 100) / 100;
  })();
  const protectedBuffer = firstDashboardMoneyValue(
    stsBreakdown?.buffer,
    nextBestDollar?.calculation?.buffer,
    nextBestDollar?.buffer
  );
  const safeToSpendFormulaLabel =
    financialOsV2?.formula_notes?.sts
      ? `${financialOsV2.formula_notes.sts} Large cash balances are not fully spendable because obligations, runway, and FI reserves stay protected first.`
      : safeToSpendBeforeBuffer != null
      ? "Safe-to-Spend before buffer = cash total - upcoming obligations. Final Safe-to-Spend = that amount - protected buffer."
      : (nextBestDollar?.calculation?.formula || "safe_to_spend_today = cash_total - upcoming_total - buffer");
  const statementCoverage = useMemo(
    () => statementsTrackedByDebt(latestPerCard as any, trackedDebtItems as any),
    [latestPerCard, trackedDebtItems]
  );
  const untrackedStatementOutstanding = statementCoverage.untracked;
  const financialOsCashLabel = osCashSources
    ? `Imported ${fmtMoney(Number(osCashSources?.pdf_cash_total || 0))} • Linked ${fmtMoney(Number(osCashSources?.plaid_cash_total || 0))}`
    : (cashTotals.hasCash ? `Latest imported cash snapshot ${cashTotals.label}` : "Cash counted in your plan");

  const netWorthV1 = useMemo(() => {
    if (financialOsCashTotal == null || trackedDebtTotal == null) return null;
    return financialOsCashTotal - trackedDebtTotal - untrackedStatementOutstanding;
  }, [financialOsCashTotal, trackedDebtTotal, untrackedStatementOutstanding]);

  const plaidIncludedAccounts = useMemo(
    () => osCashSources?.plaid_accounts_included || [],
    [osCashSources]
  );

  const plaidDuplicateAccounts = useMemo(
    () => osCashSources?.plaid_duplicate_accounts_skipped || [],
    [osCashSources]
  );

  const healthScore = intelligence?.financial_health?.score ?? null;
  const healthComponents = useMemo(
    () => (intelligence?.financial_health?.components || []).filter((component) => component.included).slice(0, 5),
    [intelligence]
  );
  const stabilityMeter = intelligence?.stability_meter ?? null;
  const debtCountdown = intelligence?.debt_free_countdown ?? null;
  const fiProgress = intelligence?.fi_progress ?? null;
  const fiProgressComponents = useMemo(
    () => (fiProgress?.components || []).slice(0, 3),
    [fiProgress]
  );
  const nextDollarImpact = intelligence?.next_best_dollar_impact ?? null;
  const debtPayoffProjection = financialOsV2?.debt_payoff_projection ?? null;
  const projectedPayoffDebt = useMemo(() => {
    const debts = debtPayoffProjection?.debts || [];
    if (!debts.length) return null;
    if (debtPayoffProjection?.target_debt_id != null) {
      const match = debts.find((item) => item.debt_id === debtPayoffProjection.target_debt_id);
      if (match) return match;
    }
    return debts.find((item) => Number(item.recommended_extra_payment || 0) > 0) || debts[0] || null;
  }, [debtPayoffProjection]);
  const payoffRecurringExtra = firstDashboardMoneyValue(
    projectedPayoffDebt?.recommended_extra_payment,
    debtPayoffProjection?.recurring_extra_payment,
    nextDollarImpact?.recommended_extra_payment
  );
  const payoffMonthsSaved = firstDashboardMoneyValue(
    projectedPayoffDebt?.months_saved,
    nextDollarImpact?.estimated_months_faster
  );
  const payoffInterestSaved = firstDashboardMoneyValue(
    projectedPayoffDebt?.interest_saved,
    nextDollarImpact?.estimated_interest_saved
  );
  const payoffMonthsWithExtra = firstDashboardMoneyValue(
    projectedPayoffDebt?.with_extra_months,
    debtPayoffProjection?.portfolio_months_with_extra,
    nextDollarImpact?.estimated_payoff_months_with_extra
  );
  const availableStsForDebt = firstDashboardMoneyValue(
    financialOsV2?.current_period_safe_to_spend,
    nextDollarImpact?.available_sts,
    intelligenceContext?.available_sts,
    nextBestDollar?.available_sts
  );
  const payoffExplanation = debtPayoffProjection
    ? projectedPayoffDebt?.payoff_warning === "missing_minimum_due"
      ? "Projection is limited until the target debt has a minimum due amount."
      : projectedPayoffDebt?.name
        ? `Projection uses Financial OS V2 for ${projectedPayoffDebt.name}. Extra payments only start after due-soon obligations, runway reserves, and FI cash protections are covered.`
        : "Projection uses the Financial OS V2 avalanche payoff model across active debts."
    : (nextDollarImpact?.explanation || "Loading impact estimate.");
  const healthTone = scoreTone(healthScore);
  const fiTargetExplanation = hasFinancialOsV2
    ? fiTargetDetails?.source === "user_set_goal"
      ? `Using your user-set FI target of ${formatDashboardMoney(fiTargetDetails?.configured_value ?? fiTargetAmount)}.`
      : fiTargetDetails?.annual_required_spend != null
        ? `Derived FI target = annual required spend ${fmtMoney(Number(fiTargetDetails.annual_required_spend || 0))} x 25.`
        : (financialOsV2?.formula_notes?.fi_target || "FI target details are loading.")
    : (intelligenceContext?.fi_cash_target_label || "Loading FI target.");
  const stabilityToneClass = stabilityTone(stabilityMeter?.label);
  const osInsights = useMemo(
    () => (intelligence?.insights?.items || []).slice(0, 5),
    [intelligence]
  );
  const whatToDoNext = intelligence?.insights?.what_to_do_next ?? osInsights[0] ?? null;
  const secondaryInsights = useMemo(
    () => osInsights.filter((item) => item.key !== whatToDoNext?.key).slice(0, 4),
    [osInsights, whatToDoNext]
  );
  const plaidDisplaySummary = useMemo(
    () => classifyPlaidDisplayRows(plaidTransactions.filter((txn) => isPlaidSpend(txn))),
    [plaidTransactions]
  );
  const plaidRecentRows = useMemo(() => plaidDisplaySummary.rows.slice(0, 8), [plaidDisplaySummary]);

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

  const monthSpendRows = useMemo<MonthSpendRow[]>(() => {
    const rules = loadRules();
    const rows: MonthSpendRow[] = [];

    for (const txn of monthTxns) {
      if (isCreditLike(txn)) continue;
      const dateValue = parseDateLoose((txn as any).posted_date ?? (txn as any).date);
      if (!dateValue || !isSameMonth(dateValue, cy, cm0)) continue;
      rows.push({
        key: `statement-${(txn as any).id ?? signatureFor(txn)}-${dateValue.toISOString()}`,
        source: "Statement",
        category: categoryFor(txn, rules),
        amount: amountAbs(txn),
        date: dateValue,
        title: String((txn as any).merchant ?? (txn as any).description ?? "Statement purchase"),
        subtitle: String((txn as any).description ?? "Imported statement activity"),
      });
    }

    for (const txn of cashMonthTxns || []) {
      const dateValue = parseDateLoose((txn as any).posted_date ?? (txn as any).transaction_date ?? (txn as any).date);
      if (!dateValue || !isSameMonth(dateValue, cy, cm0) || !isCashSpend(txn as any)) continue;
      rows.push({
        key: `cash-${(txn as any).id ?? signatureForParts((txn as any).description, (txn as any).merchant, (txn as any).name)}-${dateValue.toISOString()}`,
        source: "Imported Cash",
        category: categoryForCash(txn as any, rules),
        amount: amountAbs(Number((txn as any).amount || 0)),
        date: dateValue,
        title: String((txn as any).description ?? (txn as any).merchant ?? (txn as any).name ?? "Cash activity"),
        subtitle: String((txn as any).name ?? "Imported cash activity"),
      });
    }

    for (const txn of manualTransactions) {
      const dateValue = parseDateLoose(txn.date);
      if (!dateValue || !isSameMonth(dateValue, cy, cm0) || !isManualSpend(txn)) continue;
      rows.push({
        key: `manual-${txn.id}`,
        source: "Manual",
        category: categoryForManual(txn, rules),
        amount: amountAbs(txn.amount),
        date: dateValue,
        title: String(txn.description || "Manual activity"),
        subtitle: "Manual activity",
      });
    }

    for (const txn of plaidDisplaySummary.countedRows) {
      const dateValue = parseDateLoose(txn.posted_date ?? txn.authorized_date ?? null);
      if (!dateValue || !isSameMonth(dateValue, cy, cm0) || !isPlaidSpend(txn)) continue;
      rows.push({
        key: `plaid-${txn.transaction_id}`,
        source: "Plaid",
        category: categoryForPlaid(txn, rules),
        amount: Number(txn.amount || 0),
        date: dateValue,
        title: String(txn.merchant_name || txn.name || "Linked activity"),
        subtitle: [txn.institution_name, txn.account_name].filter(Boolean).join(" • ") || "Linked account",
      });
    }

    return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [cashMonthTxns, cm0, cy, manualTransactions, monthTxns, plaidDisplaySummary]);

  /** =========================
   * Category totals for current month (spend only)
   * ========================= */
  const categoryTiles = useMemo(() => {
    const totalsMap = new Map<Category, { total: number; count: number }>();
    for (const c of CATEGORY_OPTIONS) totalsMap.set(c, { total: 0, count: 0 });

    for (const row of monthSpendRows) {
      const prev = totalsMap.get(row.category) ?? { total: 0, count: 0 };
      prev.total += row.amount;
      prev.count += 1;
      totalsMap.set(row.category, prev);
    }

    const tiles = Array.from(totalsMap.entries())
      .map(([cat, value]) => ({ cat, total: value.total, count: value.count }))
      .sort((a, b) => b.total - a.total);

    return tiles.slice(0, 15);
  }, [monthSpendRows]);

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
    const buckets = [0, 0, 0, 0];
    for (const row of monthSpendRows) {
      const idx = weekBucketIndex(row.date.getDate());
      buckets[idx] += row.amount;
    }

    const max = Math.max(1, ...buckets);
    return { buckets, max };
  }, [monthSpendRows]);

  /** =========================
   * Financial OS metrics from month txns (V1)
   * ========================= */
  const monthMetrics = useMemo(() => {
    const ccCredits = monthTxns.filter((t: any) => isCreditLike(t));
    const sourceSpend = {
      statement: 0,
      importedCash: 0,
      plaid: 0,
      manual: 0,
    };

    for (const row of monthSpendRows) {
      if (row.source === "Statement") sourceSpend.statement += row.amount;
      if (row.source === "Imported Cash") sourceSpend.importedCash += row.amount;
      if (row.source === "Plaid") sourceSpend.plaid += row.amount;
      if (row.source === "Manual") sourceSpend.manual += row.amount;
    }

    const ccMonthSpend = sourceSpend.statement;

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
    const cashSpend = sourceSpend.importedCash;

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
    const effectiveSpend = sourceSpend.statement + sourceSpend.importedCash + sourceSpend.plaid + sourceSpend.manual;

    const discretionaryCats: Category[] = [
      "Dining",
      "Entertainment",
      "Shopping",
      "Travel",
      "Subscriptions",
      "Personal Care",
    ];

    const discretionarySpend = monthSpendRows.reduce((acc, row) => {
      return discretionaryCats.includes(row.category) ? acc + row.amount : acc;
    }, 0);

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
      plaidSpend: sourceSpend.plaid,
      manualSpend: sourceSpend.manual,

      cashAccountsCount: (cashAccounts || []).length,
      cashTotalBalance: financialOsCashTotal ?? cashTotals.totalCash,
      cashLoading,
      cashErr,
    };
  }, [monthTxns, monthSpendRows, cashMonthTxns, cashAccounts, cashTotals.totalCash, cashLoading, cashErr, financialOsCashTotal, settings]);

  const stageUi = useMemo(() => stageBadge(monthMetrics.stage), [monthMetrics.stage]);

  return (
    <AppShell>
      <div
        className="space-y-5"
        data-dashboard-ready={dashboardReady ? "true" : "false"}
      >
        {dashboardReady ? (
          <div
            hidden
            data-testid="dashboard-ready"
            data-os-state-status={osStateUnavailable ? "unavailable" : "ready"}
            data-next-best-dollar-status={nextBestDollarUnavailable ? "unavailable" : "ready"}
          />
        ) : null}
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

        {settings.show_financial_os_panels && (nextBestAction || whatToDoNext) && (
          <div className="grid gap-3 xl:grid-cols-[1.35fr,1fr]">
            <div className="rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_35%),#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">What To Do Next</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Weekly coaching now follows Financial OS V2 reserve-aware safe-to-spend.
                  </div>
                </div>
                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${insightTone(coachingSeverity)}`}>
                  {coachingPriorityLabel}
                </div>
              </div>

              <div className="mt-5 max-w-3xl text-2xl font-semibold leading-tight text-zinc-100 sm:text-3xl">
                {coachingTitle}
              </div>

              <div className="mt-4 max-w-2xl text-sm leading-6 text-zinc-300">
                {coachingExplanation}
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Weekly safe-to-spend</div>
                  <div className="mt-2 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(weeklySafeToSpend, {
                      loading: nextBestDollarLoadingState,
                      unavailable: nextBestDollarUnavailable,
                    })}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Remaining this month</div>
                  <div className="mt-2 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(remainingDiscretionaryThisMonth, {
                      loading: nextBestDollarLoadingState,
                      unavailable: nextBestDollarUnavailable,
                    })}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Suggested amount</div>
                  <div className="mt-2 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(nextBestActionAmount, {
                      loading: nextBestDollarLoadingState,
                      unavailable: nextBestDollarUnavailable,
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Suggested action</div>
                <div className="mt-2 text-sm font-medium leading-6 text-zinc-100">
                  {coachingSuggestedAction}
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Top Insights</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Low-noise coaching and alerts from your Financial OS.
                  </div>
                </div>
                <div className="text-xs text-zinc-500">{osInsights.length} items</div>
              </div>

              <div className="mt-4 space-y-3">
                {secondaryInsights.length ? (
                  secondaryInsights.map((insight) => (
                    <div key={insight.key} className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm font-medium leading-5 text-zinc-100">{insight.title}</div>
                        <div className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${insightTone(insight.severity)}`}>
                          {insight.severity}
                        </div>
                      </div>
                      <div className="mt-2 text-xs leading-5 text-zinc-400">{insight.explanation}</div>
                      <div className="mt-3 text-xs font-medium text-zinc-200">{insight.suggested_action}</div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3 text-sm text-zinc-400">
                    Additional insights are loading.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {settings.show_financial_os_panels && (
          <div className="grid gap-3 xl:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5 xl:col-span-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Financial Health Score</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Weighted score from current cash, runway, debt, and coverage data.
                  </div>
                </div>
                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${healthTone}`}>
                  {healthScore != null ? `${healthScore}/100` : "Loading"}
                </div>
              </div>

              <div className="mt-4 flex items-end justify-between gap-3">
                <div className="text-4xl font-semibold text-zinc-100">
                  {healthScore != null ? healthScore : "--"}
                </div>
                <div className="text-xs text-zinc-500">
                  {intelligence?.financial_health?.formula || "Waiting for score details."}
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {healthComponents.length ? (
                  healthComponents.map((component) => (
                    <div key={component.key} className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium text-zinc-100">{component.label}</div>
                        <div className="text-xs font-mono text-zinc-400">
                          {Math.round(Number(component.points || 0))}/{component.weight}
                        </div>
                      </div>
                      <div className="mt-2 text-xs leading-5 text-zinc-400">
                        {component.explanation}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3 text-sm text-zinc-400 sm:col-span-2">
                    Health score details are loading.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Stability Meter</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Fast read on near-term stability across cash, obligations, and runway.
                  </div>
                </div>
                <div className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${stabilityToneClass}`}>
                  {stabilityMeter?.label || "Loading"}
                </div>
              </div>

              <div className="mt-4 flex items-end justify-between gap-3">
                <div className="text-4xl font-semibold text-zinc-100">
                  {stabilityMeter?.value ?? "--"}
                </div>
                <div className="text-xs text-zinc-500">out of 100</div>
              </div>

              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-zinc-200 transition-all"
                  style={{ width: `${clamp01(Number(stabilityMeter?.value || 0) / 100) * 100}%` }}
                />
              </div>

              <div className="mt-4 text-sm leading-6 text-zinc-300">
                {stabilityMeter?.explanation || "Loading stability explanation."}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Final Safe-to-Spend</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(
                      safeToSpendToday,
                      { loading: nextBestDollarLoadingState, unavailable: nextBestDollarUnavailable }
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">Current period V2 allowance</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Weekly Safe-to-Spend</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(weeklySafeToSpend, {
                      loading: nextBestDollarLoadingState,
                      unavailable: nextBestDollarUnavailable,
                    })}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">Reserve-aware weekly guidance</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Remaining Discretionary</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(remainingDiscretionaryThisMonth, {
                      loading: nextBestDollarLoadingState,
                      unavailable: nextBestDollarUnavailable,
                    })}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">Left in this month&apos;s cap</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Runway Reserve</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {runwayMonths != null ? `${Number(runwayMonths).toFixed(1)} mo` : "--"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {runwayReserveCurrent != null && runwayReserveTarget != null
                      ? `${fmtMoney(Number(runwayReserveCurrent || 0))} of ${fmtMoney(Number(runwayReserveTarget || 0))} protected${runwayTargetMonths != null ? ` • ${Number(runwayTargetMonths).toFixed(1)} mo target` : ""}`
                      : "Protected runway cash"}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Debt-free Countdown</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Estimated from current balances, minimums, and the current extra-payment suggestion.
                  </div>
                </div>
                {debtCountdown?.is_partial ? (
                  <div className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
                    Partial
                  </div>
                ) : null}
              </div>

              <div className="mt-4 text-3xl font-semibold text-zinc-100">
                {fmtMonthsCompact(debtCountdown?.estimated_months_remaining)}
              </div>

              <div className="mt-2 text-sm text-zinc-300">
                {debtCountdown?.priority_debt?.name
                  ? `Priority debt: ${debtCountdown.priority_debt.name}`
                  : "No priority debt available"}
              </div>

              <div className="mt-4 text-sm leading-6 text-zinc-400">
                {debtCountdown?.explanation || "Loading payoff projection."}
              </div>

              {Number(debtCountdown?.excluded_debts?.length || 0) > 0 ? (
                <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-3 text-xs text-zinc-400">
                  Excluded debts: {(debtCountdown?.excluded_debts || []).map((item) => item.name).filter(Boolean).join(", ")}
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">FI Progress</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    V2 progress tracks the protected path toward your FI cash target.
                  </div>
                </div>
                <div className="text-xs text-zinc-400">
                  {hasFinancialOsV2 ? "Financial OS V2" : (intelligenceContext?.fi_cash_target_label || "Proxy target")}
                </div>
              </div>

              <div className="mt-4 flex items-end justify-between gap-3">
                <div className="text-4xl font-semibold text-zinc-100">
                  {fiProgressPercent != null ? `${fiProgressPercent}%` : "--"}
                </div>
                <div className="text-xs text-zinc-500">
                  {fiTargetAmount != null
                    ? `Target ${fmtMoney(Number(fiTargetAmount || 0))}`
                    : "Target pending"}
                </div>
              </div>

              <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-zinc-200 transition-all"
                  style={{ width: `${clamp01(Number(fiProgressPercent || 0) / 100) * 100}%` }}
                />
              </div>

              <div className="mt-4 text-sm leading-6 text-zinc-400">
                {hasFinancialOsV2
                  ? fiTargetExplanation
                  : (fiProgress?.explanation || "Loading FI progress.")}
              </div>

              <div className="mt-4 space-y-2">
                {hasFinancialOsV2 ? (
                  <>
                    <div className="flex items-start justify-between gap-3 text-xs text-zinc-400">
                      <div>{fiTargetDetails?.label || "FI target source"}</div>
                      <div className="font-mono text-zinc-200">
                        {fiTargetDetails?.source === "user_set_goal" ? "User-set" : "Derived"}
                      </div>
                    </div>
                    <div className="flex items-start justify-between gap-3 text-xs text-zinc-400">
                      <div>Annual required spend</div>
                      <div className="font-mono text-zinc-200">{formatDashboardMoney(fiTargetDetails?.annual_required_spend)}</div>
                    </div>
                    <div className="flex items-start justify-between gap-3 text-xs text-zinc-400">
                      <div>Progress amount</div>
                      <div className="font-mono text-zinc-200">{formatDashboardMoney(fiProgressAmount)}</div>
                    </div>
                    <div className="flex items-start justify-between gap-3 text-xs text-zinc-400">
                      <div>Monthly FI contribution</div>
                      <div className="font-mono text-zinc-200">{formatDashboardMoney(fiContributionRecommendation)}</div>
                    </div>
                    <div className="flex items-start justify-between gap-3 text-xs text-zinc-400">
                      <div>Years to FI</div>
                      <div className="font-mono text-zinc-200">{yearsToFi != null ? `${yearsToFi} yrs` : "--"}</div>
                    </div>
                    <div className="text-[11px] leading-5 text-zinc-500">
                      {fiTargetDetails?.formula || financialOsV2?.formula_notes?.fi_target}
                    </div>
                  </>
                ) : (
                  fiProgressComponents.map((component, idx) => (
                    <div key={`${component.label}-${idx}`} className="flex items-start justify-between gap-3 text-xs text-zinc-400">
                      <div>{component.label}</div>
                      <div className="font-mono text-zinc-200">{Math.round(Number(component.progress || 0))}%</div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Debt Payoff Projection</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Uses the Financial OS V2 payoff model when available.
                  </div>
                </div>
                <div className="text-xs text-zinc-400">
                  {projectedPayoffDebt?.name || nextDollarImpact?.target_debt?.name || nextBestDollar?.recommendation?.name || "No target"}
                </div>
              </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Repeatable extra</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(payoffRecurringExtra)}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Months faster</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {payoffMonthsSaved != null
                      ? `${payoffMonthsSaved} mo`
                      : "--"}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Interest saved</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(payoffInterestSaved)}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Payoff with extra</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {payoffMonthsWithExtra != null
                      ? `${payoffMonthsWithExtra} mo`
                      : "--"}
                  </div>
                </div>
              </div>

              <div className="mt-4 text-sm leading-6 text-zinc-400">
                {payoffExplanation}
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                {availableStsForDebt != null
                  ? `Final Safe-to-Spend is ${fmtMoney(Number(availableStsForDebt || 0))}, but only the repeatable protected extra above is assumed for debt payoff.`
                  : "The payoff view uses the smaller repeatable extra payment, not the full STS balance."}
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                {payoffMonthsWithExtra != null && projectedPayoffDebt?.minimum_only_months != null
                  ? `Minimum-only payoff for this target is about ${projectedPayoffDebt.minimum_only_months} months before the extra payment is applied.`
                  : "Approximation assumes this extra amount can be repeated monthly and debt APRs stay flat."}
              </div>
            </div>
          </div>
        )}

        {/* ===== Financial OS control panels ===== */}
        {settings.show_financial_os_panels && (
          <div className="grid gap-3 lg:grid-cols-3">
            {/* Safe-to-Spend */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">
                  Safe-to-Spend Breakdown
                </div>
                <div className="text-xs text-zinc-400">STS formula</div>
              </div>

              <div className="mt-2 text-xs text-zinc-400">
                Final Safe-to-Spend is the V2 current-period allowance after protected obligations, runway, and FI cash are protected.
              </div>

              <div className="mt-3 text-3xl font-semibold text-zinc-100">
                {formatDashboardMoney(safeToSpendToday, {
                  loading: nextBestDollarLoadingState,
                  unavailable: nextBestDollarUnavailable,
                })}
              </div>

              {hasFinancialOsV2 && stsStatus ? (
                <div className={`mt-3 inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${financialOsStatusTone(stsStatus.state)}`}>
                  {stsStatus.label || "STS status"}
                </div>
              ) : null}

              {hasFinancialOsV2 && stsStatus?.detail ? (
                <div className="mt-3 text-xs leading-5 text-zinc-400">
                  {stsStatus.detail}
                </div>
              ) : null}

              {hasFinancialOsV2 && setupRequired ? (
                <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-100">
                  <div className="font-medium uppercase tracking-[0.16em]">Setup required</div>
                  <div className="mt-2 space-y-2">
                    {setupReasons.map((reason, idx) => (
                      <div key={`${reason.code || "setup"}-${idx}`}>
                        <span className="text-amber-200">{reason.label || "Missing input"}:</span> {reason.detail}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {hasFinancialOsV2 ? (
                <div className="mt-4 space-y-2 text-xs text-zinc-500">
                  <div className="flex items-center justify-between gap-3">
                    <span>Total cash</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(financialOsV2?.total_cash)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Protected cash</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(protectedCash)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Bills/manual obligations</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(billsManualObligationsTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Debt minimums</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(debtMinimumsTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Total protected obligations</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(protectedObligationsTotal)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Runway reserve current</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(runwayReserveCurrent)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Runway reserve target</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(runwayReserveTarget)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>FI cash protected</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(savingsGoalCash)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Available discretionary cash</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(availableDiscretionaryCash)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Remaining discretionary this month</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(remainingDiscretionaryThisMonth)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Discretionary cap source</span>
                    <span className="font-mono text-zinc-200">
                      {discretionaryCapDetails?.label || "Data unavailable"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Weekly Safe-to-Spend</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(weeklySafeToSpend)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2 text-zinc-300">
                    <span>Final Safe-to-Spend</span>
                    <span className="font-mono text-zinc-100">{formatDashboardMoney(safeToSpendToday)}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {safeToSpendFormulaLabel}
                  </div>
                </div>
              ) : stsBreakdown ? (
                <div className="mt-4 space-y-2 text-xs text-zinc-500">
                  <div className="flex items-center justify-between gap-3">
                    <span>Total cash</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.total_cash ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>PDF cash</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.pdf_cash ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Plaid cash counted</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.plaid_cash_counted ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Duplicates skipped</span>
                    <span className="font-mono text-zinc-200">
                      {Number(stsBreakdown.duplicates_skipped || 0)}
                      {Number(stsBreakdown.duplicates_skipped_balance || 0) > 0
                        ? ` • ${fmtMoney(Number(stsBreakdown.duplicates_skipped_balance || 0))}`
                        : ""}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Upcoming bills</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.upcoming_bills_total ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Manual obligations</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.manual_obligations_total ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Debt minimums</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.debt_minimums_total ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Upcoming total</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(stsBreakdown.upcoming_total ?? null)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Safe-to-Spend before buffer</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(safeToSpendBeforeBuffer)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Protected buffer</span>
                    <span className="font-mono text-zinc-200">{formatDashboardMoney(protectedBuffer)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2 text-zinc-300">
                    <span>Final Safe-to-Spend</span>
                    <span className="font-mono text-zinc-100">{formatDashboardMoney(safeToSpendToday)}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {safeToSpendFormulaLabel}
                  </div>
                </div>
              ) : nextBestDollarUnavailable ? (
                <div className="mt-2 text-xs text-zinc-500">
                  STS data unavailable.
                </div>
              ) : (
                <div className="mt-2 text-xs text-zinc-500">
                  Backend STS breakdown is loading.
                </div>
              )}

              <div className="mt-3 text-xs text-zinc-500">
                {hasFinancialOsV2
                  ? "Large cash balances are not all spendable. Financial OS V2 protects due-soon obligations, runway reserves, and planned FI cash before discretionary spending is allowed."
                  : "Financial OS uses your counted cash totals, including non-duplicate linked cash accounts, before applying upcoming obligations and buffer."}
              </div>

              {hasFinancialOsV2 && discretionaryCapDetails?.pending_income_cap ? (
                <div className="mt-3 text-xs text-zinc-500">
                  Settings has a percentage-based discretionary cap, but V2 still needs a monthly income baseline to turn that percentage into a clean dollar plan.
                </div>
              ) : null}

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
            {/* ===== Upcoming Obligations (Phase 1) ===== */}
<div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Upcoming Obligations</div>
        <div className="mt-1 text-xs text-zinc-400">
        Next {upcomingWindowDays} days • total needed{" "}
        <span className="text-zinc-100 font-mono">
          {formatDashboardMoney(protectedObligationsTotal, {
            loading: osStateLoading,
            unavailable: osStateUnavailable,
          })}
        </span>
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        Bills/manual obligations {formatDashboardMoney(billsManualObligationsTotal, { loading: osStateLoading, unavailable: osStateUnavailable })} â€¢ Debt minimums {formatDashboardMoney(debtMinimumsTotal, { loading: osStateLoading, unavailable: osStateUnavailable })} â€¢ Total protected obligations {formatDashboardMoney(protectedObligationsTotal, { loading: osStateLoading, unavailable: osStateUnavailable })}
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        Bills {formatDashboardMoney(upcomingSummary?.bill_total ?? null, { loading: osStateLoading, unavailable: osStateUnavailable })} • Manual {formatDashboardMoney(upcomingSummary?.manual_bill_total ?? null, { loading: osStateLoading, unavailable: osStateUnavailable })} • Debt minimums {formatDashboardMoney(upcomingSummary?.debt_minimum_total ?? null, { loading: osStateLoading, unavailable: osStateUnavailable })}
      </div>
    </div>

    <Link
      href="/bills"
      className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
      title="Manage bills"
    >
      Manage →
    </Link>
  </div>

  {billsLoading && <div className="mt-4 text-sm text-zinc-400">Loading obligations…</div>}
  {billsErr && <div className="mt-4 text-sm text-red-400">Data unavailable. {billsErr}</div>}

  {!billsLoading && !billsErr && (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-zinc-400">
          <tr className="border-b border-white/10">
            <th className="py-3 pr-4">obligation</th>
            <th className="py-3 pr-4">due</th>
            <th className="py-3 pr-4">frequency</th>
            <th className="py-3 pr-0 text-right">amount</th>
          </tr>
        </thead>
        <tbody className="text-zinc-200">
          {upcomingItemsList.map((b: any) => (
            <tr key={b.id} className="border-b border-white/5 hover:bg-white/5">
              <td className="py-3 pr-4">
                <div className="text-zinc-100">{b.name}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {b.type === "debt_minimum"
                    ? "Debt minimum"
                    : b.type === "manual_bill"
                      ? "Manual obligation"
                      : (b.autopay ? "Autopay bill" : "Bill")}
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

          {upcomingItemsList.length === 0 && (
            <tr>
              <td className="py-6 text-zinc-400" colSpan={4}>
                No obligations due in the next {upcomingWindowDays} days.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )}

  <div className="mt-3 text-xs text-zinc-500">
    Backend Financial OS now surfaces bills, manual obligations, and debt minimums from one upcoming-obligations window.
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
                    {nextBestDollar?.recommendation?.why || "This card updates from your counted cash after bills and buffer."}
                    {nextBestDollar?.recommendation?.available_sts != null
                      ? ` Available STS today: ${fmtMoney(Number(nextBestDollar.recommendation.available_sts || 0))}.`
                      : ""}
                  </div>
                </div>
              </div>

              <div className="mt-4 text-xs text-zinc-500">
                Linked cash feeds your plan totals without being merged into imported statement transaction tables.
              </div>
            </div>
          </div>
        )}

        {settings.show_financial_os_panels && (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Plaid Cash in Financial OS</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Linked cash that is already counted in your plan, without double-counting imported cash snapshots.
                  </div>
                </div>
                <Link
                  href="/plaid"
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                >
                  Open Plaid →
                </Link>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Plaid cash counted</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {fmtMoney(Number(osCashSources?.plaid_cash_total || 0))}
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Included cash accounts</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">{plaidIncludedAccounts.length}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Duplicates skipped</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">{plaidDuplicateAccounts.length}</div>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                {plaidIncludedAccounts.length ? (
                  plaidIncludedAccounts.map((account) => (
                    <div
                      key={account.account_id}
                      className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-3 text-xs text-zinc-300"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-zinc-100">{account.name}</div>
                          <div className="mt-1 text-zinc-500">
                            {account.institution_name || "Linked institution"}
                            {account.mask ? ` • ****${account.mask}` : ""}
                            {account.subtype ? ` • ${account.subtype}` : ""}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-sm text-zinc-100">
                            {fmtMoney(Number(account.counted_balance || account.current_balance || 0))}
                          </div>
                          <div className="text-[11px] text-zinc-500">Counted in cash total</div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] px-3 py-4 text-xs text-zinc-400">
                    No Plaid cash accounts are currently contributing to Financial OS cash.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Current Month Linked Activity</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Institution labels stay visible so repeated sandbox-style rows are easier to tell apart.
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">
                    Suspected duplicate linked rows are hidden from spend totals but kept visible for review.
                  </div>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300">
                  {plaidAccounts.length} account{plaidAccounts.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                  <div className="text-xs text-zinc-400">Counted linked spend</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {fmtMoney(plaidDisplaySummary.countedSpend)}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    Used in current month dashboard spend totals
                  </div>
                </div>
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
                  <div className="text-xs text-amber-200">Suspected duplicates skipped</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {plaidDisplaySummary.suspectedDuplicateCount}
                    {plaidDisplaySummary.suspectedDuplicateCount === 0
                      ? ""
                      : ` • ${fmtMoney(plaidDisplaySummary.suspectedDuplicateSpend)}`}
                  </div>
                  <div className="mt-1 text-[11px] text-amber-100/80">
                    Exact duplicate-looking linked rows kept for review
                  </div>
                </div>
              </div>

              {plaidRecentRows.length ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-xs text-zinc-300">
                    <thead className="text-zinc-500">
                      <tr className="border-b border-white/10">
                        <th className="py-2 pr-3">date</th>
                        <th className="py-2 pr-3">account</th>
                        <th className="py-2 pr-3">merchant</th>
                        <th className="py-2 pr-3">status</th>
                        <th className="py-2 pr-0 text-right">amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plaidRecentRows.map((txn) => (
                        <tr
                          key={txn.transaction_id}
                          className={[
                            "border-b border-white/5",
                            txn.suspectedDuplicate ? "bg-amber-500/5" : "",
                          ].join(" ")}
                        >
                          <td className="py-2 pr-3 text-zinc-400">{txn.posted_date || txn.authorized_date || "—"}</td>
                          <td className="py-2 pr-3">
                            <div className="text-zinc-200">{txn.account_name || "Plaid account"}</div>
                            <div className="text-[11px] text-zinc-500">
                              {txn.institution_name || "Linked institution"}
                              {txn.account_mask ? ` • ****${txn.account_mask}` : ""}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-zinc-300">{txn.merchant_name || txn.name || "—"}</td>
                          <td className="py-2 pr-3">
                            <span
                              className={[
                                "inline-flex rounded-full border px-2 py-0.5 text-[10px]",
                                txn.suspectedDuplicate
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                  : "border-emerald-500/20 bg-emerald-500/10 text-emerald-200",
                              ].join(" ")}
                            >
                              {txn.suspectedDuplicate ? "Suspected duplicate" : "Counted"}
                            </span>
                          </td>
                          <td className="py-2 pr-0 text-right font-mono text-zinc-100">
                            {typeof txn.amount === "number" ? fmtMoney(txn.amount) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-[#0B0F14] px-3 py-4 text-xs text-zinc-400">
                  No linked activity is visible for this month yet.
                </div>
              )}

              <div className="mt-4 text-xs text-zinc-500">
                Linked activity stays separate from imported statement transactions while still staying visible in your monthly dashboard view.
              </div>
            </div>
          </div>
        )}

        {/* Stat cards (now includes cash + net worth) */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Total Cash</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {formatDashboardMoney(financialOsCashTotal, {
                loading: osStateLoading,
                unavailable: osStateUnavailable,
              })}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Cash available to your plan • {financialOsCashLabel}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Tracked Debt Registry</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {formatDashboardMoney(trackedDebtTotal, {
                loading: osStateLoading,
                unavailable: osStateUnavailable,
              })}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Active debts from the debt registry
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Statement Card Balances</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {fmtMoney(totals.totalOutstanding)}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Latest imported statement per card • {fmtMoney(statementCoverage.tracked)} already covered in tracked debt
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Net Worth (V1)</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {formatDashboardMoney(netWorthV1, {
                loading: osStateLoading,
                unavailable: osStateUnavailable,
              })}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Cash minus tracked debt and only the statement balances not already tracked
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
            <div className="text-xs text-zinc-400">4 buckets across all visible sources</div>
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
              click a category to review the full source-aware list
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
            Category totals now reflect statement, imported cash, manual, and counted linked activity for the current month. Suspected duplicate linked rows stay visible for review but are skipped from spend totals.
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
            Balance trend still reflects latest imported statement balances by period. Monthly spend panels above now use live source-aware transaction activity instead.
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
