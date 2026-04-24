"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  getCashAccountTransactions,
  getCashAccounts,
  getPlaidTransactions,
  listManualTransactions,
  listStatements,
  listStatementTransactions,
  Statement,
} from "@/lib/api";
import {
  amountAbs,
  categoryForCash,
  categoryForManual,
  categoryForPlaid,
  categoryForStatement,
  CATEGORY_OPTIONS,
  isCashSpend,
  isManualSpend,
  isPlaidSpend,
  isStatementCreditLike,
  parseDateLoose,
  signatureForParts,
  SpendingCategory,
} from "@/lib/financial-os-display";

type Category = SpendingCategory;

const RULES_KEY = "accountantbot_category_rules_v1";

function loadRules(): Record<string, Category> {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveRules(rules: Record<string, Category>) {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
}

function fmtDate(value?: string | null) {
  const dateValue = parseDateLoose(value ?? "");
  if (!dateValue) return value ?? "-";
  return dateValue.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function labelFromMonthKey(key: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return key;
  const dateValue = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return dateValue.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function monthKeyFromDate(dateValue: Date | null) {
  if (!dateValue) return null;
  return `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, "0")}`;
}

function cardLabelFromStatement(statement: Statement) {
  return [
    statement.account_label || "Statement import",
    statement.card_name || null,
    statement.card_last4 ? `•••• ${statement.card_last4}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
}

type CategoryActivityRow = {
  id: string;
  dateRaw: string;
  dateValue: Date | null;
  monthKey: string;
  source: "Statement" | "Imported Cash" | "Manual" | "Plaid";
  sourceDetail: string;
  description: string;
  merchant: string;
  amount: number;
  isSpend: boolean;
  category: Category;
  signature: string;
};

export default function CategoryDrilldownPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const params = useParams<{ category: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  const category = useMemo(() => {
    return decodeURIComponent(params?.category ?? "") as Category;
  }, [params]);

  const monthParam = searchParams.get("month") ?? "all";

  const [rules, setRules] = useState<Record<string, Category>>({});
  const [rows, setRows] = useState<CategoryActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "spend" | "credit">("all");
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [highlightThreshold, setHighlightThreshold] = useState(100);

  useEffect(() => {
    setRules(loadRules());
  }, []);

  useEffect(() => {
    if (!userId) {
      setRows([]);
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        const [statementRes, cashAccountsRes, manualRes, plaidRes] = await Promise.all([
          listStatements(),
          getCashAccounts({ user_id: userId, limit: 100 }),
          listManualTransactions({ user_id: userId }),
          getPlaidTransactions({ user_id: userId, limit: 250 }),
        ]);

        const currentRules = loadRules();
        const nextRows: CategoryActivityRow[] = [];

        const statementRows = await Promise.all(
          statementRes.map(async (statement) => {
            try {
              const txns = await listStatementTransactions(statement.id);
              const sourceDetail = cardLabelFromStatement(statement);
              return txns.map((txn) => {
                const dateRaw = String((txn as any).posted_date ?? (txn as any).date ?? "");
                const dateValue = parseDateLoose(dateRaw);
                return {
                  id: `statement-${statement.id}-${(txn as any).id ?? signatureForParts((txn as any).merchant, (txn as any).description, dateRaw)}`,
                  dateRaw,
                  dateValue,
                  monthKey: monthKeyFromDate(dateValue) ?? "unknown",
                  source: "Statement" as const,
                  sourceDetail,
                  description: String((txn as any).description ?? ""),
                  merchant: String((txn as any).merchant ?? ""),
                  amount: Number((txn as any).amount || 0),
                  isSpend: !isStatementCreditLike(txn as any),
                  category: categoryForStatement(txn as any, currentRules),
                  signature: signatureForParts((txn as any).merchant, (txn as any).description),
                };
              });
            } catch {
              return [] as CategoryActivityRow[];
            }
          })
        );
        nextRows.push(...statementRows.flat());

        const cashRows = await Promise.all(
          (cashAccountsRes as any[]).map(async (account) => {
            try {
              const txns = await getCashAccountTransactions(account.id, { user_id: userId, limit: 500 });
              const sourceDetail = [
                account.account_label || account.account_name || account.institution || "Imported cash",
                account.statement_end_date || account.statement_period || null,
              ]
                .filter(Boolean)
                .join(" • ");

              return (txns as any[]).map((txn) => {
                const dateRaw = String(txn.posted_date ?? txn.transaction_date ?? txn.date ?? "");
                const dateValue = parseDateLoose(dateRaw);
                return {
                  id: `cash-${account.id}-${txn.id ?? signatureForParts(txn.description, txn.merchant, txn.name, dateRaw)}`,
                  dateRaw,
                  dateValue,
                  monthKey: monthKeyFromDate(dateValue) ?? "unknown",
                  source: "Imported Cash" as const,
                  sourceDetail,
                  description: String(txn.description ?? txn.name ?? ""),
                  merchant: String(txn.merchant ?? txn.name ?? ""),
                  amount: Number(txn.amount || 0),
                  isSpend: isCashSpend(txn),
                  category: categoryForCash(txn, currentRules),
                  signature: signatureForParts(txn.description, txn.merchant, txn.name),
                };
              });
            } catch {
              return [] as CategoryActivityRow[];
            }
          })
        );
        nextRows.push(...cashRows.flat());

        nextRows.push(
          ...(manualRes || []).map((txn) => {
            const dateValue = parseDateLoose(txn.date);
            return {
              id: `manual-${txn.id}`,
              dateRaw: txn.date,
              dateValue,
              monthKey: monthKeyFromDate(dateValue) ?? "unknown",
              source: "Manual" as const,
              sourceDetail: "Manual activity",
              description: String(txn.description || "Manual activity"),
              merchant: "",
              amount: Number(txn.amount || 0),
              isSpend: isManualSpend(txn),
              category: categoryForManual(txn, currentRules),
              signature: signatureForParts(txn.description, txn.category),
            };
          })
        );

        nextRows.push(
          ...((plaidRes.transactions || []).map((txn) => {
            const dateRaw = String(txn.posted_date ?? txn.authorized_date ?? "");
            const dateValue = parseDateLoose(dateRaw);
            return {
              id: `plaid-${txn.transaction_id}`,
              dateRaw,
              dateValue,
              monthKey: monthKeyFromDate(dateValue) ?? "unknown",
              source: "Plaid" as const,
              sourceDetail: [txn.institution_name, txn.account_name].filter(Boolean).join(" • ") || "Linked account",
              description: String(txn.name || txn.merchant_name || "Linked activity"),
              merchant: String(txn.merchant_name || txn.name || ""),
              amount: Number(txn.amount || 0),
              isSpend: isPlaidSpend(txn),
              category: categoryForPlaid(txn, currentRules),
              signature: signatureForParts(txn.merchant_name, txn.name),
            };
          }) as CategoryActivityRow[])
        );

        if (!cancelled) {
          setRows(
            nextRows.sort((left, right) => {
              const leftTime = left.dateValue?.getTime() ?? 0;
              const rightTime = right.dateValue?.getTime() ?? 0;
              return rightTime - leftTime;
            })
          );
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load category activity.");
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const monthOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const row of rows) {
      if (row.monthKey && row.monthKey !== "unknown") keys.add(row.monthKey);
    }
    return Array.from(keys).sort((left, right) => right.localeCompare(left));
  }, [rows]);

  const rowsInCategory = useMemo(() => {
    return rows.filter((row) => {
      if (row.category !== category) return false;
      if (monthParam !== "all" && row.monthKey !== monthParam) return false;
      return true;
    });
  }, [category, monthParam, rows]);

  const insights = useMemo(() => {
    const spend = rowsInCategory.reduce((sum, row) => (row.isSpend ? sum + amountAbs(row.amount) : sum), 0);
    const credits = rowsInCategory.reduce((sum, row) => (!row.isSpend ? sum + amountAbs(row.amount) : sum), 0);
    return { spend, credits, count: rowsInCategory.length };
  }, [rowsInCategory]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    let next = [...rowsInCategory];

    if (typeFilter === "spend") next = next.filter((row) => row.isSpend);
    if (typeFilter === "credit") next = next.filter((row) => !row.isSpend);

    if (query) {
      next = next.filter((row) => {
        const haystack = `${row.description} ${row.merchant} ${row.source} ${row.sourceDetail}`.toLowerCase();
        return haystack.includes(query);
      });
    }

    next.sort((left, right) => {
      if (sortBy === "amount") {
        const leftAmount = amountAbs(left.amount);
        const rightAmount = amountAbs(right.amount);
        return sortDir === "asc" ? leftAmount - rightAmount : rightAmount - leftAmount;
      }

      const leftTime = left.dateValue?.getTime() ?? 0;
      const rightTime = right.dateValue?.getTime() ?? 0;
      return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
    });

    return next;
  }, [rowsInCategory, search, sortBy, sortDir, typeFilter]);

  function updateMonth(nextMonth: string) {
    router.push(`/dashboard/category/${encodeURIComponent(category)}?month=${encodeURIComponent(nextMonth)}`);
  }

  function updateCategoryRule(row: CategoryActivityRow, nextCategory: Category) {
    const nextRules = { ...rules, [row.signature]: nextCategory };
    setRules(nextRules);
    saveRules(nextRules);
    setRows((current) =>
      current.map((item) => (item.signature === row.signature ? { ...item, category: nextCategory } : item))
    );
  }

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10"
              title="Back to Dashboard"
            >
              ← Back
            </Link>

            <div className="text-right">
              <div className="text-xs text-zinc-400">Category</div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">{category}</div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs text-zinc-400">Month</div>
              <select
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20 sm:w-60"
                value={monthParam}
                onChange={(e) => updateMonth(e.target.value)}
              >
                <option value="all">All</option>
                {monthOptions.map((monthKey) => (
                  <option key={monthKey} value={monthKey}>
                    {labelFromMonthKey(monthKey)}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-right text-sm text-zinc-300">
              <div className="text-xs text-zinc-400">{insights.count} rows</div>
              <div className="mt-1">
                Spend <span className="font-mono text-zinc-100">${insights.spend.toFixed(2)}</span>
                <span className="px-2 text-zinc-500">•</span>
                Money in <span className="font-mono text-zinc-100">${insights.credits.toFixed(2)}</span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                Source-aware view across statements, imported cash, manual activity, and linked activity.
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">Category Activity</div>
            <div className="text-xs text-zinc-400">{filteredRows.length} shown</div>
          </div>

          {loading ? <div className="mt-4 text-sm text-zinc-400">Loading…</div> : null}
          {error ? <div className="mt-4 text-sm text-red-400">Error: {error}</div> : null}

          {!loading && !error ? (
            <>
              <div className="mt-4 flex flex-col gap-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                  <input
                    className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20 lg:flex-1"
                    placeholder="Search merchant, description, or source…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />

                  <div className="flex w-full flex-wrap gap-2 lg:w-auto">
                    {[
                      ["all", "All"],
                      ["spend", "Spends"],
                      ["credit", "Money in"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => setTypeFilter(value as "all" | "spend" | "credit")}
                        className={[
                          "rounded-xl border border-white/10 px-3 py-2 text-sm",
                          typeFilter === value
                            ? "bg-white/10 text-zinc-100"
                            : "bg-white/5 text-zinc-300 hover:bg-white/10",
                        ].join(" ")}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <select
                      className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20 sm:w-56"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as "date" | "amount")}
                    >
                      <option value="date">Sort: Date</option>
                      <option value="amount">Sort: Amount</option>
                    </select>

                    <button
                      onClick={() => setSortDir((current) => (current === "desc" ? "asc" : "desc"))}
                      className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10 sm:w-28"
                    >
                      {sortDir === "desc" ? "Desc ↓" : "Asc ↑"}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {[50, 100, 200].map((value) => (
                      <button
                        key={value}
                        onClick={() => setHighlightThreshold(value)}
                        className={[
                          "rounded-xl border border-white/10 px-3 py-2 text-sm",
                          highlightThreshold === value
                            ? "bg-white/10 text-zinc-100"
                            : "bg-white/5 text-zinc-300 hover:bg-white/10",
                        ].join(" ")}
                      >
                        ${value}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-zinc-400">
                    <tr className="border-b border-white/10">
                      <th className="py-3 pr-4">date</th>
                      <th className="py-3 pr-4">description</th>
                      <th className="py-3 pr-4">source</th>
                      <th className="py-3 pr-4">category</th>
                      <th className="py-3 pr-0 text-right">amount</th>
                    </tr>
                  </thead>

                  <tbody className="text-zinc-200">
                    {filteredRows.map((row) => {
                      const highlight = amountAbs(row.amount) >= highlightThreshold;
                      return (
                        <tr
                          key={row.id}
                          className={[
                            "border-b border-white/5 hover:bg-white/5",
                            highlight ? "bg-white/[0.04]" : "",
                          ].join(" ")}
                        >
                          <td className="py-3 pr-4 text-zinc-300">{fmtDate(row.dateRaw)}</td>

                          <td className="py-3 pr-4 text-zinc-200">
                            <div className="flex items-center gap-2">
                              <div className="max-w-[520px] truncate">{row.description || row.merchant || "-"}</div>
                              {highlight ? (
                                <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-zinc-300">
                                  Large
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500">{row.sourceDetail}</div>
                          </td>

                          <td className="py-3 pr-4 text-zinc-300">
                            <div className="text-zinc-100">{row.source}</div>
                            <div className="mt-1 text-[11px] text-zinc-500">
                              {row.isSpend ? "Spend" : "Money in"}
                            </div>
                          </td>

                          <td className="py-3 pr-4">
                            <select
                              value={row.category}
                              onChange={(e) => updateCategoryRule(row, e.target.value as Category)}
                              className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                            >
                              {CATEGORY_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td
                            className={[
                              "py-3 pr-0 text-right font-mono",
                              row.isSpend ? "text-zinc-100" : "text-emerald-300",
                            ].join(" ")}
                          >
                            {row.isSpend ? "$" : "+$"}
                            {amountAbs(row.amount).toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}

                    {filteredRows.length === 0 ? (
                      <tr>
                        <td className="py-6 text-zinc-400" colSpan={5}>
                          No rows match this category and filter combination.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Changing a category here updates the local category rule used by the dashboard display.
              </div>
            </>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
