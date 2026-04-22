"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  AuthResponse,
  AuthUser,
  clearSessionToken,
  getMe,
  getSessionToken,
  login as apiLogin,
  logout as apiLogout,
  sessionEventName,
  setSessionToken,
  signup as apiSignup,
} from "@/lib/api";

type AuthState = "loading" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  status: AuthState;
  user: AuthUser | null;
  login: (input: { email: string; password: string }) => Promise<AuthResponse>;
  signup: (input: { email: string; password: string; display_name?: string }) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  async function refresh() {
    const token = getSessionToken();
    if (!token) {
      setUser(null);
      setStatus("unauthenticated");
      return;
    }

    try {
      const res = await getMe();
      setUser(res.user);
      setStatus("authenticated");
    } catch {
      clearSessionToken();
      setUser(null);
      setStatus("unauthenticated");
    }
  }

  useEffect(() => {
    const bootId = window.setTimeout(() => {
      refresh().catch(() => {});
    }, 0);
    const sync = () => {
      refresh().catch(() => {});
    };
    window.addEventListener("storage", sync);
    window.addEventListener(sessionEventName(), sync);
    return () => {
      window.clearTimeout(bootId);
      window.removeEventListener("storage", sync);
      window.removeEventListener(sessionEventName(), sync);
    };
  }, []);

  async function handleLogin(input: { email: string; password: string }) {
    const res = await apiLogin(input);
    setSessionToken(res.token);
    setUser(res.user);
    setStatus("authenticated");
    return res;
  }

  async function handleSignup(input: { email: string; password: string; display_name?: string }) {
    const res = await apiSignup(input);
    setSessionToken(res.token);
    setUser(res.user);
    setStatus("authenticated");
    return res;
  }

  async function handleLogout() {
    try {
      await apiLogout();
    } catch {}
    clearSessionToken();
    setUser(null);
    setStatus("unauthenticated");
  }

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        login: handleLogin,
        signup: handleSignup,
        logout: handleLogout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return value;
}
