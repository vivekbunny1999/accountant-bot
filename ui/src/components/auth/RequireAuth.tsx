"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";

const PUBLIC_PATHS = new Set(["/", "/login", "/signup"]);

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status } = useAuth();
  const isPublic = PUBLIC_PATHS.has(pathname || "/");

  useEffect(() => {
    if (status === "loading") return;
    if (!isPublic && status === "unauthenticated") {
      router.replace("/login");
      return;
    }
    if (isPublic && status === "authenticated" && pathname !== "/dashboard") {
      router.replace("/dashboard");
    }
  }, [isPublic, pathname, router, status]);

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-[#0B0F14] text-zinc-100 flex items-center justify-center">
        <div className="rounded-2xl border border-white/10 bg-[#0E141C] px-5 py-4 text-sm text-zinc-300">
          Loading Accountant Bot...
        </div>
      </div>
    );
  }

  if (!isPublic && status !== "authenticated") {
    return null;
  }

  return <>{children}</>;
}
