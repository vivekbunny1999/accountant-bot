"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

export default function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await requestPasswordReset({ email });
      const extra =
        res.delivery_mode === "manual_beta"
          ? " During beta, reset links are delivered manually by the operator."
          : "";
      setMessage(`${res.message}${extra}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start password reset.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100 flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0E141C] p-7">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Accountant Bot</div>
          <h1 className="mt-2 text-2xl font-semibold">Reset password</h1>
          <p className="mt-2 text-sm text-zinc-400">Enter your email and we’ll queue a reset for your beta account.</p>
        </div>

        <input
          className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        {message ? <div className="mt-4 text-sm text-emerald-300">{message}</div> : null}
        {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-2xl bg-white/10 px-4 py-3 text-sm font-medium hover:bg-white/15 disabled:opacity-60"
        >
          {busy ? "Submitting..." : "Request reset"}
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
