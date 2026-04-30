"use client";

import {
  FinancialOsAdvisorSummary,
  FinancialOsDecisionPlan,
  FinancialOsDecisionPlanAction,
  FinancialOsSetupItem,
  FinancialOsSetupStatus,
  FinancialOsV2,
  FinancialOsIntelligenceResponse,
  getCashAccounts,
  getCashAccountTransactions,
  getFinancialOsIntelligence,
  listManualTransactions,
  listDebts,
  Debt,
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
import { formatMoney, formatMonths, formatShortDate } from "@/lib/format";
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
  return formatMoney(n || 0);
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

function formatDashboardMoneyOrText(value: unknown, fallback = "Not set") {
  const coerced = coerceDashboardMoneyValue(value);
  if (coerced == null) return fallback;
  return fmtMoney(coerced);
}

function formatDashboardPercent(value: unknown) {
  const coerced = coerceDashboardMoneyValue(value);
  if (coerced == null || coerced <= 0) return null;
  return Number.isInteger(coerced) ? `${coerced}%` : `${coerced.toFixed(1)}%`;
}

function setupStatusLabel(status?: string | null) {
  switch ((status || "").toLowerCase()) {
    case "confirmed":
      return "Confirmed";
    case "detected":
      return "Detected";
    case "default":
      return "Default";
    case "missing":
      return "Missing";
    case "derived":
      return "Derived";
    default:
      return "Unknown";
  }
}

function setupStatusTone(status?: string | null) {
  switch ((status || "").toLowerCase()) {
    case "confirmed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "detected":
    case "derived":
      return "border-sky-500/30 bg-sky-500/10 text-sky-200";
    case "default":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "missing":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    default:
      return "border-white/10 bg-white/5 text-zinc-300";
  }
}

function trustLevelTone(level?: string | null) {
  switch ((level || "").toLowerCase()) {
    case "high":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "medium":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "low":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    default:
      return "border-white/10 bg-white/5 text-zinc-300";
  }
}

function advisorSummaryTone(tone?: string | null) {
  switch ((tone || "").toLowerCase()) {
    case "positive":
      return "border-emerald-500/20 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_42%),#0B0F14]";
    case "warning":
      return "border-amber-500/20 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.16),transparent_42%),#0B0F14]";
    case "urgent":
      return "border-red-500/20 bg-[radial-gradient(circle_at_top_left,rgba(239,68,68,0.14),transparent_42%),#0B0F14]";
    default:
      return "border-sky-500/20 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_42%),#0B0F14]";
  }
}

function advisorConfidenceTone(confidence?: string | null) {
  switch ((confidence || "").toLowerCase()) {
    case "high":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "medium":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "low":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    default:
      return "border-white/10 bg-white/5 text-zinc-300";
  }
}

function advisorConfidenceLabel(confidence?: string | null) {
  switch ((confidence || "").toLowerCase()) {
    case "high":
      return "High confidence";
    case "medium":
      return "Medium confidence";
    case "low":
      return "Low confidence";
    default:
      return "Confidence pending";
  }
}

function decisionPlanStatusTone(status?: string | null) {
  switch ((status || "").toLowerCase()) {
    case "ready":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "limited":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "blocked":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    default:
      return "border-white/10 bg-white/5 text-zinc-300";
  }
}

function decisionPlanStatusLabel(status?: string | null) {
  switch ((status || "").toLowerCase()) {
    case "ready":
      return "Ready";
    case "limited":
      return "Limited";
    case "blocked":
      return "Blocked";
    default:
      return "Plan";
  }
}

function decisionCommandFromText(text?: string | null) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("pause") && normalized.includes("spend")) return "Pause spending";
  if (normalized.includes("debt") || normalized.includes("payment")) return "Pay debt";
  if (
    normalized.includes("protect") ||
    normalized.includes("reserve") ||
    normalized.includes("buffer") ||
    normalized.includes("cash")
  ) {
    return "Protect cash";
  }
  if (normalized.includes("setup") || normalized.includes("confirm")) return "Confirm setup";
  if (normalized.includes("bill")) return "Review bills";
  if (normalized.includes("save")) return "Save cash";
  return null;
}

function decisionActionCommand(action?: FinancialOsDecisionPlanAction | null) {
  switch ((action?.type || "").toLowerCase()) {
    case "pause_spending":
      return "Pause spending";
    case "pay_debt":
      return "Pay debt";
    case "protect_cash":
      return "Protect cash";
    case "confirm_setup":
      return "Confirm setup";
    case "review_bill":
      return "Review bills";
    case "save_cash":
      return "Save cash";
    default: {
      const labelCommand = decisionCommandFromText(action?.label);
      if (labelCommand) return labelCommand;

      const cleanedLabel = String(action?.label || "").trim().replace(/[.]+$/, "");
      return cleanedLabel && cleanedLabel.length <= 36 ? cleanedLabel : null;
    }
  }
}

function decisionHeadlineFromActions(
  actions: FinancialOsDecisionPlanAction[],
  fallback?: string | null
) {
  const commands: string[] = [];

  for (const action of actions) {
    const command = decisionActionCommand(action);
    if (command && !commands.includes(command)) commands.push(command);
    if (commands.length === 2) break;
  }

  const fallbackCommand = decisionCommandFromText(fallback);
  if (!commands.length && fallbackCommand) commands.push(fallbackCommand);

  return commands.length ? commands.join(" • ") : "Review plan";
}

function decisionActionMeta(action?: FinancialOsDecisionPlanAction | null) {
  const parts: string[] = [];
  if (action?.amount != null) parts.push(fmtMoney(action.amount));
  if (action?.target) parts.push(action.target);
  if (action?.timing) parts.push(action.timing);
  return parts.join(" • ");
}

function standardCtaLabel(label?: string | null) {
  const normalized = String(label || "").toLowerCase();
  if (normalized.includes("review")) return "Review";
  if (normalized.includes("set") || normalized.includes("setup")) return "Set";
  if (normalized.includes("confirm")) return "Confirm";
  return "Open";
}

function polishDashboardCopy(value?: string | null, fallback = "") {
  const text = String(value || fallback)
    .replace(/this does not mean[^.?!]*[.?!]\s*/gi, "")
    .replace(/\bshould\b/gi, "can")
    .replace(/Spending paused:\s*/gi, "Spending paused. ")
    .replace(/your monthly cap is fully used/gi, "Cap used")
    .trim();

  return text || fallback;
}

