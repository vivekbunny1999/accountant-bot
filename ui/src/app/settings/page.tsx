"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PasswordGuidance } from "@/components/auth/PasswordGuidance";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  createDebt,
  createPlaidLinkToken,
  Debt,
  confirmEmailVerification,
  exchangePlaidPublicToken,
  FinancialOsSetupItem,
  FinancialOsSetupStatus,
  getOsState,
  getPasswordPolicy,
  getUserSettings,
  listGoals,
  getPlaidAccounts,
  getPlaidTransactions,
  listDebts,
  PasswordPolicy,
  PlaidAccountSummary,
  PlaidItemSummary,
  PlaidTransactionSummary,
  saveUserSettings,
  requestEmailVerification,
  syncPlaidData,
  unlinkPlaidItem,
  upsertGoal,
  updateDebt,
} from "@/lib/api";
import { FALLBACK_PASSWORD_POLICY, validatePasswordAgainstPolicy } from "@/lib/password-policy";

type PlaidLinkOnSuccessMetadata = {
  institution?: { name?: string | null } | null;
  accounts?: Array<{
    id?: string;
    name?: string;
    mask?: string | null;
    subtype?: string | null;
    type?: string | null;
  }>;
};

type PlaidLinkOnExitError = {
  error_message?: string;
};

type PlaidLinkHandler = {
  open: () => void;
  destroy?: () => void;
};

type PlaidGlobal = {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: PlaidLinkOnSuccessMetadata) => void | Promise<void>;
    onExit?: (error: PlaidLinkOnExitError | null) => void;
  }) => PlaidLinkHandler;
};

declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

const PLAID_LINK_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
let plaidScriptPromise: Promise<void> | null = null;

function formatMoney(value?: number | null) {
  const amount = Number(value ?? 0);
  return `$${amount.toFixed(2)}`;
}

function formatDateTime(value?: string | null) {
  if (!value) return "not yet";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString();
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

function formatSetupItemValue(item?: FinancialOsSetupItem | null) {
  if (!item || item.value == null || item.value === "") return null;
  if (typeof item.value === "string") return item.value;

  switch (item.key) {
    case "monthly_income":
      return `${formatMoney(item.value)}/month`;
    case "fixed_essentials":
      return `${formatMoney(item.value)}/month`;
    case "runway_target":
      return `${Number(item.value).toFixed(Number.isInteger(item.value) ? 0 : 1)} months`;
    case "fi_target":
      return formatMoney(item.value);
    case "debt_registry":
      return `${item.value} ${Number(item.value) === 1 ? "debt" : "debts"}`;
    default:
      return String(item.value);
  }
}

function loadPlaidLinkScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Plaid Link can only run in the browser."));
  }

  if (window.Plaid) return Promise.resolve();
  if (plaidScriptPromise) return plaidScriptPromise;

  plaidScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Plaid Link.")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Plaid Link."));
    document.body.appendChild(script);
  });

  return plaidScriptPromise;
}

/**
 * SETTINGS PAGE (single-file, copy/paste)
 * - Zero cognitive load layout: 2-column on desktop, stacked on mobile
 * - Auto-save to localStorage (works immediately)
 * - Financial OS controls:
 *   - Safe-to-Spend buffer rule
 *   - Stage targets
 *   - Paycheck split preferences (bills/spend/extra)
 *   - Debt strategy preferences (snowball/avalanche/Next Best Dollar style knobs)
 *   - Alerts & nudges
 * - Plus practical app settings:
 *   - Profile / Money calendar
 *   - Category rules import/export (same signature rules key you used)
 *   - Data/import behaviors
 *   - Privacy & reset
 */

type Stage =
  | "Crisis"
  | "Stabilize"
  | "Attack Debt"
  | "Build Security"
  | "Build Wealth";

type DebtStrategy = "Avalanche" | "Snowball" | "Hybrid (Next Best Dollar)";

type PaycheckCadence = "Weekly" | "Biweekly" | "Semimonthly" | "Monthly";

type Currency = "USD" | "INR" | "EUR" | "GBP";

type AlertChannel = "InApp" | "Email" | "Push";

type SettingsModel = {
  version: 1;

  /** 1) Profile / Basics */
  profile: {
    homeCurrency: Currency;
    timezone: string; // just display; browser is truth for now
    monthStartsOn: 1 | 2 | 3 | 4 | 5 | 6 | 7; // 1=Mon ... 7=Sun (ISO style)
    weekStartLabel: "Monday" | "Sunday";
    showCents: boolean;
    compactNumbers: boolean; // 12.3k etc
  };

  /** 2) Category rules (shared with statement page key) */
  categories: {
    rulesKey: string; // localStorage key used in your app
    autoCategorizeNew: boolean;
    treatPaymentsAsCredit: boolean;
    treatRefundsAsCredit: boolean;
  };

  /** 3) Financial OS Engine Controls */
  financialOS: {
    /** Safe-to-Spend buffer rule */
    sts: {
      enabled: boolean;
      bufferMode: "Percent" | "Fixed";
      bufferPercent: number; // 0..50
      bufferFixed: number; // dollars
      neverNegativeSTS: boolean; // clamp at 0
      includeUpcomingBillsWindowDays: number; // forecast horizon
    };

    /** Stage targets (thresholds that define the stage classification) */
    stageTargets: {
      runwayMonthsCrisis: number; // below => Crisis
      runwayMonthsStabilize: number; // below => Stabilize
      runwayMonthsSecurityGoal: number; // Build Security target
      utilizationRiskPct: number; // credit utilization warning
      debtCostRateHighPct: number; // weighted debt cost rate "high"
    };

    /** Paycheck split preferences */
    paycheck: {
      monthlyIncome: number;
      cadence: PaycheckCadence;
      paydayHint: string; // "Fri" / "Every other Wed" etc (free text)
      splitMode: "ThreeCaps" | "ManualBuckets";
      threeCaps: {
        essentialsCapPct: number; // E cap
        discretionaryCapPct: number; // D cap
        surplusCapPct: number; // S cap
      };
      manualBuckets: {
        billsPct: number;
        spendPct: number;
        extraPct: number;
      };
      rounding: "None" | "Nearest1" | "Nearest5" | "Nearest10";
    };

    /** Debt preferences */
    debt: {
      strategy: DebtStrategy;
      allowHybridRebalance: boolean; // for Next Best Dollar style
      minExtraPayment: number; // smallest extra payment we consider meaningful
      keepCardsOpen: boolean; // preference only
      targetUtilizationPct: number; // e.g. 10-30
      nextBestDollar: {
        enabled: boolean;
        protectMinimums: boolean;
        protectBillsFirst: boolean;
        protectSTSBuffer: boolean;
      };
    };

    /** Savings preferences */
    savings: {
      emergencyFundGoalMonths: number; // e.g. 3
      emergencyFundPriority: "High" | "Medium" | "Low";
      sinkingFundsEnabled: boolean;
      defaultSinkingFunds: Array<{ name: string; monthly: number }>;
    };

    /** Scoreboards (what user sees and what matters) */
    scoreboards: {
      showFinancialHealthScore: boolean;
      showStabilityMeter: boolean;
      showDebtFreeCountdown: boolean;
      showFIProgress: boolean;
      streaksEnabled: boolean;
    };

    /** Explicit checklist confirmations */
    setupConfirmations: {
      monthlyIncomeConfirmed: boolean;
      paycheckCadenceConfirmed: boolean;
      runwayTargetConfirmed: boolean;
      debtStrategyConfirmed: boolean;
    };
  };

  /** 4) Alerts / Nudges */
  alerts: {
    enabled: boolean;
    channels: AlertChannel[];
    frequency: "Daily" | "Weekly" | "Monthly";
    quietHours: { start: string; end: string }; // "22:00" - "07:00"
    triggers: {
      stsNegative: boolean;
      runwayBelowTarget: boolean;
      utilizationAboveTarget: boolean;
      largeUnusualSpend: boolean;
      missedMinimumsRisk: boolean;
      paycheckDetected: boolean;
    };
    largeSpendThreshold: number; // e.g. 150
  };

  /** 5) Imports / Data behaviors */
  data: {
    autoRefreshOnOpen: boolean;
    showDebugPanel: boolean;
    keepRawPdfText: boolean; // MVP preference
    dedupeTransactions: boolean;
    dedupeWindowDays: number;
  };

  /** 6) Privacy / Export */
  privacy: {
    maskMerchantInScreenshots: boolean;
    hideLast4ByDefault: boolean;
  };
};

const SETTINGS_KEY = "accountantbot_settings_v1";
const RULES_KEY_DEFAULT = "accountantbot_category_rules_v1";

/** ------- helpers ------- */
function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function parseNum(v: string, fallback: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function fmtPct(n: number) {
  return `${Math.round(n)}%`;
}

function safeJsonParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function downloadJson(filename: string, obj: any) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fileToText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed reading file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsText(file);
  });
}

function emailVerificationMeta(status?: string, configured?: boolean) {
  if (!configured) {
    return {
      label: "Verification not configured",
      tone: "border-white/10 bg-white/5 text-zinc-300",
      detail: "This environment does not have real email verification or resend flow configured yet.",
    };
  }
  if (status === "verified") {
    return {
      label: "Verified",
      tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
      detail: "This account has a verified email on record.",
    };
  }
  if (status === "not_verified") {
    return {
      label: "Not verified",
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-200",
      detail: "Email verification is required, but this address has not been verified yet.",
    };
  }
  return {
    label: "Not verified",
    tone: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    detail: "Email verification is supported, but this address has not been verified yet.",
  };
}

/** ------- defaults ------- */
function defaultSettings(): SettingsModel {
  return {
    version: 1,
    profile: {
      homeCurrency: "USD",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Detroit",
      monthStartsOn: 1,
      weekStartLabel: "Monday",
      showCents: true,
      compactNumbers: true,
    },
    categories: {
      rulesKey: RULES_KEY_DEFAULT,
      autoCategorizeNew: true,
      treatPaymentsAsCredit: true,
      treatRefundsAsCredit: true,
    },
    financialOS: {
      sts: {
        enabled: true,
        bufferMode: "Percent",
        bufferPercent: 10,
        bufferFixed: 200,
        neverNegativeSTS: true,
        includeUpcomingBillsWindowDays: 21,
      },
      stageTargets: {
        runwayMonthsCrisis: 0.5,
        runwayMonthsStabilize: 1.5,
        runwayMonthsSecurityGoal: 3,
        utilizationRiskPct: 30,
        debtCostRateHighPct: 18,
      },
      paycheck: {
        monthlyIncome: 0,
        cadence: "Weekly",
        paydayHint: "Friday",
        splitMode: "ThreeCaps",
        threeCaps: {
          essentialsCapPct: 60,
          discretionaryCapPct: 25,
          surplusCapPct: 15,
        },
        manualBuckets: {
          billsPct: 55,
          spendPct: 30,
          extraPct: 15,
        },
        rounding: "Nearest5",
      },
      debt: {
        strategy: "Hybrid (Next Best Dollar)",
        allowHybridRebalance: true,
        minExtraPayment: 25,
        keepCardsOpen: true,
        targetUtilizationPct: 10,
        nextBestDollar: {
          enabled: true,
          protectMinimums: true,
          protectBillsFirst: true,
          protectSTSBuffer: true,
        },
      },
      savings: {
        emergencyFundGoalMonths: 3,
        emergencyFundPriority: "High",
        sinkingFundsEnabled: true,
        defaultSinkingFunds: [
          { name: "Car maintenance", monthly: 60 },
          { name: "Gifts", monthly: 25 },
          { name: "Travel", monthly: 50 },
        ],
      },
      scoreboards: {
        showFinancialHealthScore: true,
        showStabilityMeter: true,
        showDebtFreeCountdown: true,
        showFIProgress: true,
        streaksEnabled: true,
      },
      setupConfirmations: {
        monthlyIncomeConfirmed: false,
        paycheckCadenceConfirmed: false,
        runwayTargetConfirmed: false,
        debtStrategyConfirmed: false,
      },
    },
    alerts: {
      enabled: true,
      channels: ["InApp"],
      frequency: "Weekly",
      quietHours: { start: "22:00", end: "07:00" },
      triggers: {
        stsNegative: true,
        runwayBelowTarget: true,
        utilizationAboveTarget: true,
        largeUnusualSpend: true,
        missedMinimumsRisk: true,
        paycheckDetected: true,
      },
      largeSpendThreshold: 150,
    },
    data: {
      autoRefreshOnOpen: true,
      showDebugPanel: false,
      keepRawPdfText: false,
      dedupeTransactions: true,
      dedupeWindowDays: 7,
    },
    privacy: {
      maskMerchantInScreenshots: true,
      hideLast4ByDefault: false,
    },
  };
}

