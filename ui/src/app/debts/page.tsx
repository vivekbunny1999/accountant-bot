"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { createDebt, Debt, deleteDebt, listDebts, updateDebt } from "@/lib/api";

type DebtFormState = {
  kind: string;
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

const DEBT_KIND_OPTIONS = [
  { value: "credit_card", label: "Credit Card" },
  { value: "loan", label: "Loan" },
  { value: "other", label: "Other" },
];
const HIGH_APR_THRESHOLD = 18;

function fmtMoney(value?: number | null) {
  const amount = Number(value ?? 0);
  return `$${amount.toFixed(2)}`;
}

function debtKindLabel(kind?: string | null) {
  const value = (kind || "other").toLowerCase();
  if (value === "credit_card") return "Credit card";
  if (value === "loan") return "Loan";
  return "Other debt";
}

function dueLabel(debt: Debt) {
  if (debt.due_date) return debt.due_date;
  if (debt.due_day != null) return `Day ${debt.due_day}`;
  return "Not set";
}

function emptyDebtForm(): DebtFormState {
  return {
    kind: "credit_card",
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
    kind: debt?.kind ?? "credit_card",
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

function normalizeDebtPayload(form: DebtFormState, userId: string) {
  return {
    user_id: userId,
    kind: form.kind || "credit_card",
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

function InputField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block">
      <div className="text-xs text-zinc-400">{props.label}</div>
      <input
        type={props.type || "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
      />
    </label>
  );
}

function DebtFormFields({
  form,
  onChange,
}: {
  form: DebtFormState;
  onChange: (next: DebtFormState) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="block">
          <div className="text-xs text-zinc-400">Type</div>
          <select
            value={form.kind}
            onChange={(e) => onChange({ ...form, kind: e.target.value })}
            className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
          >
            {DEBT_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <InputField
          label="Name"
          value={form.name}
          onChange={(value) => onChange({ ...form, name: value })}
          placeholder="Venture"
        />
        <InputField
          label="Lender"
          value={form.lender}
          onChange={(value) => onChange({ ...form, lender: value })}
          placeholder="Capital One"
        />
        <InputField
          label="Last 4"
          value={form.last4}
          onChange={(value) => onChange({ ...form, last4: value })}
          placeholder="4399"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <InputField
          label="Balance"
          value={form.balance}
          onChange={(value) => onChange({ ...form, balance: value })}
          placeholder="812.05"
        />
        <InputField
          label="APR"
          value={form.apr}
          onChange={(value) => onChange({ ...form, apr: value })}
          placeholder="28.24"
        />
        <InputField
          label="Minimum due"
          value={form.minimum_due}
          onChange={(value) => onChange({ ...form, minimum_due: value })}
          placeholder="25"
        />
        <InputField
          label="Due day"
          value={form.due_day}
          onChange={(value) => onChange({ ...form, due_day: value })}
          placeholder="2"
        />
        <InputField
          label="Due date"
          value={form.due_date}
          onChange={(value) => onChange({ ...form, due_date: value })}
          placeholder="2026-05-02"
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <InputField
          label="Credit limit"
          value={form.credit_limit}
          onChange={(value) => onChange({ ...form, credit_limit: value })}
          placeholder="5000"
        />
        <label className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-3 text-sm text-zinc-200">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => onChange({ ...form, active: e.target.checked })}
            className="h-4 w-4 accent-white"
          />
          Active debt
        </label>
      </div>
    </div>
  );
}

export default function DebtsPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const [debts, setDebts] = useState<Debt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newDebtForm, setNewDebtForm] = useState<DebtFormState>(() => emptyDebtForm());
  const [editingDebtId, setEditingDebtId] = useState<number | null>(null);
  const [editingDebtForm, setEditingDebtForm] = useState<DebtFormState>(() => emptyDebtForm());
  const [saving, setSaving] = useState(false);

  const fetchDebtRegistry = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await listDebts({ user_id: userId });
      setDebts(rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load debts");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    fetchDebtRegistry();
  }, [userId, fetchDebtRegistry]);

  const summary = useMemo(() => {
    const activeDebts = debts.filter((debt) => debt.active !== false);
    const highAprCount = activeDebts.filter((debt) => Number(debt.apr || 0) > HIGH_APR_THRESHOLD).length;
    return {
      count: debts.length,
      activeCount: activeDebts.length,
      totalBalance: activeDebts.reduce((sum, debt) => sum + Number(debt.balance || 0), 0),
      totalMinimumDue: activeDebts.reduce((sum, debt) => sum + Number(debt.minimum_due || 0), 0),
      highAprCount,
    };
  }, [debts]);

  function startCreateDebt() {
    setStatus(null);
    setError(null);
    setShowCreate(true);
    setEditingDebtId(null);
    setNewDebtForm(emptyDebtForm());
  }

  function startEditDebt(debt: Debt) {
    setStatus(null);
    setError(null);
    setShowCreate(false);
    setEditingDebtId(debt.id);
    setEditingDebtForm(debtToForm(debt));
  }

  function cancelEditor() {
    setShowCreate(false);
    setEditingDebtId(null);
    setStatus(null);
    setError(null);
    setNewDebtForm(emptyDebtForm());
    setEditingDebtForm(emptyDebtForm());
  }

  async function handleCreateDebt() {
    if (!userId || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await createDebt(normalizeDebtPayload(newDebtForm, userId), { user_id: userId });
      setStatus("Debt saved.");
      setShowCreate(false);
      setNewDebtForm(emptyDebtForm());
      await fetchDebtRegistry();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save debt");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveEdit() {
    if (!userId || !editingDebtId || saving) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await updateDebt(editingDebtId, normalizeDebtPayload(editingDebtForm, userId), { user_id: userId });
      setStatus("Debt updated.");
      setEditingDebtId(null);
      setEditingDebtForm(emptyDebtForm());
      await fetchDebtRegistry();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update debt");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDebt(debt: Debt) {
    if (!userId) return;
    const confirmed = window.confirm(`Delete ${debt.name}?`);
    if (!confirmed) return;

    setError(null);
    setStatus(null);
    try {
      await deleteDebt(debt.id, { user_id: userId });
      setStatus("Debt deleted.");
      if (editingDebtId === debt.id) {
        cancelEditor();
      }
      await fetchDebtRegistry();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete debt");
    }
  }

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-lg font-semibold text-zinc-100">Debts</div>
              <div className="mt-1 text-sm text-zinc-400">
                Manage the debt registry that powers utilization, minimums, and Financial OS planning.
              </div>
            </div>

          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Tracked debts</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{summary.count}</div>
            <div className="mt-1 text-xs text-zinc-500">{summary.activeCount} active</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Active balances</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(summary.totalBalance)}</div>
            <div className="mt-1 text-xs text-zinc-500">From the debt registry</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">Minimum due total</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{fmtMoney(summary.totalMinimumDue)}</div>
            <div className="mt-1 text-xs text-zinc-500">Used by upcoming obligation planning</div>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-xs text-zinc-400">High APR debts</div>
            <div className="mt-2 text-2xl font-semibold text-zinc-100">{summary.highAprCount}</div>
            <div className="mt-1 text-xs text-zinc-500">APR above {HIGH_APR_THRESHOLD}%</div>
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        {status ? (
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-emerald-200">
            {status}
          </div>
        ) : null}

        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-zinc-100">Debt registry</div>
              <div className="mt-1 text-xs text-zinc-400">
                Name, balance, APR, minimum due, due timing, and type all live here now.
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={startCreateDebt}
                className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs text-zinc-100 transition-transform duration-150 hover:-translate-y-0.5 hover:bg-white/15 active:translate-y-0.5 active:scale-95"
              >
                Add debt
              </button>
              <button
                type="button"
                onClick={fetchDebtRegistry}
                className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
              >
                Refresh
              </button>
            </div>
          </div>

          {showCreate ? (
            <div className="mt-4 rounded-2xl border border-sky-500/20 bg-sky-500/5 p-4">
              <div className="text-sm font-semibold text-zinc-100">Add debt</div>
              <div className="mt-1 text-xs text-zinc-400">
                This writes directly to the existing backend debt registry.
              </div>
              <div className="mt-4">
                <DebtFormFields form={newDebtForm} onChange={setNewDebtForm} />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleCreateDebt}
                  disabled={saving}
                  className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {saving ? "Saving..." : "Save debt"}
                </button>
                <button
                  type="button"
                  onClick={cancelEditor}
                  className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-100 hover:bg-white/10"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-4 space-y-3">
            {loading ? (
              <div className="rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                Loading debt registry...
              </div>
            ) : debts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-400">
                No debts yet. Add one to start tracking balances and minimums.
              </div>
            ) : (
              debts.map((debt) => {
                const isEditing = editingDebtId === debt.id;
                return (
                  <div key={debt.id} className="rounded-2xl border border-white/10 bg-[#0B0F14] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-zinc-100">{debt.name}</div>
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-zinc-300">
                            {debtKindLabel(debt.kind)}
                          </span>
                          {debt.lender ? (
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-zinc-300">
                              {debt.lender}
                            </span>
                          ) : null}
                          {debt.last4 ? (
                            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-zinc-300">
                              **** {debt.last4}
                            </span>
                          ) : null}
                          {Number(debt.apr || 0) > HIGH_APR_THRESHOLD ? (
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-200">
                              High APR
                            </span>
                          ) : null}
                        </div>
                        <div className="hidden">
                          {[debt.kind || "Debt", debt.lender || null, debt.last4 ? `**** ${debt.last4}` : null]
                            .filter(Boolean)
                            .join(" | ")}
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
                        <button
                          type="button"
                          onClick={() => handleDeleteDebt(debt)}
                          className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/20"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 xl:grid-cols-5">
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        <div className="text-[11px] text-zinc-500">Balance</div>
                        <div className="mt-1 font-medium text-zinc-100">{fmtMoney(debt.balance)}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        <div className="text-[11px] text-zinc-500">APR</div>
                        <div className="mt-1 font-medium text-zinc-100">
                          {debt.apr != null ? `${Number(debt.apr).toFixed(2)}%` : "-"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        <div className="text-[11px] text-zinc-500">Minimum</div>
                        <div className="mt-1 font-medium text-zinc-100">
                          {debt.minimum_due != null ? fmtMoney(debt.minimum_due) : "-"}
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        <div className="text-[11px] text-zinc-500">Due</div>
                        <div className="mt-1 font-medium text-zinc-100">{dueLabel(debt)}</div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        <div className="text-[11px] text-zinc-500">Credit limit</div>
                        <div className="mt-1 font-medium text-zinc-100">
                          {debt.credit_limit != null ? fmtMoney(debt.credit_limit) : "-"}
                        </div>
                      </div>
                    </div>

                    <div className="hidden mt-3 grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 xl:grid-cols-6">
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        Balance: {fmtMoney(debt.balance)}
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        APR: {debt.apr != null ? `${Number(debt.apr).toFixed(2)}%` : "—"}
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        Minimum: {debt.minimum_due != null ? fmtMoney(debt.minimum_due) : "—"}
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        Due day: {debt.due_day ?? "—"}
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        Due date: {debt.due_date || "—"}
                      </div>
                      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                        Type: {debt.kind || "credit_card"}
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
                            onClick={handleSaveEdit}
                            disabled={saving}
                            className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
                          >
                            {saving ? "Saving..." : "Save changes"}
                          </button>
                          <button
                            type="button"
                            onClick={cancelEditor}
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
        </div>
      </div>
    </AppShell>
  );
}