function shortDashboardCopy(value?: string | null, fallback = "", maxLength = 150) {
  const text = polishDashboardCopy(value, fallback);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function isInstructionalInsight(text?: string | null) {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return false;
  return /\b(pause|pay|review|set|confirm|open|avoid|do not|don't|next step|what to do|should|need to)\b/.test(normalized);
}

function setupTrustCopy(status?: FinancialOsSetupStatus | null) {
  switch ((status?.trust_level || "").toLowerCase()) {
    case "high":
      return "Recommendations are based on confirmed setup.";
    case "medium":
      return "Recommendations are usable, but some assumptions should be confirmed.";
    case "low":
      return "Some recommendations are estimated until setup is completed.";
    default:
      return "Setup status is loading.";
  }
}

function formatSetupItemValue(item?: FinancialOsSetupItem | null) {
  if (!item || item.value == null || item.value === "") return null;
  if (typeof item.value === "string") return item.value;

  switch (item.key) {
    case "monthly_income":
      return `${fmtMoney(item.value)}/month`;
    case "fixed_essentials":
      return `${fmtMoney(item.value)}/month`;
    case "runway_target":
      return formatMonths(item.value);
    case "fi_target":
      return fmtMoney(item.value);
    case "debt_registry":
      return `${item.value} ${Number(item.value) === 1 ? "debt" : "debts"}`;
    default:
      return String(item.value);
  }
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

function monthIndexFromBucketKey(key: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

type PayoffDebtInput = {
  id?: string | number | null;
  name: string;
  lender?: string | null;
  last4?: string | null;
  balance: number;
  apr: number | null;
  minimumDue: number | null;
  creditLimit: number | null;
  source: "registry" | "financial_os" | "projection" | "plaid";
};

function recordValue(source: unknown, key: string) {
  if (!source || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key];
}

function cleanDebtName(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Debt";
}

function cleanLast4(value: unknown) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

function payoffDebtMergeKey(debt: PayoffDebtInput) {
  if (debt.id != null) return `id:${debt.id}`;
  if (debt.last4) return `last4:${debt.last4}`;
  return `name:${debt.name.toLowerCase()}`;
}

function addPayoffDebtInput(map: Map<string, PayoffDebtInput>, debt: PayoffDebtInput) {
  if (debt.balance <= 0) return;
  const key = payoffDebtMergeKey(debt);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, debt);
    return;
  }

  map.set(key, {
    ...existing,
    name: existing.name || debt.name,
    lender: existing.lender ?? debt.lender,
    last4: existing.last4 ?? debt.last4,
    balance: existing.balance > 0 ? existing.balance : debt.balance,
    apr: existing.apr ?? debt.apr,
    minimumDue: existing.minimumDue ?? debt.minimumDue,
    creditLimit: existing.creditLimit ?? debt.creditLimit,
  });
}

function estimatedMinimumDue(balance: number) {
  if (balance <= 0) return 0;
  return Math.max(25, balance * 0.02);
}

function simulateDebtPortfolio(debts: PayoffDebtInput[], extraMonthly: number) {
  const modeled = debts
    .filter((debt) => debt.balance > 0)
    .map((debt) => ({
      name: debt.name,
      balance: debt.balance,
      apr: Math.max(0, debt.apr ?? 0),
      minimumDue: Math.max(0, debt.minimumDue ?? estimatedMinimumDue(debt.balance)),
    }))
    .filter((debt) => debt.minimumDue > 0);

  if (!modeled.length) return { months: null, interest: null, workable: false };

  let months = 0;
  let interest = 0;
  const extraPayment = Math.max(0, Number(extraMonthly) || 0);

  while (months < 600) {
    const remainingBefore = modeled.reduce((sum, debt) => sum + Math.max(0, debt.balance), 0);
    if (remainingBefore <= 0.01) return { months, interest, workable: true };

    for (const debt of modeled) {
      if (debt.balance <= 0.01) continue;
      const monthlyInterest = debt.balance * (debt.apr / 100 / 12);
      debt.balance += monthlyInterest;
      interest += monthlyInterest;
    }

    for (const debt of modeled) {
      if (debt.balance <= 0.01) continue;
      const payment = Math.min(debt.minimumDue, debt.balance);
      debt.balance -= payment;
    }

    let extraLeft = extraPayment;
    while (extraLeft > 0.01) {
      const target = modeled
        .filter((debt) => debt.balance > 0.01)
        .sort((left, right) => right.apr - left.apr || right.balance - left.balance)[0];
      if (!target) break;
      const payment = Math.min(extraLeft, target.balance);
      target.balance -= payment;
      extraLeft -= payment;
    }

    const remainingAfter = modeled.reduce((sum, debt) => sum + Math.max(0, debt.balance), 0);
    months += 1;
    if (remainingAfter >= remainingBefore - 0.01) {
      return { months: null, interest: null, workable: false };
    }
  }

  return { months: null, interest: null, workable: false };
}

/** =========================
 * Categories
 * ========================= */
type Category = SpendingCategory;
type TrendRange = "all" | "year" | "3m" | "1m";

type DiscretionaryExplanation = {
  monthly_income_baseline?: number | null;
  income_source?: string | null;
  discretionary_cap_percent?: number | null;
  discretionary_cap_amount?: number | null;
  month_to_date_spend?: number | null;
  skipped_duplicate_spend?: number | null;
  remaining_monthly_cap?: number | null;
  available_cash_after_protection?: number | null;
  final_allowance?: number | null;
  limiting_factor?: string | null;
  reason_short?: string | null;
  reason_detail?: string | null;
  action?: string | null;
};

type FinancialOsV2WithExplanation = FinancialOsV2 & {
  discretionary_explanation?: DiscretionaryExplanation | null;
};

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
const RUNWAY_MANUAL_CASH_KEY = "accountantbot_runway_manual_cash_v1";

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

function loadManualRunwayCashInput() {
  if (typeof window === "undefined") return "0";
  try {
    return localStorage.getItem(RUNWAY_MANUAL_CASH_KEY) || "0";
  } catch {
    return "0";
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

function discretionaryExplanationTone(limitingFactor?: string | null) {
  switch ((limitingFactor || "").toLowerCase()) {
    case "none":
      return "border-emerald-500/20 bg-emerald-500/10 text-emerald-200";
    case "income_missing":
      return "border-amber-500/20 bg-amber-500/10 text-amber-100";
    case "cap_exhausted":
    case "cash_protected":
    case "period_limit":
      return "border-red-500/20 bg-red-500/10 text-red-100";
    default:
      return "border-white/10 bg-white/5 text-zinc-200";
  }
}

function discretionaryExplanationHeadline(
  limitingFactor?: string | null,
  fallback?: string | null
) {
  switch ((limitingFactor || "").toLowerCase()) {
    case "cap_exhausted":
      return "Spending paused: your monthly cap is fully used.";
    case "income_missing":
      return "Spending paused: income not set, cap cannot be calculated.";
    case "cash_protected":
      return "Spending paused: cash is reserved for bills and safety buffer.";
    case "period_limit":
      return "Spending paused: this period's allowance has already been used.";
    case "none":
      return fallback || "Spending is available inside your current allowance.";
    default:
      return fallback || "Allowance details are loading.";
  }
}

function incomeSourceLabel(source?: string | null) {
  switch ((source || "").toLowerCase()) {
    case "user_set":
      return "User set";
    case "detected":
      return "Detected";
    case "missing":
      return "Not set";
    default:
      return "Unknown";
  }
}

function fmtMonthsCompact(months?: number | null) {
  if (months == null) return "Needs data";
  if (months <= 0) return "Debt-free";
  return formatMonths(months);
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

function cashSavingsBalance(a: any) {
  const savings = Number(a?.savings_end_balance ?? 0);
  return Number.isFinite(savings) ? Math.max(0, savings) : 0;
}

function isPlaidRunwaySavingsAccount(account: PlaidAccountSummary) {
  const type = String(account.type || "").toLowerCase();
  const subtype = String(account.subtype || "").toLowerCase();
  const searchable = [account.name, account.official_name, account.institution_name, subtype]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (account.is_liability || type === "credit" || type === "loan") return false;
  return (
    (account.is_cash_like === true || type === "depository") &&
    (subtype === "savings" ||
      subtype === "money market" ||
      subtype === "cd" ||
      searchable.includes("savings") ||
      searchable.includes("money market"))
  );
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

type UpcomingDashboardItem = NonNullable<OsStateResponse["upcoming_items"]>[number];

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
    setManualRunwayCashInput(loadManualRunwayCashInput());

    const onStorage = (e: StorageEvent) => {
      if (e.key === SETTINGS_KEY) {
        setSettings(resolveSettings(loadSettings()));
      } else if (e.key === RUNWAY_MANUAL_CASH_KEY) {
        setManualRunwayCashInput(loadManualRunwayCashInput());
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

  function updateManualRunwayCashInput(value: string) {
    setManualRunwayCashInput(value);
    try {
      localStorage.setItem(RUNWAY_MANUAL_CASH_KEY, value);
    } catch {
      // Local storage can be unavailable in private browser contexts.
    }
  }


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
  const [debtRegistry, setDebtRegistry] = useState<Debt[]>([]);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashErr, setCashErr] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);
  const [osState, setOsState] = useState<OsStateResponse | null>(null);
  const [nextBestDollar, setNextBestDollar] = useState<NextBestDollarResponse | null>(null);
  const [intelligence, setIntelligence] = useState<FinancialOsIntelligenceResponse | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccountSummary[]>([]);
  const [plaidTransactions, setPlaidTransactions] = useState<PlaidTransactionSummary[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [trendRange, setTrendRange] = useState<TrendRange>("1m");
  const [showPayoffSimulator, setShowPayoffSimulator] = useState(false);
  const [showRunwayDetails, setShowRunwayDetails] = useState(false);
  const [manualRunwayCashInput, setManualRunwayCashInput] = useState("0");
  const [payoffSimulationExtra, setPayoffSimulationExtra] = useState("100");

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

    (async () => {
      try {
        const rows = await listDebts({ user_id: userId });
        if (!cancelled) setDebtRegistry(rows || []);
      } catch {
        if (!cancelled) setDebtRegistry([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasAuthenticatedUser, userId]);

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

  const importedRunwaySavings = useMemo(() => {
    const list = (cashAccounts || []) as CashAccount[];
    const latestByAccount = new Map<string, CashAccount>();

    for (const account of list) {
      const keyParts = [
        account.institution,
        account.account_label,
        account.account_name,
        account.account_last4,
      ].filter(Boolean);
      const key = keyParts.length ? keyParts.join(":").toLowerCase() : "__latest_cash_snapshot";
      const current = latestByAccount.get(key);
      if (!current || getCashImportEndTime(account) > getCashImportEndTime(current)) {
        latestByAccount.set(key, account);
      }
    }

    return Array.from(latestByAccount.values()).reduce((sum, account) => sum + cashSavingsBalance(account), 0);
  }, [cashAccounts]);

  const plaidRunwaySavings = useMemo(
    () =>
      (plaidAccounts || [])
        .filter(isPlaidRunwaySavingsAccount)
        .reduce((sum, account) => sum + Math.max(0, firstDashboardMoneyValue(account.current_balance) ?? 0), 0),
    [plaidAccounts]
  );

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
  const decisionPlan = (osState?.decision_plan ?? null) as FinancialOsDecisionPlan | null;
  const advisorSummary = (osState?.advisor_summary ?? null) as FinancialOsAdvisorSummary | null;
  const setupStatus = (osState?.setup_status ?? financialOsV2?.setup_status ?? null) as FinancialOsSetupStatus | null;
  const setupItems = setupStatus?.items ?? [];
  const setupCompletedCount = Number(setupStatus?.completed_count ?? 0);
  const setupTotalCount = Number(setupStatus?.total_count ?? setupItems.length ?? 0);
  const decisionPlanActions = useMemo(
    () =>
      [...(decisionPlan?.actions ?? [])]
        .sort((left, right) => {
          const leftPriority =
            typeof left?.priority === "number" && Number.isFinite(left.priority)
              ? left.priority
              : Number.MAX_SAFE_INTEGER;
          const rightPriority =
            typeof right?.priority === "number" && Number.isFinite(right.priority)
              ? right.priority
              : Number.MAX_SAFE_INTEGER;
          return leftPriority - rightPriority;
        })
        .slice(0, 3),
    [decisionPlan?.actions]
  );
  const decisionPlanHeadline = decisionHeadlineFromActions(
    decisionPlanActions,
    decisionPlan?.headline
  );
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
  const protectedObligationsTotal = firstDashboardMoneyValue(
    financialOsV2?.protected_obligations_total,
    nextBestDollar?.breakdown?.protected_obligations_total,
    financialOsUpcomingTotal
  );
  const trackedDebtTotal = firstDashboardMoneyValue(
    osState?.debt_utilization?.total_balance,
    trackedDebtItemsTotal
  );
  const discretionarySpendAllowance = firstDashboardMoneyValue(
    financialOsV2?.discretionary_spending_allowance,
    financialOsV2?.current_period_safe_to_spend,
    nextBestDollar?.safe_to_spend_today,
    nextBestDollar?.calculation?.safe_to_spend_today,
    stsBreakdown?.final_safe_to_spend,
    intelligenceContext?.safe_to_spend_today
  );
  const safeToSpendToday = discretionarySpendAllowance;
  const weeklySafeToSpend = firstDashboardMoneyValue(
    financialOsV2?.weekly_discretionary_spending_allowance,
    financialOsV2?.weekly_safe_to_spend,
    safeToSpendToday
  );
  const remainingDiscretionaryThisMonth = firstDashboardMoneyValue(
    financialOsV2?.remaining_discretionary_this_month
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
  const fiTargetDetails = financialOsV2?.fi_target_details ?? null;
  const financialOsV2WithExplanation = financialOsV2 as FinancialOsV2WithExplanation | null;
  const discretionaryExplanation = ((financialOsV2WithExplanation?.discretionary_explanation) ?? (() => {
    const fallbackFinalAllowance = firstDashboardMoneyValue(
      financialOsV2?.discretionary_spending_allowance,
      financialOsV2?.current_period_safe_to_spend
    );
    const fallbackRemainingCap = firstDashboardMoneyValue(
      financialOsV2?.remaining_discretionary_this_month
    );
    const fallbackAvailableCash = firstDashboardMoneyValue(
      financialOsV2?.available_discretionary_cash
    );
    const fallbackIncomeBaseline = firstDashboardMoneyValue(
      financialOsV2?.monthly_income_baseline
    );
    const fallbackFactor =
      fallbackIncomeBaseline == null
        ? "income_missing"
        : (fallbackRemainingCap ?? 0) <= 0.01
        ? "cap_exhausted"
        : (fallbackAvailableCash ?? 0) <= 0.01
        ? "cash_protected"
        : (fallbackFinalAllowance ?? 0) <= 0.01
        ? "period_limit"
        : "none";

    return {
      monthly_income_baseline: fallbackIncomeBaseline,
      income_source: fallbackIncomeBaseline == null ? "missing" : "detected",
      discretionary_cap_percent: firstDashboardMoneyValue(financialOsV2?.discretionary_cap_details?.spend_pct) ?? 0,
      discretionary_cap_amount: firstDashboardMoneyValue(financialOsV2?.monthly_discretionary_cap),
      month_to_date_spend: firstDashboardMoneyValue(financialOsV2?.discretionary_spend_month_to_date) ?? 0,
      skipped_duplicate_spend: 0,
      remaining_monthly_cap: fallbackRemainingCap ?? 0,
      available_cash_after_protection: fallbackAvailableCash ?? 0,
      final_allowance: fallbackFinalAllowance ?? 0,
      limiting_factor: fallbackFactor,
      reason_short: stsStatus?.label ?? null,
      reason_detail: stsStatus?.detail ?? null,
      action: nextBestAction?.action ?? null,
    };
  })()) as DiscretionaryExplanation | null;
  const discretionaryExplanationHeadlineText = discretionaryExplanationHeadline(
    discretionaryExplanation?.limiting_factor,
    discretionaryExplanation?.reason_short
  );
  const discretionaryExplanationToneClass = discretionaryExplanationTone(
    discretionaryExplanation?.limiting_factor
  );
  const discretionaryExplanationFinalAllowance = firstDashboardMoneyValue(
    discretionaryExplanation?.final_allowance,
    safeToSpendToday
  );
  const discretionaryExplanationIsZero = (discretionaryExplanationFinalAllowance ?? 0) <= 0.01;
  const discretionaryCapPercentLabel = formatDashboardPercent(
    discretionaryExplanation?.discretionary_cap_percent
  );
  const decisionPlanSummary =
    shortDashboardCopy(
      decisionPlan?.summary ||
        nextBestAction?.reason ||
        intelligence?.insights?.what_to_do_next?.explanation,
      "Financial OS is preparing the clearest next step."
    );
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
      ? "Safe-to-Spend before buffer = cash total - upcoming obligations. Discretionary spending allowance = that amount after protected limits are applied."
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
  const payoffDebts = useMemo(() => {
    const map = new Map<string, PayoffDebtInput>();

    for (const debt of debtRegistry) {
      if (debt.active === false) continue;
      addPayoffDebtInput(map, {
        id: debt.id,
        name: cleanDebtName(debt.name, debt.lender),
        lender: debt.lender ?? null,
        last4: cleanLast4(debt.last4),
        balance: Math.max(0, firstDashboardMoneyValue(debt.balance) ?? 0),
        apr: firstDashboardMoneyValue(debt.apr),
        minimumDue: firstDashboardMoneyValue(debt.minimum_due),
        creditLimit: firstDashboardMoneyValue(debt.credit_limit),
        source: "registry",
      });
    }

    for (const item of trackedDebtItems) {
      addPayoffDebtInput(map, {
        id: recordValue(item, "id") as string | number | null,
        name: cleanDebtName(recordValue(item, "name"), recordValue(item, "lender")),
        lender: typeof recordValue(item, "lender") === "string" ? String(recordValue(item, "lender")) : null,
        last4: cleanLast4(recordValue(item, "last4")),
        balance: Math.max(0, firstDashboardMoneyValue(recordValue(item, "balance")) ?? 0),
        apr: firstDashboardMoneyValue(recordValue(item, "apr")),
        minimumDue: firstDashboardMoneyValue(recordValue(item, "minimum_due")),
        creditLimit: firstDashboardMoneyValue(recordValue(item, "credit_limit")),
        source: "financial_os",
      });
    }

    for (const item of debtPayoffProjection?.debts || []) {
      addPayoffDebtInput(map, {
        id: recordValue(item, "debt_id") as string | number | null,
        name: cleanDebtName(recordValue(item, "name")),
        lender: null,
        last4: cleanLast4(recordValue(item, "last4")),
        balance: Math.max(0, firstDashboardMoneyValue(recordValue(item, "balance")) ?? 0),
        apr: firstDashboardMoneyValue(recordValue(item, "apr")),
        minimumDue: firstDashboardMoneyValue(recordValue(item, "minimum_due")),
        creditLimit: firstDashboardMoneyValue(recordValue(item, "credit_limit")),
        source: "projection",
      });
    }

    for (const account of plaidAccounts) {
      const type = String(account.type || "").toLowerCase();
      const subtype = String(account.subtype || "").toLowerCase();
      const isLiability =
        account.is_liability === true ||
        type === "credit" ||
        type === "loan" ||
        ["credit card", "student", "mortgage", "auto", "personal"].includes(subtype);
      if (!isLiability) continue;

      const balance = Math.max(0, firstDashboardMoneyValue(account.current_balance) ?? 0);
      const available = firstDashboardMoneyValue(account.available_balance);
      const creditLimit =
        type === "credit" && available != null && balance > 0
          ? Math.max(0, balance + Math.max(0, available))
          : null;

      addPayoffDebtInput(map, {
        id: account.account_id,
        name: cleanDebtName(account.name, account.official_name, account.institution_name),
        lender: account.institution_name ?? null,
        last4: cleanLast4(account.mask),
        balance,
        apr: null,
        minimumDue: null,
        creditLimit,
        source: "plaid",
      });
    }

    return Array.from(map.values()).sort((left, right) => (right.apr ?? 0) - (left.apr ?? 0) || right.balance - left.balance);
  }, [debtRegistry, debtPayoffProjection, plaidAccounts, trackedDebtItems]);

  const payoffSimulationExtraAmount = Math.max(0, Number(payoffSimulationExtra) || 0);
  const payoffSimulationBalance = payoffDebts.reduce((sum, debt) => sum + debt.balance, 0);
  const payoffTotalLimit = payoffDebts.reduce((sum, debt) => sum + Math.max(0, debt.creditLimit ?? 0), 0);
  const payoffTotalMinimums = payoffDebts.reduce(
    (sum, debt) => sum + Math.max(0, debt.minimumDue ?? estimatedMinimumDue(debt.balance)),
    0
  );
  const hasEstimatedMinimums = payoffDebts.some((debt) => debt.balance > 0 && (debt.minimumDue == null || debt.minimumDue <= 0));
  const payoffWeightedApr = (() => {
    const weighted = payoffDebts.reduce((sum, debt) => {
      if (debt.apr == null || debt.apr <= 0) return sum;
      return sum + debt.balance * debt.apr;
    }, 0);
    const balanceWithApr = payoffDebts.reduce((sum, debt) => {
      if (debt.apr == null || debt.apr <= 0) return sum;
      return sum + debt.balance;
    }, 0);
    return balanceWithApr > 0 ? weighted / balanceWithApr : 0;
  })();
  const payoffAprIsPartial = payoffDebts.some((debt) => debt.balance > 0 && (debt.apr == null || debt.apr <= 0));
  const payoffBaselineSimulation = simulateDebtPortfolio(payoffDebts, 0);
  const payoffExtraSimulation = simulateDebtPortfolio(payoffDebts, payoffSimulationExtraAmount);
  const simulatedMonthsSaved =
    payoffBaselineSimulation.months != null && payoffExtraSimulation.months != null
      ? Math.max(0, payoffBaselineSimulation.months - payoffExtraSimulation.months)
      : null;
  const simulatedInterestSaved =
    payoffBaselineSimulation.interest != null && payoffExtraSimulation.interest != null
      ? Math.max(0, payoffBaselineSimulation.interest - payoffExtraSimulation.interest)
      : null;
  const payoffSimulatorProgress =
    payoffBaselineSimulation.months && simulatedMonthsSaved != null
      ? clamp01(simulatedMonthsSaved / payoffBaselineSimulation.months)
      : 0;
  const payoffPriorityDebt = payoffDebts[0] ?? null;
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
  const secondaryInsights = useMemo(
    () =>
      osInsights
        .filter((insight) => !isInstructionalInsight(`${insight.title || ""} ${insight.explanation || ""}`))
        .slice(0, 4),
    [osInsights]
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

    return sorted;
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

  const settingsFinancialOs = recordValue(settings, "financialOS");
  const settingsPaycheck = recordValue(settingsFinancialOs, "paycheck");
  const settingsMonthlyIncome = firstDashboardMoneyValue(
    recordValue(settingsPaycheck, "monthlyIncome"),
    recordValue(settingsPaycheck, "monthly_income")
  );
  const setupMonthlyIncome = firstDashboardMoneyValue(
    setupItems.find((item) => item.key === "monthly_income")?.value
  );
  const debtMinimumIncomeBase = firstDashboardMoneyValue(
    settingsMonthlyIncome,
    setupMonthlyIncome,
    discretionaryExplanation?.monthly_income_baseline,
    financialOsV2?.monthly_income_baseline,
    monthMetrics.monthIncome
  );
  const debtMinimumIncomePct =
    debtMinimumIncomeBase != null && debtMinimumIncomeBase > 0
      ? (payoffTotalMinimums / debtMinimumIncomeBase) * 100
      : null;
  const debtMinimumPaycheckLabel =
    debtMinimumIncomePct != null
      ? `${debtMinimumIncomePct.toFixed(debtMinimumIncomePct >= 10 ? 0 : 1)}% of paycheck`
      : null;
  const debtMinimumBurdenLabel =
    debtMinimumPaycheckLabel || "Set income to show debt %";
  const runwayFixedBillsMonthly = firstDashboardMoneyValue(
    financialOsV2?.bills_manual_obligations_total,
    (firstDashboardMoneyValue(osState?.upcoming_summary?.bill_total) ?? 0) +
      (firstDashboardMoneyValue(osState?.upcoming_summary?.manual_bill_total) ?? 0)
  );
  const runwayDebtMinimumsMonthly = firstDashboardMoneyValue(
    financialOsV2?.debt_minimums_cash,
    financialOsV2?.debt_minimums,
    nextBestDollar?.breakdown?.debt_minimums_total,
    payoffTotalMinimums
  );
  const runwayMonthlyEssentials = firstDashboardMoneyValue(
    monthlyEssentials,
    intelligenceContext?.monthly_essentials_total,
    runwayFixedBillsMonthly
  );
  const runwayOneMonthNeed =
    Math.max(0, runwayMonthlyEssentials ?? 0, runwayFixedBillsMonthly ?? 0) +
    Math.max(0, runwayDebtMinimumsMonthly ?? 0);
  const runwayTargetMonthCount = Math.max(0, runwayTargetMonths ?? settings.target_runway_months ?? 3);
  const runwayCalculatedTarget =
    runwayOneMonthNeed > 0
      ? runwayOneMonthNeed * runwayTargetMonthCount
      : firstDashboardMoneyValue(runwayReserveTarget) ?? 0;
  const manualRunwayCash = Math.max(0, firstDashboardMoneyValue(manualRunwayCashInput) ?? 0);
  const detectedRunwaySavings = Math.max(0, importedRunwaySavings) + Math.max(0, plaidRunwaySavings);
  const runwayBackendProtected = firstDashboardMoneyValue(runwayReserveCurrent) ?? 0;
  const runwayCashAfterObligations =
    financialOsCashTotal != null
      ? Math.max(0, Number(financialOsCashTotal || 0) - Number(protectedObligationsTotal || 0))
      : 0;
  const runwayAutoProtected = Math.max(
    0,
    runwayBackendProtected,
    detectedRunwaySavings,
    runwayCashAfterObligations
  );
  const runwayCurrentProtected = runwayAutoProtected + manualRunwayCash;
  const runwayCalculatedMonths =
    runwayOneMonthNeed > 0 ? Math.round((runwayCurrentProtected / runwayOneMonthNeed) * 10) / 10 : runwayMonths;
  const runwayGap = Math.max(0, runwayCalculatedTarget - runwayCurrentProtected);
  const runwayIncomeBase = debtMinimumIncomeBase;
  const runwayDiscretionaryProtection = firstDashboardMoneyValue(
    financialOsV2?.monthly_discretionary_cap,
    discretionaryExplanation?.discretionary_cap_amount,
    0
  );
  const runwayRepeatableSurplus =
    runwayIncomeBase != null && runwayIncomeBase > 0
      ? Math.max(0, runwayIncomeBase - runwayOneMonthNeed - Number(runwayDiscretionaryProtection || 0))
      : null;
  const runwaySuggestedMonthly =
    runwayGap <= 0 ? 0 : Math.min(runwayGap, Math.max(0, runwayRepeatableSurplus ?? 0));
  const runwayContributionPct =
    runwayIncomeBase != null && runwayIncomeBase > 0
      ? (runwaySuggestedMonthly / runwayIncomeBase) * 100
      : null;
  const runwayContributionLabel =
    runwayContributionPct != null
      ? `${runwayContributionPct.toFixed(runwayContributionPct >= 10 ? 0 : 1)}% of paycheck`
      : "Set income to show runway %";
  const runwayMonthsToTarget =
    runwayGap <= 0
      ? 0
      : runwaySuggestedMonthly > 0
      ? Math.ceil(runwayGap / runwaySuggestedMonthly)
      : null;
  const runwayForecastLabel =
    runwayGap <= 0
      ? "Target funded"
      : runwayMonthsToTarget != null
      ? `${formatMonths(runwayMonthsToTarget)} to target`
      : "Needs income surplus";

  const stageUi = useMemo(() => stageBadge(monthMetrics.stage), [monthMetrics.stage]);
  const spendAllowanceStatus =
    nextBestDollarLoadingState
      ? "Loading"
      : nextBestDollarUnavailable
      ? "Unavailable"
      : Number((safeToSpendToday ?? weeklySafeToSpend) || 0) <= 0
      ? "Paused"
      : "Available";
  const spendAllowanceMicrocopy =
    spendAllowanceStatus === "Paused"
      ? "Pause spending"
      : spendAllowanceStatus === "Available"
      ? "Available"
      : spendAllowanceStatus;
  const spendAllowanceTone =
    spendAllowanceStatus === "Available"
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
      : spendAllowanceStatus === "Paused"
      ? "border-red-500/20 bg-red-500/10 text-red-200"
      : "border-white/10 bg-white/5 text-zinc-300";
  const debtPriorityLabel =
    payoffPriorityDebt?.name
      ? `Priority: ${payoffPriorityDebt.name}`
      : debtCountdown?.priority_debt?.name
      ? `Priority: ${debtCountdown.priority_debt.name}`
      : projectedPayoffDebt?.name
      ? `Priority: ${projectedPayoffDebt.name}`
      : "Priority debt loading";
  const payoffWithExtraLabel =
    payoffExtraSimulation.months != null
      ? `${formatMonths(payoffExtraSimulation.months)} with extra`
      : payoffSimulationBalance > 0
      ? "Needs payment data"
      : "Add balances to simulate";
  const totalPosition = firstDashboardMoneyValue(
    (financialOsV2 as (FinancialOsV2 & { net_worth?: unknown }) | null)?.net_worth,
    (osState as (OsStateResponse & { net_worth?: unknown }) | null)?.net_worth,
    netWorthV1,
    financialOsCashTotal
  );
  const protectedFallback =
    protectedObligationsTotal != null || runwayReserveCurrent != null
      ? Number(protectedObligationsTotal || 0) + Number(runwayReserveCurrent || 0)
      : null;
  const protectedMoney = firstDashboardMoneyValue(
    financialOsV2?.protected_cash,
    protectedFallback,
    protectedObligationsTotal
  );
  const heroFiProgressLabel =
    fiProgressPercent != null
      ? `${Number(fiProgressPercent).toFixed(Number.isInteger(Number(fiProgressPercent)) ? 0 : 1)}%`
      : "Loading";
  const currentMonthIndex = cy * 12 + cm0;
  const trendRangeOptions: Array<{ value: TrendRange; label: string }> = [
    { value: "all", label: "All" },
    { value: "year", label: "Year" },
    { value: "3m", label: "3 months" },
    { value: "1m", label: "1 month" },
  ];
  const monthlyTrendRows =
    trendRange === "1m"
      ? []
      : trend.filter(([key]) => {
          const idx = monthIndexFromBucketKey(key);
          if (idx == null) return trendRange === "all";
          if (trendRange === "year") return idx >= currentMonthIndex - 11 && idx <= currentMonthIndex;
          if (trendRange === "3m") return idx >= currentMonthIndex - 2 && idx <= currentMonthIndex;
          return true;
        });
  const currentMonthTrendRows = weekly.buckets.map((value, index) => ({
    label: `W${index + 1}`,
    value: Math.max(0, Number(value) || 0),
  }));
  const monthlyTrendBars = monthlyTrendRows.map(([key, value]) => ({
    label: labelFromBucketKey(key),
    value: Math.max(0, Number(value) || 0),
  }));
  const dashboardTrendBars =
    trendRange === "1m"
      ? currentMonthTrendRows
      : monthlyTrendBars.length
      ? monthlyTrendBars
      : currentMonthTrendRows;
  const hasRealHeroTrendData = dashboardTrendBars.some((bar) => bar.value > 0);
  const demoTrendBars = [420, 680, 520, 790, 610, 930, 740, 1040].map((value, index) => ({
    label: trendRange === "1m" ? `W${(index % 4) + 1}` : `M${index + 1}`,
    value,
  }));
  const visibleHeroTrendBars = hasRealHeroTrendData
    ? dashboardTrendBars
    : demoTrendBars;
  const heroTrendMax = Math.max(1, ...visibleHeroTrendBars.map((bar) => bar.value));
  const dashboardTrendLabel = trendRange === "1m" ? "Current month spend" : "Spending trend";
  const heroTrendPeriodLabel =
    !hasRealHeroTrendData
      ? "Demo preview until real data is added"
      : trendRange === "all"
      ? `${monthlyTrendBars.length || trend.length || visibleHeroTrendBars.length} periods`
      : trendRangeOptions.find((option) => option.value === trendRange)?.label || "Trend";
  const advisorSummaryBullets = (
    advisorSummary?.reasoning?.length
      ? advisorSummary.reasoning
      : [advisorSummary?.one_liner || advisorSummary?.headline].filter(Boolean)
  )
    .map((item) => shortDashboardCopy(item, "", 120))
    .filter(Boolean)
    .slice(0, 3);

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
        {/* Money Clarity Hero */}
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.16),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.12),transparent_32%),#0E141C] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.28)] sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-xs font-medium uppercase text-zinc-500">Financial OS</div>
              <div className="mt-2 text-2xl font-semibold tracking-normal text-zinc-100 sm:text-3xl">
                Money clarity
              </div>
              <div className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">
                Total position is not fully spendable. Your OS separates protected money from spending money.
              </div>
            </div>

            {settings.show_financial_os_panels && (
              <div
                className={[
                  "inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs",
                  stageUi.cls,
                ].join(" ")}
                title="Your current Financial OS stage (V1 estimate)"
              >
                Stage: {stageUi.label}
              </div>
            )}
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-[#0B0F14]/80 p-4">
              <div className="text-xs text-zinc-400">Total position</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">
                {formatDashboardMoney(totalPosition, {
                  loading: osStateLoading,
                  unavailable: osStateUnavailable,
                })}
              </div>
              <div className="mt-2 text-[11px] text-zinc-500">Net worth when available</div>
            </div>

            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
              <div className="text-xs text-emerald-100/80">Spendable today</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">
                {formatDashboardMoney(safeToSpendToday, {
                  loading: nextBestDollarLoadingState,
                  unavailable: nextBestDollarUnavailable,
                })}
              </div>
              <div className="mt-2 text-[11px] text-emerald-100/70">{spendAllowanceMicrocopy}</div>
            </div>

            <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-4">
              <div className="text-xs text-sky-100/80">Protected</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">
                {formatDashboardMoney(protectedMoney, {
                  loading: osStateLoading,
                  unavailable: osStateUnavailable,
                })}
              </div>
              <div className="mt-2 text-[11px] text-sky-100/70">Bills, runway, reserves</div>
            </div>

            <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 p-4">
              <div className="text-xs text-violet-100/80">FI progress</div>
              <div className="mt-2 text-2xl font-semibold text-zinc-100">{heroFiProgressLabel}</div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-violet-200"
                  style={{ width: `${clamp01(Number(fiProgressPercent || 0) / 100) * 100}%` }}
                />
              </div>
            </div>
          </div>

          <div className="relative mt-5 overflow-hidden rounded-xl border border-white/10 bg-[#0B0F14]/70 p-4">
            {!hasRealHeroTrendData ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-6xl font-semibold tracking-[0.22em] text-white/[0.035] sm:text-7xl">
                DEMO
              </div>
            ) : null}
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-xs font-medium text-zinc-300">{dashboardTrendLabel}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{heroTrendPeriodLabel}</div>
              </div>
              <div className="flex flex-wrap gap-1 rounded-full border border-white/10 bg-white/5 p-1">
                {trendRangeOptions.map((option) => {
                  const active = trendRange === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setTrendRange(option.value)}
                      className={[
                        "rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
                        active
                          ? "bg-sky-400/20 text-sky-100"
                          : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                      ].join(" ")}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="relative mt-5 flex h-32 items-end gap-2 border-b border-white/10 pt-5">
              {visibleHeroTrendBars.map((bar, index) => (
                <div
                  key={`${bar.label}-${index}`}
                  className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
                  title={`${bar.label}: ${fmtMoney(bar.value)}`}
                >
                  <div className="text-[10px] font-medium text-zinc-300">
                    {fmtMoney(bar.value)}
                  </div>
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className={[
                        "w-full rounded-t-md border",
                        hasRealHeroTrendData
                          ? "border-sky-300/20 bg-sky-300/20"
                          : "border-emerald-200/20 bg-gradient-to-t from-emerald-300/20 to-sky-300/25",
                      ].join(" ")}
                      style={{ height: `${Math.max(14, (bar.value / heroTrendMax) * 100)}%` }}
                    />
                  </div>
                  <div className="w-full truncate text-center text-[9px] text-zinc-500">{bar.label}</div>
                </div>
              ))}
            </div>
            {!hasRealHeroTrendData ? (
              <div className="relative mt-3 text-[11px] text-zinc-500">
                Demo numbers show how the graph will look. Real activity replaces this after accounts, bills, debts, or activity data is added.
              </div>
            ) : null}
          </div>
        </section>

        {settings.show_financial_os_panels && (
          <div className="grid gap-3 xl:grid-cols-[0.92fr,1.08fr]">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Advisor Summary</div>
                  <div className="mt-1 text-xs text-zinc-400">Explains the OS readout.</div>
                </div>

                <span className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-medium uppercase ${advisorConfidenceTone(advisorSummary?.confidence)}`}>
                  {advisorConfidenceLabel(advisorSummary?.confidence)}
                </span>
              </div>

              {advisorSummary ? (
                <div className={`mt-4 rounded-xl border p-5 ${advisorSummaryTone(advisorSummary.tone)}`}>
                  <div className="text-xl font-semibold leading-tight text-zinc-100">
                    {shortDashboardCopy(advisorSummary.headline, "Financial OS summary", 82)}
                  </div>
                  <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-300">
                    {advisorSummaryBullets.map((item, index) => (
                      <li key={`${item}-${index}`} className="flex gap-3">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                  {osStateLoading ? "Advisor summary is loading." : "Advisor summary is not available yet."}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.18),transparent_35%),#0E141C] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02),0_24px_60px_rgba(8,15,25,0.35)]">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Decision Plan</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Your Financial OS turns the numbers into actions.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className={`inline-flex items-center rounded-full border px-3 py-1 font-medium uppercase tracking-[0.18em] ${decisionPlanStatusTone(decisionPlan?.status)}`}>
                    {decisionPlanStatusLabel(decisionPlan?.status)}
                  </span>
                  {decisionPlanActions.length ? (
                    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-zinc-200">
                      {decisionPlanActions.length} action{decisionPlanActions.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              </div>

              {decisionPlan ? (
                <>
                  <div className="mt-5 rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,197,94,0.14),transparent_42%),#0B0F14] p-5">
                    <div className="text-2xl font-semibold leading-tight text-zinc-100 sm:text-3xl">
                      {decisionPlanHeadline}
                    </div>
                    <div className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300">
                      {decisionPlanSummary}
                    </div>
                  </div>

                  <div className="mt-4 space-y-3">
                    {decisionPlanActions.length ? (
                      decisionPlanActions.map((action, index) => {
                        const actionMeta = decisionActionMeta(action);

                        return (
                          <div
                            key={`${action.type || "action"}-${index}`}
                            className="rounded-xl border border-white/10 bg-[#0B0F14] p-4"
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start gap-3">
                                  <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-xs font-semibold text-zinc-100">
                                    {index + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <div className="text-base font-semibold leading-6 text-zinc-100">
                                      {action.label || "Next action"}
                                    </div>
                                    {actionMeta ? (
                                      <div className="mt-1 text-sm text-zinc-300">{actionMeta}</div>
                                    ) : null}
                                    {action.reason ? (
                                      <div className="mt-2 text-sm leading-6 text-zinc-400">
                                        {shortDashboardCopy(action.reason, "", 130)}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </div>

                              {action.href ? (
                                <Link
                                  href={action.href}
                                  className="inline-flex shrink-0 items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-white/10"
                                >
                                  {standardCtaLabel(action.cta_label)}
                                </Link>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                        Decision actions are loading.
                      </div>
                    )}
                  </div>

                </>
              ) : (
                <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                  {osStateLoading ? "Decision plan is loading." : "Decision plan is not available yet."}
                </div>
              )}
            </div>
          </div>
        )}

        {settings.show_financial_os_panels && (
          <section>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-sm font-semibold text-zinc-100">OS Command Center</div>
                <div className="mt-1 text-xs text-zinc-400">
                  Spend, runway, debt, FI, and health in one cockpit.
                </div>
              </div>
              <div className="text-xs text-zinc-500">System status</div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-[#0E141C] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-zinc-400">STS / Spend allowance</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-100">
                      {formatDashboardMoney(safeToSpendToday ?? weeklySafeToSpend, {
                        loading: nextBestDollarLoadingState,
                        unavailable: nextBestDollarUnavailable,
                      })}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${spendAllowanceTone}`}>
                    {spendAllowanceStatus}
                  </span>
                </div>
                <div className="mt-3 text-xs leading-5 text-zinc-400">
                  {spendAllowanceMicrocopy}
                  {weeklySafeToSpend != null ? ` • Weekly ${fmtMoney(Number(weeklySafeToSpend || 0))}` : ""}
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className={`h-full rounded-full ${Number((safeToSpendToday ?? weeklySafeToSpend) || 0) > 0 ? "bg-emerald-200" : "bg-red-200"}`}
                    style={{ width: `${Number((safeToSpendToday ?? weeklySafeToSpend) || 0) > 0 ? 100 : 8}%` }}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0E141C] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">Stability</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-100">
                      {stabilityMeter?.value != null ? `${stabilityMeter.value}/100` : "Loading"}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${stabilityToneClass}`}>
                    {stabilityMeter?.label || "Loading"}
                  </span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-zinc-200"
                    style={{ width: `${clamp01(Number(stabilityMeter?.value || 0) / 100) * 100}%` }}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0E141C] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">Runway</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-100">
                      {runwayCalculatedMonths != null ? formatMonths(runwayCalculatedMonths) : "Loading"}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-sky-200">
                      Runway protected
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowRunwayDetails((open) => !open)}
                      className={
                        runwayContributionPct != null
                          ? "rounded-full border border-sky-400/20 bg-sky-400/10 px-2.5 py-1 text-[11px] font-medium text-sky-100 hover:bg-sky-400/15"
                          : "rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:bg-white/10"
                      }
                    >
                      {runwayContributionLabel}
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-1 text-xs leading-5 text-zinc-400">
                  <div>
                    {fmtMoney(runwayCurrentProtected)} protected - Target {fmtMoney(runwayCalculatedTarget)}
                  </div>
                  <div>
                    1 month need {fmtMoney(runwayOneMonthNeed)} - Target {formatMonths(runwayTargetMonthCount)}
                  </div>
                  <div>
                    Suggested {fmtMoney(runwaySuggestedMonthly)}/mo - {runwayForecastLabel}
                  </div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-sky-200"
                    style={{
                      width: `${clamp01(
                        runwayCalculatedTarget > 0
                          ? runwayCurrentProtected / runwayCalculatedTarget
                          : runwayCalculatedMonths != null && runwayTargetMonthCount > 0
                          ? Number(runwayCalculatedMonths || 0) / Number(runwayTargetMonthCount || 1)
                          : 0
                      ) * 100}%`,
                    }}
                  />
                </div>
                {showRunwayDetails ? (
                  <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14]/80 p-3 text-xs text-zinc-400">
                    <div className="font-medium text-zinc-100">Runway calculation</div>
                    <div className="mt-3 grid gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span>Essentials / fixed bills</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(Math.max(runwayMonthlyEssentials ?? 0, runwayFixedBillsMonthly ?? 0))}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Debt minimums</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(runwayDebtMinimumsMonthly ?? 0)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>One month survival need</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(runwayOneMonthNeed)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Target cash</span>
                        <span className="font-mono text-zinc-100">
                          {fmtMoney(runwayOneMonthNeed)} x {formatMonths(runwayTargetMonthCount)} = {fmtMoney(runwayCalculatedTarget)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Detected savings</span>
                        <span className="text-right font-mono text-zinc-100">
                          {fmtMoney(detectedRunwaySavings)}
                          <span className="block font-sans text-[10px] text-zinc-500">
                            Cash {fmtMoney(importedRunwaySavings)} - Plaid {fmtMoney(plaidRunwaySavings)}
                          </span>
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Manual runway cash</span>
                        <input
                          value={manualRunwayCashInput}
                          onChange={(event) => updateManualRunwayCashInput(event.target.value)}
                          inputMode="decimal"
                          className="w-28 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-right font-mono text-zinc-100 outline-none focus:border-sky-400/40"
                          placeholder="0"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Auto protected base</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(runwayAutoProtected)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Current protected runway</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(runwayCurrentProtected)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Gap left</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(runwayGap)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Repeatable monthly surplus</span>
                        <span className="font-mono text-zinc-100">
                          {runwayRepeatableSurplus != null ? fmtMoney(runwayRepeatableSurplus) : "Needs income"}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 leading-5 text-zinc-500">
                      Current protected runway uses detected savings from imported cash statements and Plaid savings accounts,
                      plus any manual runway cash entered here. Suggested monthly runway is the smaller of the remaining gap and repeatable surplus.
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0E141C] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">Debt-free Countdown</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-100">
                      {payoffExtraSimulation.months != null
                        ? formatMonths(payoffExtraSimulation.months)
                        : fmtMonthsCompact(debtCountdown?.estimated_months_remaining)}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-emerald-200">
                      Debt payoff active
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPayoffSimulator((open) => !open)}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-zinc-100 transition-colors hover:bg-white/10"
                    >
                      {showPayoffSimulator ? "Hide simulator" : "Simulate"}
                    </button>
                    <div
                      className={
                        debtMinimumPaycheckLabel
                          ? "rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-100"
                          : "rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-zinc-400"
                      }
                    >
                      {debtMinimumBurdenLabel}
                    </div>
                  </div>
                </div>
                <div className="mt-3 space-y-1 text-xs leading-5 text-zinc-400">
                  <div className="truncate">{debtPriorityLabel}</div>
                  <div className="truncate">{payoffWithExtraLabel}</div>
                  <div className="truncate">
                    Minimums: {fmtMoney(payoffTotalMinimums)}
                    {hasEstimatedMinimums ? " - some estimated" : ""}
                  </div>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-emerald-200"
                    style={{
                      width: `${Math.max(
                        payoffSimulationBalance > 0 ? 6 : 0,
                        clamp01(payoffTotalLimit > 0 ? payoffSimulationBalance / payoffTotalLimit : 0) * 100
                      )}%`,
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-zinc-500">
                  <span>Balance {fmtMoney(payoffSimulationBalance)}</span>
                  <span>{payoffTotalLimit > 0 ? `Limit ${fmtMoney(payoffTotalLimit)}` : "Limit not set"}</span>
                </div>
                {showPayoffSimulator ? (
                  <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14]/80 p-3">
                    <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-500">
                      Extra monthly amount
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="25"
                      value={payoffSimulationExtra}
                      onChange={(event) => setPayoffSimulationExtra(event.target.value)}
                      className="mt-2 w-full rounded-xl border border-white/10 bg-[#080C11] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-400/60"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[100, 200, 500].map((amount) => (
                        <button
                          key={amount}
                          type="button"
                          onClick={() => setPayoffSimulationExtra(String(amount))}
                          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/10"
                        >
                          ${amount}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-zinc-400">
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Balance</span>
                        <span className="font-mono text-zinc-100">{fmtMoney(payoffSimulationBalance)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Total limit</span>
                        <span className="font-mono text-zinc-100">
                          {payoffTotalLimit > 0 ? fmtMoney(payoffTotalLimit) : "Not set"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Avg APR</span>
                        <span className="font-mono text-zinc-100">
                          {payoffWeightedApr > 0 ? `${payoffWeightedApr.toFixed(1)}%${payoffAprIsPartial ? " partial" : ""}` : "Needs APR"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                        <span>Minimums</span>
                        <span className="font-mono text-zinc-100">
                          {fmtMoney(payoffTotalMinimums)}
                          {debtMinimumPaycheckLabel ? ` - ${debtMinimumPaycheckLabel}` : ""}
                        </span>
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="flex items-center justify-between gap-3 text-xs text-zinc-400">
                        <span>Potential speed-up</span>
                        <span className="text-zinc-200">
                          {simulatedMonthsSaved != null ? `${formatMonths(simulatedMonthsSaved)} faster` : "Needs payment data"}
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-emerald-200"
                          style={{ width: `${Math.max(6, payoffSimulatorProgress * 100)}%` }}
                        />
                      </div>
                      <div className="mt-3 space-y-1 text-xs text-zinc-400">
                        <div>
                          Interest saved:{" "}
                          <span className="font-mono text-zinc-100">
                            {simulatedInterestSaved != null ? fmtMoney(simulatedInterestSaved) : "Needs APR"}
                          </span>
                        </div>
                        <div>
                          Minimum-only payoff:{" "}
                          <span className="font-mono text-zinc-100">
                            {payoffBaselineSimulation.months != null ? formatMonths(payoffBaselineSimulation.months) : "Needs data"}
                          </span>
                        </div>
                        <div>
                          Simulated payoff:{" "}
                          <span className="font-mono text-zinc-100">
                            {payoffExtraSimulation.months != null ? formatMonths(payoffExtraSimulation.months) : "Needs data"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0E141C] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">FI progress</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-100">
                      {fiProgressPercent != null ? `${fiProgressPercent}%` : "Loading"}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full border border-violet-500/20 bg-violet-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-violet-200">
                    FI tracking
                  </span>
                </div>
                <div className="mt-3 text-xs leading-5 text-zinc-400">
                  {fiTargetAmount != null ? `Target ${fmtMoney(Number(fiTargetAmount || 0))}` : "Target loading"}
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-violet-200"
                    style={{ width: `${clamp01(Number(fiProgressPercent || 0) / 100) * 100}%` }}
                  />
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0E141C] p-4 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-zinc-400">Health score</div>
                    <div className="mt-2 text-2xl font-semibold text-zinc-100">
                      {healthScore != null ? `${healthScore}/100` : "Loading"}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${healthTone}`}>
                    Health score
                  </span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                  <div
                    className="h-full rounded-full bg-zinc-200"
                    style={{ width: `${clamp01(Number(healthScore || 0) / 100) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {settings.show_financial_os_panels && (
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-100">Upcoming Obligations</div>
                <div className="mt-1 text-xs text-zinc-400">
                  Next {upcomingWindowDays} days •{" "}
                  <span className="font-mono text-zinc-100">
                    {formatDashboardMoney(protectedObligationsTotal, {
                      loading: osStateLoading,
                      unavailable: osStateUnavailable,
                    })}
                  </span>{" "}
                  protected.
                </div>
              </div>

              <Link
                href="/bills"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                title="Open bills"
              >
                Open
              </Link>
            </div>

            {billsLoading && <div className="mt-4 text-sm text-zinc-400">Loading obligations...</div>}
            {billsErr && <div className="mt-4 text-sm text-red-400">Data unavailable. {billsErr}</div>}

            {!billsLoading && !billsErr && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-zinc-400">
                    <tr className="border-b border-white/10">
                      <th className="py-3 pr-4">obligation</th>
                      <th className="py-3 pr-4">due</th>
                      <th className="py-3 pr-0 text-right">amount</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-200">
                    {upcomingItemsList.slice(0, 5).map((b: UpcomingDashboardItem) => (
                      <tr key={b.id} className="border-b border-white/5 hover:bg-white/5">
                        <td className="py-3 pr-4">
                          <div className="text-zinc-100">{b.name}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {b.type === "debt_minimum"
                              ? "Debt minimum"
                              : b.type === "manual_bill"
                                ? "Manual obligation"
                                : (b.autopay ? "Autopay bill" : "Bill")}
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-zinc-300">{formatShortDate(b.due_date)}</td>
                        <td className="py-3 pr-0 text-right font-mono text-zinc-100">
                          {fmtMoney(Number(b.amount || 0))}
                        </td>
                      </tr>
                    ))}

                    {upcomingItemsList.length === 0 && (
                      <tr>
                        <td className="py-6 text-zinc-400" colSpan={3}>
                          No obligations due in the next {upcomingWindowDays} days.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-white/10"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
        </div>

        {/* ===== Collapsed details ===== */}
        {showDetails && settings.show_financial_os_panels && monthMetrics.alerts.length > 0 && (
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

        {showDetails && settings.show_financial_os_panels && (
          <div className="grid gap-3 xl:grid-cols-[1fr,0.85fr]">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Financial OS Setup</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Inputs behind trust and estimates.
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-xs">
                  <span className={`inline-flex items-center rounded-full border px-3 py-1 font-medium uppercase ${trustLevelTone(setupStatus?.trust_level)}`}>
                    Trust: {setupStatus?.trust_level || (osStateLoading ? "Loading" : "Unknown")}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-zinc-200">
                    {setupCompletedCount} / {setupTotalCount || 7}
                  </span>
                </div>
              </div>

              <div
                className={[
                  "mt-4 rounded-xl border p-4 text-sm",
                  (setupStatus?.trust_level || "").toLowerCase() === "high"
                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-100"
                    : (setupStatus?.trust_level || "").toLowerCase() === "medium"
                    ? "border-amber-500/20 bg-amber-500/10 text-amber-100"
                    : "border-red-500/20 bg-red-500/10 text-red-100",
                ].join(" ")}
              >
                {setupTrustCopy(setupStatus)}
              </div>

              <div className="mt-4 space-y-3">
                {setupItems.length ? (
                  setupItems.map((item) => {
                    const formattedValue = formatSetupItemValue(item);
                    return (
                      <div key={item.key || item.label} className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium text-zinc-100">{item.label}</div>
                              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase ${setupStatusTone(item.status)}`}>
                                {setupStatusLabel(item.status)}
                              </span>
                              {item.required ? (
                                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] uppercase text-zinc-400">
                                  Required
                                </span>
                              ) : null}
                            </div>
                            {formattedValue ? (
                              <div className="mt-2 text-sm font-medium text-zinc-200">{formattedValue}</div>
                            ) : null}
                            <div className="mt-2 text-sm leading-6 text-zinc-400">{item.reason}</div>
                          </div>

                          {item.href ? (
                            <Link
                              href={item.href}
                              className="inline-flex shrink-0 items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-100 hover:bg-white/10"
                            >
                              {standardCtaLabel(item.action)}
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                    {osStateLoading ? "Setup checklist is loading." : "Setup checklist is not available yet."}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Top Insights</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Low-noise OS signals.
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
                        <div className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase ${insightTone(insight.severity)}`}>
                          {insight.severity}
                        </div>
                      </div>
                      <div className="mt-2 text-xs leading-5 text-zinc-400">
                        {shortDashboardCopy(insight.explanation, "", 120)}
                      </div>
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

        {showDetails && settings.show_financial_os_panels && (
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
                  <div className="text-xs text-zinc-400">Discretionary spend allowance</div>
                  <div className="mt-1 text-lg font-semibold text-zinc-100">
                    {formatDashboardMoney(
                      safeToSpendToday,
                      { loading: nextBestDollarLoadingState, unavailable: nextBestDollarUnavailable }
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">Current period V2 non-essential spending cap</div>
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
                  <div className="text-xs text-zinc-400">Remaining discretionary allowance</div>
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
                    {runwayMonths != null ? formatMonths(runwayMonths) : "--"}
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">
                    {runwayReserveCurrent != null && runwayReserveTarget != null
                      ? `${fmtMoney(Number(runwayReserveCurrent || 0))} of ${fmtMoney(Number(runwayReserveTarget || 0))} protected${runwayTargetMonths != null ? ` • ${formatMonths(runwayTargetMonths)} target` : ""}`
                      : "Protected runway cash"}
                  </div>
                </div>
              </div>
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

          </div>
        )}

        {/* ===== Financial OS control panels ===== */}
        {showDetails && settings.show_financial_os_panels && (
          <div className="grid gap-3 lg:grid-cols-3">
            {/* Safe-to-Spend */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-100">
                  Discretionary Spend
                </div>
                <div className="text-xs text-zinc-400">Current period</div>
              </div>

              <div className="mt-4 text-4xl font-semibold text-zinc-100">
                {nextBestDollarLoadingState
                  ? "Loading"
                  : formatDashboardMoneyOrText(safeToSpendToday, "--")}
              </div>

              {hasFinancialOsV2 ? (
                <>
                  <div className={`mt-3 rounded-xl border px-4 py-3 text-sm font-medium ${discretionaryExplanationToneClass}`}>
                    {discretionaryExplanationHeadlineText}
                  </div>

                  {discretionaryExplanation?.reason_detail ? (
                    <div className="mt-3 text-sm leading-6 text-zinc-300">
                      {discretionaryExplanation.reason_detail}
                    </div>
                  ) : null}
                </>
              ) : stsStatus ? (
                <div className={`mt-3 inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${financialOsStatusTone(stsStatus.state)}`}>
                  {stsStatus.label || "STS status"}
                </div>
              ) : null}

              {!hasFinancialOsV2 && stsStatus?.detail ? (
                <div className="mt-3 text-xs leading-5 text-zinc-400">
                  {stsStatus.detail}
                </div>
              ) : null}

              {hasFinancialOsV2 ? (
                <>
                  <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                    <div className="text-sm font-semibold text-zinc-100">
                      {discretionaryExplanationIsZero ? "Why is my allowance $0?" : "Allowance breakdown"}
                    </div>
                    <div className="mt-3 space-y-2 text-sm text-zinc-400">
                      <div className="flex items-center justify-between gap-3">
                        <span>Monthly income baseline ({incomeSourceLabel(discretionaryExplanation?.income_source)})</span>
                        <span className="font-mono text-zinc-100">
                          {formatDashboardMoneyOrText(discretionaryExplanation?.monthly_income_baseline, "Not set")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>
                          {discretionaryCapPercentLabel
                            ? `Discretionary cap (${discretionaryCapPercentLabel})`
                            : "Discretionary cap"}
                        </span>
                        <span className="font-mono text-zinc-100">
                          {formatDashboardMoneyOrText(discretionaryExplanation?.discretionary_cap_amount, "Not set")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Month-to-date discretionary spend</span>
                        <span className="font-mono text-zinc-100">
                          {formatDashboardMoneyOrText(discretionaryExplanation?.month_to_date_spend, "$0")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Remaining monthly cap</span>
                        <span className="font-mono text-zinc-100">
                          {formatDashboardMoneyOrText(discretionaryExplanation?.remaining_monthly_cap, "$0")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Available cash after protections</span>
                        <span className="font-mono text-zinc-100">
                          {formatDashboardMoneyOrText(discretionaryExplanation?.available_cash_after_protection, "$0")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-2 text-zinc-200">
                        <span>Final allowance</span>
                        <span className="font-mono text-zinc-100">
                          {formatDashboardMoneyOrText(discretionaryExplanation?.final_allowance, "$0")}
                        </span>
                      </div>
                    </div>
                  </div>

                </>
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
                    <span>Discretionary spend allowance</span>
                    <span className="font-mono text-zinc-100">{formatDashboardMoney(safeToSpendToday)}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {safeToSpendFormulaLabel}
                  </div>
                </div>
              ) : nextBestDollarUnavailable ? (
                <div className="mt-2 text-xs text-zinc-500">
                  Allowance data could not be loaded right now.
                </div>
              ) : (
                <div className="mt-2 text-xs text-zinc-500">
                  Backend STS breakdown is loading.
                </div>
              )}

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
            {/*
            Legacy Upcoming Obligations card removed.
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
      title="Open bills"
    >
      Open
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
            */}
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
                    {formatMonths(settings.target_runway_months || 0)}
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

        {showDetails && settings.show_financial_os_panels && (
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
                  Open
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
                          <td className="py-2 pr-3 text-zinc-400">
                            {formatShortDate(txn.posted_date || txn.authorized_date)}
                          </td>
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

        {showDetails && (
        <>
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
                    <td className="py-3 pr-4 text-zinc-300">{formatShortDate(s.due_date)}</td>
                    <td className="py-3 pr-4 text-zinc-300">
                      {fmtMoney(s.new_balance)}
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">{s.apr}%</td>
                    <td className="py-3 pr-0 text-right">
                      <Link
                        href={`/statements/${encodeURIComponent(s.statement_code)}`}
                        className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                      >
                        Open
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
              Open
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
                        Open
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
        </>
        )}
      </div>
    </AppShell>
  );
}
