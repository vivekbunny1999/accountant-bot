"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  createManualTransaction,
  deleteManualTransaction,
  getPlaidTransactions,
  listStatements,
  listStatementTransactions,
  listManualTransactions,
  ManualTransaction,
  PlaidTransactionSummary,
  Statement,
  Transaction,
} from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  amountAbs,
  CATEGORY_OPTIONS,
  categoryForStatement,
  isManualSpend,
  isPlaidSpend,
  isStatementCreditLike,
  manualDisplayDirection,
  parseDateLoose,
  SpendingCategory,
} from "@/lib/financial-os-display";

/** =========================
 * Helpers
 * ========================= */
function fmtMoney(n: number) {
  const v = Number(n || 0);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function todayInputValue() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function monthKeyFromDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthLabel(key: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/** =========================
 * Categories + rules (same key you used on dashboard)
 * ========================= */
type Category = SpendingCategory;

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

function saveRules(rules: Record<string, Category>) {
  localStorage.setItem(RULES_KEY, JSON.stringify(rules));
}

function signatureFor(t: Transaction): string {
  const raw = `${(t as any).merchant ?? ""} ${t.description ?? ""}`
    .trim()
    .toLowerCase();
  return (
    raw.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() || "unknown"
  );
}

function categoryFor(t: Transaction, rules: Record<string, Category>): Category {
  return categoryForStatement(t, rules);
}

function isCreditLike(t: Transaction) {
  return isStatementCreditLike(t);
}

type TxRow = Transaction & {
  _statement?: Statement;
  _date?: Date | null;
  _monthKey?: string;
  _computedCategory?: Category;
};

type SortKey = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

type ManualTransactionForm = {
  amount: string;
  date: string;
  category: Category;
  description: string;
};

/** =========================
 * Page
 * ========================= */
export default function TransactionsPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";
  const [statements, setStatements] = useState<Statement[]>([]);
  const [rows, setRows] = useState<TxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [manualTransactions, setManualTransactions] = useState<ManualTransaction[]>([]);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [plaidTransactions, setPlaidTransactions] = useState<PlaidTransactionSummary[]>([]);
  const [plaidLoading, setPlaidLoading] = useState(false);
  const [plaidError, setPlaidError] = useState<string | null>(null);
  const [manualFormOpen, setManualFormOpen] = useState(false);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualForm, setManualForm] = useState<ManualTransactionForm>({
    amount: "",
    date: todayInputValue(),
    category: "Other",
    description: "",
  });

  // UI state
  const [q, setQ] = useState("");
  const [onlySpends, setOnlySpends] = useState(true);
  const [monthFilter, setMonthFilter] = useState<string>(""); // "" means all
  const [cardFilter, setCardFilter] = useState<string>(""); // "" means all
  const [categoryFilter, setCategoryFilter] = useState<Category | "">("");
  const [sort, setSort] = useState<SortKey>("date_desc");
  const [minAmt, setMinAmt] = useState<string>("");
  const [maxAmt, setMaxAmt] = useState<string>("");

  // Details drawer/modal
  const [active, setActive] = useState<TxRow | null>(null);

  // Category rules
  const [rules, setRules] = useState<Record<string, Category>>({});

  // Pagination (kept simple)
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 60;

  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    // load rules once client-side
    setRules(loadRules());
  }, []);

  const loadManualEntries = useCallback(async () => {
    if (!userId) return;
    setManualLoading(true);
    setManualError(null);
    try {
      const rows = await listManualTransactions({ user_id: userId });
      setManualTransactions(rows || []);
    } catch (error) {
      setManualError(getErrorMessage(error, "Failed to load manual transactions"));
    } finally {
      setManualLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    loadManualEntries();
  }, [userId, loadManualEntries]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      setPlaidLoading(true);
      setPlaidError(null);
      try {
        const res = await getPlaidTransactions({ user_id: userId, limit: 50 });
        if (!cancelled) setPlaidTransactions(res.transactions || []);
      } catch (error) {
        if (!cancelled) {
          setPlaidTransactions([]);
          setPlaidError(getErrorMessage(error, "Failed to load Plaid transactions"));
        }
      } finally {
        if (!cancelled) setPlaidLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    setErr(null);

    (async () => {
      try {
        const st = await listStatements();
        setStatements(st);

        // fetch txns for all statements
        const all = await Promise.all(
          st.map(async (s) => {
            try {
              const tx = await listStatementTransactions(s.id);
              return tx.map((t) => {
                const d = parseDateLoose((t as any).posted_date ?? (t as any).date);
                const mk = d ? monthKeyFromDate(d) : "";
                const computed = categoryFor(t, loadRules()); // fresh rules on render
                const row: TxRow = {
                  ...(t as any),
                  _statement: s,
                  _date: d,
                  _monthKey: mk,
                  _computedCategory: computed,
                };
                return row;
              });
            } catch {
              return [] as TxRow[];
            }
          })
        );

        // flatten
        const flat = all.flat();

        // default month filter = current month if user wants (we keep ALL by default)
        setRows(flat);
      } catch (e: any) {
        setErr(e?.message || "Failed to load transactions");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Card list for dropdown
  const cardOptions = useMemo(() => {
    const map = new Map<string, { key: string; label: string }>();
    for (const s of statements) {
      const key =
        (s.account_label ?? "Account") +
        "|" +
        (s.card_last4 ?? s.card_name ?? s.statement_code);

      if (!map.has(key)) {
        const label =
          `${s.account_label ?? "Account"}` +
          (s.card_name ? ` • ${s.card_name}` : "") +
          (s.card_last4 ? ` • ${s.card_last4}` : "");
        map.set(key, { key, label });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [statements]);

  // Month list for dropdown
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      if (r._monthKey) set.add(r._monthKey);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const plaidSectionRows = useMemo(
    () => plaidTransactions.filter((txn) => isPlaidSpend(txn)).slice(0, 10),
    [plaidTransactions]
  );

  const manualSectionRows = useMemo(() => manualTransactions.slice(0, 8), [manualTransactions]);

  // Filter + sort
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const min = minAmt.trim() ? Number(minAmt) : null;
    const max = maxAmt.trim() ? Number(maxAmt) : null;

    const out = rows
      .filter((r) => {
        if (onlySpends && isCreditLike(r)) return false;

        if (monthFilter && r._monthKey !== monthFilter) return false;

        if (cardFilter) {
          const key =
            (r._statement?.account_label ?? "Account") +
            "|" +
            (r._statement?.card_last4 ??
              r._statement?.card_name ??
              r._statement?.statement_code);
          if (key !== cardFilter) return false;
        }

        if (categoryFilter && r._computedCategory !== categoryFilter) return false;

        const amt = amountAbs(r);
        if (min !== null && !(amt >= min)) return false;
        if (max !== null && !(amt <= max)) return false;

        if (!qq) return true;
        const text =
          `${r.description ?? ""} ${(r as any).merchant ?? ""} ${r._statement?.account_label ?? ""} ${r._statement?.card_last4 ?? ""} ${r._statement?.card_name ?? ""}`
            .toLowerCase()
            .trim();
        return text.includes(qq);
      })
      .sort((a, b) => {
        const da = a._date ? a._date.getTime() : 0;
        const db = b._date ? b._date.getTime() : 0;
        const aa = amountAbs(a);
        const ab = amountAbs(b);

        switch (sort) {
          case "date_asc":
            return da - db;
          case "date_desc":
            return db - da;
          case "amount_asc":
            return aa - ab;
          case "amount_desc":
            return ab - aa;
          default:
            return db - da;
        }
      });

    return out;
  }, [rows, q, onlySpends, monthFilter, cardFilter, categoryFilter, sort, minAmt, maxAmt]);

  const sourceSummary = useMemo(() => {
    const statementSpend = filtered.reduce((sum, row) => {
      return !isCreditLike(row) ? sum + amountAbs(row) : sum;
    }, 0);

    const plaidSpend = plaidSectionRows.reduce((sum, txn) => sum + Number(txn.amount || 0), 0);

    const manualSpend = manualSectionRows.reduce((sum, row) => {
      return isManualSpend(row) ? sum + amountAbs(row.amount) : sum;
    }, 0);

    return {
      statementSpend,
      plaidSpend,
      manualSpend,
      totalVisibleSpend: statementSpend + plaidSpend + manualSpend,
      plaidRecentRows: plaidSectionRows,
    };
  }, [filtered, plaidSectionRows, manualSectionRows]);

  // Reset pagination when filters change
  useEffect(() => {
    setPage(1);
  }, [q, onlySpends, monthFilter, cardFilter, categoryFilter, sort, minAmt, maxAmt]);

  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  }, [filtered.length]);

  /** =========================
   * Top-row KPIs
   * ========================= */
  const kpis = useMemo(() => {
    const spends = filtered.filter((t) => !isCreditLike(t));
    const credits = filtered.filter((t) => isCreditLike(t));

    const spendTotal = spends.reduce((s, t) => s + amountAbs(t), 0);
    const creditTotal = credits.reduce((s, t) => s + amountAbs(t), 0);

    const net = spendTotal - creditTotal;

    // biggest spend
    let biggest: TxRow | null = null;
    let biggestAmt = 0;
    for (const t of spends) {
      const a = amountAbs(t);
      if (a > biggestAmt) {
        biggestAmt = a;
        biggest = t;
      }
    }

    return {
      spendTotal,
      creditTotal,
      net,
      count: filtered.length,
      biggest,
      biggestAmt,
    };
  }, [filtered]);

  /** =========================
   * Actions
   * ========================= */
  function updateRuleForRow(row: TxRow, cat: Category) {
    const sig = signatureFor(row);
    const next = { ...rules, [sig]: cat };
    setRules(next);
    saveRules(next);

    // Update rows in memory so UI updates immediately (no API write needed)
    setRows((prev) =>
      prev.map((r) => {
        if (signatureFor(r) === sig) {
          return { ...r, _computedCategory: cat };
        }
        return r;
      })
    );

    // Also update active if open
    setActive((a) => {
      if (!a) return a;
      if (signatureFor(a) === sig) return { ...a, _computedCategory: cat };
      return a;
    });
  }

  async function handleCreateManualTransaction(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || manualSaving) return;

    const amount = Number(manualForm.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      setManualError("Amount must be a valid number and cannot be 0.");
      return;
    }
    if (!manualForm.date) {
      setManualError("Date is required.");
      return;
    }

    setManualSaving(true);
    setManualError(null);
    try {
      await createManualTransaction(
        {
          user_id: userId,
          amount,
          date: manualForm.date,
          category: manualForm.category,
          description: manualForm.description.trim(),
        },
        { user_id: userId }
      );
      setManualForm({
        amount: "",
        date: todayInputValue(),
        category: "Other",
        description: "",
      });
      setManualFormOpen(false);
      await loadManualEntries();
    } catch (error) {
      setManualError(getErrorMessage(error, "Failed to save manual transaction"));
    } finally {
      setManualSaving(false);
    }
  }

  async function handleDeleteManualTransaction(row: ManualTransaction) {
    if (!userId) return;
    const ok = window.confirm("Delete this manual transaction?");
    if (!ok) return;

    try {
      await deleteManualTransaction(row.id, { user_id: userId });
      await loadManualEntries();
    } catch (error) {
      setManualError(getErrorMessage(error, "Failed to delete manual transaction"));
    }
  }

  function exportCsv() {
    // export current FILTERED view (not just current page)
    const headers = [
      "date",
      "description",
      "amount",
      "category",
      "card",
      "card_last4",
      "statement_period",
      "statement_code",
    ];

    const lines = filtered.map((r) => {
      const d = r._date ? r._date.toISOString().slice(0, 10) : "";
      const desc = (r.description ?? "").replace(/"/g, '""');
      const amt = Number(r.amount ?? 0);
      const cat = (r._computedCategory ?? "Uncategorized").replace(/"/g, '""');
      const card = (r._statement?.card_name ?? r._statement?.account_label ?? "").replace(/"/g, '""');
      const last4 = (r._statement?.card_last4 ?? "").replace(/"/g, '""');
      const period = (r._statement?.statement_period ?? "").replace(/"/g, '""');
      const code = (r._statement?.statement_code ?? "").replace(/"/g, '""');

      return [
        d,
        `"${desc}"`,
        amt,
        `"${cat}"`,
        `"${card}"`,
        `"${last4}"`,
        `"${period}"`,
        `"${code}"`,
      ].join(",");
    });

    const csv = [headers.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `activity_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">Activity</div>
              <div className="mt-1 text-sm text-zinc-400">
                A source-aware activity view with Plaid, statement/PDF, and manual activity kept separate so it matches dashboard intelligence.
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setManualError(null);
                  setManualFormOpen((prev) => !prev);
                }}
                className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-zinc-100 hover:bg-white/15"
                title="Add a manual activity entry"
              >
                Add Activity
              </button>
              <button
                onClick={exportCsv}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                title="Export filtered view to CSV"
              >
                Export CSV
              </button>
              <Link
                href="/statements"
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                title="Go to statements"
              >
                Statement Source
              </Link>
            </div>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Plaid spend shown</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(sourceSummary.plaidSpend)}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {plaidLoading ? "Loading Plaid activity..." : `${sourceSummary.plaidRecentRows.length} rows in the section below`}
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Statement / PDF spend shown</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(sourceSummary.statementSpend)}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {filtered.length} filtered imported rows in view
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Manual spend shown</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(sourceSummary.manualSpend)}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {manualSectionRows.length} manual rows in the section below
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Total spend shown</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(sourceSummary.totalVisibleSpend)}</div>
            <div className="mt-1 text-xs text-zinc-500">Adds the source sections currently shown on this page</div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-zinc-100">Plaid Activity</div>
              <div className="mt-1 text-xs text-zinc-400">
                Dashboard coaching uses linked transactions too, so this page shows recent linked activity without merging imported source tables.
              </div>
            </div>
            <div className="text-xs text-zinc-500">Source: Plaid</div>
          </div>

          {plaidError ? (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {plaidError}
            </div>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr className="border-b border-white/10">
                  <th className="py-3 pr-4">date</th>
                  <th className="py-3 pr-4">account</th>
                  <th className="py-3 pr-4">merchant</th>
                  <th className="py-3 pr-0 text-right">amount</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {plaidLoading ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-zinc-400">
                      Loading Plaid activity...
                    </td>
                  </tr>
                ) : sourceSummary.plaidRecentRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-zinc-400">
                      No recent Plaid spend is visible right now.
                    </td>
                  </tr>
                ) : (
                  sourceSummary.plaidRecentRows.map((txn) => (
                    <tr key={txn.transaction_id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 pr-4 text-zinc-300">
                        {txn.posted_date || txn.authorized_date || "-"}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="text-zinc-100">{txn.account_name || "Plaid account"}</div>
                        <div className="mt-1 text-xs text-zinc-500">{txn.institution_name || "Linked institution"}</div>
                      </td>
                      <td className="py-3 pr-4 text-zinc-300">{txn.merchant_name || txn.name || "-"}</td>
                      <td className="py-3 pr-0 text-right font-mono text-zinc-100">
                        {fmtMoney(Number(txn.amount || 0))}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-zinc-100">Manual Activity</div>
              <div className="mt-1 text-xs text-zinc-400">
                Stored separately from Plaid and statement imports so cash/manual activity has its own source.
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                Positive manual amounts count as spend. Negative amounts are treated as money in when the entry is labeled like income, refund, or deposit.
              </div>
            </div>
            <div className="text-xs text-zinc-500">
              {manualTransactions.length} saved
            </div>
          </div>

          {manualFormOpen && (
            <form onSubmit={handleCreateManualTransaction} className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div>
                <div className="text-xs text-zinc-400">Amount</div>
                <input
                  value={manualForm.amount}
                  onChange={(e) => setManualForm((prev) => ({ ...prev, amount: e.target.value }))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                  placeholder="-42.50 or 1200"
                />
              </div>

              <div>
                <div className="text-xs text-zinc-400">Date</div>
                <input
                  type="date"
                  value={manualForm.date}
                  onChange={(e) => setManualForm((prev) => ({ ...prev, date: e.target.value }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                />
              </div>

              <div>
                <div className="text-xs text-zinc-400">Category</div>
                <select
                  value={manualForm.category}
                  onChange={(e) => setManualForm((prev) => ({ ...prev, category: e.target.value as Category }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="xl:col-span-2">
                <div className="text-xs text-zinc-400">Description</div>
                <input
                  value={manualForm.description}
                  onChange={(e) => setManualForm((prev) => ({ ...prev, description: e.target.value }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                  placeholder="Cash groceries, Venmo split, rent paid in cash..."
                />
              </div>

              <div className="md:col-span-2 xl:col-span-5 flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={manualSaving}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm text-zinc-100 hover:bg-white/15 disabled:opacity-60"
                >
                  {manualSaving ? "Saving..." : "Save Activity"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setManualForm({
                      amount: "",
                      date: todayInputValue(),
                      category: "Other",
                      description: "",
                    });
                    setManualError(null);
                    setManualFormOpen(false);
                  }}
                  className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-2 text-sm text-zinc-300 hover:bg-white/5"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {manualError && (
            <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {manualError}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr className="border-b border-white/10">
                  <th className="py-3 pr-4">date</th>
                  <th className="py-3 pr-4">description</th>
                  <th className="py-3 pr-4">category</th>
                  <th className="py-3 pr-4 text-right">amount</th>
                  <th className="py-3 pr-0 text-right">actions</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {manualLoading ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-zinc-400">
                      Loading manual activity...
                    </td>
                  </tr>
                ) : manualTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-zinc-400">
                      No manual activity saved yet.
                    </td>
                  </tr>
                ) : (
                  manualSectionRows.map((row) => (
                    <tr key={row.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 pr-4 text-zinc-300">
                        {parseDateLoose(row.date)?.toLocaleDateString(undefined, {
                          year: "numeric",
                          month: "short",
                          day: "2-digit",
                        }) || row.date}
                      </td>
                      <td className="py-3 pr-4 text-zinc-100">
                        <div>{row.description || "-"}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {manualDisplayDirection(row) === "spend" ? "Counts as spend" : "Counts as money in"}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-zinc-300">{row.category || "Other"}</td>
                      <td className="py-3 pr-4 text-right font-mono text-zinc-200">
                        {fmtMoney(Number(row.amount || 0))}
                      </td>
                      <td className="py-3 pr-0 text-right">
                        <button
                          onClick={() => handleDeleteManualTransaction(row)}
                          className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/20"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Loading / error */}
        {loading && (
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5 text-sm text-zinc-400">
            Loading activity...
          </div>
        )}
        {err && (
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5 text-sm text-red-400">
            Error: {err}
          </div>
        )}

        {!loading && !err && (
          <>
            {/* =========================
             * Top Row (KPIs)
             * ========================= */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
                <div className="text-xs text-zinc-400">Statement / PDF spend</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">
                  {fmtMoney(kpis.spendTotal)}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  Purchases only (excludes credits/refunds)
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
                <div className="text-xs text-zinc-400">Statement credits / payments</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">
                  {fmtMoney(kpis.creditTotal)}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  Payments, refunds, reversals
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
                <div className="text-xs text-zinc-400">Statement net (spend - credits)</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">
                  {fmtMoney(kpis.net)}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  Quick reality check for the view
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
                <div className="text-xs text-zinc-400">Statement / PDF transactions</div>
                <div className="mt-2 text-2xl font-semibold text-zinc-100">
                  {kpis.count}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  After filters
                </div>
              </div>
            </div>

            {/* =========================
             * Second Row (Controls)
             * ========================= */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="grid gap-3 lg:grid-cols-12">
                {/* Search */}
                <div className="lg:col-span-4">
                  <div className="text-xs text-zinc-400">Search</div>
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="merchant, description, card…"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                  />
                </div>

                {/* Month */}
                <div className="lg:col-span-2">
                  <div className="text-xs text-zinc-400">Month</div>
                  <select
                    value={monthFilter}
                    onChange={(e) => setMonthFilter(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  >
                    <option value="">All</option>
                    {monthOptions.map((m) => (
                      <option key={m} value={m}>
                        {monthLabel(m)}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Card */}
                <div className="lg:col-span-3">
                  <div className="text-xs text-zinc-400">Card</div>
                  <select
                    value={cardFilter}
                    onChange={(e) => setCardFilter(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  >
                    <option value="">All</option>
                    {cardOptions.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Category */}
                <div className="lg:col-span-2">
                  <div className="text-xs text-zinc-400">Category</div>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value as any)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  >
                    <option value="">All</option>
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Sort + toggles */}
                <div className="lg:col-span-1">
                  <div className="text-xs text-zinc-400">Sort</div>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-2 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  >
                    <option value="date_desc">Date ↓</option>
                    <option value="date_asc">Date ↑</option>
                    <option value="amount_desc">Amt ↓</option>
                    <option value="amount_asc">Amt ↑</option>
                  </select>
                </div>

                {/* Amount range */}
                <div className="lg:col-span-4">
                  <div className="mt-3 grid grid-cols-2 gap-3 lg:mt-0 lg:grid-cols-2">
                    <div>
                      <div className="text-xs text-zinc-400">Min $</div>
                      <input
                        value={minAmt}
                        onChange={(e) => setMinAmt(e.target.value)}
                        inputMode="decimal"
                        placeholder="0"
                        className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                      />
                    </div>
                    <div>
                      <div className="text-xs text-zinc-400">Max $</div>
                      <input
                        value={maxAmt}
                        onChange={(e) => setMaxAmt(e.target.value)}
                        inputMode="decimal"
                        placeholder="∞"
                        className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                      />
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-8">
                  <div className="mt-3 flex flex-wrap items-center gap-3 lg:mt-0 lg:justify-end">
                    <label className="flex items-center gap-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={onlySpends}
                        onChange={(e) => setOnlySpends(e.target.checked)}
                        className="h-4 w-4 accent-white"
                      />
                      Spend only
                    </label>

                    <button
                      onClick={() => {
                        setQ("");
                        setOnlySpends(true);
                        setMonthFilter("");
                        setCardFilter("");
                        setCategoryFilter("");
                        setSort("date_desc");
                        setMinAmt("");
                        setMaxAmt("");
                      }}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                      title="Reset filters"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 text-xs text-zinc-500">
                Tip: click a row to open details. Changing category saves a “rule” so future imports auto-classify similar merchants/descriptions.
              </div>
            </div>

            {/* =========================
             * Main Area (Table)
             * ========================= */}
            <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-zinc-100">
                  Imported statement activity
                </div>
                <div className="text-xs text-zinc-400">
                  {filtered.length} rows • page {page}/{totalPages}
                </div>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-zinc-400">
                    <tr className="border-b border-white/10">
                      <th className="py-3 pr-4">date</th>
                      <th className="py-3 pr-4">description</th>
                      <th className="py-3 pr-4">category</th>
                      <th className="py-3 pr-4">card</th>
                      <th className="py-3 pr-4 text-right">amount</th>
                      <th className="py-3 pr-0 text-right">open</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-200">
                    {paged.map((r) => {
                      const d = r._date
                        ? r._date.toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "2-digit",
                          })
                        : "—";

                      const cat = r._computedCategory ?? "Uncategorized";
                      const cardLabel =
                        (r._statement?.card_name ?? r._statement?.account_label ?? "—") +
                        (r._statement?.card_last4 ? ` • ${r._statement?.card_last4}` : "");

                      const amt = Number(r.amount || 0);
                      const isCredit = isCreditLike(r);

                      return (
                        <tr
                          key={`${(r as any).id ?? ""}-${r._statement?.id ?? ""}-${r.description ?? ""}-${amt}`}
                          className="border-b border-white/5 hover:bg-white/5"
                        >
                          <td className="py-3 pr-4 text-zinc-300">{d}</td>

                          <td className="py-3 pr-4">
                            <div className="text-zinc-100">{r.description ?? "—"}</div>
                            <div className="mt-1 text-xs text-zinc-500">
                              {isCredit ? "Credit/Payment" : "Spend"} •{" "}
                              {(r as any).txn_type ?? "—"}
                            </div>
                          </td>

                          <td className="py-3 pr-4">
                            <select
                              value={cat}
                              onChange={(e) =>
                                updateRuleForRow(r, e.target.value as Category)
                              }
                              className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-white/20"
                              title="Change category (saves as rule)"
                            >
                              {CATEGORY_OPTIONS.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="py-3 pr-4 text-zinc-300">
                            {cardLabel}
                          </td>

                          <td className="py-3 pr-4 text-right font-mono text-zinc-200">
                            {fmtMoney(amt)}
                          </td>

                          <td className="py-3 pr-0 text-right">
                            <button
                              onClick={() => setActive(r)}
                              className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}

                    {filtered.length === 0 && (
                      <tr>
                        <td className="py-6 text-zinc-400" colSpan={6}>
                          No results. Try clearing filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="mt-4 flex items-center justify-between">
                <div className="text-xs text-zinc-500">
                  Showing {(page - 1) * PAGE_SIZE + 1}–
                  {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10 disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>

            {/* =========================
             * Details Modal (low cognitive load)
             * ========================= */}
            {active && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0E141C] p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-zinc-100">
                        Transaction Details
                      </div>
                      <div className="mt-1 truncate text-xs text-zinc-400">
                        {(active._statement?.card_name ?? active._statement?.account_label ?? "—")}
                        {active._statement?.card_last4 ? ` • ${active._statement?.card_last4}` : ""}
                      </div>
                    </div>

                    <button
                      onClick={() => setActive(null)}
                      className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                    >
                      Close
                    </button>
                  </div>

                  <div className="mt-4 space-y-3">
                    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                      <div className="text-xs text-zinc-400">Description</div>
                      <div className="mt-1 text-sm text-zinc-100">
                        {active.description ?? "—"}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                        <div className="text-xs text-zinc-400">Date</div>
                        <div className="mt-1 text-sm text-zinc-100">
                          {active._date
                            ? active._date.toLocaleDateString(undefined, {
                                year: "numeric",
                                month: "short",
                                day: "2-digit",
                              })
                            : "—"}
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                        <div className="text-xs text-zinc-400">Amount</div>
                        <div className="mt-1 text-sm font-mono text-zinc-100">
                          {fmtMoney(Number(active.amount || 0))}
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                        <div className="text-xs text-zinc-400">Type</div>
                        <div className="mt-1 text-sm text-zinc-100">
                          {isCreditLike(active) ? "Credit/Payment" : "Spend"} •{" "}
                          {(active as any).txn_type ?? "—"}
                        </div>
                      </div>

                      <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                        <div className="text-xs text-zinc-400">Category</div>
                        <div className="mt-2">
                          <select
                            value={active._computedCategory ?? "Uncategorized"}
                            onChange={(e) =>
                              updateRuleForRow(active, e.target.value as Category)
                            }
                            className="w-full rounded-xl border border-white/10 bg-[#0E141C] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                          >
                            {CATEGORY_OPTIONS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <div className="mt-2 text-[11px] text-zinc-500">
                            This saves a rule for similar merchants/descriptions.
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                      <div className="text-xs text-zinc-400">Statement Context</div>
                      <div className="mt-1 text-sm text-zinc-100">
                        {active._statement?.statement_period ?? "—"}
                      </div>
                      <div className="mt-2 text-xs text-zinc-500">
                        Statement code:{" "}
                        <span className="font-mono text-zinc-300">
                          {active._statement?.statement_code ?? "—"}
                        </span>
                      </div>
                      {active._statement?.statement_code && (
                        <div className="mt-3">
                          <Link
                            href={`/statements/${encodeURIComponent(
                              active._statement.statement_code
                            )}`}
                            className="inline-flex rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                          >
                            Open Statement →
                          </Link>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