const SETTINGS_SECTION_ALIASES: Record<string, string> = {
  "setup-income": "income-paycheck",
  "setup-runway": "runway-target",
  "setup-fi-target": "fi-target",
  "setup-debt-strategy": "debt-strategy",
};

function normalizeSettings(input?: Partial<SettingsModel> | null): SettingsModel {
  const defaults = defaultSettings();
  const source = (input && typeof input === "object" ? input : {}) as Partial<SettingsModel> & Record<string, any>;
  const sourceFinancialOs = (source.financialOS || {}) as Record<string, any>;
  const sourceAlerts = (source.alerts || {}) as Record<string, any>;

  return {
    ...defaults,
    ...source,
    profile: { ...defaults.profile, ...(source.profile || {}) },
    categories: { ...defaults.categories, ...(source.categories || {}) },
    financialOS: {
      ...defaults.financialOS,
      ...sourceFinancialOs,
      sts: { ...defaults.financialOS.sts, ...(sourceFinancialOs.sts || {}) },
      stageTargets: { ...defaults.financialOS.stageTargets, ...(sourceFinancialOs.stageTargets || {}) },
      paycheck: {
        ...defaults.financialOS.paycheck,
        ...(sourceFinancialOs.paycheck || {}),
        threeCaps: {
          ...defaults.financialOS.paycheck.threeCaps,
          ...(sourceFinancialOs.paycheck?.threeCaps || {}),
        },
        manualBuckets: {
          ...defaults.financialOS.paycheck.manualBuckets,
          ...(sourceFinancialOs.paycheck?.manualBuckets || {}),
        },
      },
      debt: {
        ...defaults.financialOS.debt,
        ...(sourceFinancialOs.debt || {}),
        nextBestDollar: {
          ...defaults.financialOS.debt.nextBestDollar,
          ...(sourceFinancialOs.debt?.nextBestDollar || {}),
        },
      },
      savings: {
        ...defaults.financialOS.savings,
        ...(sourceFinancialOs.savings || {}),
        defaultSinkingFunds: Array.isArray(sourceFinancialOs.savings?.defaultSinkingFunds)
          ? sourceFinancialOs.savings.defaultSinkingFunds
          : defaults.financialOS.savings.defaultSinkingFunds,
      },
      scoreboards: { ...defaults.financialOS.scoreboards, ...(sourceFinancialOs.scoreboards || {}) },
      setupConfirmations: {
        ...defaults.financialOS.setupConfirmations,
        ...(sourceFinancialOs.setupConfirmations || {}),
      },
    },
    alerts: {
      ...defaults.alerts,
      ...sourceAlerts,
      channels: Array.isArray(sourceAlerts.channels) ? sourceAlerts.channels : defaults.alerts.channels,
      quietHours: { ...defaults.alerts.quietHours, ...(sourceAlerts.quietHours || {}) },
      triggers: { ...defaults.alerts.triggers, ...(sourceAlerts.triggers || {}) },
    },
    data: { ...defaults.data, ...(source.data || {}) },
    privacy: { ...defaults.privacy, ...(source.privacy || {}) },
  };
}

type SetupSaveKey = "monthly_income" | "paycheck_cadence" | "runway_target" | "debt_strategy";

type SetupSaveState = {
  busy: boolean;
  status: string | null;
  error: string | null;
};

const INITIAL_SETUP_SAVE_STATE: Record<SetupSaveKey, SetupSaveState> = {
  monthly_income: { busy: false, status: null, error: null },
  paycheck_cadence: { busy: false, status: null, error: null },
  runway_target: { busy: false, status: null, error: null },
  debt_strategy: { busy: false, status: null, error: null },
};

/** ------- tiny UI atoms ------- */
function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-zinc-100">{title}</div>
        {subtitle ? (
          <div className="mt-1 text-xs text-zinc-400">{subtitle}</div>
        ) : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
      {children}
    </div>
  );
}

function CollapsibleCard({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div id={id} className="scroll-mt-24 rounded-2xl border border-white/10 bg-[#0E141C] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-sm font-semibold text-zinc-100">{title}</div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
          aria-expanded={open}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <>
          {subtitle ? <div className="mt-1 text-xs text-zinc-400">{subtitle}</div> : null}
          <Divider />
          {children}
        </>
      ) : null}
    </div>
  );
}

function Divider() {
  return <div className="my-4 h-px bg-white/10" />;
}

function DisclosureSection({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className="rounded-xl border border-white/10 bg-black/20"
    >
      <summary className="cursor-pointer list-none px-4 py-3">
        <div className="text-sm font-medium text-zinc-100">{title}</div>
        {subtitle ? <div className="mt-1 text-xs text-zinc-400">{subtitle}</div> : null}
      </summary>
      <div className="border-t border-white/10 px-4 py-4">{children}</div>
    </details>
  );
}

