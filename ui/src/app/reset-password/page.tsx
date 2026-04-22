"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { confirmPasswordReset } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    const token = searchParams.get("token") || "";
    if (!token) {
      setError("Reset token is missing.");
      return;
    }

    setBusy(true);
    try {
      await confirmPasswordReset({ token, password });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100 flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0E141C] p-7">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Accountant Bot</div>
          <h1 className="mt-2 text-2xl font-semibold">Choose a new password</h1>
          <p className="mt-2 text-sm text-zinc-400">Resetting your password signs out older sessions automatically.</p>
        </div>

        <div className="space-y-4">
          <input
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
            placeholder="New password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <input
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
            placeholder="Confirm password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-2xl bg-white/10 px-4 py-3 text-sm font-medium hover:bg-white/15 disabled:opacity-60"
        >
          {busy ? "Saving..." : "Save new password"}
        </button>

        <p className="mt-5 text-sm text-zinc-400">
          Back to{" "}
          <Link href="/login" className="text-zinc-100">
            login
          </Link>
        </p>
      </form>
    </div>
  );
}
