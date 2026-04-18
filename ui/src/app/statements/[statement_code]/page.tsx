"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import {
  listStatements,
  Statement,
  listStatementTransactions,
  Transaction,
} from "@/lib/api";

/** ===== Categories (same list you finalized) ===== */
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

/** ===== localStorage rules ===== */
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

/** ===== Helpers ===== */
function signatureFor(t: Transaction): string {
  const raw = `${t.merchant ?? ""} ${t.description ?? ""}`.trim().toLowerCase();
  return (
    raw.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() || "unknown"
  );
}

function parseDateLoose(s?: string | null): Date | null {
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = /^(\d{4})[-\/](\d{2})[-\/](\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // MM/DD/YYYY
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));

  return null;
}

function fmtDate(s?: string | null) {
  const d = parseDateLoose(s ?? "");
  if (!d) return s ?? "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function isCreditLike(t: Transaction) {
  const a = Number(t.amount);
  const text = `${t.description ?? ""} ${t.merchant ?? ""}`.toLowerCase();
  return (
    a < 0 ||
    text.includes("pymt") ||
    text.includes("payment") ||
    text.includes("refund") ||
    text.includes("reversal") ||
    text.includes("credit")
  );
}

function defaultCategoryFor(t: Transaction): Category {
  const text = `${t.description ?? ""} ${t.merchant ?? ""}`.toLowerCase();

  if (text.includes("pymt") || text.includes("payment")) return "Debt Payment";

  if (
    text.includes("interest") ||
    text.includes("late fee") ||
    text.includes("annual fee") ||
    text.includes("fee")
  )
    return "Fees & Interest";

  return "Uncategorized";
}

function categoryFor(t: Transaction, rules: Record<string, Category>): Category {
  const sig = signatureFor(t);
  return rules[sig] ?? defaultCategoryFor(t);
}

function amountAbs(t: Transaction) {
  return Math.abs(Number(t.amount) || 0);
}

