"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  getOsState,
  getPlaidAccounts,
  getPlaidTransactions,
  OsStateResponse,
  PlaidAccountSummary,
  PlaidItemSummary,
  PlaidTransactionSummary,
} from "@/lib/api";

function fmtMoney(n: number) {
  const v = Number(n || 0);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtDateTime(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PlaidPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [osState, setOsState] = useState<OsStateResponse | null>(null);
  const [items, setItems] = useState<PlaidItemSummary[]>([]);
  const [accounts, setAccounts] = useState<PlaidAccountSummary[]>([]);
  const [transactions, setTransactions] = useState<PlaidTransactionSummary[]>([]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const [accountsRes, transactionsRes, stateRes] = await Promise.all([
          getPlaidAccounts(userId),
          getPlaidTransactions({ user_id: userId, limit: 100 }),
          getOsState({ user_id: userId, window_days: 21 }),
        ]);

        if (cancelled) return;
        setItems(accountsRes?.items || []);
        setAccounts(accountsRes?.accounts || []);
        setTransactions(transactionsRes?.transactions || []);
        setOsState(stateRes || null);
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load Plaid data.");
          setItems([]);
          setAccounts([]);
          setTransactions([]);
          setOsState(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const cashAccounts = useMemo(
    () => accounts.filter((account) => Boolean(account.is_cash_like)),
    [accounts]
  );

  const liabilityAccounts = useMemo(
    () => accounts.filter((account) => Boolean(account.is_liability)),
    [accounts]
  );

  const plaidIncludedAccounts = osState?.cash_sources?.plaid_accounts_included || [];
  const duplicateAccounts = osState?.cash_sources?.plaid_duplicate_accounts_skipped || [];

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">Plaid</div>
              <div className="mt-1 text-sm text-zinc-400">
                Backend source-of-truth view for linked Plaid items, accounts, transactions, and Financial OS cash usage.
              </div>
            </div>

            <div className="flex gap-2">
              <Link
                href="/dashboard"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
              >
                Dashboard
              </Link>
              <Link
                href="/settings"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
              >
                Settings
              </Link>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5 text-sm text-zinc-400">
            Loading Plaid data…
          </div>
        ) : null}

        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Linked institutions</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{items.length}</div>
            <div className="mt-1 text-xs text-zinc-500">Rows in `plaid_items` for this user</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Accounts stored</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{accounts.length}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {cashAccounts.length} cash-like • {liabilityAccounts.length} liabilities
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Transactions visible</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{transactions.length}</div>
            <div className="mt-1 text-xs text-zinc-500">Rendered from `/plaid/transactions`</div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Plaid cash counted by Financial OS</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">
              {fmtMoney(Number(osState?.cash_sources?.plaid_cash_total || 0))}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              PDF cash {fmtMoney(Number(osState?.cash_sources?.pdf_cash_total || 0))}
            </div>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-sm font-semibold text-zinc-100">Financial OS Trace</div>
            <div className="mt-1 text-xs text-zinc-400">
              This is the path from Plaid sync to safe-to-spend inputs.
            </div>

            <div className="mt-4 space-y-3 text-sm text-zinc-300">
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                1. Plaid enters the backend through the link-token, public-token exchange, and sync routes.
              </div>
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                2. Backend stores items in `plaid_items`, balances in `plaid_accounts`, and transactions in `plaid_transactions`.
              </div>
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                3. Financial OS reads cash-like Plaid accounts from `/os/state` and combines them with PDF cash without mixing transaction tables.
              </div>
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                4. Dashboard safe-to-spend uses backend cash total, upcoming obligations, and buffer through `/os/next-best-dollar`.
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-sm font-semibold text-zinc-100">Cash Inputs Used by Financial OS</div>
            <div className="mt-1 text-xs text-zinc-400">
              Only non-duplicate Plaid cash accounts are counted toward backend cash total.
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                <div className="text-xs text-zinc-400">Total cash</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">
                  {fmtMoney(Number(osState?.cash_total || 0))}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-3">
                <div className="text-xs text-zinc-400">Upcoming obligations</div>
                <div className="mt-1 text-lg font-semibold text-zinc-100">
                  {fmtMoney(Number(osState?.upcoming_total || 0))}
                </div>
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
                        </div>
                      </div>
                      <div className="text-right font-mono text-zinc-100">
                        {fmtMoney(Number(account.counted_balance || account.current_balance || 0))}
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

            {duplicateAccounts.length ? (
              <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-xs text-amber-100">
                {duplicateAccounts.length} Plaid cash account{duplicateAccounts.length === 1 ? "" : "s"} skipped to avoid double-counting
                against PDF cash imports.
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-zinc-100">Linked Plaid Items</div>
              <div className="mt-1 text-xs text-zinc-400">Institution-level sync status</div>
            </div>
            <div className="text-xs text-zinc-500">{items.length} item{items.length === 1 ? "" : "s"}</div>
          </div>

          <div className="mt-4 grid gap-2">
            {items.length ? (
              items.map((item) => (
                <div
                  key={item.item_id}
                  className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-3 text-xs text-zinc-300"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-zinc-100">{item.institution_name || "Linked institution"}</div>
                    <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-zinc-300">
                      {item.status || "linked"}
                    </div>
                  </div>
                  <div className="mt-2 text-zinc-400">Accounts sync: {fmtDateTime(item.last_accounts_sync_at)}</div>
                  <div className="mt-1 text-zinc-400">Balances sync: {fmtDateTime(item.last_balances_sync_at)}</div>
                  <div className="mt-1 text-zinc-400">Transactions sync: {fmtDateTime(item.last_transactions_sync_at)}</div>
                  {item.last_sync_error ? <div className="mt-2 text-red-300">{item.last_sync_error}</div> : null}
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] px-3 py-4 text-xs text-zinc-400">
                No Plaid items linked yet.
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.1fr_1.9fr]">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-sm font-semibold text-zinc-100">Accounts</div>
            <div className="mt-1 text-xs text-zinc-400">Separate from PDF cash and statement tables</div>

            <div className="mt-4 space-y-2">
              {accounts.length ? (
                accounts.map((account) => (
                  <div
                    key={account.account_id}
                    className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-3 text-xs text-zinc-300"
                  >
                    <div className="text-sm font-medium text-zinc-100">{account.name}</div>
                    <div className="mt-1 text-zinc-500">
                      {account.institution_name || "Linked institution"}
                      {account.mask ? ` • ****${account.mask}` : ""}
                    </div>
                    <div className="mt-1 text-zinc-400">
                      {(account.type || "account").toString()}
                      {account.subtype ? ` • ${account.subtype}` : ""}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <div className="text-zinc-400">{account.sync_status || "linked"}</div>
                      <div className="font-mono text-zinc-100">
                        {typeof account.current_balance === "number" ? fmtMoney(account.current_balance) : "—"}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] px-3 py-4 text-xs text-zinc-400">
                  No Plaid accounts stored yet.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-zinc-100">Transactions</div>
                <div className="mt-1 text-xs text-zinc-400">Direct backend Plaid transaction feed</div>
              </div>
              <div className="text-xs text-zinc-500">{transactions.length} row{transactions.length === 1 ? "" : "s"}</div>
            </div>

            {transactions.length ? (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs text-zinc-300">
                  <thead className="text-zinc-500">
                    <tr className="border-b border-white/10">
                      <th className="py-2 pr-3">date</th>
                      <th className="py-2 pr-3">account</th>
                      <th className="py-2 pr-3">merchant</th>
                      <th className="py-2 pr-3">category</th>
                      <th className="py-2 pr-0 text-right">amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((txn) => (
                      <tr key={txn.transaction_id} className="border-b border-white/5">
                        <td className="py-2 pr-3 text-zinc-400">{txn.posted_date || txn.authorized_date || "—"}</td>
                        <td className="py-2 pr-3">
                          <div className="text-zinc-200">{txn.account_name || "Plaid account"}</div>
                          <div className="text-[11px] text-zinc-500">{txn.institution_name || "Linked institution"}</div>
                        </td>
                        <td className="py-2 pr-3 text-zinc-300">{txn.merchant_name || txn.name || "—"}</td>
                        <td className="py-2 pr-3 text-zinc-300">
                          {txn.category_detailed || txn.category_primary || "—"}
                          {txn.pending ? <span className="ml-2 text-amber-300">Pending</span> : null}
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
                No Plaid transactions were returned by the backend.
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
