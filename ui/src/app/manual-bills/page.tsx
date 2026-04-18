"use client";

import React, { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  listManualBills,
  createManualBill,
  updateManualBill,
  deleteManualBill,
  ManualBill,
} from "@/lib/api";

export default function ManualBillsPage() {
  const [bills, setBills] = useState<ManualBill[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Partial<ManualBill> | null>(null);
  const [form, setForm] = useState<Partial<ManualBill>>({ frequency: "monthly", category: "Essentials", autopay: false, active: true });

  const USER_ID = "demo";

  async function fetchBills() {
    setLoading(true);
    try {
      const res = await listManualBills({ user_id: USER_ID });
      setBills(res || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBills();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createManualBill(form as any, { user_id: USER_ID });
      setForm({ frequency: "monthly", category: "Essentials", autopay: false, active: true });
      fetchBills();
    } catch (err) {
      alert(String(err));
    }
  }

  async function handleToggleActive(b: ManualBill) {
    try {
      await updateManualBill(b.id, { active: !b.active }, { user_id: USER_ID });
      fetchBills();
    } catch (err) {
      alert(String(err));
    }
  }

  async function handleDelete(b: ManualBill) {
    if (!confirm("Soft-delete this manual bill?")) return;
    try {
      await deleteManualBill(b.id, { user_id: USER_ID });
      fetchBills();
    } catch (err) {
      alert(String(err));
    }
  }

  async function handleSaveEdit() {
    if (!editing || !editing.id) return;
    try {
      await updateManualBill(editing.id, editing as any, { user_id: USER_ID });
      setEditing(null);
      fetchBills();
    } catch (err) {
      alert(String(err));
    }
  }

  return (
    <AppShell>
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Manual Bills</h1>

        <form onSubmit={handleCreate} className="mb-6 grid grid-cols-6 gap-2">
          <input className="col-span-2 p-2 border" placeholder="Name" value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="p-2 border" placeholder="Amount" value={form.amount ?? ""} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} />
          <select className="p-2 border" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as any })}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
            <option value="one_time">One-time</option>
          </select>
          <input className="p-2 border" placeholder="Due day (1-31)" value={form.due_day ?? ""} onChange={(e) => setForm({ ...form, due_day: e.target.value ? Number(e.target.value) : undefined })} />
          <input className="p-2 border" placeholder="Due date (YYYY-MM-DD)" value={form.due_date ?? ""} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          <button className="col-span-1 bg-sky-500 text-white p-2 rounded" type="submit">Add</button>
        </form>

        <div className="bg-white/5 p-4 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-300">
                <th>Name</th>
                <th>Amount</th>
                <th>Frequency</th>
                <th>Due</th>
                <th>Autopay</th>
                <th>Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7}>Loading...</td></tr>
              ) : bills.length === 0 ? (
                <tr><td colSpan={7}>No manual bills</td></tr>
              ) : bills.map((b) => (
                <tr key={b.id} className="border-t border-white/5">
                  <td>{b.name}</td>
                  <td>${Number(b.amount || 0).toFixed(2)}</td>
                  <td>{b.frequency}</td>
                  <td>{b.due_date ?? (b.due_day ? `day ${b.due_day}` : "—")}</td>
                  <td>{b.autopay ? "Yes" : "No"}</td>
                  <td>
                    <button className="p-1 border rounded" onClick={() => handleToggleActive(b)}>{b.active ? "Active" : "Inactive"}</button>
                  </td>
                  <td>
                    <button className="p-1 mr-2 border rounded" onClick={() => setEditing(b)}>Edit</button>
                    <button className="p-1 border rounded text-red-400" onClick={() => handleDelete(b)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editing && (
          <div className="mt-4 p-4 bg-white/5 rounded">
            <h3 className="font-semibold">Edit</h3>
            <div className="grid grid-cols-4 gap-2 mt-2">
              <input className="p-2 border" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <input className="p-2 border" value={editing.amount ?? ""} onChange={(e) => setEditing({ ...editing, amount: Number(e.target.value) })} />
              <select className="p-2 border" value={editing.frequency} onChange={(e) => setEditing({ ...editing, frequency: e.target.value as any })}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
                <option value="one_time">One-time</option>
              </select>
              <input className="p-2 border" value={editing.due_day ?? ""} onChange={(e) => setEditing({ ...editing, due_day: e.target.value ? Number(e.target.value) : undefined })} />
              <input className="p-2 border" value={editing.due_date ?? ""} onChange={(e) => setEditing({ ...editing, due_date: e.target.value })} />
              <div className="col-span-4 mt-2">
                <button className="mr-2 p-2 bg-green-600 rounded" onClick={() => handleSaveEdit()}>Save</button>
                <button className="p-2 bg-zinc-600 rounded" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

      </div>
    </AppShell>
  );
}
