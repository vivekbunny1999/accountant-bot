"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  createDebt,
  createPlaidLinkToken,
  Debt,
  exchangePlaidPublicToken,
  getUserSettings,
  getPlaidAccounts,
  listDebts,
  PlaidAccountSummary,
  PlaidItemSummary,
  saveUserSettings,
  syncPlaidData,
  updateDebt,
} from "@/lib/api";

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
    displayName: string;
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

/** ------- defaults ------- */
function defaultSettings(): SettingsModel {
  return {
    version: 1,
    profile: {
      displayName: "Vivek",
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

function Divider() {
  return <div className="my-4 h-px bg-white/10" />;
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
}: {
  label: string;
  desc?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
      <div className="text-sm font-medium text-zinc-100">{label}</div>
      {desc ? <div className="mt-1 text-xs text-zinc-400">{desc}</div> : null}
      <input
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
        desc="Inactive debts stay in history but won’t drive planning."
        value={form.active}
        onChange={(value) => onChange({ ...form, active: value })}
      />
    </div>
  );
}

export default function SettingsPage() {
  const { user } = useAuth();
  const USER_ID = user?.id ?? "";
  const [settings, setSettings] = useState<SettingsModel>(() => defaultSettings());
  const [loaded, setLoaded] = useState(false);
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

  // load persisted
  useEffect(() => {
    const s = safeJsonParse<SettingsModel>(localStorage.getItem(SETTINGS_KEY));
    if (s?.version === 1) {
      // merge with defaults so new fields never break old saves
      setSettings((prev) => ({ ...defaultSettings(), ...s }));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!USER_ID) return;
    let cancelled = false;

    (async () => {
      try {
        const remote = await getUserSettings();
        if (cancelled) return;
        if (remote?.settings && Object.keys(remote.settings).length > 0) {
          setSettings({ ...defaultSettings(), ...(remote.settings as SettingsModel) });
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

  // persist on change
  useEffect(() => {
    if (!loaded || !USER_ID) return;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    const rulesKey = settings.categories.rulesKey || RULES_KEY_DEFAULT;
    const rules = safeJsonParse<Record<string, any>>(localStorage.getItem(rulesKey)) ?? {};
    saveUserSettings({ settings, category_rules: rules }).catch(() => {});
  }, [settings, loaded, USER_ID]);

  async function fetchDebtRegistry() {
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

  useEffect(() => {
    fetchDebtRegistry();
  }, []);

  async function fetchPlaidState(opts?: { silent?: boolean }) {
    if (!opts?.silent) {
      setPlaidBusy(true);
      setPlaidError(null);
    }
    try {
      const res = await getPlaidAccounts(USER_ID);
      setPlaidAccounts(res.accounts || []);
      setPlaidItems(res.items || []);
      if (!opts?.silent && (res.accounts?.length || 0) > 0) {
        setPlaidStatus(`Loaded ${res.accounts.length} linked Plaid account${res.accounts.length === 1 ? "" : "s"}.`);
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
    fetchPlaidState({ silent: true });
  }, []);

  const quickSummary = useMemo(() => {
    const sts = settings.financialOS.sts;
    const buffer =
      sts.bufferMode === "Percent"
        ? `${fmtPct(sts.bufferPercent)} buffer`
        : `$${Math.round(sts.bufferFixed)} buffer`;
    return {
      buffer,
      strategy: settings.financialOS.debt.strategy,
      splitMode: settings.financialOS.paycheck.splitMode,
      alerts: settings.alerts.enabled ? settings.alerts.frequency : "Off",
    };
  }, [settings]);

  function resetAll() {
    localStorage.removeItem(SETTINGS_KEY);
    setSettings(defaultSettings());
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
      setSettings({ ...defaultSettings(), ...obj.settings });
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
    if (!editingDebtId) return;
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

  async function handleConnectPlaidSandbox() {
    setPlaidBusy(true);
    setPlaidError(null);
    setPlaidStatus("Preparing Plaid sandbox link...");

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
          setPlaidStatus("Link successful. Exchanging sandbox token...");

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
                `Sandbox connected to ${institutionName}. ${exchange.accounts.length} account${
                  exchange.accounts.length === 1 ? "" : "s"
                } linked, but transaction sync needs attention.`
              );
            } else {
              setPlaidStatus(
                `Sandbox connected to ${institutionName}. ${exchange.accounts.length} account${
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
      setPlaidError(err instanceof Error ? err.message : "Failed to start Plaid sandbox.");
      setPlaidStatus(null);
      setPlaidBusy(false);
      handler?.destroy?.();
    }
  }

  async function handleSyncPlaidData() {
    setPlaidBusy(true);
    setPlaidError(null);
    setPlaidStatus("Syncing Plaid balances and transactions...");
    try {
      const res = await syncPlaidData({ user_id: USER_ID, lookback_days: 30 });
      await fetchPlaidState({ silent: true });
      setPlaidStatus(
        `Plaid sync complete. ${res.accounts_synced || 0} account${res.accounts_synced === 1 ? "" : "s"} updated and ${
          res.transactions_synced || 0
        } transaction${res.transactions_synced === 1 ? "" : "s"} synced.`
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
                Tune your Financial OS once — then the app runs on autopilot with low cognitive load.
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
            {/* Safe-to-Spend */}
            <Card>
              <SectionTitle
                title="Safe-to-Spend (STS) Controls"
                subtitle="Defines your buffer rule and how conservative the app should be before it says you can spend."
              />
              <Divider />

              <Toggle
                label="Enable STS engine"
                desc="When on, the app will compute a daily Safe-to-Spend with a safety buffer."
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
                  desc="Percent scales with spending. Fixed is a constant cushion."
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
                    desc="Example: 10% means the app holds back 10% of available money."
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
                    desc="A fixed cushion the app never spends into."
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
                  desc="How many days ahead STS should consider upcoming bills."
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
                  label="Never allow negative STS"
                  desc="When enabled, STS is clamped to 0 so users never see scary negatives."
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
                Why this matters: users don’t want budgeting math — they want a single safe number that’s conservative by design.
              </div>
            </Card>

            {/* Stage targets */}
            <Card>
              <SectionTitle
                title="Stage Targets"
                subtitle="Defines what “Crisis / Stabilize / Attack Debt / Build Security / Build Wealth” means in your system."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Crisis threshold (runway months)"
                  desc="If runway is below this, stage becomes Crisis."
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
                  label="Stabilize threshold (runway months)"
                  desc="Below this, stage becomes Stabilize."
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
                  desc="Target runway used for Build Security progress."
                  value={settings.financialOS.stageTargets.runwayMonthsSecurityGoal}
                  min={1}
                  max={12}
                  step={0.5}
                  suffix="months"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        stageTargets: {
                          ...p.financialOS.stageTargets,
                          runwayMonthsSecurityGoal: clamp(n, 1, 12),
                        },
                      },
                    }))
                  }
                />

                <NumberInput
                  label="Utilization risk"
                  desc="Above this, the app warns about credit utilization."
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
                  label="High debt cost rate"
                  desc="Weighted debt APR above this is considered high-cost debt."
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
                Goal: the app classifies the user into a stage automatically, so they never have to “decide what to do next.”
              </div>
            </Card>

            {/* Paycheck splits */}
            <Card>
              <SectionTitle
                title="Paycheck Split Preferences"
                subtitle="Controls how the bot recommends splitting each paycheck into Bills / Spending / Extra."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  label="Pay cadence"
                  desc="Used for forecasting and reminders."
                  value={settings.financialOS.paycheck.cadence}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: { ...p.financialOS, paycheck: { ...p.financialOS.paycheck, cadence: v as any } },
                    }))
                  }
                  options={[
                    { label: "Weekly", value: "Weekly" },
                    { label: "Biweekly", value: "Biweekly" },
                    { label: "Semi-monthly", value: "Semimonthly" },
                    { label: "Monthly", value: "Monthly" },
                  ]}
                />

                <Input
                  label="Payday hint"
                  desc="Human hint to reduce mistakes (ex: Friday, or every other Wed)."
                  value={settings.financialOS.paycheck.paydayHint}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: { ...p.financialOS, paycheck: { ...p.financialOS.paycheck, paydayHint: v } },
                    }))
                  }
                  placeholder="Friday"
                />
              </div>

              <div className="mt-3">
                <ChipGroup
                  label="Split mode"
                  desc="Three-Caps = simple non-budgety system. Manual Buckets = explicit percentages."
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
                    { label: "Three-Caps (E/D/S)", value: "ThreeCaps" },
                    { label: "Manual Buckets", value: "ManualBuckets" },
                  ]}
                />
              </div>

              {settings.financialOS.paycheck.splitMode === "ThreeCaps" ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <NumberInput
                    label="Essentials cap"
                    desc="Bills, rent, groceries — must stay under this."
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
                    desc="Fun money cap to prevent leaks."
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
                    desc="Debt paydown + savings acceleration."
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
                    Tip: totals don’t have to be exactly 100 — the engine can normalize later. For now it’s preference guidance.
                  </div>
                </div>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  <NumberInput
                    label="Bills bucket"
                    desc="Rent, utilities, minimums"
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
                    desc="Daily spending"
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
                    desc="Debt + savings acceleration"
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
                  desc="Reduces friction and decision fatigue (most people like rounding)."
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
            </Card>

            {/* Debt strategy */}
            <Card>
              <SectionTitle
                title="Debt Strategy Preferences"
                subtitle="Controls how the bot chooses the Next Best Dollar: avalanche, snowball, or hybrid with safety constraints."
              />
              <Divider />

              <ChipGroup<DebtStrategy>
                label="Strategy"
                desc="Avalanche = highest APR first. Snowball = smallest balance first. Hybrid = Next Best Dollar with guardrails."
                value={settings.financialOS.debt.strategy}
                onChange={(v) =>
                  setSettings((p) => ({
                    ...p,
                    financialOS: { ...p.financialOS, debt: { ...p.financialOS.debt, strategy: v } },
                  }))
                }
                options={[
                  { label: "Avalanche", value: "Avalanche" },
                  { label: "Snowball", value: "Snowball" },
                  { label: "Hybrid (Next Best Dollar)", value: "Hybrid (Next Best Dollar)" },
                ]}
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Minimum extra payment"
                  desc="Below this, the bot won’t recommend splitting hairs."
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
                  desc="Soft target for credit score stability."
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
                  label="Keep cards open (preference)"
                  desc="If enabled, bot avoids recommending closures and focuses on payoff/utilization."
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
                  desc="In Hybrid mode, bot can switch targets when a better Next Best Dollar appears."
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
                  subtitle="These prevent the engine from optimizing debt while accidentally creating chaos."
                />
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Toggle
                    label="Protect minimum payments"
                    desc="Never allocate extra if minimums can’t be met."
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
                    desc="Bills bucket is funded before recommending extra debt pay."
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
                    desc="Never spend into the STS buffer to pay extra debt."
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
                    label="Enable Next Best Dollar engine"
                    desc="Hybrid recommendations use a single best-action allocation."
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
              </div>
            </Card>

            {/* Savings & Scoreboards */}
            <Card>
              <SectionTitle
                title="Savings & Scoreboards"
                subtitle="Controls emergency fund goals + which progress widgets show on the dashboard."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Emergency fund goal"
                  desc="Goal runway in months."
                  value={settings.financialOS.savings.emergencyFundGoalMonths}
                  min={1}
                  max={24}
                  step={1}
                  suffix="months"
                  onChange={(n) =>
                    setSettings((p) => ({
                      ...p,
                      financialOS: {
                        ...p.financialOS,
                        savings: { ...p.financialOS.savings, emergencyFundGoalMonths: clamp(n, 1, 24) },
                      },
                    }))
                  }
                />

                <Select
                  label="Emergency fund priority"
                  desc="When money is limited, this decides how aggressive we are."
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
                  desc="Small monthly allocations for predictable future costs (car, gifts, travel)."
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
                  desc="0–100 score + components. Motivates consistent behavior."
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
                <Toggle
                  label="Show Stability meter"
                  desc="Tracks STS never negative + runway progress."
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
                  desc="Countdown improves as extra payments accelerate."
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
                  desc="Simple progress toward financial independence."
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
                  label="Enable streaks / leveling"
                  desc="Turns consistency into a game without extra work."
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
            </Card>
          </div>

          {/* RIGHT: App, Categories, Alerts, Data, Privacy */}
          <div className="space-y-5">
            {/* Profile */}
            <Card>
              <SectionTitle
                title="Profile & Display"
                subtitle="Small choices that reduce friction everywhere (formatting, week starts, currency)."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  label="Display name"
                  desc="Used in dashboard greetings."
                  value={settings.profile.displayName}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, displayName: v } }))}
                />

                <Select
                  label="Home currency"
                  desc="Used for labels. (We can support multi-currency later.)"
                  value={settings.profile.homeCurrency}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, homeCurrency: v as any } }))}
                  options={[
                    { label: "USD", value: "USD" },
                    { label: "INR", value: "INR" },
                    { label: "EUR", value: "EUR" },
                    { label: "GBP", value: "GBP" },
                  ]}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Select
                  label="Week starts on"
                  desc="Used for weekly summaries."
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

                <Input
                  label="Timezone (display)"
                  desc="Read from browser."
                  value={settings.profile.timezone}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, timezone: v } }))}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Show cents"
                  desc="If off, UI shows rounded dollars (low cognitive load)."
                  value={settings.profile.showCents}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, showCents: v } }))}
                />
                <Toggle
                  label="Compact numbers"
                  desc="Shows 12.3k instead of 12,300."
                  value={settings.profile.compactNumbers}
                  onChange={(v) => setSettings((p) => ({ ...p, profile: { ...p.profile, compactNumbers: v } }))}
                />
              </div>
            </Card>

            <Card>
              <SectionTitle
                title="Debt Registry"
                subtitle="Keep card balances, APRs, minimums, and due timing accurate without leaving Settings."
                right={
                  <button
                    type="button"
                    onClick={startCreateDebt}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                  >
                    Add debt
                  </button>
                }
              />
              <Divider />

              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
                  Debts: <span className="text-zinc-200">{debts.length}</span>
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

              {showCreateDebt ? (
                <div className="mt-4 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4">
                  <div className="text-sm font-medium text-zinc-100">Add debt</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    This writes to the existing backend debt registry for planning and utilization.
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
                    Loading debt registry...
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
                              {[debt.lender || "No lender", debt.last4 ? `•••• ${debt.last4}` : "No last4"]
                                .filter(Boolean)
                                .join(" • ")}
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
                            APR: {debt.apr != null ? `${Number(debt.apr).toFixed(2)}%` : "—"}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Minimum: {debt.minimum_due != null ? `$${Number(debt.minimum_due).toFixed(2)}` : "—"}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Due day: {debt.due_day ?? "—"}
                          </div>
                          <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                            Due date: {debt.due_date || "—"}
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
            </Card>

            {/* Categories & Rules */}
            <Card>
              <SectionTitle
                title="Categories & Rules"
                subtitle="Where your merchant rules live (same system used on statements page)."
              />
              <Divider />

              <Input
                label="Rules storage key"
                desc="Advanced: keep consistent with statements page. Default is fine."
                value={settings.categories.rulesKey}
                onChange={(v) =>
                  setSettings((p) => ({
                    ...p,
                    categories: { ...p.categories, rulesKey: v || RULES_KEY_DEFAULT },
                  }))
                }
                placeholder={RULES_KEY_DEFAULT}
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Auto-categorize new transactions"
                  desc="Applies rules instantly so users don’t do busywork."
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
                  desc="Keeps spend views clean."
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
                  desc="Refunds don’t count as “spend”."
                  value={settings.categories.treatRefundsAsCredit}
                  onChange={(v) =>
                    setSettings((p) => ({
                      ...p,
                      categories: { ...p.categories, treatRefundsAsCredit: v },
                    }))
                  }
                />
              </div>

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

              <div className="mt-3 text-xs text-zinc-500">
                This is “set and forget.” Once rules are learned, the app categorizes automatically.
              </div>
            </Card>

            {/* Alerts */}
            <Card>
              <SectionTitle
                title="Alerts & Nudges"
                subtitle="Low-noise alerts that trigger only when something important changes."
              />
              <Divider />

              <Toggle
                label="Enable alerts"
                desc="If off, the app stays fully passive."
                value={settings.alerts.enabled}
                onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, enabled: v } }))}
              />

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Select
                  label="Frequency"
                  desc="Weekly is best for low cognitive load."
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
                  desc="Triggers an alert when a single spend exceeds this."
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
                  desc="No pings inside this window."
                  value={settings.alerts.quietHours.start}
                  onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, quietHours: { ...p.alerts.quietHours, start: v } } }))}
                  placeholder="22:00"
                />
                <Input
                  label="Quiet hours end"
                  desc="No pings inside this window."
                  value={settings.alerts.quietHours.end}
                  onChange={(v) => setSettings((p) => ({ ...p, alerts: { ...p.alerts, quietHours: { ...p.alerts.quietHours, end: v } } }))}
                  placeholder="07:00"
                />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="STS goes negative"
                  desc="Only triggers if STS engine is on."
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
                  desc="Warn when runway drops below your stage targets."
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
                  desc="Warn when utilization exceeds target."
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
                  desc="Single transaction over your threshold."
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
                  desc="Warn when minimums are in danger."
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
                  desc="Notify when checking imports detect payroll."
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
            </Card>

            {/* Data / Import behavior */}
            <Card>
              <SectionTitle
                title="Data & Import Behavior"
                subtitle="Controls performance, dedupe, and developer toggles."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Auto refresh on open"
                  desc="Fetch newest data when opening dashboard/transactions."
                  value={settings.data.autoRefreshOnOpen}
                  onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, autoRefreshOnOpen: v } }))}
                />
                <Toggle
                  label="Dedupe transactions"
                  desc="Prevents double-counting if imports overlap."
                  value={settings.data.dedupeTransactions}
                  onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, dedupeTransactions: v } }))}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Dedupe window"
                  desc="How many days around a transaction to treat as duplicate."
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
                <Toggle
                  label="Keep raw PDF text"
                  desc="Only for debugging parsing issues."
                  value={settings.data.keepRawPdfText}
                  onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, keepRawPdfText: v } }))}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Show debug panel"
                  desc="Developer-only: shows extra diagnostics."
                  value={settings.data.showDebugPanel}
                  onChange={(v) => setSettings((p) => ({ ...p, data: { ...p.data, showDebugPanel: v } }))}
                />
              </div>
            </Card>

            <Card>
              <SectionTitle
                title="Plaid Sandbox"
                subtitle="Backend-linked sandbox accounts sync server-side and can contribute cash-like balances to the Financial OS."
              />
              <Divider />

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-sm font-medium text-zinc-100">Connected accounts</div>
                <div className="mt-1 text-xs text-zinc-400">
                  Plaid stays additive here. PDF uploads keep working as-is, and linked liabilities are stored separately.
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleConnectPlaidSandbox}
                    disabled={plaidBusy}
                    className="rounded-xl border border-sky-500/30 bg-sky-500/15 px-3 py-2 text-xs text-sky-100 hover:bg-sky-500/20 disabled:opacity-50"
                  >
                    {plaidBusy ? "Connecting..." : "Connect Plaid Sandbox"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSyncPlaidData}
                    disabled={plaidBusy || !plaidItems.length}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10 disabled:opacity-50"
                  >
                    {plaidBusy ? "Syncing..." : "Sync Plaid Data"}
                  </button>
                </div>

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
                        <div className="mt-2 text-zinc-400">Accounts sync: {item.last_accounts_sync_at || "not yet"}</div>
                        <div className="mt-1 text-zinc-400">Balances sync: {item.last_balances_sync_at || "not yet"}</div>
                        <div className="mt-1 text-zinc-400">
                          Transactions sync: {item.last_transactions_sync_at || "not yet"}
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
                          {account.subtype ? ` • ${account.subtype}` : ""}
                          {account.mask ? ` • ****${account.mask}` : ""}
                        </div>
                        <div className="mt-1 text-zinc-400">
                          Sync: {account.sync_status || "linked"}
                          {typeof account.current_balance === "number" ? ` • Balance ${account.current_balance}` : ""}
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
              </div>
            </Card>

            {/* Privacy / Export / Reset */}
            <Card>
              <SectionTitle
                title="Privacy, Export, Reset"
                subtitle="Control what’s visible + backup your configuration."
              />
              <Divider />

              <div className="grid gap-3 sm:grid-cols-2">
                <Toggle
                  label="Mask merchant in screenshots"
                  desc="Good for sharing screenshots safely."
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
                  desc="Reduces sensitive exposure in UI."
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
                Export is your “future-proof” guarantee: move devices, restore instantly, or migrate to backend storage later.
              </div>
            </Card>
          </div>
        </div>

        {/* Footer note */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="text-sm font-semibold text-zinc-100">Next step</div>
          <div className="mt-1 text-sm text-zinc-400">
            After this Settings page, we’ll add Capital One Checking/Savings imports so the bot can detect paychecks, map
            fixed bills, compute STS, recommend paycheck splits, and choose the Next Best Dollar for extra debt paydown.
          </div>
        </div>
      </div>
    </AppShell>
  );
}
