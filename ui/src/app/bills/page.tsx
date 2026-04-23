"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  createManualBill,
  deleteManualBill,
  listManualBills,
  ManualBill,
  updateManualBill,
} from "@/lib/api";

type BillFormState = {
  name: string;
  amount: string;
  frequency: "monthly" | "weekly";
  due_day: string;
  due_date: string;
  category: "essential" | "discretionary";
};

const EMPTY_FORM: BillFormState = {
  name: "",
  amount: "",
  frequency: "monthly",
  due_day: "",
  due_date: "",
  category: "essential",
};

function fmtMoney(n: number) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function billCategoryLabel(bill: ManualBill) {
  return (bill.category || "Essentials").toLowerCase() === "discretionary"
    ? "Discretionary"
    : "Essential";
}

function toFormState(bill?: ManualBill | null): BillFormState {
  if (!bill) return { ...EMPTY_FORM };
  return {
    name: bill.name || "",
    amount: bill.amount != null ? String(bill.amount) : "",
    frequency: bill.frequency === "weekly" ? "weekly" : "monthly",
    due_day: bill.due_day != null ? String(bill.due_day) : "",
    due_date: bill.due_date || "",
    category: (bill.category || "Essentials").toLowerCase() === "discretionary" ? "discretionary" : "essential",
  };
}

export default function BillsPage() {
  const { user } = useAuth();
  const userId = user?.id ?? "";

  const [bills, setBills] = useState<ManualBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<BillFormState>(EMPTY_FORM);

  const loadBills = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await listManualBills({ user_id: userId });
      setBills((rows || []).filter((row) => row.active !== false));
    } catch (error) {
      setError(getErrorMessage(error, "Failed to load bills."));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    loadBills();
  }, [userId, loadBills]);

  function openCreateForm() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setError(null);
    setFormOpen(true);
  }

  function openEditForm(bill: ManualBill) {
    setEditingId(bill.id);
    setForm(toFormState(bill));
    setError(null);
    setFormOpen(true);
  }

  function closeForm() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || saving) return;

    const trimmedName = form.name.trim();
    const amount = Number(form.amount);
    const dueDay = form.due_day.trim() ? Number(form.due_day) : null;
    const dueDate = form.due_date.trim() || null;

    if (!trimmedName) {
      setError("Bill name is required.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Amount must be greater than 0.");
      return;
    }
    if (!dueDay && !dueDate) {
      setError("Enter either a due day or a due date.");
      return;
    }
    if (dueDay && (dueDay < 1 || dueDay > 31)) {
      setError("Due day must be between 1 and 31.");
      return;
    }

    const current = bills.find((bill) => bill.id === editingId);
    const payload = {
      user_id: userId,
      name: trimmedName,
      amount,
      frequency: form.frequency,
      due_day: dueDay,
      due_date: dueDate,
      category: form.category === "discretionary" ? "Discretionary" : "Essentials",
      active: current?.active ?? true,
      autopay: current?.autopay ?? false,
      notes: current?.notes ?? null,
    };

    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await updateManualBill(editingId, payload, { user_id: userId });
      } else {
        await createManualBill(payload, { user_id: userId });
      }
      closeForm();
      await loadBills();
    } catch (error) {
      setError(getErrorMessage(error, "Failed to save bill."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(bill: ManualBill) {
    if (!userId) return;
    if (!window.confirm(`Delete ${bill.name}?`)) return;

    try {
      await deleteManualBill(bill.id, { user_id: userId });
      await loadBills();
    } catch (error) {
      setError(getErrorMessage(error, "Failed to delete bill."));
    }
  }

  return (
    <AppShell>
      <div className="space-y-5">
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-lg font-semibold text-zinc-100">Bills</div>
              <div className="mt-1 text-sm text-zinc-400">
                Add recurring obligations here so upcoming obligations and STS can protect them.
              </div>
            </div>

            <button
              onClick={openCreateForm}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-100 hover:bg-white/10"
            >
              Add Bill
            </button>
          </div>
        </div>

        {formOpen && (
          <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
            <div className="text-sm font-semibold text-zinc-100">
              {editingId ? "Edit Bill" : "New Bill"}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Use due day for monthly bills or due date when you want a specific anchor date.
            </div>

            <form onSubmit={handleSubmit} className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <div className="xl:col-span-2">
                <div className="text-xs text-zinc-400">Name</div>
                <input
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  placeholder="Rent"
                />
              </div>

              <div>
                <div className="text-xs text-zinc-400">Amount</div>
                <input
                  value={form.amount}
                  onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
                  inputMode="decimal"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  placeholder="1200"
                />
              </div>

              <div>
                <div className="text-xs text-zinc-400">Frequency</div>
                <select
                  value={form.frequency}
                  onChange={(e) => setForm((prev) => ({ ...prev, frequency: e.target.value as "monthly" | "weekly" }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>

              <div>
                <div className="text-xs text-zinc-400">Due Day</div>
                <input
                  value={form.due_day}
                  onChange={(e) => setForm((prev) => ({ ...prev, due_day: e.target.value }))}
                  inputMode="numeric"
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                  placeholder="1-31"
                />
              </div>

              <div>
                <div className="text-xs text-zinc-400">Due Date</div>
                <input
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setForm((prev) => ({ ...prev, due_date: e.target.value }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                />
              </div>

              <div>
                <div className="text-xs text-zinc-400">Category</div>
                <select
                  value={form.category}
                  onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value as "essential" | "discretionary" }))}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0B0F14] px-3 py-2 text-sm text-zinc-100 outline-none focus:border-white/20"
                >
                  <option value="essential">Essential</option>
                  <option value="discretionary">Discretionary</option>
                </select>
              </div>

              <div className="md:col-span-2 xl:col-span-6 flex flex-wrap gap-2 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-sm text-zinc-100 hover:bg-white/15 disabled:opacity-60"
                >
                  {saving ? "Saving..." : editingId ? "Save Changes" : "Create Bill"}
                </button>
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-2 text-sm text-zinc-300 hover:bg-white/5"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-zinc-100">All Bills</div>
            <div className="text-xs text-zinc-500">{bills.length} total</div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-zinc-400">
                <tr className="border-b border-white/10">
                  <th className="py-3 pr-4">bill</th>
                  <th className="py-3 pr-4">amount</th>
                  <th className="py-3 pr-4">due</th>
                  <th className="py-3 pr-4">frequency</th>
                  <th className="py-3 pr-4">category</th>
                  <th className="py-3 pr-4">status</th>
                  <th className="py-3 pr-0 text-right">actions</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-zinc-400">
                      Loading bills...
                    </td>
                  </tr>
                ) : bills.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-zinc-400">
                      No bills yet. Add rent, utilities, subscriptions, or other recurring obligations.
                    </td>
                  </tr>
                ) : (
                  bills.map((bill) => (
                    <tr key={bill.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-3 pr-4">
                        <div className="text-zinc-100">{bill.name}</div>
                      </td>
                      <td className="py-3 pr-4 font-mono">{fmtMoney(Number(bill.amount || 0))}</td>
                      <td className="py-3 pr-4 text-zinc-300">
                        {bill.due_date || (bill.due_day ? `Day ${bill.due_day}` : "-")}
                      </td>
                      <td className="py-3 pr-4 capitalize">{bill.frequency || "monthly"}</td>
                      <td className="py-3 pr-4">{billCategoryLabel(bill)}</td>
                      <td className="py-3 pr-4">{bill.active === false ? "Inactive" : "Active"}</td>
                      <td className="py-3 pr-0">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => openEditForm(bill)}
                            className="rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-100 hover:bg-white/10"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(bill)}
                            className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/20"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
