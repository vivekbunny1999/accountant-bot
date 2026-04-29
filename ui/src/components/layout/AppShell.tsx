"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

const primaryNav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/activity", label: "Activity" },
  { href: "/bills", label: "Bills" },
  { href: "/debts", label: "Debts" },
  { href: "/settings", label: "Settings" },
];

const sourceNav = [
  { href: "/plaid", label: "Plaid" },
  { href: "/cash-accounts", label: "Cash Accounts" },
  { href: "/statements", label: "Statements" },
];

function SidebarArrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {direction === "left" ? (
        <path d="M15 18l-6-6 6-6" />
      ) : (
        <path d="M9 18l6-6-6-6" />
      )}
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
    >
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const primaryIdentity = user?.display_name || user?.username || user?.email || "Signed in";
  const secondaryIdentity =
    user?.email && user.email !== primaryIdentity
      ? user.email
      : user?.username && `@${user.username}`;

  return (
    <div className="min-h-screen bg-[#0B0F14] text-zinc-100">
      <div className="mx-auto flex max-w-[1400px] gap-4 p-5 sm:gap-6">
        {sidebarOpen ? (
          <aside className="w-64 shrink-0 rounded-2xl border border-white/10 bg-[#0E141C] p-4">
            <div className="flex items-start gap-2 px-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">Accountant Bot</div>
                <div className="truncate text-xs text-zinc-200">{primaryIdentity}</div>
                {secondaryIdentity ? <div className="mt-1 truncate text-[11px] text-zinc-500">{secondaryIdentity}</div> : null}
              </div>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-zinc-200 transition-colors hover:bg-white/10 hover:text-zinc-100"
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
              >
                <SidebarArrow direction="left" />
              </button>
            </div>

            <div className="my-3 h-px bg-white/10" />

            <nav className="flex flex-col gap-1">
              {primaryNav.map((i) => {
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

            <div className="mt-6">
              <div className="px-2 pb-2 text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Source Views
              </div>
              <nav className="flex flex-col gap-1">
                {sourceNav.map((i) => {
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
            </div>
          </aside>
        ) : null}

        <main className="min-w-0 flex-1">
          {!sidebarOpen ? (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-[#0E141C] text-zinc-200 shadow-[0_16px_40px_rgba(0,0,0,0.18)] transition-colors hover:bg-white/10 hover:text-zinc-100"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <MenuIcon />
            </button>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
