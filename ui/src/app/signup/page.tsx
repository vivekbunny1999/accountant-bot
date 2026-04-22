"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

export default function SignupPage() {
  const router = useRouter();
  const { signup } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup({ display_name: displayName, email, password });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100 flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0E141C] p-7">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Accountant Bot</div>
          <h1 className="mt-2 text-2xl font-semibold">Create account</h1>
          <p className="mt-2 text-sm text-zinc-400">One account, one data boundary, one financial workspace.</p>
        </div>

        <div className="space-y-4">
          <input
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
            placeholder="Password (8+ characters)"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </div>

        {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-2xl bg-white/10 px-4 py-3 text-sm font-medium hover:bg-white/15 disabled:opacity-60"
        >
          {busy ? "Creating account..." : "Create account"}
        </button>

        <p className="mt-5 text-sm text-zinc-400">
          Already have one?{" "}
          <Link href="/login" className="text-zinc-100">
            Log in
          </Link>
        </p>
      </form>
    </div>
  );
}
