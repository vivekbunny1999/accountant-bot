"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plaid", label: "Plaid" },
  { href: "/cash-accounts", label: "Cash Accounts" },
  { href: "/statements", label: "Statements" },
  { href: "/transactions", label: "Transactions" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100">
      <div className="mx-auto flex max-w-[1400px] gap-6 p-5">
        <aside className="w-64 shrink-0 rounded-2xl border border-white/10 bg-[#0E141C] p-4">
          <div className="px-2 py-2">
            <div className="text-sm font-semibold">Accountant Bot</div>
            <div className="text-xs text-zinc-400">{user?.display_name || user?.email || "Signed in"}</div>
          </div>

          <div className="my-3 h-px bg-white/10" />

          <nav className="flex flex-col gap-1">
            {nav.map((i) => {
              const active =
                pathname === i.href || (i.href !== "/" && pathname?.startsWith(i.href));

              return (
                <Link
                  key={i.href}
                  href={i.href}
                  className={[
                    "rounded-xl px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-white/10 text-zinc-100"
                      : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100",
                  ].join(" ")}
                >
                  {i.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-6 border-t border-white/10 pt-4">
            <button
              onClick={handleLogout}
              className="w-full rounded-xl px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
            >
              Log out
            </button>
          </div>
        </aside>

        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