function Toggle({
  label,
  desc,
  value,
  onChange,
}: {
  label: string;
  desc?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4 hover:bg-white/5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-100">{label}</div>
        {desc ? <div className="mt-1 text-xs text-zinc-400">{desc}</div> : null}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={[
          "h-7 w-12 rounded-full border transition",
          value
            ? "border-emerald-500/30 bg-emerald-500/20"
            : "border-white/10 bg-white/5",
        ].join(" ")}
        aria-pressed={value}
      >
        <div
          className={[
            "h-6 w-6 translate-x-0 rounded-full bg-white/80 transition",
            value ? "translate-x-5" : "translate-x-0",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

function Input({
  label,
  desc,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "password" | "email";
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
      <div className="text-sm font-medium text-zinc-100">{label}</div>
      {desc ? <div className="mt-1 text-xs text-zinc-400">{desc}</div> : null}
      <input
        type={type}
        className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function Select({
  label,
  desc,
  value,
  onChange,
  options,
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
      <div className="text-sm font-medium text-zinc-100">{label}</div>
      {desc ? <div className="mt-1 text-xs text-zinc-400">{desc}</div> : null}
      <select
        className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NumberInput({
  label,
  desc,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
}: {
  label: string;
  desc?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-100">{label}</div>
          {desc ? (
            <div className="mt-1 text-xs text-zinc-400">{desc}</div>
          ) : null}
        </div>
        {suffix ? (
          <div className="text-xs text-zinc-400">{suffix}</div>
        ) : null}
      </div>
      <input
        type="number"
        className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseNum(e.target.value, value))}
      />
    </div>
  );
}

function ChipGroup<T extends string>({
  label,
  desc,
  value,
  onChange,
  options,
}: {
  label: string;
  desc?: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ label: string; value: T }>;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
      <div className="text-sm font-medium text-zinc-100">{label}</div>
      {desc ? <div className="mt-1 text-xs text-zinc-400">{desc}</div> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={[
                "rounded-full border px-3 py-1 text-xs transition",
                active
                  ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
                  : "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10",
              ].join(" ")}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type DebtFormState = {
  name: string;
  lender: string;
  last4: string;
  balance: string;
  apr: string;
  minimum_due: string;
  due_day: string;
  due_date: string;
  credit_limit: string;
  active: boolean;
};

function emptyDebtForm(): DebtFormState {
  return {
    name: "",
    lender: "",
    last4: "",
    balance: "",
    apr: "",
    minimum_due: "",
    due_day: "",
    due_date: "",
    credit_limit: "",
    active: true,
  };
}

function debtToForm(debt?: Partial<Debt> | null): DebtFormState {
  return {
    name: debt?.name ?? "",
    lender: debt?.lender ?? "",
    last4: debt?.last4 ?? "",
    balance: debt?.balance != null ? String(debt.balance) : "",
    apr: debt?.apr != null ? String(debt.apr) : "",
    minimum_due: debt?.minimum_due != null ? String(debt.minimum_due) : "",
    due_day: debt?.due_day != null ? String(debt.due_day) : "",
    due_date: debt?.due_date ?? "",
    credit_limit: debt?.credit_limit != null ? String(debt.credit_limit) : "",
    active: debt?.active ?? true,
  };
}

function toNullableFloat(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function normalizeDebtPayload(form: DebtFormState, user_id: string) {
  return {
    user_id,
    kind: "credit_card",
    name: form.name.trim() || "Debt",
    lender: form.lender.trim() || null,
    last4: form.last4.trim() || null,
    balance: toNullableFloat(form.balance) ?? 0,
    apr: toNullableFloat(form.apr),
    minimum_due: toNullableFloat(form.minimum_due),
    due_day: toNullableInt(form.due_day),
    due_date: form.due_date.trim() || null,
    credit_limit: toNullableFloat(form.credit_limit),
    active: form.active,
  };
}

function DebtFormFields({
  form,
  onChange,
}: {
  form: DebtFormState;
  onChange: (next: DebtFormState) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Debt name"
          desc="Card or loan name shown across the app."
          value={form.name}
          onChange={(value) => onChange({ ...form, name: value })}
          placeholder="Venture"
        />
        <Input
          label="Lender"
          desc="Issuer or lender name."
          value={form.lender}
          onChange={(value) => onChange({ ...form, lender: value })}
          placeholder="Capital One"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          label="Last 4"
          desc="Optional masked identifier."
          value={form.last4}
          onChange={(value) => onChange({ ...form, last4: value })}
          placeholder="4399"
        />
        <Input
          label="Balance"
          desc="Current balance."
          value={form.balance}
          onChange={(value) => onChange({ ...form, balance: value })}
          placeholder="812.05"
        />
        <Input
          label="APR"
          desc="Interest rate percent."
          value={form.apr}
          onChange={(value) => onChange({ ...form, apr: value })}
          placeholder="28.24"
        />
        <Input
          label="Minimum due"
          desc="Monthly minimum payment."
          value={form.minimum_due}
          onChange={(value) => onChange({ ...form, minimum_due: value })}
          placeholder="25"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          label="Due day"
          desc="Monthly fallback day (1-31)."
          value={form.due_day}
          onChange={(value) => onChange({ ...form, due_day: value })}
          placeholder="2"
        />
        <Input
          label="Due date"
          desc="Optional exact date for current cycle."
          value={form.due_date}
          onChange={(value) => onChange({ ...form, due_date: value })}
          placeholder="2026-05-02"
        />
        <Input
          label="Credit limit"
          desc="Used for utilization when known."
          value={form.credit_limit}
          onChange={(value) => onChange({ ...form, credit_limit: value })}
          placeholder="5000"
        />
      </div>

      <Toggle
        label="Active debt"
        desc="Inactive debts stay in history but won't drive planning."
        value={form.active}
        onChange={(value) => onChange({ ...form, active: value })}
      />
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { user, bootstrap, updateProfile, changePassword, refresh, logout } = useAuth();
  const USER_ID = user?.id ?? "";
  const [settings, setSettings] = useState<SettingsModel>(() => defaultSettings());
  const [loaded, setLoaded] = useState(false);
  const [passwordPolicy, setPasswordPolicy] = useState<PasswordPolicy>(FALLBACK_PASSWORD_POLICY);
  const [accountForm, setAccountForm] = useState({
    display_name: "",
    username: "",
    email: "",
    current_password: "",
  });
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<string | null>(null);
  const [securityForm, setSecurityForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
  });
  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securityStatus, setSecurityStatus] = useState<string | null>(null);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [debtsLoading, setDebtsLoading] = useState(false);
  const [debtError, setDebtError] = useState<string | null>(null);
  const [debtStatus, setDebtStatus] = useState<string | null>(null);
  const [showCreateDebt, setShowCreateDebt] = useState(false);
  const [newDebtForm, setNewDebtForm] = useState<DebtFormState>(() => emptyDebtForm());
  const [editingDebtId, setEditingDebtId] = useState<number | null>(null);
  const [editingDebtForm, setEditingDebtForm] = useState<DebtFormState>(() => emptyDebtForm());
  const [savingDebt, setSavingDebt] = useState(false);
  const [plaidBusy, setPlaidBusy] = useState(false);
  const [plaidError, setPlaidError] = useState<string | null>(null);
  const [plaidStatus, setPlaidStatus] = useState<string | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccountSummary[]>([]);
  const [plaidItems, setPlaidItems] = useState<PlaidItemSummary[]>([]);
  const [selectedPlaidItemId, setSelectedPlaidItemId] = useState("");
  const [plaidTransactions, setPlaidTransactions] = useState<PlaidTransactionSummary[]>([]);
  const [plaidCashContribution, setPlaidCashContribution] = useState(0);
  const [plaidDuplicateCount, setPlaidDuplicateCount] = useState(0);
  const [setupStatus, setSetupStatus] = useState<FinancialOsSetupStatus | null>(null);
  const [setupSaveState, setSetupSaveState] = useState<Record<SetupSaveKey, SetupSaveState>>(INITIAL_SETUP_SAVE_STATE);
  const [fiTargetInput, setFiTargetInput] = useState("");
  const [fiTargetStatus, setFiTargetStatus] = useState<string | null>(null);
  const [fiTargetError, setFiTargetError] = useState<string | null>(null);

  // load persisted
  useEffect(() => {
    const s = safeJsonParse<SettingsModel>(localStorage.getItem(SETTINGS_KEY));
    if (s?.version === 1) {
      setSettings(normalizeSettings(s));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    getPasswordPolicy()
      .then((res) => {
        if (res?.policy) setPasswordPolicy(res.policy);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setAccountForm({
      display_name: user?.display_name || "",
      username: user?.username || "",
      email: user?.email || "",
      current_password: "",
    });
  }, [user?.display_name, user?.username, user?.email]);

  useEffect(() => {
    if (!USER_ID) return;
    let cancelled = false;

    (async () => {
      try {
        const remote = await getUserSettings();
        if (cancelled) return;
        if (remote?.settings && Object.keys(remote.settings).length > 0) {
          setSettings(normalizeSettings(remote.settings as SettingsModel));
        }
        if (remote?.category_rules && Object.keys(remote.category_rules).length > 0) {
          const key = (remote.settings?.categories?.rulesKey as string) || RULES_KEY_DEFAULT;
          localStorage.setItem(key, JSON.stringify(remote.category_rules));
        }
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [USER_ID]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const scrollToHashSection = () => {
      const rawHash = window.location.hash.replace(/^#/, "");
      if (!rawHash) return;
      const targetId = SETTINGS_SECTION_ALIASES[rawHash] || rawHash;
      const target = document.getElementById(targetId);
      if (!target) return;
      const top = Math.max(target.getBoundingClientRect().top + window.scrollY - 96, 0);
      window.scrollTo({ top, behavior: "smooth" });
    };

    const timer = window.setTimeout(scrollToHashSection, 80);
    window.addEventListener("hashchange", scrollToHashSection);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", scrollToHashSection);
    };
  }, []);

  useEffect(() => {
    if (!USER_ID) return;
    let cancelled = false;

    (async () => {
      try {
        const goals = await listGoals();
        if (cancelled) return;
        const fiGoal = (goals || []).find((goal) => goal.key === "fi_target");
        setFiTargetInput(fiGoal?.value != null && Number(fiGoal.value) > 0 ? String(fiGoal.value) : "");
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, [USER_ID]);

  // persist on change
  useEffect(() => {
    if (!loaded || !USER_ID) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    const rulesKey = settings.categories.rulesKey || RULES_KEY_DEFAULT;
    const rules = safeJsonParse<Record<string, any>>(localStorage.getItem(rulesKey)) ?? {};
    saveUserSettings({ settings, category_rules: rules }).catch(() => {});
  }, [settings, loaded, USER_ID]);

  async function refreshSetupChecklist() {
    if (!USER_ID) return null;
    const osState = await getOsState({ user_id: USER_ID, window_days: 21 });
    setSetupStatus(osState?.setup_status || osState?.financial_os_v2?.setup_status || null);
    return osState;
  }

  async function persistSettingsSnapshot(nextSettings: SettingsModel) {
    const normalized = normalizeSettings(nextSettings);
    const rulesKey = normalized.categories.rulesKey || RULES_KEY_DEFAULT;
    const rules = safeJsonParse<Record<string, any>>(localStorage.getItem(rulesKey)) ?? {};
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
    const saved = await saveUserSettings({ settings: normalized, category_rules: rules });
    return normalizeSettings(saved?.settings as SettingsModel);
  }

  function updateSetupSaveState(
    key: SetupSaveKey,
    patch: Partial<SetupSaveState>,
  ) {
    setSetupSaveState((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        ...patch,
      },
    }));
  }

  async function fetchDebtRegistry() {
    if (!USER_ID) return;
    setDebtsLoading(true);
    setDebtError(null);
    try {
      const rows = await listDebts({ user_id: USER_ID });
      setDebts(rows || []);
    } catch (err) {
      setDebtError(err instanceof Error ? err.message : "Failed to load debt registry");
    } finally {
      setDebtsLoading(false);
    }
  }

  async function handleConfirmMonthlyIncome() {
    const monthlyIncome = Number(settings.financialOS.paycheck.monthlyIncome || 0);
    if (!Number.isFinite(monthlyIncome) || monthlyIncome <= 0) {
      updateSetupSaveState("monthly_income", {
        busy: false,
        status: null,
        error: "Enter a monthly income before confirming it.",
      });
      return;
    }

    updateSetupSaveState("monthly_income", { busy: true, status: null, error: null });
    try {
      const nextSettings = normalizeSettings({
        ...settings,
        financialOS: {
          ...settings.financialOS,
          setupConfirmations: {
            ...settings.financialOS.setupConfirmations,
            monthlyIncomeConfirmed: true,
          },
        },
      });
      const savedSettings = await persistSettingsSnapshot(nextSettings);
      setSettings(savedSettings);
      await refreshSetupChecklist();
      updateSetupSaveState("monthly_income", {
        busy: false,
        status: "Monthly income saved and confirmed.",
        error: null,
      });
    } catch (error) {
      updateSetupSaveState("monthly_income", {
        busy: false,
        status: null,
        error: error instanceof Error ? error.message : "Failed to save monthly income.",
      });
    }
  }

  async function handleConfirmPaycheckCadence() {
    updateSetupSaveState("paycheck_cadence", { busy: true, status: null, error: null });
    try {
      const nextSettings = normalizeSettings({
        ...settings,
        financialOS: {
          ...settings.financialOS,
          setupConfirmations: {
            ...settings.financialOS.setupConfirmations,
            paycheckCadenceConfirmed: true,
          },
        },
      });
      const savedSettings = await persistSettingsSnapshot(nextSettings);
      setSettings(savedSettings);
      await refreshSetupChecklist();
      updateSetupSaveState("paycheck_cadence", {
        busy: false,
        status: "Paycheck cadence saved and confirmed.",
        error: null,
      });
    } catch (error) {
      updateSetupSaveState("paycheck_cadence", {
        busy: false,
        status: null,
        error: error instanceof Error ? error.message : "Failed to save paycheck cadence.",
      });
    }
  }

  async function handleConfirmRunwayTarget() {
    updateSetupSaveState("runway_target", { busy: true, status: null, error: null });
    try {
      const nextSettings = normalizeSettings({
        ...settings,
        financialOS: {
          ...settings.financialOS,
          setupConfirmations: {
            ...settings.financialOS.setupConfirmations,
            runwayTargetConfirmed: true,
          },
        },
      });
      const savedSettings = await persistSettingsSnapshot(nextSettings);
      setSettings(savedSettings);
      await refreshSetupChecklist();
      updateSetupSaveState("runway_target", {
        busy: false,
        status: "Runway target saved and confirmed.",
        error: null,
      });
    } catch (error) {
      updateSetupSaveState("runway_target", {
        busy: false,
        status: null,
        error: error instanceof Error ? error.message : "Failed to save runway target.",
      });
    }
  }

  async function handleConfirmDebtStrategy() {
    updateSetupSaveState("debt_strategy", { busy: true, status: null, error: null });
    try {
      const nextSettings = normalizeSettings({
        ...settings,
        financialOS: {
          ...settings.financialOS,
          setupConfirmations: {
            ...settings.financialOS.setupConfirmations,
            debtStrategyConfirmed: true,
          },
        },
      });
      const savedSettings = await persistSettingsSnapshot(nextSettings);
      setSettings(savedSettings);
      await refreshSetupChecklist();
      updateSetupSaveState("debt_strategy", {
        busy: false,
        status: "Debt strategy saved and confirmed.",
        error: null,
      });
    } catch (error) {
      updateSetupSaveState("debt_strategy", {
        busy: false,
        status: null,
        error: error instanceof Error ? error.message : "Failed to save debt strategy.",
      });
    }
  }

  async function saveFiTarget(rawValue: string) {
    if (!USER_ID) return;
    const trimmed = rawValue.trim();
    const numericValue = trimmed ? Number(trimmed.replace(/[$,\s]/g, "")) : 0;
    if (trimmed && !Number.isFinite(numericValue)) {
      setFiTargetError("Enter a valid dollar amount or leave it blank to use the derived formula.");
      setFiTargetStatus(null);
      return;
    }

    setFiTargetError(null);
    try {
      await upsertGoal("fi_target", {
        value: trimmed ? Math.max(0, numericValue) : 0,
        notes: trimmed ? "User-set FI target" : "Use derived Financial OS FI target",
      });
      setFiTargetInput(trimmed ? String(Math.max(0, numericValue)) : "");
      await refreshSetupChecklist();
      setFiTargetStatus(trimmed ? "FI target saved." : "FI target cleared. Dashboard will use the derived formula.");
    } catch (error) {
      setFiTargetError(error instanceof Error ? error.message : "Failed to save FI target.");
      setFiTargetStatus(null);
    }
  }

  useEffect(() => {
    if (!USER_ID) return;
    fetchDebtRegistry();
  }, [USER_ID]);

  async function fetchPlaidState(opts?: { silent?: boolean }) {
    if (!USER_ID) return;
    if (!opts?.silent) {
      setPlaidBusy(true);
      setPlaidError(null);
    }
    try {
      const [accountsRes, txRes, osState] = await Promise.all([
        getPlaidAccounts(USER_ID),
        getPlaidTransactions({ user_id: USER_ID, limit: 12 }),
        refreshSetupChecklist(),
      ]);
      setPlaidAccounts(accountsRes.accounts || []);
      setPlaidItems(accountsRes.items || []);
      setSelectedPlaidItemId((current) => {
        if (current && (accountsRes.items || []).some((item) => item.item_id === current)) return current;
        return accountsRes.items?.[0]?.item_id || "";
      });
      setPlaidTransactions(txRes.transactions || []);
      setPlaidCashContribution(Number(osState?.cash_sources?.plaid_cash_total || 0));
      setPlaidDuplicateCount((osState?.cash_sources?.plaid_duplicate_accounts_skipped || []).length);
      setSetupStatus(osState?.setup_status || osState?.financial_os_v2?.setup_status || null);
      if (!opts?.silent && (accountsRes.accounts?.length || 0) > 0) {
        setPlaidStatus(
          `Loaded ${accountsRes.accounts.length} linked Plaid account${accountsRes.accounts.length === 1 ? "" : "s"}.`
        );
      }
    } catch (err) {
      if (!opts?.silent) {
        setPlaidError(err instanceof Error ? err.message : "Failed to load linked Plaid accounts.");
      }
    } finally {
      if (!opts?.silent) setPlaidBusy(false);
    }
  }

  useEffect(() => {
    if (!USER_ID) return;
    fetchPlaidState({ silent: true });
  }, [USER_ID]);

  const quickSummary = useMemo(() => {
    const sts = settings.financialOS.sts;
    const buffer =
      sts.bufferMode === "Percent"
        ? `${fmtPct(sts.bufferPercent)} buffer`
        : `$${Math.round(sts.bufferFixed)} buffer`;
    const splitMode = settings.financialOS.paycheck.splitMode === "ThreeCaps" ? "Three caps" : "Custom buckets";
    return {
      buffer,
      strategy: settings.financialOS.debt.strategy,
      splitMode,
      alerts: settings.alerts.enabled ? settings.alerts.frequency : "Off",
    };
  }, [settings]);
  const setupItems = setupStatus?.items ?? [];
  const setupCompletedCount = Number(setupStatus?.completed_count ?? 0);
  const setupTotalCount = Number(setupStatus?.total_count ?? setupItems.length ?? 0);
  const detectedMonthlyIncome = (() => {
    const rawValue = setupItems.find((item) => item.key === "monthly_income")?.value;
    if (typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue > 0) return rawValue;
    return null;
  })();

  const verificationConfigured = Boolean(bootstrap?.beta?.email_verification_configured && user?.email_verification_configured);
  const verificationMeta = emailVerificationMeta(user?.email_verification_status, verificationConfigured);

  async function handleSaveAccount() {
    if (!user) return;
    setAccountBusy(true);
    setAccountError(null);
    setAccountStatus(null);

    const trimmedDisplayName = accountForm.display_name.trim();
    const trimmedUsername = accountForm.username.trim().toLowerCase();
    const trimmedEmail = accountForm.email.trim().toLowerCase();

    if (!trimmedDisplayName) {
      setAccountBusy(false);
      setAccountError("Display name is required.");
      return;
    }
    if (trimmedUsername && !/^[a-z0-9](?:[a-z0-9._-]{2,30}[a-z0-9])?$/.test(trimmedUsername)) {
      setAccountBusy(false);
      setAccountError("Username must be 4-32 characters and use only letters, numbers, dots, dashes, or underscores.");
      return;
    }
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setAccountBusy(false);
      setAccountError("A valid email address is required.");
      return;
    }
    if (trimmedEmail !== (user.email || "").toLowerCase() && !accountForm.current_password) {
      setAccountBusy(false);
      setAccountError("Current password is required to change your email.");
      return;
    }

    try {
      await updateProfile({
        display_name: trimmedDisplayName,
        username: trimmedUsername || "",
        email: trimmedEmail,
        current_password: accountForm.current_password || undefined,
      });
      setAccountForm((prev) => ({ ...prev, current_password: "" }));
      setAccountStatus("Profile saved.");
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Could not save profile changes.");
    } finally {
      setAccountBusy(false);
    }
  }

  async function handleChangePassword() {
    setSecurityBusy(true);
    setSecurityError(null);
    setSecurityStatus(null);

    if (!securityForm.current_password) {
      setSecurityBusy(false);
      setSecurityError("Enter your current password.");
      return;
    }
    const passwordError = validatePasswordAgainstPolicy(securityForm.new_password, passwordPolicy);
    if (passwordError) {
      setSecurityBusy(false);
      setSecurityError(passwordError);
      return;
    }
    if (securityForm.new_password !== securityForm.confirm_password) {
      setSecurityBusy(false);
      setSecurityError("New password and confirmation do not match.");
      return;
    }

    try {
      await changePassword({
        current_password: securityForm.current_password,
        new_password: securityForm.new_password,
      });
      setSecurityForm({ current_password: "", new_password: "", confirm_password: "" });
      setAccountForm((prev) => ({ ...prev, current_password: "" }));
      setSecurityStatus("Password changed. Older sessions were signed out.");
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : "Could not change password.");
    } finally {
      setSecurityBusy(false);
    }
  }

  async function handleRequestEmailVerification() {
    setVerificationBusy(true);
    setVerificationError(null);
    setVerificationStatus(null);
    try {
      const res = await requestEmailVerification();
      setVerificationStatus(res.message || "Verification code sent.");
    } catch (err) {
      setVerificationError(err instanceof Error ? err.message : "Could not send verification code.");
    } finally {
      setVerificationBusy(false);
    }
  }

  async function handleConfirmEmailVerification() {
    setVerificationBusy(true);
    setVerificationError(null);
    setVerificationStatus(null);
    try {
      await confirmEmailVerification({ code: verificationCode.trim() });
      setVerificationCode("");
      await refresh();
      setVerificationStatus("Email verified.");
    } catch (err) {
      setVerificationError(err instanceof Error ? err.message : "Could not verify email.");
    } finally {
      setVerificationBusy(false);
    }
  }

  async function handleSettingsLogout() {
    await logout();
    router.replace("/login");
  }

  async function handleUnlinkPlaidItem(itemId: string) {
    if (!USER_ID) return;
    setPlaidBusy(true);
    setPlaidError(null);
    setPlaidStatus(null);
    try {
      const res = await unlinkPlaidItem(itemId, { user_id: USER_ID });
      setPlaidStatus(res.message || "Connection disconnected.");
      await fetchPlaidState({ silent: true });
    } catch (err) {
      setPlaidError(err instanceof Error ? err.message : "Could not disconnect account connection.");
    } finally {
      setPlaidBusy(false);
    }
  }

  function resetAll() {
    localStorage.removeItem(SETTINGS_KEY);
    setSettings(defaultSettings());
    setSetupSaveState(INITIAL_SETUP_SAVE_STATE);
  }

  async function exportAll() {
    // also export category rules if present
    const rulesKey = settings.categories.rulesKey || RULES_KEY_DEFAULT;
    const rulesRaw = localStorage.getItem(rulesKey);
    const bundle = {
      exportedAt: new Date().toISOString(),
      settings,
      categoryRules: safeJsonParse<Record<string, any>>(rulesRaw) ?? {},
      rulesKey,
    };
    downloadJson("accountantbot_export.json", bundle);
  }

  async function importAll(file: File) {
    const txt = await fileToText(file);
    const obj = safeJsonParse<any>(txt);
    if (!obj) throw new Error("Invalid JSON");

    if (obj.settings?.version === 1) {
      setSettings(normalizeSettings(obj.settings));
    }

    // restore category rules if present
    if (obj.categoryRules && typeof obj.categoryRules === "object") {
      const key = (obj.rulesKey as string) || settings.categories.rulesKey || RULES_KEY_DEFAULT;
      localStorage.setItem(key, JSON.stringify(obj.categoryRules));
      setSettings((prev) => ({
        ...prev,
        categories: { ...prev.categories, rulesKey: key },
      }));
    }
  }

  function startCreateDebt() {
    setDebtStatus(null);
    setDebtError(null);
    setShowCreateDebt(true);
    setEditingDebtId(null);
    setNewDebtForm(emptyDebtForm());
  }

  function startEditDebt(debt: Debt) {
    setDebtStatus(null);
    setDebtError(null);
    setShowCreateDebt(false);
    setEditingDebtId(debt.id);
    setEditingDebtForm(debtToForm(debt));
  }

  function cancelDebtEditor() {
    setShowCreateDebt(false);
    setEditingDebtId(null);
    setDebtStatus(null);
    setDebtError(null);
    setNewDebtForm(emptyDebtForm());
    setEditingDebtForm(emptyDebtForm());
  }

  async function handleCreateDebt() {
    if (!USER_ID) return;
    setSavingDebt(true);
    setDebtError(null);
    setDebtStatus(null);
    try {
      await createDebt(normalizeDebtPayload(newDebtForm, USER_ID), { user_id: USER_ID });
      setDebtStatus("Debt saved.");
      setShowCreateDebt(false);
      setNewDebtForm(emptyDebtForm());
      await fetchDebtRegistry();
    } catch (err) {
      setDebtError(err instanceof Error ? err.message : "Failed to save debt");
    } finally {
      setSavingDebt(false);
    }
  }

  async function handleSaveDebtEdit() {
    if (!editingDebtId || !USER_ID) return;
    setSavingDebt(true);
    setDebtError(null);
    setDebtStatus(null);
    try {
      await updateDebt(editingDebtId, normalizeDebtPayload(editingDebtForm, USER_ID), { user_id: USER_ID });
      setDebtStatus("Debt updated.");
      setEditingDebtId(null);
      setEditingDebtForm(emptyDebtForm());
      await fetchDebtRegistry();
    } catch (err) {
      setDebtError(err instanceof Error ? err.message : "Failed to update debt");
    } finally {
      setSavingDebt(false);
    }
  }

  async function handleConnectPlaidConnection() {
    if (!USER_ID) return;
    setPlaidBusy(true);
    setPlaidError(null);
    setPlaidStatus("Preparing Plaid Link...");

    let handler: PlaidLinkHandler | null = null;

    try {
      const [{ link_token }] = await Promise.all([
        createPlaidLinkToken({ user_id: USER_ID }),
        loadPlaidLinkScript(),
      ]);

      if (!window.Plaid) {
        throw new Error("Plaid Link did not initialize correctly.");
      }

      handler = window.Plaid.create({
        token: link_token,
        onSuccess: async (publicToken, metadata) => {
          setPlaidError(null);
          setPlaidStatus("Link successful. Finishing account connection...");

          try {
            const exchange = await exchangePlaidPublicToken({
              user_id: USER_ID,
              public_token: publicToken,
              institution_name: metadata.institution?.name || null,
            });

            await fetchPlaidState({ silent: true });
            const institutionName = exchange.institution_name || metadata.institution?.name || "institution";
            if (exchange.sync_warning) {
              setPlaidStatus(
                `Connected to ${institutionName}. ${exchange.accounts.length} account${
                  exchange.accounts.length === 1 ? "" : "s"
                } linked. ${exchange.sync_warning}`
              );
            } else {
              setPlaidStatus(
                `Connected to ${institutionName}. ${exchange.accounts.length} account${
                  exchange.accounts.length === 1 ? "" : "s"
                } linked and synced.`
              );
            }
          } catch (err) {
            setPlaidError(err instanceof Error ? err.message : "Failed to exchange Plaid public token.");
            setPlaidStatus(null);
          } finally {
            setPlaidBusy(false);
            handler?.destroy?.();
          }
        },
        onExit: (error) => {
          if (error?.error_message) {
            setPlaidError(error.error_message);
            setPlaidStatus(null);
          } else if (!plaidAccounts.length) {
            setPlaidStatus("Plaid Link closed before completing a connection.");
          }
          setPlaidBusy(false);
          handler?.destroy?.();
        },
      });

      setPlaidStatus("Opening Plaid Link...");
      handler.open();
    } catch (err) {
      setPlaidError(err instanceof Error ? err.message : "Failed to start Plaid Link.");
      setPlaidStatus(null);
      setPlaidBusy(false);
      handler?.destroy?.();
    }
  }

  async function handleSyncPlaidData() {
    if (!USER_ID) return;
    setPlaidBusy(true);
    setPlaidError(null);
    setPlaidStatus("Syncing Plaid balances and transactions...");
    try {
      const res = await syncPlaidData({ user_id: USER_ID, lookback_days: 30 });
      await fetchPlaidState({ silent: true });
      const warningText = res.warnings?.length ? ` Warnings: ${res.warnings.join(" ")}` : "";
      setPlaidStatus(
        `Plaid sync complete. ${res.accounts_synced || 0} account${res.accounts_synced === 1 ? "" : "s"} updated and ${
          res.transactions_synced || 0
        } transaction${res.transactions_synced === 1 ? "" : "s"} synced.${warningText}`
      );
    } catch (err) {
      setPlaidError(err instanceof Error ? err.message : "Failed to sync Plaid data.");
      setPlaidStatus(null);
    } finally {
      setPlaidBusy(false);
    }
  }

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-lg font-semibold text-zinc-100">Settings</div>
              <div className="mt-1 text-sm text-zinc-400">
                Make Accountant Bot fit how you spend, save, and stay organized.
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
                  STS: <span className="text-zinc-200">{quickSummary.buffer}</span>
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
                  Debt: <span className="text-zinc-200">{quickSummary.strategy}</span>
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
                  Split: <span className="text-zinc-200">{quickSummary.splitMode}</span>
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
                  Alerts: <span className="text-zinc-200">{quickSummary.alerts}</span>
                </span>
              </div>
            </div>

            <div className="shrink-0">
              <Link
                href="/dashboard"
                className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        </Card>

        {/* Layout: left = Financial OS controls, right = App & Data controls */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* LEFT: Financial OS */}
          <div className="space-y-5">
            <Card>
              <div id="setup-entry" className="scroll-mt-24">
                <SectionTitle
                  title="Financial OS Setup"
                  subtitle="Start here. These few inputs power the dashboard recommendations."
                />
                <Divider />

                <div className="flex flex-wrap gap-2 text-xs">
                  <span className={`inline-flex items-center rounded-full border px-3 py-1 font-medium uppercase tracking-[0.18em] ${trustLevelTone(setupStatus?.trust_level)}`}>
                    Trust level: {setupStatus?.trust_level || "Loading"}
                  </span>
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1 text-zinc-200">
                    Completed: {setupCompletedCount} / {setupTotalCount || 7}
                  </span>
                </div>

                <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-300">
                  {(setupStatus?.trust_level || "").toLowerCase() === "high"
                    ? "Recommendations are based on confirmed setup."
                    : (setupStatus?.trust_level || "").toLowerCase() === "medium"
                    ? "Recommendations are usable, but some assumptions should be confirmed."
                    : "Some recommendations are estimated until setup is completed."}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href="/settings#income-paycheck" className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                    Income / paycheck
                  </Link>
                  <Link href="/settings#bills" className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                    Bills
                  </Link>
                  <Link href="/settings#debts" className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                    Debts
                  </Link>
                  <Link href="/settings#fi-target" className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                    FI target
                  </Link>
                  <Link href="/settings#runway-target" className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                    Runway target
                  </Link>
                  <Link href="/settings#debt-strategy" className="inline-flex items-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                    Debt strategy
                  </Link>
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
                                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] ${setupStatusTone(item.status)}`}>
                                  {setupStatusLabel(item.status)}
                                </span>
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
                                {item.action || "Open"}
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                      Setup checklist is loading.
                    </div>
                  )}
                </div>
              </div>
            </Card>

            {/* Safe-to-Spend */}
            <CollapsibleCard
              title="Safe-to-Spend Controls"
              subtitle="Choose how much breathing room to keep before the app tells you money is safe to spend."
            >

              <Toggle
                label="Turn on Safe-to-Spend"
                desc="Shows a daily amount you can use after bills and your cushion are protected."
                value={settings.financialOS.sts.enabled}
                onChange={(v) =>
                  setSettings((p) => ({
                    ...p,
                    financialOS: { ...p.financialOS, sts: { ...p.financialOS.sts, enabled: v } },
                  }))
                }
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Select
                  label="Buffer mode"
                  desc="Percent flexes with your money flow. Fixed keeps the same cushion every month."
                  value={settings.financialOS.sts.bufferMode}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        sts: { ...p.financialOS.sts, bufferMode: v as any },
                      },
                    }))
                  }
                  options={[
                    { label: "Percent buffer", value: "Percent" },
                    { label: "Fixed buffer", value: "Fixed" },
                  ]}
                />

                {settings.financialOS.sts.bufferMode === "Percent" ? (
                  <NumberInput
                    label="Buffer percent"
                    desc="Example: 10% means the app keeps 10% of available money untouched."
                    value={settings.financialOS.sts.bufferPercent}
                    min={0}
                    max={50}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          sts: { ...p.financialOS.sts, bufferPercent: clamp(n, 0, 50) },
                        },
                      }))
                    }
                  />
                ) : (
                  <NumberInput
                    label="Buffer amount"
                    desc="A fixed cushion the app always leaves alone."
                    value={settings.financialOS.sts.bufferFixed}
                    min={0}
                    step={10}
                    suffix={settings.profile.homeCurrency}
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          sts: { ...p.financialOS.sts, bufferFixed: Math.max(0, n) },
                        },
                      }))
                    }
                  />
                )}
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Upcoming bills window (days)"
                  desc="How far ahead to look when holding money for upcoming bills."
                  value={settings.financialOS.sts.includeUpcomingBillsWindowDays}
                  min={7}
                  max={60}
                  step={1}
                  suffix="days"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        sts: {
                          ...p.financialOS.sts,
                          includeUpcomingBillsWindowDays: clamp(n, 7, 60),
                        },
                      },
                    }))
                  }
                />

                <Toggle
                  label="Never show a negative Safe-to-Spend"
                  desc="Keeps the number at $0 instead of showing a negative amount."
                  value={settings.financialOS.sts.neverNegativeSTS}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        sts: { ...p.financialOS.sts, neverNegativeSTS: v },
                      },
                    }))
                  }
                />
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                This helps keep money decisions calm and simple with one safe daily number.
              </div>
            </CollapsibleCard>

            {/* Stage targets */}
            <CollapsibleCard
              id="runway-target"
              title="Stage Targets"
              subtitle="Set the milestones that guide your Financial OS stage and progress."
            >

                <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Crisis threshold"
                  desc="If runway falls below this, the app treats money as urgent."
                  value={settings.financialOS.stageTargets.runwayMonthsCrisis}
                  min={0}
                  max={6}
                  step={0.1}
                  suffix="months"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        stageTargets: {
                          ...p.financialOS.stageTargets,
                          runwayMonthsCrisis: clamp(n, 0, 6),
                        },
                      },
                    }))
                  }
                />

                <NumberInput
                  label="Stabilize threshold"
                  desc="Below this, the app focuses on getting your footing back."
                  value={settings.financialOS.stageTargets.runwayMonthsStabilize}
                  min={0}
                  max={12}
                  step={0.1}
                  suffix="months"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        stageTargets: {
                          ...p.financialOS.stageTargets,
                          runwayMonthsStabilize: clamp(n, 0, 12),
                        },
                      },
                    }))
                  }
                />

                <NumberInput
                  label="Security goal runway"
                  desc="Your target runway for feeling comfortably covered."
                  value={settings.financialOS.stageTargets.runwayMonthsSecurityGoal}
                  min={1}
                  max={12}
                  step={0.5}
                  suffix="months"
                  onChange={(n) => {
                    updateSetupSaveState("runway_target", { status: null, error: null });
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        stageTargets: {
                          ...p.financialOS.stageTargets,
                          runwayMonthsSecurityGoal: clamp(n, 1, 12),
                        },
                        setupConfirmations: {
                          ...p.financialOS.setupConfirmations,
                          runwayTargetConfirmed: false,
                        },
                      },
                    }));
                  }}
                />

                <NumberInput
                  label="Utilization risk"
                  desc="Get warned when card usage rises above this level."
                  value={settings.financialOS.stageTargets.utilizationRiskPct}
                  min={5}
                  max={95}
                  step={1}
                  suffix="%"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        stageTargets: {
                          ...p.financialOS.stageTargets,
                          utilizationRiskPct: clamp(n, 5, 95),
                        },
                      },
                    }))
                  }
                />

                <NumberInput
                  label="High-cost debt rate"
                  desc="Debt above this rate is treated as especially important to pay down."
                  value={settings.financialOS.stageTargets.debtCostRateHighPct}
                  min={0}
                  max={60}
                  step={0.5}
                  suffix="%"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        stageTargets: {
                          ...p.financialOS.stageTargets,
                          debtCostRateHighPct: clamp(n, 0, 60),
                        },
                      },
                    }))
                  }
                />
                </div>

                <div className="mt-3 text-xs text-zinc-500">
                  These targets help the app choose the next priority automatically.
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleConfirmRunwayTarget}
                    disabled={setupSaveState.runway_target.busy}
                    className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {setupSaveState.runway_target.busy ? "Saving..." : "Save runway target"}
                  </button>
                  {setupSaveState.runway_target.status ? (
                    <div className="text-xs text-emerald-300">{setupSaveState.runway_target.status}</div>
                  ) : null}
                  {setupSaveState.runway_target.error ? (
                    <div className="text-xs text-red-300">{setupSaveState.runway_target.error}</div>
                  ) : null}
                </div>
            </CollapsibleCard>

            {/* Paycheck splits */}
            <CollapsibleCard
              id="income-paycheck"
              title="Paycheck Split"
              subtitle="Choose how each paycheck should be divided across bills, day-to-day spending, and extra progress."
            >

                <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm text-zinc-200">
                  Confirming income makes spending caps and recommendations more trustworthy.
                </div>

                {detectedMonthlyIncome && settings.financialOS.paycheck.monthlyIncome <= 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-300">
                    <div>Detected monthly income: <span className="font-medium text-zinc-100">{formatMoney(detectedMonthlyIncome)}/month</span></div>
                    <button
                      type="button"
                      onClick={() =>
                        setSettings((p) => ({
                          ...p,
                          financialOS: {
                            ...p.financialOS,
                            paycheck: { ...p.financialOS.paycheck, monthlyIncome: detectedMonthlyIncome },
                            setupConfirmations: {
                              ...p.financialOS.setupConfirmations,
                              monthlyIncomeConfirmed: false,
                            },
                          },
                        }))
                      }
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                    >
                      Use detected amount
                    </button>
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-3">
                <Input
                  label="Monthly income confirmation"
                  desc="Optional setup confirmation for the trust checklist."
                  value={settings.financialOS.paycheck.monthlyIncome > 0 ? String(settings.financialOS.paycheck.monthlyIncome) : ""}
                  onChange={(v) => {
                    updateSetupSaveState("monthly_income", { status: null, error: null });
                    setSettings((p) => {
                      const trimmed = v.trim();
                      const parsed = trimmed ? Number(trimmed.replace(/[$,\s]/g, "")) : 0;
                      return {
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            monthlyIncome: trimmed && Number.isFinite(parsed) ? Math.max(0, parsed) : 0,
                          },
                          setupConfirmations: {
                            ...p.financialOS.setupConfirmations,
                            monthlyIncomeConfirmed: false,
                          },
                        },
                      };
                    });
                  }}
                  placeholder="3766.76"
                />
                <Select
                  label="Pay cadence"
                  desc="Used to time forecasts and paycheck reminders."
                  value={settings.financialOS.paycheck.cadence}
                  onChange={(v) => {
                    updateSetupSaveState("paycheck_cadence", { status: null, error: null });
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        paycheck: { ...p.financialOS.paycheck, cadence: v as any },
                        setupConfirmations: {
                          ...p.financialOS.setupConfirmations,
                          paycheckCadenceConfirmed: false,
                        },
                      },
                    }));
                  }}
                  options={[
                    { label: "Weekly", value: "Weekly" },
                    { label: "Biweekly", value: "Biweekly" },
                    { label: "Semi-monthly", value: "Semimonthly" },
                    { label: "Monthly", value: "Monthly" },
                  ]}
                />

                <Input
                  label="Payday hint"
                  desc="A plain-language note like Friday or every other Wednesday."
                  value={settings.financialOS.paycheck.paydayHint}
                  onChange={(v) => {
                    updateSetupSaveState("paycheck_cadence", { status: null, error: null });
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        paycheck: { ...p.financialOS.paycheck, paydayHint: v },
                        setupConfirmations: {
                          ...p.financialOS.setupConfirmations,
                          paycheckCadenceConfirmed: false,
                        },
                      },
                    }));
                  }}
                  placeholder="Friday"
                />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleConfirmMonthlyIncome}
                    disabled={setupSaveState.monthly_income.busy}
                    className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {setupSaveState.monthly_income.busy ? "Saving..." : "Save and confirm income"}
                  </button>
                  {setupSaveState.monthly_income.status ? (
                    <div className="text-xs text-emerald-300">{setupSaveState.monthly_income.status}</div>
                  ) : null}
                  {setupSaveState.monthly_income.error ? (
                    <div className="text-xs text-red-300">{setupSaveState.monthly_income.error}</div>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleConfirmPaycheckCadence}
                    disabled={setupSaveState.paycheck_cadence.busy}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10 disabled:opacity-50"
                  >
                    {setupSaveState.paycheck_cadence.busy ? "Saving..." : "Save cadence and payday hint"}
                  </button>
                  {setupSaveState.paycheck_cadence.status ? (
                    <div className="text-xs text-emerald-300">{setupSaveState.paycheck_cadence.status}</div>
                  ) : null}
                  {setupSaveState.paycheck_cadence.error ? (
                    <div className="text-xs text-red-300">{setupSaveState.paycheck_cadence.error}</div>
                  ) : null}
                </div>

                <div className="mt-3">
                <ChipGroup
                  label="Split mode"
                  desc="Three Caps keeps things simple. Custom buckets lets you set exact percentages."
                  value={settings.financialOS.paycheck.splitMode}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        paycheck: { ...p.financialOS.paycheck, splitMode: v as any },
                      },
                    }))
                  }
                  options={[
                    { label: "Three Caps", value: "ThreeCaps" },
                    { label: "Custom Buckets", value: "ManualBuckets" },
                  ]}
                />
                </div>

                {settings.financialOS.paycheck.splitMode === "ThreeCaps" ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <NumberInput
                    label="Essentials cap"
                    desc="Bills, rent, groceries, and essentials should stay under this."
                    value={settings.financialOS.paycheck.threeCaps.essentialsCapPct}
                    min={10}
                    max={95}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            threeCaps: {
                              ...p.financialOS.paycheck.threeCaps,
                              essentialsCapPct: clamp(n, 10, 95),
                            },
                          },
                        },
                      }))
                    }
                  />
                  <NumberInput
                    label="Discretionary cap"
                    desc="Keeps everyday fun spending in a healthy range."
                    value={settings.financialOS.paycheck.threeCaps.discretionaryCapPct}
                    min={0}
                    max={80}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            threeCaps: {
                              ...p.financialOS.paycheck.threeCaps,
                              discretionaryCapPct: clamp(n, 0, 80),
                            },
                          },
                        },
                      }))
                    }
                  />
                  <NumberInput
                    label="Surplus cap"
                    desc="What you want left over for debt payoff and savings."
                    value={settings.financialOS.paycheck.threeCaps.surplusCapPct}
                    min={0}
                    max={80}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            threeCaps: {
                              ...p.financialOS.paycheck.threeCaps,
                              surplusCapPct: clamp(n, 0, 80),
                            },
                          },
                        },
                      }))
                    }
                  />
                  <div className="sm:col-span-3 text-xs text-zinc-500">
                    Tip: this does not need to total exactly 100. The app can smooth it out later.
                  </div>
                </div>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <NumberInput
                    label="Bills bucket"
                    desc="Rent, utilities, and minimum payments."
                    value={settings.financialOS.paycheck.manualBuckets.billsPct}
                    min={0}
                    max={100}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            manualBuckets: { ...p.financialOS.paycheck.manualBuckets, billsPct: clamp(n, 0, 100) },
                          },
                        },
                      }))
                    }
                  />
                  <NumberInput
                    label="Spending allowance"
                    desc="Everyday spending."
                    value={settings.financialOS.paycheck.manualBuckets.spendPct}
                    min={0}
                    max={100}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            manualBuckets: { ...p.financialOS.paycheck.manualBuckets, spendPct: clamp(n, 0, 100) },
                          },
                        },
                      }))
                    }
                  />
                  <NumberInput
                    label="Extra"
                    desc="Extra money for debt payoff and savings."
                    value={settings.financialOS.paycheck.manualBuckets.extraPct}
                    min={0}
                    max={100}
                    step={1}
                    suffix="%"
                    onChange={(n) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          paycheck: {
                            ...p.financialOS.paycheck,
                            manualBuckets: { ...p.financialOS.paycheck.manualBuckets, extraPct: clamp(n, 0, 100) },
                          },
                        },
                      }))
                    }
                  />
                </div>
                )}

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Select
                  label="Rounding"
                  desc="Rounds recommendations into cleaner numbers."
                  value={settings.financialOS.paycheck.rounding}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        paycheck: { ...p.financialOS.paycheck, rounding: v as any },
                      },
                    }))
                  }
                  options={[
                    { label: "No rounding", value: "None" },
                    { label: "Nearest $1", value: "Nearest1" },
                    { label: "Nearest $5", value: "Nearest5" },
                    { label: "Nearest $10", value: "Nearest10" },
                  ]}
                />
                </div>
            </CollapsibleCard>

            {/* Debt strategy */}
            <CollapsibleCard
              id="debt-strategy"
              title="Debt Strategy"
              subtitle="Choose the payoff style that should guide extra payments when money is available."
            >

                <ChipGroup<DebtStrategy>
                label="Strategy"
                desc="Avalanche focuses on interest. Snowball focuses on quick wins. Hybrid balances both with safety rules."
                value={settings.financialOS.debt.strategy}
                onChange={(v) => {
                  updateSetupSaveState("debt_strategy", { status: null, error: null });
                  setSettings((p) => ({
                    ...p,
                    financialOS: {
                      ...p.financialOS,
                      debt: { ...p.financialOS.debt, strategy: v },
                      setupConfirmations: {
                        ...p.financialOS.setupConfirmations,
                        debtStrategyConfirmed: false,
                      },
                    },
                  }));
                }}
                options={[
                  { label: "Avalanche", value: "Avalanche" },
                  { label: "Snowball", value: "Snowball" },
                  { label: "Hybrid (Next Best Dollar)", value: "Hybrid (Next Best Dollar)" },
                ]}
                />

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Minimum extra payment"
                  desc="Ignore tiny extra payment suggestions below this amount."
                  value={settings.financialOS.debt.minExtraPayment}
                  min={0}
                  step={5}
                  suffix={settings.profile.homeCurrency}
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        debt: { ...p.financialOS.debt, minExtraPayment: Math.max(0, n) },
                      },
                    }))
                  }
                />

                <NumberInput
                  label="Target utilization"
                  desc="A target to help keep card usage in a healthier range."
                  value={settings.financialOS.debt.targetUtilizationPct}
                  min={1}
                  max={95}
                  step={1}
                  suffix="%"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        debt: { ...p.financialOS.debt, targetUtilizationPct: clamp(n, 1, 95) },
                      },
                    }))
                  }
                />
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Prefer keeping cards open"
                  desc="Avoids closure-style recommendations and focuses on payoff and utilization."
                  value={settings.financialOS.debt.keepCardsOpen}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        debt: { ...p.financialOS.debt, keepCardsOpen: v },
                      },
                    }))
                  }
                />

                <Toggle
                  label="Allow hybrid rebalance"
                  desc="Lets the app switch targets when a clearly better next move appears."
                  value={settings.financialOS.debt.allowHybridRebalance}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        debt: { ...p.financialOS.debt, allowHybridRebalance: v },
                      },
                    }))
                  }
                />
                </div>

                <div className="mt-3">
                <SectionTitle
                  title="Next Best Dollar Guardrails"
                  subtitle="These rules keep extra debt recommendations practical and low-stress."
                />
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Toggle
                    label="Protect minimum payments"
                    desc="Do not suggest extra debt payments if minimums are not covered."
                    value={settings.financialOS.debt.nextBestDollar.protectMinimums}
                    onChange={(v) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          debt: {
                            ...p.financialOS.debt,
                            nextBestDollar: { ...p.financialOS.debt.nextBestDollar, protectMinimums: v },
                          },
                        },
                      }))
                    }
                  />
                  <Toggle
                    label="Protect bills first"
                    desc="Make sure bills are covered before suggesting extra debt payoff."
                    value={settings.financialOS.debt.nextBestDollar.protectBillsFirst}
                    onChange={(v) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          debt: {
                            ...p.financialOS.debt,
                            nextBestDollar: { ...p.financialOS.debt.nextBestDollar, protectBillsFirst: v },
                          },
                        },
                      }))
                    }
                  />
                  <Toggle
                    label="Protect STS buffer"
                    desc="Do not dip into your Safe-to-Spend cushion for extra payments."
                    value={settings.financialOS.debt.nextBestDollar.protectSTSBuffer}
                    onChange={(v) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          debt: {
                            ...p.financialOS.debt,
                            nextBestDollar: { ...p.financialOS.debt.nextBestDollar, protectSTSBuffer: v },
                          },
                        },
                      }))
                    }
                  />
                  <Toggle
                    label="Turn on Next Best Dollar"
                    desc="Use one best-action recommendation when you are in Hybrid mode."
                    value={settings.financialOS.debt.nextBestDollar.enabled}
                    onChange={(v) =>
                      setSettings((p) => ({
                        ...p,
                        financialOS: {
                          ...p.financialOS,
                          debt: {
                            ...p.financialOS.debt,
                            nextBestDollar: { ...p.financialOS.debt.nextBestDollar, enabled: v },
                          },
                        },
                      }))
                    }
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleConfirmDebtStrategy}
                    disabled={setupSaveState.debt_strategy.busy}
                    className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {setupSaveState.debt_strategy.busy ? "Saving..." : "Save debt strategy"}
                  </button>
                  {setupSaveState.debt_strategy.status ? (
                    <div className="text-xs text-emerald-300">{setupSaveState.debt_strategy.status}</div>
                  ) : null}
                  {setupSaveState.debt_strategy.error ? (
                    <div className="text-xs text-red-300">{setupSaveState.debt_strategy.error}</div>
                  ) : null}
                </div>
              </div>
            </CollapsibleCard>

            {/* Savings & Scoreboards */}
            <CollapsibleCard
              id="fi-target"
              title="Savings & Scoreboards"
              subtitle="Choose your savings targets and the progress trackers you want to see around the app."
            >

                <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Emergency fund goal"
                  desc="How many months of cushion you want in your emergency fund."
                  value={settings.financialOS.savings.emergencyFundGoalMonths}
                  min={1}
                  max={24}
                  step={1}
                  suffix="months"
                  onChange={(n) => {
                    updateSetupSaveState("runway_target", { status: null, error: null });
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        savings: { ...p.financialOS.savings, emergencyFundGoalMonths: clamp(n, 1, 24) },
                        setupConfirmations: {
                          ...p.financialOS.setupConfirmations,
                          runwayTargetConfirmed: false,
                        },
                      },
                    }));
                  }}
                />

                <Select
                  label="Emergency fund priority"
                  desc="Choose how strongly the app should protect emergency savings."
                  value={settings.financialOS.savings.emergencyFundPriority}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        savings: { ...p.financialOS.savings, emergencyFundPriority: v as any },
                      },
                    }))
                  }
                  options={[
                    { label: "High", value: "High" },
                    { label: "Medium", value: "Medium" },
                    { label: "Low", value: "Low" },
                  ]}
                />
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Enable sinking funds"
                  desc="Set aside money for expected costs like travel, car care, or gifts."
                  value={settings.financialOS.savings.sinkingFundsEnabled}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        savings: { ...p.financialOS.savings, sinkingFundsEnabled: v },
                      },
                    }))
                  }
                />

                <Toggle
                  label="Show Financial Health Score"
                  desc="Keep a simple overall progress score visible."
                  value={settings.financialOS.scoreboards.showFinancialHealthScore}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        scoreboards: { ...p.financialOS.scoreboards, showFinancialHealthScore: v },
                      },
                    }))
                  }
                />
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input
                  label="FI target (optional)"
                  desc="Set your own FI cash target, or leave this blank to derive it from annual required spend x 25."
                  value={fiTargetInput}
                  onChange={(v) => {
                    setFiTargetStatus(null);
                    setFiTargetError(null);
                    setFiTargetInput(v);
                  }}
                  placeholder="Leave blank to use (monthly required spend x 12 x 25)"
                />
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-sm font-medium text-zinc-100">How dashboard will explain it</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    If this field has a value, Dashboard shows that user-set target. If it is blank, Dashboard shows the derived formula:
                    annual required spend = (monthly essentials + planned discretionary baseline) x 12, then FI target = annual required spend x 25.
                  </div>
                  {fiTargetStatus ? <div className="mt-3 text-xs text-emerald-300">{fiTargetStatus}</div> : null}
                  {fiTargetError ? <div className="mt-3 text-xs text-red-300">{fiTargetError}</div> : null}
                  <button
                    type="button"
                    onClick={() => saveFiTarget(fiTargetInput)}
                    className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10"
                  >
                    Save FI target
                  </button>
                </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Show Stability meter"
                  desc="Track whether your cash flow and runway are getting steadier."
                  value={settings.financialOS.scoreboards.showStabilityMeter}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        scoreboards: { ...p.financialOS.scoreboards, showStabilityMeter: v },
                      },
                    }))
                  }
                />
                <Toggle
                  label="Show Debt-free countdown"
                  desc="Show how debt payoff timing improves as you make progress."
                  value={settings.financialOS.scoreboards.showDebtFreeCountdown}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        scoreboards: { ...p.financialOS.scoreboards, showDebtFreeCountdown: v },
                      },
                    }))
                  }
                />
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Show FI progress"
                  desc="Show long-term wealth progress in a simple way."
                  value={settings.financialOS.scoreboards.showFIProgress}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        scoreboards: { ...p.financialOS.scoreboards, showFIProgress: v },
                      },
                    }))
                  }
                />
                <Toggle
                  label="Show streaks and milestones"
                  desc="Add a little momentum by highlighting consistency."
                  value={settings.financialOS.scoreboards.streaksEnabled}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        scoreboards: { ...p.financialOS.scoreboards, streaksEnabled: v },
                      },
                    }))
                  }
                />
                </div>
            </CollapsibleCard>
          </div>

          {/* RIGHT: App, Categories, Alerts, Data, Privacy */}
          <div className="space-y-5">
            {/* Account */}
            <Card>
              <SectionTitle
                title="Account & Identity"
                subtitle="Update the name, username, and email tied to your account."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Display name"
                  desc="Shown anywhere the app refers to you by name."
                  value={accountForm.display_name}
                  onChange={(v) => {
                    setAccountStatus(null);
                    setAccountError(null);
                    setAccountForm((prev) => ({ ...prev, display_name: v }));
                  }}
                />
                <Input
                  label="Username"
                  desc="Minimum 4 characters. This must be unique."
                  value={accountForm.username}
                  onChange={(v) => {
                    setAccountStatus(null);
                    setAccountError(null);
                    setAccountForm((prev) => ({ ...prev, username: v.toLowerCase() }));
                  }}
                  placeholder="vivek"
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input
                  label="Email"
                  desc="Your sign-in email."
                  value={accountForm.email}
                  type="email"
                  onChange={(v) => {
                    setAccountStatus(null);
                    setAccountError(null);
                    setAccountForm((prev) => ({ ...prev, email: v }));
                  }}
                  placeholder="you@example.com"
                />
                <Input
                  label="Current password"
                  desc="Needed only if you change your email address."
                  value={accountForm.current_password}
                  type="password"
                  onChange={(v) => {
                    setAccountStatus(null);
                    setAccountError(null);
                    setAccountForm((prev) => ({ ...prev, current_password: v }));
                  }}
                  placeholder="Current password"
                />
              </div>

              <div className="mt-4 rounded-2xl border p-4 text-sm text-zinc-300">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Email verification</div>
                    <div className="mt-1 text-zinc-100">{verificationMeta.label}</div>
                    <div className="mt-1 text-xs text-zinc-400">{verificationMeta.detail}</div>
                  </div>
                  <div className={`rounded-full border px-3 py-1 text-xs ${verificationMeta.tone}`}>{verificationMeta.label}</div>
                </div>

                {user?.email_verified ? (
                  <div className="mt-3 text-xs text-emerald-300">Profile is verified.</div>
                ) : (
                  <div className="mt-4 space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleRequestEmailVerification}
                        disabled={verificationBusy}
                        className="rounded-xl border border-sky-500/30 bg-sky-500/15 px-3 py-2 text-xs text-sky-100 hover:bg-sky-500/20 disabled:opacity-50"
                      >
                        {verificationBusy ? "Sending..." : "Send code"}
                      </button>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                        value={verificationCode}
                        onChange={(e) => {
                          setVerificationError(null);
                          setVerificationStatus(null);
                          setVerificationCode(e.target.value);
                        }}
                        placeholder="Enter email code"
                      />
                      <button
                        type="button"
                        onClick={handleConfirmEmailVerification}
                        disabled={verificationBusy || !verificationCode.trim()}
                        className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                      >
                        Verify email
                      </button>
                    </div>
                    {verificationStatus ? <div className="text-xs text-emerald-300">{verificationStatus}</div> : null}
                    {verificationError ? <div className="text-xs text-red-300">{verificationError}</div> : null}
                    {!bootstrap?.beta?.email_verification_configured ? (
                      <div className="text-xs text-zinc-500">
                        Configure Resend or SMTP environment variables on Vercel to send real email codes.
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="mt-3 rounded-2xl border border-white/10 bg-black/10 p-4 text-xs text-zinc-400">
                Phone number settings are not available yet.
              </div>

              {accountError ? <div className="mt-3 text-xs text-red-300">{accountError}</div> : null}
              {accountStatus ? <div className="mt-3 text-xs text-emerald-300">{accountStatus}</div> : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSaveAccount}
                  disabled={accountBusy}
                  className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {accountBusy ? "Saving..." : "Save profile"}
                </button>
              </div>
            </Card>

            <Card>
              <SectionTitle
                title="Account Security"
                subtitle="Update your password and keep your account protected."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Current password"
                  value={securityForm.current_password}
                  type="password"
                  onChange={(v) => {
                    setSecurityStatus(null);
                    setSecurityError(null);
                    setSecurityForm((prev) => ({ ...prev, current_password: v }));
                  }}
                  placeholder="Current password"
                />
                <Input
                  label="New password"
                  value={securityForm.new_password}
                  type="password"
                  onChange={(v) => {
                    setSecurityStatus(null);
                    setSecurityError(null);
                    setSecurityForm((prev) => ({ ...prev, new_password: v }));
                  }}
                  placeholder={`New password (${passwordPolicy.min_length}+ characters)`}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input
                  label="Confirm new password"
                  value={securityForm.confirm_password}
                  type="password"
                  onChange={(v) => {
                    setSecurityStatus(null);
                    setSecurityError(null);
                    setSecurityForm((prev) => ({ ...prev, confirm_password: v }));
                  }}
                  placeholder="Confirm new password"
                />
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4 text-xs text-zinc-400">
                  Changing your password signs out older sessions for security.
                </div>
              </div>

              <PasswordGuidance password={securityForm.new_password} policy={passwordPolicy} className="mt-4" />

              {securityError ? <div className="mt-3 text-xs text-red-300">{securityError}</div> : null}
              {securityStatus ? <div className="mt-3 text-xs text-emerald-300">{securityStatus}</div> : null}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleChangePassword}
                  disabled={securityBusy}
                  className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {securityBusy ? "Updating..." : "Change password"}
                </button>
              </div>
            </Card>

            <CollapsibleCard
              title="Display Preferences"
              subtitle="Control how dates, numbers, and money are shown across the app."
            >

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="Home currency"
                  desc="Used for labels and displays across the app."
                  value={settings.profile.homeCurrency}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, homeCurrency: v as any } }))}
                  options={[
                    { label: "USD", value: "USD" },
                    { label: "INR", value: "INR" },
                    { label: "EUR", value: "EUR" },
                    { label: "GBP", value: "GBP" },
                  ]}
                />

                <Select
                  label="Week starts on"
                  desc="Choose the day that starts your weekly view."
                  value={settings.profile.weekStartLabel}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      profile: { ...p.profile, weekStartLabel: v as any, monthStartsOn: v === "Monday" ? 1 : 7 },
                    }))
                  }
                  options={[
                    { label: "Monday", value: "Monday" },
                    { label: "Sunday", value: "Sunday" },
                  ]}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input
                  label="Timezone"
                  desc="Pulled from your browser for display purposes."
                  value={settings.profile.timezone}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, timezone: v } }))}
                />

                <div className="rounded-2xl border border-white/10 bg-black/10 p-4 text-xs text-zinc-400">
                  These controls only change how the app looks and feels for you.
                </div>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Show cents"
                  desc="Turn this off if you prefer cleaner whole-dollar displays."
                  value={settings.profile.showCents}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, showCents: v } }))}
                />
                <Toggle
                  label="Compact numbers"
                  desc="Show 12.3k instead of 12,300."
                  value={settings.profile.compactNumbers}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, compactNumbers: v } }))}
                />
              </div>
            </CollapsibleCard>

            <Card>
              <div id="bills" className="scroll-mt-24">
                <SectionTitle
                  title="Bills & Essentials"
                  subtitle="Review recurring bills and manual obligations so Financial OS can protect them before spending."
                  right={
                    <Link
                      href="/bills"
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                    >
                      Open bills workspace
                    </Link>
                  }
                />
                <Divider />

                <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm text-zinc-300">
                  Bills and manual obligations are managed on the <Link href="/bills" className="text-zinc-100 underline underline-offset-4">Bills</Link> page. Keep that list current so due-soon protection and runway planning stay reliable.
                </div>
              </div>
            </Card>

            <Card>
              <div id="debts" className="scroll-mt-24">
              <SectionTitle
                title="Debt Accounts"
                subtitle="Review the debt accounts in your plan or jump to the full debt workspace."
                right={
                  <Link
                    href="/debts"
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                  >
                    Open debt workspace
                  </Link>
                }
              />
              <Divider />

              <div className="rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm text-zinc-300">
                The full debt workflow now lives on the <Link href="/debts" className="text-zinc-100 underline underline-offset-4">Debts</Link> page for a cleaner day-to-day experience.
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
                  Accounts in plan: <span className="text-zinc-200">{debts.length}</span>
                </span>
                <button
                  type="button"
                  onClick={fetchDebtRegistry}
                  className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-zinc-200 hover:bg-white/10"
                >
                  Refresh
                </button>
              </div>

              {debtError ? <div className="mt-3 text-xs text-red-300">{debtError}</div> : null}
              {debtStatus ? <div className="mt-3 text-xs text-emerald-300">{debtStatus}</div> : null}

              <DisclosureSection
                title="Manage debt details in Settings"
                subtitle="Use this only if you want to review or edit the debt list without leaving Settings."
              >
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={startCreateDebt}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                >
                  Add debt in Settings
                </button>
              </div>
              {showCreateDebt ? (
                <div className="mt-4 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4">
                  <div className="text-sm font-medium text-zinc-100">Add debt</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    This updates the debt list used throughout your plan.
                  </div>
                  <div className="mt-4">
                    <DebtFormFields form={newDebtForm} onChange={setNewDebtForm} />
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={handleCreateDebt}
                      disabled={savingDebt}
                      className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                    >
                      {savingDebt ? "Saving..." : "Save debt"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelDebtEditor}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="mt-4 space-y-3">
                {debtsLoading ? (
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                    Loading debt accounts...
                  </div>
                ) : debts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                    No debts yet. Add one here or refresh from statements first.
                  </div>
                ) : (
                  debts.map((debt) => {
                    const isEditing = editingDebtId === debt.id;
                    return (
                      <div key={debt.id} className="rounded-2xl border border-white/10 bg-[#0B0F14] p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-100">{debt.name}</div>
                            <div className="mt-1 text-xs text-zinc-400">
                              {[debt.lender || "No lender", debt.last4 ? `**** ${debt.last4}` : "No last4"]
                                .filter(Boolean)
                                .join(" - ")}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <span
                              className={[
                                "rounded-full border px-2 py-1 text-[11px]",
                                debt.active
                                  ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
                                  : "border-white/10 bg-white/5 text-zinc-400",
                              ].join(" ")}
                            >
                              {debt.active ? "Active" : "Inactive"}
                            </span>
                            <button
                              type="button"
                              onClick={() => startEditDebt(debt)}
                              className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-100 hover:bg-white/10"
                            >
                              {isEditing ? "Editing" : "Edit"}
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 lg:grid-cols-5">
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Balance: ${Number(debt.balance || 0).toFixed(2)}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            APR: {debt.apr != null ? `${Number(debt.apr).toFixed(2)}%` : "-"}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Minimum: {debt.minimum_due != null ? `$${Number(debt.minimum_due).toFixed(2)}` : "-"}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Due day: {debt.due_day ?? "-"}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Due date: {debt.due_date || "-"}
                          </div>
                        </div>

                        {isEditing ? (
                          <div className="mt-4 rounded-2xl border border-white/10 bg-black/10 p-4">
                            <div className="text-sm font-medium text-zinc-100">Edit debt</div>
                            <div className="mt-4">
                              <DebtFormFields form={editingDebtForm} onChange={setEditingDebtForm} />
                            </div>
                            <div className="mt-4 flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={handleSaveDebtEdit}
                                disabled={savingDebt}
                                className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                              >
                                {savingDebt ? "Saving..." : "Save changes"}
                              </button>
                              <button
                                type="button"
                                onClick={cancelDebtEditor}
                                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
              </DisclosureSection>
              </div>
            </Card>

            {/* Categories & Rules */}
            <CollapsibleCard
              title="Spending Categories"
              subtitle="Keep transaction labeling simple and automatic."
            >

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Auto-categorize new transactions"
                   desc="Apply category rules automatically to save time."
                  value={settings.categories.autoCategorizeNew}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      categories: { ...p.categories, autoCategorizeNew: v },
                    }))
                  }
                />

                <Toggle
                  label="Treat payments as credits"
                  desc="Keep payment activity from cluttering spending views."
                  value={settings.categories.treatPaymentsAsCredit}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      categories: { ...p.categories, treatPaymentsAsCredit: v },
                    }))
                  }
                />

                <Toggle
                  label="Treat refunds as credits"
                  desc="Treat refunds as money coming back, not new spending."
                  value={settings.categories.treatRefundsAsCredit}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      categories: { ...p.categories, treatRefundsAsCredit: v },
                    }))
                  }
                />
              </div>

              <div className="mt-4">
                <DisclosureSection
                  title="Advanced category tools"
                  subtitle="Import, export, or customize category rule storage if you need it."
                >
                  <Input
                    label="Rules storage key"
                    desc="Leave this alone unless you are syncing category rule files manually."
                    value={settings.categories.rulesKey}
                    onChange={(v) =>
                      setSettings((p) => ({
                        ...p,
                        categories: { ...p.categories, rulesKey: v || RULES_KEY_DEFAULT },
                      }))
                    }
                    placeholder={RULES_KEY_DEFAULT}
                  />

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const key = settings.categories.rulesKey || RULES_KEY_DEFAULT;
                        const rules = safeJsonParse<Record<string, any>>(localStorage.getItem(key)) ?? {};
                        downloadJson(`category_rules_${key}.json`, rules);
                      }}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                    >
                      Export category rules
                    </button>

                    <label className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                      Import category rules
                      <input
                        type="file"
                        accept="application/json"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const txt = await fileToText(f);
                          const obj = safeJsonParse<any>(txt);
                          if (!obj || typeof obj !== "object") return;
                          const key = settings.categories.rulesKey || RULES_KEY_DEFAULT;
                          localStorage.setItem(key, JSON.stringify(obj));
                          // small nudge: re-render state
                          setSettings((p) => ({ ...p }));
                          e.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                </DisclosureSection>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Once this is set up, new transactions should stay organized with very little effort.
              </div>
            </CollapsibleCard>

            {/* Alerts */}
            <CollapsibleCard
              title="Alerts & Reminders"
              subtitle="Stay informed without getting spammed."
            >

              <Toggle
                  label="Turn on alerts"
                  desc="If this is off, the app stays quiet."
                value={settings.alerts.enabled}
                onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, enabled: v } }))}
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Select
                  label="Frequency"
                  desc="Weekly works well for most people."
                  value={settings.alerts.frequency}
                  onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, frequency: v as any } }))}
                  options={[
                    { label: "Daily", value: "Daily" },
                    { label: "Weekly", value: "Weekly" },
                    { label: "Monthly", value: "Monthly" },
                  ]}
                />

                <NumberInput
                  label="Large spend threshold"
                  desc="Get notified when a single purchase is larger than this."
                  value={settings.alerts.largeSpendThreshold}
                  min={0}
                  step={10}
                  suffix={settings.profile.homeCurrency}
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, largeSpendThreshold: Math.max(0, n) },
                    }))
                  }
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Input
                  label="Quiet hours start"
                  desc="No alerts during this window."
                  value={settings.alerts.quietHours.start}
                  onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, quietHours: { ...p.alerts.quietHours, start: v } } }))}
                  placeholder="22:00"
                />
                <Input
                  label="Quiet hours end"
                  desc="No alerts during this window."
                  value={settings.alerts.quietHours.end}
                  onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, quietHours: { ...p.alerts.quietHours, end: v } } }))}
                  placeholder="07:00"
                />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="STS goes negative"
                  desc="Only matters when Safe-to-Spend is turned on."
                  value={settings.alerts.triggers.stsNegative}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, triggers: { ...p.alerts.triggers, stsNegative: v } },
                    }))
                  }
                />
                <Toggle
                  label="Runway below target"
                  desc="Warn you when your cash cushion slips below your stage targets."
                  value={settings.alerts.triggers.runwayBelowTarget}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, triggers: { ...p.alerts.triggers, runwayBelowTarget: v } },
                    }))
                  }
                />
                <Toggle
                  label="Utilization above target"
                  desc="Warn you when card usage goes above your target."
                  value={settings.alerts.triggers.utilizationAboveTarget}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, triggers: { ...p.alerts.triggers, utilizationAboveTarget: v } },
                    }))
                  }
                />
                <Toggle
                  label="Large unusual spend"
                  desc="Trigger when one transaction crosses your threshold."
                  value={settings.alerts.triggers.largeUnusualSpend}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, triggers: { ...p.alerts.triggers, largeUnusualSpend: v } },
                    }))
                  }
                />
                <Toggle
                  label="Missed minimums risk"
                  desc="Warn you when minimum payments may be at risk."
                  value={settings.alerts.triggers.missedMinimumsRisk}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, triggers: { ...p.alerts.triggers, missedMinimumsRisk: v } },
                    }))
                  }
                />
                <Toggle
                  label="Paycheck detected"
                  desc="Notify you when incoming pay looks like a paycheck."
                  value={settings.alerts.triggers.paycheckDetected}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      alerts: { ...p.alerts, triggers: { ...p.alerts.triggers, paycheckDetected: v } },
                    }))
                  }
                />
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Future-proof: once checking/savings imports are live, these triggers become powerful and automatic.
              </div>
            </CollapsibleCard>

            {/* Data / Import behavior */}
            <CollapsibleCard
              title="Imported Data Preferences"
              subtitle="Choose how imported data refreshes and how duplicates are handled."
            >

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Refresh when I open the app"
                  desc="Pull in the latest data when you open key money views."
                  value={settings.data.autoRefreshOnOpen}
                  onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, autoRefreshOnOpen: v } }))}
                />
                <Toggle
                  label="Prevent duplicate transactions"
                  desc="Helps avoid double-counting when imports overlap."
                  value={settings.data.dedupeTransactions}
                  onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, dedupeTransactions: v } }))}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Duplicate-check window"
                  desc="How many nearby days to compare when looking for duplicates."
                  value={settings.data.dedupeWindowDays}
                  min={1}
                  max={45}
                  step={1}
                  suffix="days"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      data: { ...p.data, dedupeWindowDays: clamp(n, 1, 45) },
                    }))
                  }
                />
              </div>

              <div className="mt-3">
                <DisclosureSection
                  title="Advanced / Developer diagnostics"
                  subtitle="Extra troubleshooting tools for import or parsing issues."
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Toggle
                      label="Keep raw PDF text"
                      desc="Save raw statement text for troubleshooting import issues."
                      value={settings.data.keepRawPdfText}
                      onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, keepRawPdfText: v } }))}
                    />
                    <Toggle
                      label="Show debug tools"
                      desc="Show extra troubleshooting panels around imported data."
                      value={settings.data.showDebugPanel}
                      onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, showDebugPanel: v } }))}
                    />
                  </div>
                </DisclosureSection>
              </div>
            </CollapsibleCard>

            <Card>
              <SectionTitle
                title="Connections & Data Sources"
                subtitle="Connect your accounts and keep your money picture up to date."
              />
              <Divider />

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-sm font-medium text-zinc-100">Connected accounts</div>
                <div className="mt-1 text-xs text-zinc-400">
                  Connect or refresh your linked accounts here. You can review balances and activity anytime from the main app.
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs text-zinc-300">
                    <div className="text-zinc-400">Cash counted from connections</div>
                    <div className="mt-2 text-lg font-semibold text-zinc-100">{formatMoney(plaidCashContribution)}</div>
                    <div className="mt-1 text-zinc-500">Only counted when it does not overlap with other imported cash.</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs text-zinc-300">
                    <div className="text-zinc-400">Connected accounts</div>
                    <div className="mt-2 text-lg font-semibold text-zinc-100">{plaidAccounts.length}</div>
                    <div className="mt-1 text-zinc-500">Available in your Accounts view.</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs text-zinc-300">
                    <div className="text-zinc-400">Duplicates skipped</div>
                    <div className="mt-2 text-lg font-semibold text-zinc-100">{plaidDuplicateCount}</div>
                    <div className="mt-1 text-zinc-500">Helps keep your plan from counting the same money twice.</div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleConnectPlaidConnection}
                    disabled={plaidBusy}
                    className="rounded-xl border border-sky-500/30 bg-sky-500/15 px-3 py-2 text-xs text-sky-100 hover:bg-sky-500/20 disabled:opacity-50"
                  >
                    {plaidBusy ? "Connecting..." : "Connect accounts"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSyncPlaidData}
                    disabled={plaidBusy || !plaidItems.length}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10 disabled:opacity-50"
                  >
                    {plaidBusy ? "Syncing..." : "Refresh balances and activity"}
                  </button>
                  <Link
                    href="/accounts"
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                  >
                    Open Accounts
                  </Link>
                  <Link
                    href="/activity"
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                  >
                    Open Activity
                  </Link>
                </div>

                {plaidItems.length ? (
                  <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="text-xs font-medium text-zinc-100">Disconnect a linked institution</div>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <select
                        className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-xs text-zinc-100 outline-none focus:border-white/20"
                        value={selectedPlaidItemId}
                        onChange={(e) => setSelectedPlaidItemId(e.target.value)}
                      >
                        {plaidItems.map((item) => (
                          <option key={item.item_id} value={item.item_id}>
                            {item.institution_name || "Linked institution"} - {item.status || "linked"}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => handleUnlinkPlaidItem(selectedPlaidItemId)}
                        disabled={plaidBusy || !selectedPlaidItemId}
                        className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 hover:bg-red-500/15 disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                ) : null}

                {plaidStatus ? (
                  <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                    {plaidStatus}
                  </div>
                ) : null}

                {plaidError ? (
                  <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                    {plaidError}
                  </div>
                ) : null}

                <div className="mt-4">
                  <DisclosureSection
                    title="Advanced / Developer diagnostics"
                    subtitle="Detailed connection status, raw sync timing, and the read-only Plaid feed."
                  >
                {plaidItems.length ? (
                  <div className="mt-4 grid gap-2">
                    {plaidItems.map((item) => (
                      <div
                        key={item.item_id}
                        className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs text-zinc-300"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium text-zinc-100">
                            {item.institution_name || "Linked institution"}
                          </div>
                          <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300">
                            {item.status || "linked"}
                          </div>
                        </div>
                        <div className="mt-2 text-zinc-400">Accounts sync: {formatDateTime(item.last_accounts_sync_at)}</div>
                        <div className="mt-1 text-zinc-400">Balances sync: {formatDateTime(item.last_balances_sync_at)}</div>
                        <div className="mt-1 text-zinc-400">
                          Transactions sync: {formatDateTime(item.last_transactions_sync_at)}
                        </div>
                        {item.last_sync_error ? <div className="mt-2 text-red-300">{item.last_sync_error}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-black/20 px-3 py-4 text-xs text-zinc-400">
                    No linked Plaid accounts yet.
                  </div>
                )}

                {plaidAccounts.length ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {plaidAccounts.map((account) => (
                      <div
                        key={account.account_id}
                        className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-xs text-zinc-300"
                      >
                        <div className="text-sm font-medium text-zinc-100">{account.name}</div>
                        <div className="mt-1 text-zinc-400">
                          {(account.type || "account").toString()}
                          {account.subtype ? ` - ${account.subtype}` : ""}
                          {account.mask ? ` - ****${account.mask}` : ""}
                        </div>
                        <div className="mt-1 text-zinc-400">
                          Sync: {account.sync_status || "linked"}
                          {typeof account.current_balance === "number" ? ` - Current ${formatMoney(account.current_balance)}` : ""}
                        </div>
                        <div className="mt-1 text-zinc-400">
                          Available: {typeof account.available_balance === "number" ? formatMoney(account.available_balance) : "-"}
                          {" - "}
                          Last balance sync: {formatDateTime(account.last_balance_sync_at)}
                        </div>
                        <div className="mt-1 text-zinc-500">
                          {account.is_cash_like
                            ? "Cash-like"
                            : account.is_liability
                              ? "Liability stored separately"
                              : "Stored for future mapping"}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="mt-4 rounded-xl border border-white/10 bg-black/20 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-zinc-100">Recent Plaid transactions</div>
                      <div className="mt-1 text-xs text-zinc-400">
                        Read-only Plaid feed. PDF transaction tables remain separate.
                      </div>
                    </div>
                    <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300">
                      Plaid only
                    </div>
                  </div>

                  {plaidTransactions.length ? (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-left text-xs text-zinc-300">
                        <thead className="text-zinc-500">
                          <tr className="border-b border-white/10">
                            <th className="py-2 pr-3">date</th>
                            <th className="py-2 pr-3">account</th>
                            <th className="py-2 pr-3">merchant</th>
                            <th className="py-2 pr-3">name</th>
                            <th className="py-2 pr-0 text-right">amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plaidTransactions.map((txn) => (
                            <tr key={txn.transaction_id} className="border-b border-white/5">
                              <td className="py-2 pr-3 text-zinc-400">{txn.posted_date || txn.authorized_date || "-"}</td>
                              <td className="py-2 pr-3">
                                <div className="text-zinc-200">{txn.account_name || "Plaid account"}</div>
                                <div className="text-[11px] text-zinc-500">{txn.institution_name || "Linked institution"}</div>
                              </td>
                              <td className="py-2 pr-3 text-zinc-300">{txn.merchant_name || "-"}</td>
                              <td className="py-2 pr-3 text-zinc-300">{txn.name || "-"}</td>
                              <td className="py-2 pr-0 text-right font-mono text-zinc-100">
                                {typeof txn.amount === "number" ? formatMoney(txn.amount) : "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-xl border border-dashed border-white/10 bg-black/10 px-3 py-4 text-xs text-zinc-400">
                      No Plaid transactions synced yet.
                    </div>
                  )}
                </div>
                  </DisclosureSection>
                </div>
              </div>
            </Card>

            {/* Privacy / Export / Reset */}
            <Card>
              <SectionTitle
                title="Privacy, Backup & Reset"
                subtitle="Protect sensitive details, download a backup, or reset your preferences."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Mask merchant in screenshots"
                  desc="Helpful when you want to share screenshots more safely."
                  value={settings.privacy.maskMerchantInScreenshots}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      privacy: { ...p.privacy, maskMerchantInScreenshots: v },
                    }))
                  }
                />
                <Toggle
                  label="Hide last4 by default"
                  desc="Hide more account detail by default across the app."
                  value={settings.privacy.hideLast4ByDefault}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      privacy: { ...p.privacy, hideLast4ByDefault: v },
                    }))
                  }
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={exportAll}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                >
                  Export everything (JSON)
                </button>

                <label className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10">
                  Import everything (JSON)
                  <input
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        await importAll(f);
                      } catch {
                        // ignore UI error for MVP; can add toast later
                      } finally {
                        e.target.value = "";
                      }
                    }}
                  />
                </label>

                <button
                  type="button"
                  onClick={resetAll}
                  className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200 hover:bg-red-500/15"
                >
                  Reset settings
                </button>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Keep a backup of your setup so you can restore it later if needed.
              </div>
            </Card>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSettingsLogout}
            className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-100 hover:bg-white/10"
          >
            Log out
          </button>
        </div>
      </div>
    </AppShell>
  );
}