/** ===== Page ===== */
export default function StatementDetailsPage() {
  const params = useParams<{ statement_code: string }>();
  const code = useMemo(
    () => decodeURIComponent(params?.statement_code ?? ""),
    [params]
  );

  const [data, setData] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [txns, setTxns] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txErr, setTxErr] = useState<string | null>(null);

  const [rules, setRules] = useState<Record<string, Category>>({});

  // Option C: filters/sort/search/highlight
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "spend" | "credit">(
    "all"
  );
  const [sortBy, setSortBy] = useState<"date" | "amount">("date");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [highlightThreshold, setHighlightThreshold] = useState<number>(100);

  useEffect(() => {
    setRules(loadRules());
  }, []);

  useEffect(() => {
    if (!code) return;

    setLoading(true);
    setErr(null);

    listStatements()
      .then(async (all) => {
        const found = all.find((s) => s.statement_code === code) ?? null;
        setData(found);

        if (!found) {
          setErr("Statement not found");
          setTxns([]);
          return;
        }

        setTxLoading(true);
        setTxErr(null);

        try {
          const t = await listStatementTransactions(found.id);
          setTxns(t);
        } catch (e: any) {
          setTxErr(e?.message || "Failed to load transactions");
          setTxns([]);
        } finally {
          setTxLoading(false);
        }
      })
      .catch((e) => setErr(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [code]);

  const insights = useMemo(() => {
    const spend = txns
      .filter((t) => Number(t.amount) > 0)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const credits = txns
      .filter((t) => Number(t.amount) < 0)
      .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

    const net = spend - credits;

    const largestAbs = txns.reduce((best, t) => {
      const a = Math.abs(Number(t.amount));
      const b = best ? Math.abs(Number(best.amount)) : -1;
      return a > b ? t : best;
    }, null as Transaction | null);

    return { spend, credits, net, count: txns.length, largest: largestAbs };
  }, [txns]);

  const filteredSortedTxns = useMemo(() => {
    const q = search.trim().toLowerCase();

    let list = [...txns];

    if (typeFilter === "spend") list = list.filter((t) => !isCreditLike(t));
    if (typeFilter === "credit") list = list.filter((t) => isCreditLike(t));

    if (q) {
      list = list.filter((t) => {
        const text = `${t.description ?? ""} ${t.merchant ?? ""}`.toLowerCase();
        return text.includes(q);
      });
    }

    list.sort((a, b) => {
      if (sortBy === "amount") {
        const av = amountAbs(a);
        const bv = amountAbs(b);
        return sortDir === "asc" ? av - bv : bv - av;
      }

      const ad = parseDateLoose(a.posted_date ?? a.date)?.getTime() ?? 0;
      const bd = parseDateLoose(b.posted_date ?? b.date)?.getTime() ?? 0;
      return sortDir === "asc" ? ad - bd : bd - ad;
    });

    return list;
  }, [txns, search, typeFilter, sortBy, sortDir]);

  function setCategory(t: Transaction, cat: Category) {
    const sig = signatureFor(t);
    const next = { ...rules, [sig]: cat };
    setRules(next);
    saveRules(next);
  }

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header */}
<div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    {/* Left: Back + title */}
    <div className="flex items-center gap-3">
      <Link
        href="/statements"
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10"
        title="Back to Statements"
      >
        ← Back
      </Link>

      <div>
        <div className="text-xs text-zinc-400">Statement</div>
        <div className="mt-1 flex items-center gap-2 font-mono text-sm text-zinc-100">
          <span className="truncate max-w-[72vw] sm:max-w-[520px]">
            {code || "—"}
          </span>

          {/* ↗ icon */}
          <span
            className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-300"
            title="Details view"
          >
            ↗
          </span>
        </div>
      </div>
    </div>

    {/* Right: Card identity (if loaded) */}
    <div className="text-xs text-zinc-400">
      {data?.account_label ? (
        <div className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2">
          <span className="text-zinc-300">{data.account_label}</span>
          {data.card_name ? <span className="text-zinc-400"> • {data.card_name}</span> : null}
          {data.card_last4 ? <span className="text-zinc-400"> • {data.card_last4}</span> : null}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2">
          <span className="text-zinc-500">Loading card…</span>
        </div>
      )}
    </div>
  </div>
</div>


          {/* ✅ STEP 2: card identity line */}
          {data && (
            <div className="mt-2 text-xs text-zinc-400">
              {data.account_label}
              {data.card_name ? ` • ${data.card_name}` : ""}
              {data.card_last4 ? ` • ${data.card_last4}` : ""}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="text-sm font-semibold text-zinc-100">Details</div>

          {loading && <div className="mt-4 text-sm text-zinc-400">Loading…</div>}
          {err && <div className="mt-4 text-sm text-red-400">Error: {err}</div>}

          {!loading && !err && data && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-xs text-zinc-400">Account</div>
                <div className="mt-1 text-sm text-zinc-100">
                  {data.account_label}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-xs text-zinc-400">Statement Period</div>
                <div className="mt-1 text-sm text-zinc-100">
                  {data.statement_period}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-xs text-zinc-400">Due Date</div>
                <div className="mt-1 text-sm text-zinc-100">{data.due_date}</div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-xs text-zinc-400">New Balance</div>
                <div className="mt-1 text-sm text-zinc-100">
                  ${data.new_balance.toFixed(2)}
                </div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-xs text-zinc-400">APR</div>
                <div className="mt-1 text-sm text-zinc-100">{data.apr}%</div>
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
                <div className="text-xs text-zinc-400">Interest Charged</div>
                <div className="mt-1 text-sm text-zinc-100">
                  ${data.interest_charged.toFixed(2)}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Insights */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">Insights</div>
            <div className="text-xs text-zinc-400">{insights.count} txns</div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
              <div className="text-xs text-zinc-400">Total Spend</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">
                ${insights.spend.toFixed(2)}
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                Debits (positive amounts)
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
              <div className="text-xs text-zinc-400">Total Credits</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">
                ${insights.credits.toFixed(2)}
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                Payments / refunds (negative amounts)
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
              <div className="text-xs text-zinc-400">Net</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">
                ${insights.net.toFixed(2)}
              </div>
              <div className="mt-1 text-xs text-zinc-500">Spend − Credits</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4">
              <div className="text-xs text-zinc-400">Largest Transaction</div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">
                {insights.largest
                  ? `$${Math.abs(Number(insights.largest.amount)).toFixed(2)}`
                  : "—"}
              </div>
              <div className="mt-1 text-xs text-zinc-500 truncate">
                {insights.largest
                  ? insights.largest.description ??
                    insights.largest.merchant ??
                    "—"
                  : "—"}
              </div>
            </div>
          </div>

          {data && (
            <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4">
              <div className="text-xs text-zinc-400">Interest Snapshot</div>
              <div className="mt-1 text-sm text-zinc-200">
                Interest charged:{" "}
                <span className="font-mono">
                  ${data.interest_charged.toFixed(2)}
                </span>{" "}
                • APR: <span className="font-mono">{data.apr}%</span> • Balance:{" "}
                <span className="font-mono">
                  ${data.new_balance.toFixed(2)}
                </span>
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                Next step: we’ll add warnings + suggestions.
              </div>
            </div>
          )}
        </div>

        {/* Transactions */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              Transactions
            </div>
            <div className="text-xs text-zinc-400">
              {filteredSortedTxns.length} shown / {txns.length} total
            </div>
          </div>

          {/* Option C Toolbar (fixed layout) */}
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <input
                className="w-full lg:flex-1 rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
                placeholder="Search merchant / description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />

              <div className="flex w-full flex-wrap gap-2 lg:w-auto">
                <button
                  onClick={() => setTypeFilter("all")}
                  className={[
                    "rounded-xl border border-white/10 px-3 py-2 text-sm",
                    typeFilter === "all"
                      ? "bg-white/10 text-zinc-100"
                      : "bg-white/5 text-zinc-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  All
                </button>
                <button
                  onClick={() => setTypeFilter("spend")}
                  className={[
                    "rounded-xl border border-white/10 px-3 py-2 text-sm",
                    typeFilter === "spend"
                      ? "bg-white/10 text-zinc-100"
                      : "bg-white/5 text-zinc-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  Spends
                </button>
                <button
                  onClick={() => setTypeFilter("credit")}
                  className={[
                    "rounded-xl border border-white/10 px-3 py-2 text-sm",
                    typeFilter === "credit"
                      ? "bg-white/10 text-zinc-100"
                      : "bg-white/5 text-zinc-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  Credits
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
                <select
                  className="w-full sm:w-56 rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                >
                  <option value="date">Sort: Date</option>
                  <option value="amount">Sort: Amount</option>
                </select>

                <button
                  onClick={() =>
                    setSortDir((d) => (d === "desc" ? "asc" : "desc"))
                  }
                  className="w-full sm:w-28 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10"
                  title="Toggle sort direction"
                >
                  {sortDir === "desc" ? "Desc ↓" : "Asc ↑"}
                </button>
              </div>

              <div className="flex w-full flex-wrap gap-2 lg:w-auto lg:justify-end">
                {[50, 100, 200].map((v) => (
                  <button
                    key={v}
                    onClick={() => setHighlightThreshold(v)}
                    className={[
                      "rounded-xl border border-white/10 px-3 py-2 text-sm",
                      highlightThreshold === v
                        ? "bg-white/10 text-zinc-100"
                        : "bg-white/5 text-zinc-300 hover:bg-white/10",
                    ].join(" ")}
                    title="Highlight transactions >= threshold"
                  >
                    ${v}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {txLoading && (
            <div className="mt-4 text-sm text-zinc-400">
              Loading transactions…
            </div>
          )}
          {txErr && (
            <div className="mt-4 text-sm text-red-400">Error: {txErr}</div>
          )}

          {!txLoading && !txErr && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-400">
                  <tr className="border-b border-white/10">
                    <th className="py-3 pr-4">date</th>
                    <th className="py-3 pr-4">description</th>
                    <th className="py-3 pr-4">category</th>
                    <th className="py-3 pr-4 text-right">amount</th>
                  </tr>
                </thead>

                <tbody className="text-zinc-200">
                  {filteredSortedTxns.map((t, idx) => {
                    const credit = isCreditLike(t);
                    const abs = amountAbs(t);
                    const highlight = abs >= highlightThreshold;
                    const cat = categoryFor(t, rules);

                    return (
                      <tr
                        key={t.id ?? idx}
                        className={[
                          "border-b border-white/5 hover:bg-white/5",
                          highlight ? "bg-white/[0.04]" : "",
                        ].join(" ")}
                      >
                        <td className="py-3 pr-4 text-zinc-300">
                          {fmtDate(t.posted_date ?? t.date) || "—"}
                        </td>

                        <td className="py-3 pr-4 text-zinc-200">
                          <div className="flex items-center gap-2">
                            <div className="truncate max-w-[520px]">
                              {t.description ?? t.merchant ?? "—"}
                            </div>
                            {highlight && (
                              <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-zinc-300">
                                Large
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-[11px] text-zinc-500">
                            sig:{" "}
                            <span className="font-mono">{signatureFor(t)}</span>
                          </div>
                        </td>

                        <td className="py-3 pr-4">
                          <select
                            className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                            value={cat}
                            onChange={(e) =>
                              setCategory(t, e.target.value as Category)
                            }
                            title="Selecting a category saves rule for similar transactions"
                          >
                            {CATEGORY_OPTIONS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <div className="mt-1 text-[11px] text-zinc-500">
                            Auto-applies to similar merchants
                          </div>
                        </td>

                        <td
                          className={[
                            "py-3 pr-4 text-right font-mono",
                            credit ? "text-emerald-300" : "text-zinc-200",
                          ].join(" ")}
                          title={credit ? "Credit / Payment" : "Spend"}
                        >
                          {credit ? "-" : ""}
                          ${abs.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}

                  {filteredSortedTxns.length === 0 && (
                    <tr>
                      <td className="py-6 text-zinc-400" colSpan={4}>
                        No transactions match your filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <div className="mt-3 text-xs text-zinc-500">
                Tip: Category rules are saved in your browser (localStorage). If
                you open in another browser/device, rules won’t be there (we’ll
                sync to backend later in V2).
              </div>
            </div>
          )}
        </div>
      
    </AppShell>
  );
}
