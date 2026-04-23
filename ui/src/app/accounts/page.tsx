"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { getCashAccounts, getOsState, getPlaidAccounts, OsStateResponse, PlaidAccountSummary } from "@/lib/api";
import type { CashAccount } from "@/types/cash";

type SourceLabel = "Plaid" | "Imported" | "Manual";

type UnifiedAccountRow = {
  id: string;
  source: SourceLabel;
  type: string;
  name: string;
  subtitle: string;
  balance: number;
  countedInTotal: boolean;
};

function fmtMoney(n: number) {
  const value = Number(n || 0);
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function safeTime(value?: string | null) {
  const time = new Date(value ?? "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatDate(value?: string | null) {
  if (!value) return "Latest";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

function getImportedSnapshotBalance(row?: Partial<CashAccount> | null) {
  if (!row) return 0;
  return Number(row.checking_end_balance || 0) + Number(row.savings_end_balance || 0);
}

function getImportedSnapshotLabel(row?: Partial<CashAccount> | null) {
  if (!row) return "Imported cash";
  return row.account_label || row.account_name || row.institution || "Imported cash";
}

export default function AccountsPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plaidAccounts, setPlaidAccounts] = useState<PlaidAccountSummary[]>([]);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [osState, setOsState] = useState<OsStateResponse | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      const [plaidRes, cashRes, osRes] = await Promise.allSettled([
        getPlaidAccounts(userId),
        getCashAccounts({ user_id: userId, limit: 100 }),
        getOsState({ user_id: userId, window_days: 21 }),
      ]);

      if (cancelled) return;

      setPlaidAccounts(plaidRes.status === "fulfilled" ? plaidRes.value.accounts || [] : []);
      setCashAccounts(cashRes.status === "fulfilled" ? ((cashRes.value || []) as CashAccount[]) : []);
      setOsState(osRes.status === "fulfilled" ? osRes.value || null : null);

      const failures = [plaidRes, cashRes, osRes]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : "Failed to load account data");
      setError(failures.length === 3 ? failures[0] : null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const plaidCashLikeAccounts = useMemo(
    () => plaidAccounts.filter((account) => Boolean(account.is_cash_like)),
    [plaidAccounts]
  );

  const latestImportedSnapshot = useMemo(() => {
    if (!cashAccounts.length) return null;
    return [...cashAccounts].sort((a, b) => {
      const left = safeTime(b.statement_end_date || b.created_at);
      const right = safeTime(a.statement_end_date || a.created_at);
      return left - right;
    })[0] || null;
  }, [cashAccounts]);

  const importedSnapshotAccounts = useMemo<UnifiedAccountRow[]>(() => {
    if (!latestImportedSnapshot) return [];

    const rows: UnifiedAccountRow[] = [];
    const baseName = getImportedSnapshotLabel(latestImportedSnapshot);
    const snapshotSubtitle = latestImportedSnapshot.statement_period || latestImportedSnapshot.filename || "Latest imported snapshot";

    if (latestImportedSnapshot.checking_end_balance != null) {
      rows.push({
        id: `imported-checking-${latestImportedSnapshot.id}`,
        source: "Imported",
        type: "Checking",
        name: `${baseName} Checking`,
        subtitle: snapshotSubtitle,
        balance: Number(latestImportedSnapshot.checking_end_balance || 0),
        countedInTotal: true,
      });
    }

    if (latestImportedSnapshot.savings_end_balance != null) {
      rows.push({
        id: `imported-savings-${latestImportedSnapshot.id}`,
        source: "Imported",
        type: "Savings",
        name: `${baseName} Savings`,
        subtitle: snapshotSubtitle,
        balance: Number(latestImportedSnapshot.savings_end_balance || 0),
        countedInTotal: true,
      });
    }

    if (!rows.length) {
      rows.push({
        id: `imported-cash-${latestImportedSnapshot.id}`,
        source: "Imported",
        type: "Cash",
        name: baseName,
        subtitle: snapshotSubtitle,
        balance: getImportedSnapshotBalance(latestImportedSnapshot),
        countedInTotal: true,
      });
    }

    return rows;
  }, [latestImportedSnapshot]);

  const plaidCountedAccounts = useMemo<UnifiedAccountRow[]>(() => {
    const included = osState?.cash_sources?.plaid_accounts_included || [];
    return included.map((account) => ({
      id: `plaid-${account.account_id}`,
      source: "Plaid" as const,
      type: account.subtype || account.type || "Cash",
      name: account.name || account.official_name || "Plaid account",
      subtitle: [account.institution_name || "Linked institution", account.mask ? `•••• ${account.mask}` : null]
        .filter(Boolean)
        .join(" • "),
      balance: Number(account.counted_balance ?? account.current_balance ?? account.available_balance ?? 0),
      countedInTotal: true,
    }));
  }, [osState]);

  const unifiedAccounts = useMemo(
    () => [...plaidCountedAccounts, ...importedSnapshotAccounts],
    [plaidCountedAccounts, importedSnapshotAccounts]
  );

  const groupedAccounts = useMemo(() => {
    const map = new Map<string, { source: SourceLabel; type: string; count: number; total: number }>();

    for (const row of unifiedAccounts) {
      const key = `${row.source}__${row.type}`;
      const entry = map.get(key) || { source: row.source, type: row.type, count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number(row.balance || 0);
      map.set(key, entry);
    }

    return Array.from(map.values()).sort((a, b) => {
      const sourceOrder = ["Plaid", "Imported", "Manual"];
      const sourceDiff = sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source);
      if (sourceDiff !== 0) return sourceDiff;
      return a.type.localeCompare(b.type);
    });
  }, [unifiedAccounts]);

  const plaidDuplicates = osState?.cash_sources?.plaid_duplicate_accounts_skipped || [];
  const totalCash = Number(osState?.cash_total || 0);
  const plaidCashTotal = Number(osState?.cash_sources?.plaid_cash_total || 0);
  const importedCashTotal = Number(
    osState?.cash_sources?.pdf_cash_total ?? getImportedSnapshotBalance(latestImportedSnapshot)
  );

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-lg font-semibold text-zinc-100">Accounts</div>
              <div className="mt-1 text-sm text-zinc-400">
                A unified view of cash accounts across linked sources, with Financial OS totals aligned to backend source rules.
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-400">
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-zinc-300">Plaid</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-zinc-300">Imported</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href="/plaid"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
              >
                Plaid Details
              </Link>
              <Link
                href="/cash-accounts"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
              >
                Cash Imports
              </Link>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5 text-sm text-zinc-400">
            Loading account overview...
          </div>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Total cash overview</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(totalCash)}</div>
            <div className="mt-1 text-xs text-zinc-500">Financial OS total from `/os/state`</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Plaid linked cash-like accounts</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(plaidCashTotal)}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {plaidCashLikeAccounts.length} linked cash-like accounts
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Imported cash snapshot</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(importedCashTotal)}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {latestImportedSnapshot ? `Latest import ${formatDate(latestImportedSnapshot.statement_end_date || latestImportedSnapshot.created_at)}` : "No imported cash snapshot yet"}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Account groups by source/type</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{groupedAccounts.length}</div>
            <div className="mt-1 text-xs text-zinc-500">{unifiedAccounts.length} visible account rows</div>
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-5">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Plaid cash accounts</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Linked cash-like accounts shown with the balances Financial OS is currently counting.
                  </div>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300">
                  Source: Plaid
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {plaidCountedAccounts.length ? (
                  plaidCountedAccounts.map((account) => (
                    <div key={account.id} className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-zinc-100">{account.name}</div>
                          <div className="mt-1 text-xs text-zinc-400">{account.subtitle}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold text-zinc-100">{fmtMoney(account.balance)}</div>
                          <div className="mt-1 text-[11px] text-zinc-500">{account.type}</div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                    No Plaid cash accounts are currently counted in Financial OS.
                  </div>
                )}
              </div>

              {plaidDuplicates.length ? (
                <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100">
                  {plaidDuplicates.length} Plaid cash account{plaidDuplicates.length === 1 ? "" : "s"} are currently skipped to avoid double-counting imported cash.
                </div>
              ) : null}
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">Imported cash accounts</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Latest PDF-imported cash snapshot, kept separate from linked source data.
                  </div>
                </div>
                <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300">
                  Source: Imported
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {importedSnapshotAccounts.length ? (
                  importedSnapshotAccounts.map((account) => (
                    <div key={account.id} className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-zinc-100">{account.name}</div>
                          <div className="mt-1 text-xs text-zinc-400">{account.subtitle}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold text-zinc-100">{fmtMoney(account.balance)}</div>
                          <div className="mt-1 text-[11px] text-zinc-500">{account.type}</div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                    No imported cash snapshot has been uploaded yet.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-5">
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="text-sm font-semibold text-zinc-100">Source totals</div>
              <div className="mt-1 text-xs text-zinc-400">
                These totals mirror the backend Financial OS source breakdown instead of merging transaction tables.
              </div>

              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-zinc-300">Plaid</span>
                    <span className="font-semibold text-zinc-100">{fmtMoney(plaidCashTotal)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-zinc-300">Imported</span>
                    <span className="font-semibold text-zinc-100">{fmtMoney(importedCashTotal)}</span>
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 px-4 py-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-zinc-300">Total cash</span>
                    <span className="font-semibold text-zinc-100">{fmtMoney(totalCash)}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="text-sm font-semibold text-zinc-100">Account groups</div>
              <div className="mt-1 text-xs text-zinc-400">
                A simple grouping layer so users see one product structure instead of one page per source.
              </div>

              <div className="mt-4 space-y-3">
                {groupedAccounts.length ? (
                  groupedAccounts.map((group) => (
                    <div key={`${group.source}-${group.type}`} className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-zinc-100">
                            {group.source} / {group.type}
                          </div>
                          <div className="mt-1 text-xs text-zinc-400">{group.count} account{group.count === 1 ? "" : "s"}</div>
                        </div>
                        <div className="text-sm font-semibold text-zinc-100">{fmtMoney(group.total)}</div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                    No account groups are available yet.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
