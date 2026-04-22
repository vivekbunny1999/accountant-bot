"use client";

import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100 flex items-center justify-center px-4">
      <div className="w-full max-w-2xl rounded-3xl border border-white/10 bg-[#0E141C] p-8">
        <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Accountant Bot</div>
        <h1 className="mt-3 text-3xl font-semibold">Financial OS for real-user testing</h1>
        <p className="mt-3 max-w-xl text-sm text-zinc-400">
          Sign in to reach your private dashboard, statements, cash accounts, debts, bills, and linked Plaid data.
        </p>
        <div className="mt-6 flex gap-3">
          <Link href="/login" className="rounded-2xl bg-white/10 px-5 py-3 text-sm font-medium hover:bg-white/15">
            Log in
          </Link>
          <Link href="/signup" className="rounded-2xl border border-white/10 px-5 py-3 text-sm text-zinc-300 hover:bg-white/5">
            Create account
          </Link>
        </div>
      </div>
    </div>
  );
}
