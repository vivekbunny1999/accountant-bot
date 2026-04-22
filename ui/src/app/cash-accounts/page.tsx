"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  getCashAccounts,
  getCashAccountTransactions,
  uploadCapitalOneBankPdf,
  deleteCashAccount,
  updateCashTransactionCategory,
} from "@/lib/api";
import type { CashAccount, CashTxn } from "@/types/cash";

type SortKey = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";
type TxnType = "credit" | "debit";

const CATEGORY_OPTIONS = [
  "Uncategorized",
  "Income",
  "Transfer",
  "Groceries",
  "Dining",
  "Gas",
  "Shopping",
  "Bills",
  "Rent",
  "Utilities",
  "Subscriptions",
  "Healthcare",
  "Insurance",
  "Travel",
  "Entertainment",
  "Fees",
  "ATM/Cash",
  "Education",
  "Other",
] as const;

function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

function fmtMoney(n: number) {
  const v = Number(n || 0);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatDate(isoLike: string | null | undefined) {
  if (!isoLike) return "—";
  const d = new Date(isoLike);
  if (Number.isNaN(d.getTime())) return isoLike;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function clampString(v: unknown) {
  return typeof v === "string" ? v : "";
}

function getTxnAmount(txn: CashTxn): number {
  const anyTxn: any = txn as any;
  if (typeof anyTxn.amount === "number") return anyTxn.amount;
  if (typeof anyTxn.amount_cents === "number") return anyTxn.amount_cents / 100;
  if (typeof anyTxn.debit === "number" && anyTxn.debit !== 0) return -Math.abs(anyTxn.debit);
  if (typeof anyTxn.credit === "number" && anyTxn.credit !== 0) return Math.abs(anyTxn.credit);
  if (typeof anyTxn.amount_abs === "number") {
    const dir = String(anyTxn.direction ?? anyTxn.type ?? "").toLowerCase();
    const abs = Math.abs(anyTxn.amount_abs);
    if (dir.includes("debit") || dir.includes("out")) return -abs;
    return abs;
  }
  return 0;
}

function getTxnTypeAuto(txn: CashTxn): TxnType {
  const amt = getTxnAmount(txn);
  return amt < 0 ? "debit" : "credit";
}

function getTxnDescription(txn: CashTxn): string {
  const anyTxn: any = txn as any;
  return (
    clampString(anyTxn.description) ||
    clampString(anyTxn.merchant) ||
    clampString(anyTxn.name) ||
    clampString(anyTxn.memo) ||
    "—"
  );
}

function getTxnCategory(txn: CashTxn): string {
  const anyTxn: any = txn as any;
  const cat = clampString(anyTxn.category);
  return cat || "Uncategorized";
}

function getTxnDate(txn: CashTxn): string {
  const anyTxn: any = txn as any;
  return clampString(anyTxn.posted_date) || clampString(anyTxn.transaction_date) || clampString(anyTxn.date) || "";
}

function getAccountDisplayName(acc: CashAccount): string {
  const anyAcc: any = acc as any;
  return (
    clampString(anyAcc.nickname) ||
    clampString(anyAcc.account_name) ||
    clampString(anyAcc.name) ||
    `Account ${String(anyAcc.id ?? "")}`
  );
}

function getAccountType(acc: CashAccount): string {
  const anyAcc: any = acc as any;
  return clampString(anyAcc.account_type) || clampString(anyAcc.type) || "Cash Account";
}

function getAccountBalance(acc: CashAccount): number {
  const anyAcc: any = acc as any;
  if (typeof anyAcc.balance === "number") return anyAcc.balance;
  if (typeof anyAcc.current_balance === "number") return anyAcc.current_balance;
  if (typeof anyAcc.available_balance === "number") return anyAcc.available_balance;
  if (typeof anyAcc.balance_cents === "number") return anyAcc.balance_cents / 100;
  return 0;
}

/** Custom dark dropdown: black menu, visible text, blue selection */
function DarkSelect<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
}) {
  const { value, onChange, options, disabled, className, buttonClassName } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const selected = options.find((o) => o.value === value)?.label ?? String(value);

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((s) => !s)}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#0B0F14] px-2 py-1.5 text-xs text-zinc-100 outline-none",
          "hover:bg-white/5 focus:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed",
          buttonClassName
        )}
      >
        <span className="truncate">{selected}</span>
        <span className="text-zinc-400">▾</span>
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-white/10 bg-black shadow-xl">
          <div className="max-h-64 overflow-auto py-1">
            {options.map((o) => {
              const isSel = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center px-3 py-2 text-left text-xs",
                    isSel ? "bg-blue-600 text-white" : "text-zinc-100 hover:bg-blue-900/40"
                  )}
                >
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function CashAccountsPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [selectedAccountId, setSelectedAccountId] = useState<string | number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [txns, setTxns] = useState<CashTxn[]>([]);
  const [txnsLoading, setTxnsLoading] = useState(false);
  const [txnsError, setTxnsError] = useState<string | null>(null);

  // Controls
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "debit" | "credit">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<"30" | "90" | "all">("90");
  const [sortKey, setSortKey] = useState<SortKey>("date_desc");

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Delete state
  const [deletingId, setDeletingId] = useState<string | number | null>(null);

  // Row-level category update state
  const [updatingTxnId, setUpdatingTxnId] = useState<string | number | null>(null);

  // Local per-row type override (UI-only)
  const [typeOverride, setTypeOverride] = useState<Record<string, TxnType>>({});

  async function loadAccounts(selectFirstIfEmpty = true) {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const data = await getCashAccounts({ user_id: userId, limit: 100 });
      const list = Array.isArray(data) ? data : (data as any)?.items ?? [];
      setAccounts(list);

      if (selectFirstIfEmpty) {
        const existing = selectedAccountId;
        const stillExists = list.some((a: any) => String(a.id) === String(existing));
        if (!existing || !stillExists) {
          const first = list[0];
          setSelectedAccountId(first ? (first as any).id : null);
        }
      }
    } catch (e: any) {
      setAccountsError(e?.message ?? "Failed to load cash accounts.");
    } finally {
      setAccountsLoading(false);
    }
  }

  async function loadTransactions(accountId: string | number) {
    setTxnsLoading(true);
    setTxnsError(null);
    try {
      const data = await getCashAccountTransactions(accountId, { user_id: userId, limit: 500 });
      const list = Array.isArray(data) ? data : (data as any)?.items ?? [];
      setTxns(list);
      setTypeOverride({});
    } catch (e: any) {
      setTxnsError(e?.message ?? "Failed to load transactions.");
    } finally {
      setTxnsLoading(false);
    }
  }

  useEffect(() => {
    loadAccounts(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedAccount = useMemo(() => {
    return accounts.find((a: any) => String(a.id) === String(selectedAccountId)) ?? null;
  }, [accounts, selectedAccountId]);

  const derived = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = new Date();
    const cutoff =
      dateRange === "all"
        ? null
        : new Date(now.getTime() - (dateRange === "30" ? 30 : 90) * 24 * 60 * 60 * 1000);

    let rows = txns.slice();

    if (cutoff) {
      rows = rows.filter((t) => {
        const d = new Date(getTxnDate(t));
        if (Number.isNaN(d.getTime())) return true;
        return d >= cutoff;
      });
    }

    if (typeFilter !== "all") {
      rows = rows.filter((t: any) => {
        const id = String(t.id ?? "");
        const effectiveType = typeOverride[id] ?? getTxnTypeAuto(t);
        return typeFilter === "debit" ? effectiveType === "debit" : effectiveType === "credit";
      });
    }

    if (categoryFilter !== "all") {
      rows = rows.filter((t) => getTxnCategory(t) === categoryFilter);
    }

    if (q) {
      rows = rows.filter((t: any) => {
        const desc = getTxnDescription(t).toLowerCase();
        const cat = getTxnCategory(t).toLowerCase();
        const effectiveType = (typeOverride[String(t.id ?? "")] ?? getTxnTypeAuto(t)).toLowerCase();
        const amt = fmtMoney(getTxnAmount(t)).toLowerCase();
        const date = formatDate(getTxnDate(t)).toLowerCase();
        return desc.includes(q) || cat.includes(q) || effectiveType.includes(q) || amt.includes(q) || date.includes(q);
      });
    }

    rows.sort((a: any, b: any) => {
      if (sortKey.startsWith("date")) {
        const da = new Date(getTxnDate(a)).getTime();
        const db = new Date(getTxnDate(b)).getTime();
        const va = Number.isNaN(da) ? 0 : da;
        const vb = Number.isNaN(db) ? 0 : db;
        return sortKey === "date_desc" ? vb - va : va - vb;
      }
      const aa = getTxnAmount(a);
      const ab = getTxnAmount(b);
      return sortKey === "amount_desc" ? ab - aa : aa - ab;
    });

    let inflow = 0;
    let outflow = 0;
    for (const t of rows) {
      const amt = getTxnAmount(t);
      const id = String((t as any).id ?? "");
      const effectiveType = typeOverride[id] ?? getTxnTypeAuto(t);
      const abs = Math.abs(amt);
      if (effectiveType === "credit") inflow += abs;
      else outflow += abs;
    }
    const net = inflow - outflow;

    const categorySet = new Set<string>();
    for (const t of txns) categorySet.add(getTxnCategory(t));
    const categoryList = Array.from(categorySet).sort((a, b) => a.localeCompare(b));

    return { rows, inflow, outflow, net, categoryList };
  }, [txns, search, typeFilter, categoryFilter, dateRange, sortKey, typeOverride]);

  async function onUploadBankPdf(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      await uploadCapitalOneBankPdf(file, { user_id: userId });
      await loadAccounts(false);
    } catch (e: any) {
      setUploadError(e?.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteAccount(accId: string | number) {
    const ok = window.confirm("Delete this cash account and its imported transactions? This cannot be undone.");
    if (!ok) return;

    setDeletingId(accId);
    try {
      await deleteCashAccount(accId, { user_id: userId });
      await loadAccounts(false);

      if (String(selectedAccountId) === String(accId)) {
        setSelectedAccountId(null);
        setTxns([]);
        setDetailsOpen(false);
      }
    } catch (e: any) {
      alert(e?.message ?? "Failed to delete cash account.");
    } finally {
      setDeletingId(null);
    }
  }

  async function onChangeCategory(txn: CashTxn, newCategory: string) {
    const anyTxn: any = txn as any;
    const txnId = anyTxn.id;
    if (txnId === undefined || txnId === null) return;

    const prev = getTxnCategory(txn);
    if (prev === newCategory) return;

    setTxns((old) => old.map((t: any) => (String(t.id) === String(txnId) ? { ...t, category: newCategory } : t)));

    setUpdatingTxnId(txnId);
    try {
      await updateCashTransactionCategory(txnId, newCategory, { user_id: userId });
    } catch (e: any) {
      setTxns((old) => old.map((t: any) => (String(t.id) === String(txnId) ? { ...t, category: prev } : t)));
      alert(e?.message ?? "Failed to update category.");
    } finally {
      setUpdatingTxnId(null);
    }
  }

  return (
    <AppShell>
      {/* IMPORTANT: relative wrapper so details overlay is only inside main content (sidebar stays) */}
      <div className="relative mx-auto w-full max-w-7xl px-4 py-6">
        {/* Header */}
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Cash Accounts</h1>
            <p className="mt-1 text-sm text-zinc-400">
              Import Capital One checking/savings PDFs, review balances, and categorize transactions.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadBankPdf(f);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10 disabled:opacity-40"
            >
              {uploading ? "Uploading…" : "Upload bank PDF"}
            </button>

            <button
              type="button"
              onClick={() => loadAccounts(false)}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
            >
              Refresh
            </button>
          </div>
        </div>

        {uploadError ? (
          <div className="mb-4 rounded-2xl border border-white/10 bg-[#0E141C] p-4 text-sm text-red-400">
            {uploadError}
          </div>
        ) : null}

        {/* Filters card (match transactions/page.tsx style) */}
        <div className="mb-4 rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-center">
            <div className="md:col-span-5">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search description, amount, category, date…"
                className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
              />
            </div>

            <div className="md:col-span-2">
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as any)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
              >
                <option value="all">All types</option>
                <option value="credit">Credit</option>
                <option value="debit">Debit</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as any)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
              >
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="all">All time</option>
              </select>
            </div>

            <div className="md:col-span-3">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
              >
                <option value="date_desc">Date: newest</option>
                <option value="date_asc">Date: oldest</option>
                <option value="amount_desc">Amount: high → low</option>
                <option value="amount_asc">Amount: low → high</option>
              </select>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-zinc-400">Quick filters:</span>

            <button
              type="button"
              onClick={() => {
                setSearch("");
                setTypeFilter("all");
                setCategoryFilter("all");
                setDateRange("90");
                setSortKey("date_desc");
              }}
              className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
            >
              Reset
            </button>

            <div className="ml-auto flex items-center gap-2">
              <label className="text-xs text-zinc-400">Category:</label>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-xs text-zinc-100 outline-none focus:border-white/20"
              >
                <option value="all">All</option>
                {derived.categoryList.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Accounts list */}
          <div className="lg:col-span-4">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Accounts</div>
                  <div className="text-xs text-zinc-400">{accountsLoading ? "Loading…" : `${accounts.length} imported`}</div>
                </div>
              </div>

              {accountsError ? <div className="mt-3 text-sm text-red-400">{accountsError}</div> : null}

              <div className="mt-4 max-h-[560px] overflow-auto rounded-xl border border-white/10">
                {accountsLoading ? (
                  <div className="p-4 text-sm text-zinc-400">Loading cash accounts…</div>
                ) : accounts.length === 0 ? (
                  <div className="p-4 text-sm text-zinc-400">
                    No cash accounts yet. Upload a Capital One bank PDF to import checking/savings.
                  </div>
                ) : (
                  <ul className="divide-y divide-white/5">
                    {accounts.map((acc: any) => {
                      const active = String(acc.id) === String(selectedAccountId);
                      const name = getAccountDisplayName(acc);
                      const type = getAccountType(acc);
                      const bal = getAccountBalance(acc);

                      return (
                        <li
                          key={String(acc.id)}
                          className={cn("cursor-pointer p-4 transition", active ? "bg-white/5" : "hover:bg-white/5")}
                          onClick={async () => {
                            setSelectedAccountId(acc.id);
                            setDetailsOpen(true);
                            await loadTransactions(acc.id);
                          }}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-zinc-100">{name}</div>
                              <div className="mt-0.5 truncate text-xs text-zinc-400">{type}</div>
                            </div>

                            <div className="shrink-0 text-right">
                              <div className="text-sm font-semibold text-zinc-100">{fmtMoney(bal)}</div>

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteAccount(acc.id);
                                }}
                                disabled={deletingId !== null}
                                className="mt-2 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10 disabled:opacity-40"
                              >
                                {String(deletingId) === String(acc.id) ? "Deleting…" : "Delete"}
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* Summary boxes (same style as transactions cards) */}
          <div className="lg:col-span-8">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="text-sm font-semibold text-zinc-100">Overview (filtered)</div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-xs text-zinc-400">Inflow</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">{fmtMoney(derived.inflow)}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-xs text-zinc-400">Outflow</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">{fmtMoney(-derived.outflow)}</div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                  <div className="text-xs text-zinc-400">Net</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-100">{fmtMoney(derived.net)}</div>
                </div>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Click an account to open a large details view inside this page (sidebar stays).
              </div>
            </div>
          </div>
        </div>

        {/* Details overlay INSIDE main content only (sidebar stays visible) */}
        {detailsOpen ? (
          <div className="absolute inset-0 z-40">
            {/* Backdrop only over main content */}
            <div className="absolute inset-0 bg-black/60" onClick={() => setDetailsOpen(false)} />

            <div className="absolute inset-x-0 top-0 z-50 mx-auto w-full max-w-7xl px-4 py-6">
              <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
                {/* Header row */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-lg font-semibold text-zinc-100">
                      {selectedAccount ? getAccountDisplayName(selectedAccount) : "Account Details"}
                    </div>
                    <div className="mt-1 text-sm text-zinc-400">
                      {selectedAccount ? getAccountType(selectedAccount) : "—"}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {/* Net shown on main row */}
                    <div className="text-right">
                      <div className="text-xs text-zinc-400">Net (filtered)</div>
                      <div className="text-base font-semibold text-zinc-100">{fmtMoney(derived.net)}</div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setDetailsOpen(false)}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                    >
                      Close
                    </button>
                  </div>
                </div>

                {/* Top stats row */}
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                    <div className="text-xs text-zinc-400">Balance</div>
                    <div className="mt-1 text-sm font-semibold text-zinc-100">
                      {selectedAccount ? fmtMoney(getAccountBalance(selectedAccount)) : "—"}
                    </div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                    <div className="text-xs text-zinc-400">Inflow</div>
                    <div className="mt-1 text-sm font-semibold text-zinc-100">{fmtMoney(derived.inflow)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                    <div className="text-xs text-zinc-400">Outflow</div>
                    <div className="mt-1 text-sm font-semibold text-zinc-100">{fmtMoney(-derived.outflow)}</div>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                    <div className="text-xs text-zinc-400">Shown / Total</div>
                    <div className="mt-1 text-sm font-semibold text-zinc-100">
                      {txnsLoading ? "Loading…" : `${derived.rows.length} / ${txns.length}`}
                    </div>
                  </div>
                </div>

                {/* Transactions table */}
                <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-[#0B0F14]">
                  {txnsError ? (
                    <div className="p-4 text-sm text-red-400">{txnsError}</div>
                  ) : null}

                  <div className="max-h-[60vh] overflow-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="sticky top-0 z-10 bg-[#0E141C]">
                        <tr className="border-b border-white/5">
                          <th className="px-3 py-2 text-xs font-semibold text-zinc-300">Date</th>
                          <th className="px-3 py-2 text-xs font-semibold text-zinc-300">Description</th>
                          <th className="px-3 py-2 text-xs font-semibold text-zinc-300">Type</th>
                          <th className="px-3 py-2 text-xs font-semibold text-zinc-300">Category</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-zinc-300">Amount</th>
                        </tr>
                      </thead>

                      <tbody className="divide-y divide-white/5">
                        {txnsLoading ? (
                          <tr>
                            <td className="px-3 py-6 text-sm text-zinc-400" colSpan={5}>
                              Loading transactions…
                            </td>
                          </tr>
                        ) : derived.rows.length === 0 ? (
                          <tr>
                            <td className="px-3 py-6 text-sm text-zinc-400" colSpan={5}>
                              No transactions match your filters.
                            </td>
                          </tr>
                        ) : (
                          derived.rows.map((t: any) => {
                            const id = String(t.id ?? `${getTxnDate(t)}-${getTxnDescription(t)}-${getTxnAmount(t)}`);
                            const date = getTxnDate(t);
                            const desc = getTxnDescription(t);
                            const cat = getTxnCategory(t);
                            const amtRaw = getTxnAmount(t);

                            const effectiveType = typeOverride[id] ?? getTxnTypeAuto(t);
                            const absAmt = Math.abs(amtRaw);
                            const displayAmt = effectiveType === "debit" ? -absAmt : absAmt;

                            return (
                              <tr key={id} className="hover:bg-white/5">
                                <td className="whitespace-nowrap px-3 py-2 text-sm text-zinc-200">
                                  {formatDate(date)}
                                </td>

                                <td className="min-w-[280px] px-3 py-2 text-sm text-zinc-100">
                                  <div className="truncate">{desc}</div>
                                </td>

                                {/* Credit/Debit dropdown (auto but editable) */}
                                <td className="whitespace-nowrap px-3 py-2">
                                  <DarkSelect<TxnType>
                                    value={effectiveType}
                                    onChange={(v) => setTypeOverride((m) => ({ ...m, [id]: v }))}
                                    options={[
                                      { value: "credit", label: "credit" },
                                      { value: "debit", label: "debit" },
                                    ]}
                                    className="w-28"
                                  />
                                </td>

                                {/* Category dropdown */}
                                <td className="whitespace-nowrap px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <DarkSelect<string>
                                      value={cat}
                                      onChange={(v) => onChangeCategory(t, v)}
                                      options={CATEGORY_OPTIONS.map((c) => ({ value: c, label: c }))}
                                      disabled={updatingTxnId !== null}
                                      className="w-56"
                                    />
                                    {String(updatingTxnId) === String(t.id) ? (
                                      <span className="text-xs text-zinc-500">Saving…</span>
                                    ) : null}
                                  </div>
                                </td>

                                <td className="whitespace-nowrap px-3 py-2 text-right font-semibold text-zinc-100">
                                  {fmtMoney(displayAmt)}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>

                      {derived.rows.length > 0 && !txnsLoading ? (
                        <tfoot className="sticky bottom-0 bg-[#0E141C]">
                          <tr className="border-t border-white/5">
                            <td className="px-3 py-2 text-xs font-semibold text-zinc-300" colSpan={2}>
                              Totals (filtered)
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-400" colSpan={2}>
                              In: {fmtMoney(derived.inflow)} · Out: {fmtMoney(-derived.outflow)}
                            </td>
                            <td className="px-3 py-2 text-right text-xs font-semibold text-zinc-200">
                              Net: {fmtMoney(derived.net)}
                            </td>
                          </tr>
                        </tfoot>
                      ) : null}
                    </table>
                  </div>
                </div>

                <div className="mt-3 text-xs text-zinc-500">
                  Category saves to backend. Type dropdown is UI-only for now (doesn’t change stored amount/type).
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
