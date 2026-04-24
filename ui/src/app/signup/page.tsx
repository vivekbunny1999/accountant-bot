"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { PasswordGuidance } from "@/components/auth/PasswordGuidance";
import { useAuth } from "@/components/auth/AuthProvider";
import { getPasswordPolicy, PasswordPolicy } from "@/lib/api";
import { FALLBACK_PASSWORD_POLICY, validatePasswordAgainstPolicy } from "@/lib/password-policy";

export default function SignupPage() {
  const router = useRouter();
  const { signup } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [policy, setPolicy] = useState<PasswordPolicy>(FALLBACK_PASSWORD_POLICY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPasswordPolicy()
      .then((res) => {
        if (res?.policy) setPolicy(res.policy);
      })
      .catch(() => {});
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const passwordError = validatePasswordAgainstPolicy(password, policy);
    if (passwordError) {
      setError(passwordError);
      return;
    }
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
          <p className="mt-2 text-sm text-zinc-400">Signup is beta-gated so only approved testers can create real-data accounts.</p>
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
            placeholder={`Password (${policy.min_length}+ characters)`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={policy.min_length}
          />
        </div>

        <PasswordGuidance password={password} policy={policy} className="mt-4" />

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
