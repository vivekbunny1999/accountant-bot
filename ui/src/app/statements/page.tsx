"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  deleteStatementByCode,
  listStatements,
  Statement,
  uploadCapitalOnePdf,
  type UploadResult,
} from "@/lib/api";

function money(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}
function pct(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

export default function StatementsPage() {
  const [data, setData] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Statement | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [uploading, setUploading] = useState(false);

  // ✅ Replace confirm state
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingUploadMeta, setPendingUploadMeta] = useState<UploadResult | null>(
    null
  );
  const [replacing, setReplacing] = useState(false);

  async function refreshStatements() {
    const updated = await listStatements();
    setData(updated);
  }

  useEffect(() => {
    setLoading(true);
    setErr(null);

    listStatements()
      .then(setData)
      .catch((e) => setErr(e?.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return data;
    return data.filter((s) => (s.statement_code || "").toLowerCase().includes(qq));
  }, [data, q]);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    try {
      setUploading(true);

      const result = await uploadCapitalOnePdf(f); // replace=false default

      // If backend says "already exists" (skip), show replace modal
      if (result?.already_exists) {
        setPendingFile(f);
        setPendingUploadMeta(result);
        setReplaceOpen(true);
        return;
      }

      // Normal success
      await refreshStatements();
      alert(
        `Upload complete ✅${
          result?.imported_txns != null ? ` (${result.imported_txns} txns)` : ""
        }`
      );
    } catch (err: any) {
      alert(err?.message || "Upload failed");
    } finally {
      setUploading(false);
      // allow re-upload same file
      e.target.value = "";
    }
  }

  async function confirmReplace() {
    if (!pendingFile) return;

    try {
      setReplacing(true);

      const result = await uploadCapitalOnePdf(pendingFile, { replace: true });

      await refreshStatements();

      alert(
        `Replaced ✅${
          result?.imported_txns != null ? ` (${result.imported_txns} txns)` : ""
        }`
      );
    } catch (e: any) {
      alert(e?.message || "Replace failed");
    } finally {
      setReplacing(false);
      setReplaceOpen(false);
      setPendingFile(null);
      setPendingUploadMeta(null);
    }
  }

  function openDelete(s: Statement) {
    setToDelete(s);
    setConfirmOpen(true);
  }

  async function confirmDelete() {
    if (!toDelete) return;

    try {
      setDeleting(true);
      await deleteStatementByCode(toDelete.statement_code);

      await refreshStatements();

      setConfirmOpen(false);
      setToDelete(null);
    } catch (e: any) {
      alert(e?.message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  const replaceSummary = useMemo(() => {
    const meta = pendingUploadMeta?.meta;
    if (!meta) return null;

    const card =
      [meta.card_name, meta.card_last4 ? `•••• ${meta.card_last4}` : ""]
        .filter(Boolean)
        .join(" ");

    return {
      period: meta.statement_period ?? "—",
      card: card || "—",
      balance: money(meta.new_balance),
      due: meta.due_date ?? "—",
      code: pendingUploadMeta?.statement_code ?? "—",
    };
  }, [pendingUploadMeta]);

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Top Bar */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="text-lg font-semibold">Statements</div>

          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <input
              className="w-full max-w-xl rounded-xl border border-white/10 bg-[#0B0F14] px-4 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-white/20"
              placeholder="Search statement_code (CO-CAPITALONE-YYYYMM-XXXXXX)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />

            <div className="flex gap-2">
              <button
                onClick={() => window.location.reload()}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-100 hover:bg-white/10"
              >
                Refresh
              </button>

              <label className="cursor-pointer rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-100 hover:bg-white/10">
                {uploading ? "Uploading…" : "+ Upload PDF"}
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={onPickFile}
                  disabled={uploading}
                />
              </label>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] p-5">
          <div className="text-sm font-semibold text-zinc-100">
            All Statements
          </div>

          {loading && (
            <div className="mt-4 text-sm text-zinc-400">Loading…</div>
          )}

          {err && <div className="mt-4 text-sm text-red-400">Error: {err}</div>}

          {!loading && !err && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-400">
                  <tr className="border-b border-white/10">
                    <th className="py-3 pr-4">statement_code</th>
                    <th className="py-3 pr-4">period</th>
                    <th className="py-3 pr-4">due_date</th>
                    <th className="py-3 pr-4">balance</th>
                    <th className="py-3 pr-4">apr</th>
                    <th className="py-3 pr-4">created_at</th>
                    <th className="py-3 pr-4 text-right">actions</th>
                  </tr>
                </thead>

                <tbody className="text-zinc-200">
                  {rows.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-white/5 hover:bg-white/5"
                    >
                      <td className="py-3 pr-4">
                        <Link
                          href={`/statements/${encodeURIComponent(
                            s.statement_code
                          )}`}
                          className="block rounded-lg p-1 -m-1 hover:bg-white/5"
                          title="Open statement details"
                        >
                          <div className="font-mono text-xs text-zinc-100 hover:underline">
                            {s.statement_code}
                          </div>
                          <div className="mt-1 text-xs text-zinc-400">
                            {s.account_label}
                            {s.card_name ? ` • ${s.card_name}` : ""}
                            {s.card_last4 ? ` • ${s.card_last4}` : ""}
                          </div>
                        </Link>
                      </td>

                      <td className="py-3 pr-4 text-zinc-300">
                        {s.statement_period || "—"}
                      </td>
                      <td className="py-3 pr-4 text-zinc-300">
                        {s.due_date || "—"}
                      </td>
                      <td className="py-3 pr-4 text-zinc-300">
                        {money(s.new_balance)}
                      </td>
                      <td className="py-3 pr-4 text-zinc-300">
                        {pct(s.apr)}
                      </td>
                      <td className="py-3 pr-4 text-zinc-400">
                        {s.created_at || "—"}
                      </td>

                      <td className="py-3 pr-4 text-right">
                        <button
                          onClick={() => openDelete(s)}
                          className="rounded-lg border border-white/10 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}

                  {rows.length === 0 && (
                    <tr>
                      <td className="py-6 text-zinc-400" colSpan={7}>
                        No statements found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Confirm Delete Modal */}
        {confirmOpen && toDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="text-base font-semibold">Delete statement?</div>

              <div className="mt-2 text-sm text-zinc-400">
                This will permanently delete:
                <div className="mt-2 rounded-xl border border-white/10 bg-[#0B0F14] p-3 font-mono text-xs text-zinc-200">
                  {toDelete.statement_code}
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  disabled={deleting}
                  onClick={() => {
                    setConfirmOpen(false);
                    setToDelete(null);
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-100 hover:bg-white/10 disabled:opacity-50"
                >
                  Cancel
                </button>

                <button
                  disabled={deleting}
                  onClick={confirmDelete}
                  className="rounded-xl border border-white/10 bg-red-500/20 px-4 py-2 text-sm text-red-200 hover:bg-red-500/30 disabled:opacity-50"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Replace Existing Modal */}
        {replaceOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0E141C] p-5">
              <div className="text-base font-semibold">
                Statement already exists
              </div>

              <div className="mt-2 text-sm text-zinc-400">
                We detected this PDF matches an existing statement.
                Do you want to replace the existing one?
              </div>

              {replaceSummary && (
                <div className="mt-4 rounded-xl border border-white/10 bg-[#0B0F14] p-4 text-sm text-zinc-200">
                  <div className="font-mono text-xs text-zinc-300">
                    {replaceSummary.code}
                  </div>
                  <div className="mt-2 grid gap-1 text-xs text-zinc-400">
                    <div>
                      <span className="text-zinc-500">Card:</span>{" "}
                      {replaceSummary.card}
                    </div>
                    <div>
                      <span className="text-zinc-500">Period:</span>{" "}
                      {replaceSummary.period}
                    </div>
                    <div>
                      <span className="text-zinc-500">Due:</span>{" "}
                      {replaceSummary.due}
                    </div>
                    <div>
                      <span className="text-zinc-500">Balance:</span>{" "}
                      {replaceSummary.balance}
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  disabled={replacing}
                  onClick={() => {
                    setReplaceOpen(false);
                    setPendingFile(null);
                    setPendingUploadMeta(null);
                  }}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-100 hover:bg-white/10 disabled:opacity-50"
                >
                  Cancel
                </button>

                <button
                  disabled={replacing}
                  onClick={confirmReplace}
                  className="rounded-xl border border-white/10 bg-amber-500/20 px-4 py-2 text-sm text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
                >
                  {replacing ? "Replacing…" : "Replace"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}