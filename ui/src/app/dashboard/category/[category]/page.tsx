"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import {
  listStatements,
  listStatementTransactions,
  Statement,
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

  // "Jan 05, 2026" etc
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;

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

function monthKeyFromTxn(t: Transaction): string | null {
  const d = parseDateLoose(t.posted_date ?? t.date);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`; // YYYY-MM
}

function labelFromMonthKey(key: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** We attach “card identity” onto each txn row */
type EnrichedTxn = Transaction & {
  _statement_id: number;
  _card_label: string; // e.g. "CapitalOne • Savor • 3090"
};

function cardLabelFromStatement(s: Statement) {
  const parts = [
    s.account_label || "Account",
    s.card_name || "",
    s.card_last4 ? s.card_last4 : "",
  ].filter(Boolean);
  return parts.join(" • ");
}

export default function CategoryDrilldownPage() {
  const params = useParams<{ category: string }>();
  const router = useRouter();
  const sp = useSearchParams();

  const category = useMemo(() => {
    const raw = decodeURIComponent(params?.category ?? "");
    return raw as Category;
  }, [params]);

  const monthParam = sp.get("month") ?? "all"; // "all" or YYYY-MM

  const [rules, setRules] = useState<Record<string, Category>>({});
  const [statements, setStatements] = useState<Statement[]>([]);
  const [txns, setTxns] = useState<EnrichedTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // toolbar state (same as statement page)
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

  // Load: statements -> txns per statement -> enrich with card identity
  useEffect(() => {
    setLoading(true);
    setErr(null);

    listStatements()
      .then(async (ss) => {
        setStatements(ss);

        // pull txns for every statement (V1 approach; optimize later)
        const all: EnrichedTxn[] = [];
        for (const s of ss) {
          try {
            const list = await listStatementTransactions(s.id);
            const label = cardLabelFromStatement(s);

            for (const t of list) {
              all.push({
                ...t,
                _statement_id: s.id,
                _card_label: label,
              });
            }
          } catch {
            // ignore statement txn fetch failures individually; keep going
          }
        }

        setTxns(all);
      })
      .catch((e) => setErr(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  function setCategoryRule(t: Transaction, cat: Category) {
    const sig = signatureFor(t);
    const next = { ...rules, [sig]: cat };
    setRules(next);
    saveRules(next);
  }

  // Month options from loaded txns (plus All)
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of txns) {
      const mk = monthKeyFromTxn(t);
      if (mk) set.add(mk);
    }
    return Array.from(set).sort((a, b) => b.localeCompare(a)); // newest first
  }, [txns]);

  // Filter to this category + month
  const txnsInCategory = useMemo(() => {
    let list = txns.filter((t) => categoryFor(t, rules) === category);

    if (monthParam !== "all") {
      list = list.filter((t) => monthKeyFromTxn(t) === monthParam);
    }
    return list;
  }, [txns, rules, category, monthParam]);

  // Insights on this category view
  const insights = useMemo(() => {
    const spend = txnsInCategory
      .filter((t) => Number(t.amount) > 0)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const credits = txnsInCategory
      .filter((t) => Number(t.amount) < 0)
      .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

    return { spend, credits, count: txnsInCategory.length };
  }, [txnsInCategory]);

  // Apply toolbar filters/sort/search/highlight
  const filteredSortedTxns = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = [...txnsInCategory];

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
  }, [txnsInCategory, search, typeFilter, sortBy, sortDir]);

  function updateMonth(next: string) {
    // keep URL in sync
    const path = `/dashboard/category/${encodeURIComponent(category)}?month=${encodeURIComponent(
      next
    )}`;
    router.push(path);
  }

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Top header with back */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 hover:bg-white/10"
              title="Back to Dashboard"
            >
              ← Back
            </Link>

            <div className="flex-1" />

            <div className="text-right">
              <div className="text-xs text-zinc-400">Category</div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">
                {category}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs text-zinc-400">Month</div>
              <select
                className="mt-2 w-full sm:w-60 rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                value={monthParam}
                onChange={(e) => updateMonth(e.target.value)}
                title="Filter this category by month"
              >
                <option value="all">All</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>
                    {labelFromMonthKey(m)}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-sm text-zinc-300">
              <div className="text-xs text-zinc-400">{insights.count} txns</div>
              <div className="mt-1">
                Spend:{" "}
                <span className="font-mono text-zinc-100">
                  ${insights.spend.toFixed(2)}
                </span>{" "}
                <span className="text-zinc-500">•</span> Credits:{" "}
                <span className="font-mono text-zinc-100">
                  ${insights.credits.toFixed(2)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Main table */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-100">
              Transactions
            </div>
            <div className="text-xs text-zinc-400">
              {filteredSortedTxns.length} shown
            </div>
          </div>

          {loading && (
            <div className="mt-4 text-sm text-zinc-400">Loading…</div>
          )}
          {err && <div className="mt-4 text-sm text-red-400">Error: {err}</div>}

          {!loading && !err && (
            <>
              {/* Toolbar */}
              <div className="mt-4 flex flex-col gap-3">
                {/* Row 1 */}
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

                {/* Row 2 */}
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

              {/* Table */}
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-zinc-400">
                    <tr className="border-b border-white/10">
                      <th className="py-3 pr-4">date</th>
                      <th className="py-3 pr-4">description</th>
                      <th className="py-3 pr-4">card</th>
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
                          key={(t.id ?? idx) + "|" + t._statement_id}
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
                              <span className="font-mono">
                                {signatureFor(t)}
                              </span>
                            </div>
                          </td>

                          {/* ✅ NEW: card column */}
                          <td className="py-3 pr-4 text-zinc-300">
                            <div className="text-sm text-zinc-200">
                              {t._card_label || "—"}
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500">
                              statement_id:{" "}
                              <span className="font-mono">{t._statement_id}</span>
                            </div>
                          </td>

                          <td className="py-3 pr-4">
                            <select
                              className="w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                              value={cat}
                              onChange={(e) =>
                                setCategoryRule(t, e.target.value as Category)
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
                        <td className="py-6 text-zinc-400" colSpan={5}>
                          No transactions match your filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <div className="mt-3 text-xs text-zinc-500">
                  Tip: Month selector supports All. Category rules are saved in
                  your browser (localStorage).
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}