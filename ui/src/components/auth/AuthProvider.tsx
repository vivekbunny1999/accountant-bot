"use client";

import { createContext, useContext, useEffect, useState } from "react";
import {
  AuthBootstrapResponse,
  AuthResponse,
  AuthUser,
  clearSessionToken,
  confirmPasswordReset as apiConfirmPasswordReset,
  getMe,
  getSessionToken,
  login as apiLogin,
  logout as apiLogout,
  requestPasswordReset as apiRequestPasswordReset,
  sessionEventName,
  setSessionToken,
  signup as apiSignup,
} from "@/lib/api";

type AuthState = "loading" | "authenticated" | "unauthenticated";

type AuthContextValue = {
  status: AuthState;
  user: AuthUser | null;
  bootstrap: AuthBootstrapResponse | null;
  login: (input: { email: string; password: string }) => Promise<AuthResponse>;
  signup: (input: { email: string; password: string; display_name?: string }) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  requestPasswordReset: (input: { email: string }) => ReturnType<typeof apiRequestPasswordReset>;
  confirmPasswordReset: (input: { token: string; password: string }) => Promise<AuthResponse>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthState>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootstrap, setBootstrap] = useState<AuthBootstrapResponse | null>(null);

  async function refresh() {
    const token = getSessionToken();
    if (!token) {
      setBootstrap(null);
      setUser(null);
      setStatus("unauthenticated");
      return;
    }

    try {
      const res = await getMe();
      setBootstrap(res);
      setUser(res.user);
      setStatus("authenticated");
    } catch {
      clearSessionToken();
      setBootstrap(null);
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
    setSessionToken(res.token, res.expires_at);
    setUser(res.user);
    setStatus("authenticated");
    await refresh();
    return res;
  }

  async function handleSignup(input: { email: string; password: string; display_name?: string }) {
    const res = await apiSignup(input);
    setSessionToken(res.token, res.expires_at);
    setUser(res.user);
    setStatus("authenticated");
    await refresh();
    return res;
  }

  async function handleLogout() {
    try {
      await apiLogout();
    } catch {}
    clearSessionToken();
    setBootstrap(null);
    setUser(null);
    setStatus("unauthenticated");
  }

  async function handleConfirmPasswordReset(input: { token: string; password: string }) {
    const res = await apiConfirmPasswordReset(input);
    setSessionToken(res.token, res.expires_at);
    setUser(res.user);
    setStatus("authenticated");
    await refresh();
    return res;
  }

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        bootstrap,
        login: handleLogin,
        signup: handleSignup,
        logout: handleLogout,
        refresh,
        requestPasswordReset: apiRequestPasswordReset,
        confirmPasswordReset: handleConfirmPasswordReset,
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
