"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
    >
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <path d="M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
      {crossed ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password });
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100 flex items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-md rounded-3xl border border-white/10 bg-[#0E141C] p-7">
        <div className="mb-6">
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Accountant Bot</div>
          <h1 className="mt-2 text-2xl font-semibold">Log in</h1>
          <p className="mt-2 text-sm text-zinc-400">Limited beta access for trusted users with real financial data.</p>
        </div>

        <div className="space-y-4">
          <input
            className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <div className="relative">
            <input
              className="w-full rounded-2xl border border-white/10 bg-black/20 py-3 pl-4 pr-14 outline-none"
              placeholder="Password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-xl text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-white/20"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              <EyeIcon crossed={showPassword} />
            </button>
          </div>
        </div>

        {error ? <div className="mt-4 text-sm text-rose-300">{error}</div> : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded-2xl bg-white/10 px-4 py-3 text-sm font-medium hover:bg-white/15 disabled:opacity-60"
        >
          {busy ? "Logging in..." : "Log in"}
        </button>

        <div className="mt-5 flex items-center justify-between gap-4 text-sm text-zinc-400">
          <Link href="/forgot-password" className="text-zinc-100">
            Forgot password?
          </Link>
          <Link href="/signup" className="text-zinc-100">
            Create account
          </Link>
        </div>
      </form>
    </div>
  );
}
