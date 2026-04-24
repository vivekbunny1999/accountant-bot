// src/lib/api.tsx

const BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const SESSION_TOKEN_KEY = "accountantbot_session_token_v1";
const SESSION_EXPIRES_AT_KEY = "accountantbot_session_expires_at_v1";
const SESSION_EVENT = "accountantbot:session-changed";

export type AuthUser = {
  id: string;
  email: string;
  username?: string | null;
  display_name?: string | null;
  auth_enabled?: boolean;
  email_verified?: boolean;
  email_verified_at?: string | null;
  email_verification_required?: boolean;
  email_verification_status?: "verified" | "not_verified" | "verification_not_configured" | string;
  can_resend_verification?: boolean;
  beta_access_approved?: boolean;
  password_changed_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type AuthResponse = {
  ok: boolean;
  token: string;
  expires_at: string;
  user: AuthUser;
};

export type AuthBootstrapResponse = {
  ok: boolean;
  user: AuthUser;
  settings: Record<string, any>;
  category_rules: Record<string, any>;
  beta?: {
    signup_mode?: string;
    email_verification_required?: boolean;
    email_verification_configured?: boolean;
    password_reset_delivery?: string;
  };
};

export type PasswordPolicy = {
  min_length: number;
  requires_uppercase: boolean;
  requires_lowercase: boolean;
  requires_number: boolean;
  requires_special: boolean;
};

export function getSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  const expiresAt = window.localStorage.getItem(SESSION_EXPIRES_AT_KEY);
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed) && parsed <= Date.now()) {
      clearSessionToken();
      return null;
    }
  }
  return window.localStorage.getItem(SESSION_TOKEN_KEY);
}

export function setSessionToken(token: string, expiresAt?: string | null) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SESSION_TOKEN_KEY, token);
  if (expiresAt) {
    window.localStorage.setItem(SESSION_EXPIRES_AT_KEY, expiresAt);
  } else {
    window.localStorage.removeItem(SESSION_EXPIRES_AT_KEY);
  }
  window.dispatchEvent(new CustomEvent(SESSION_EVENT));
}

export function clearSessionToken() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SESSION_TOKEN_KEY);
  window.localStorage.removeItem(SESSION_EXPIRES_AT_KEY);
  window.dispatchEvent(new CustomEvent(SESSION_EVENT));
}

export function sessionEventName() {
  return SESSION_EVENT;
}

function authHeaders(headers?: HeadersInit): Headers {
  const out = new Headers(headers || {});
  const token = getSessionToken();
  if (token) out.set("Authorization", `Bearer ${token}`);
  return out;
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store",
    ...init,
    headers: authHeaders(init?.headers),
  });
  if (res.status === 401 && typeof window !== "undefined") {
    clearSessionToken();
  }
  return res;
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    if (typeof data?.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {}

  const text = await res.text().catch(() => "");
  return text || fallback;
}

/* =========================
   Statements / Credit Card
========================= */

export type Statement = {
  id: number;
  user_id: string;
  account_label: string;

  // ✅ card identity
  card_name?: string | null;
  card_last4?: string | null;

  statement_period: string;
  due_date: string;
  minimum_payment: number;
  new_balance: number;
  interest_charged: number;
  apr: number;
  statement_code: string;
  filename: string;
  created_at: string;
};

export type UploadResult = {
  ok: boolean;
  already_exists?: boolean;
  statement_id?: number;
  statement_code?: string;
  imported_txns?: number;
  meta?: {
    filename?: string;
    statement_period?: string;
    due_date?: string;
    minimum_payment?: number;
    new_balance?: number;
    interest_charged?: number;
    apr?: number;
    card_name?: string | null;
    card_last4?: string | null;
  };
};

export async function listStatements(): Promise<Statement[]> {
  const res = await apiFetch(`/statements`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function deleteStatementByCode(statement_code: string): Promise<void> {
  const res = await apiFetch(`/statements/by-code/${encodeURIComponent(statement_code)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await readApiError(res, `Delete failed: ${res.status}`));
}

/**
 * Upload Capital One PDF
 * - replace=false (default): if duplicate detected, backend returns already_exists=true and does NOT create a new row
 * - replace=true: backend replaces existing statement row (no new id) and re-imports transactions
 */
export async function uploadCapitalOnePdf(
  file: File,
  opts?: { replace?: boolean }
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);

  const replace = opts?.replace ? "true" : "false";
  const res = await apiFetch(`/upload/capitalone-pdf?replace=${replace}`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    throw new Error(await readApiError(res, `Upload failed: ${res.status}`));
  }

  return res.json();
}

export async function getStatementByCode(statement_code: string): Promise<Statement> {
  const res = await apiFetch(`/statements/by-code/${encodeURIComponent(statement_code)}`);
  if (!res.ok) throw new Error(await readApiError(res, `Failed: ${res.status}`));
  return res.json();
}

export type Transaction = {
  id?: number;
  date?: string;
  posted_date?: string;
  description?: string;
  merchant?: string;
  amount: number;
  category?: string;
  type?: string;
};

export async function listStatementTransactions(statement_id: number): Promise<Transaction[]> {
  const res = await apiFetch(`/statements/${statement_id}/transactions`);
  if (!res.ok) throw new Error(await readApiError(res, `Failed: ${res.status}`));
  return res.json();
}

/* =========================
        Cash Accounts
========================= */

async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(await readApiError(res, `Failed: ${res.status}`));
  return (await res.json()) as T;
}

async function apiDelete<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(await readApiError(res, `Delete failed: ${res.status}`));

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

async function apiPatch<T>(path: string, body: any): Promise<T> {
  const res = await apiFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(await readApiError(res, `Patch failed: ${res.status}`));

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body: any): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readApiError(res, `Post failed: ${res.status}`));

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

export async function signup(body: {
  email: string;
  password: string;
  display_name?: string;
}): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/auth/signup", body);
}

export async function getPasswordPolicy(): Promise<{
  ok: boolean;
  policy: PasswordPolicy;
  guidance?: {
    recommended_mix?: string[];
  };
}> {
  return apiGet("/auth/password-policy");
}

export async function login(body: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/auth/login", body);
}

export async function logout(): Promise<void> {
  const res = await apiFetch("/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(await readApiError(res, `Logout failed: ${res.status}`));
}

export async function getMe(): Promise<{
  ok: boolean;
  user: AuthUser;
  settings: Record<string, any>;
  category_rules: Record<string, any>;
  beta?: {
    signup_mode?: string;
    email_verification_required?: boolean;
    email_verification_configured?: boolean;
    password_reset_delivery?: string;
  };
}> {
  return apiGet("/auth/me");
}

export async function updateAccountProfile(body: {
  display_name?: string;
  username?: string;
  email?: string;
  current_password?: string;
}): Promise<{
  ok: boolean;
  user: AuthUser;
}> {
  return apiPatch("/auth/profile", body);
}

export async function changePassword(body: {
  current_password: string;
  new_password: string;
}): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/auth/password/change", body);
}

export async function requestPasswordReset(body: { email: string }): Promise<{
  ok: boolean;
  message: string;
  delivery_mode?: string;
  reset_token?: string;
  reset_path?: string;
}> {
  return apiPost("/auth/password-reset/request", body);
}

export async function confirmPasswordReset(body: { token: string; password: string }): Promise<AuthResponse> {
  return apiPost<AuthResponse>("/auth/password-reset/confirm", body);
}

export async function getUserSettings(): Promise<{
  ok: boolean;
  user_id: string;
  settings: Record<string, any>;
  category_rules: Record<string, any>;
}> {
  return apiGet("/user/settings");
}

export async function saveUserSettings(body: {
  settings: Record<string, any>;
  category_rules: Record<string, any>;
}) {
  const res = await apiFetch("/user/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readApiError(res, `Save failed: ${res.status}`));
  return res.json();
}

export async function getCashAccounts(params?: { user_id?: string; limit?: number }) {
  const qs = new URLSearchParams();
  if (params?.user_id) qs.set("user_id", params.user_id);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return apiGet<any[]>(`/cash-accounts${q ? `?${q}` : ""}`);
}

export async function getCashAccountTransactions(
  cash_account_id: string | number,
  params?: { user_id?: string; limit?: number }
) {
  const qs = new URLSearchParams();
  if (params?.user_id) qs.set("user_id", params.user_id);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return apiGet<any[]>(`/cash-accounts/${cash_account_id}/transactions${q ? `?${q}` : ""}`);
}

/**
 * Upload Capital One BANK PDF (checking + savings)
 * Endpoint: POST /upload/capitalone-bank-pdf?user_id=demo
 */
export async function uploadCapitalOneBankPdf(
  file: File,
  params: { user_id: string }
): Promise<any> {
  const form = new FormData();
  form.append("file", file);

  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  const res = await apiFetch(`/upload/capitalone-bank-pdf?${q}`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Upload failed: ${res.status} ${txt}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return { ok: true };
  return res.json();
}

/**
 * Delete a cash account import
 * Endpoint: DELETE /cash-accounts/{cash_account_id}?user_id=demo
 */
export async function deleteCashAccount(
  cash_account_id: string | number,
  params: { user_id: string }
): Promise<any> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiDelete(`/cash-accounts/${cash_account_id}?${q}`);
}

/**
 * Update cash transaction fields (category and/or txn_type)
 * Endpoint: PATCH /cash-transactions/{cash_transaction_id}?user_id=demo
 * Body: { category?: string, txn_type?: string }
 */
export async function updateCashTransaction(
  cash_transaction_id: string | number,
  patch: { category?: string; txn_type?: string },
  params: { user_id: string }
): Promise<any> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPatch(`/cash-transactions/${cash_transaction_id}?${q}`, patch);
}

/**
 * Backward compatible helper: update category only
 */
export async function updateCashTransactionCategory(
  cash_transaction_id: string | number,
  category: string,
  params: { user_id: string }
): Promise<any> {
  return updateCashTransaction(cash_transaction_id, { category }, params);
}

/**
 * Optional helper: update txn_type only
 */
export async function updateCashTransactionType(
  cash_transaction_id: string | number,
  txn_type: string,
  params: { user_id: string }
): Promise<any> {
  return updateCashTransaction(cash_transaction_id, { txn_type }, params);
}

/* =========================
            Bills
========================= */

export type BillFrequency =
  | "weekly"
  | "biweekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export type Bill = {
  id: number;
  user_id: string;

  name: string;              // e.g. "Rent"
  amount: number;            // dollars
  frequency: BillFrequency;  // monthly/weekly/...
  due_day?: number | null;   // for monthly bills: 1..31
  next_due_date?: string | null; // optional "YYYY-MM-DD" (if you store it)
  category?: string | null;  // optional: "Housing", etc
  active?: boolean;          // default true
  autopay?: boolean;         // optional
  essentials?: boolean;      // included in essential obligations/STS
  notes?: string | null;

  created_at?: string;
  updated_at?: string;
};

export async function listBills(params: { user_id: string }): Promise<Bill[]> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiGet<Bill[]>(`/bills?${q}`);
}

export async function createBill(
  bill: Omit<Bill, "id" | "created_at" | "updated_at">,
  params: { user_id: string }
): Promise<Bill> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPost<Bill>(`/bills?${q}`, bill);
}

export async function updateBill(
  bill_id: string | number,
  patch: Partial<Omit<Bill, "id" | "user_id" | "created_at" | "updated_at">>,
  params: { user_id: string }
): Promise<Bill> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPatch<Bill>(`/bills/${bill_id}?${q}`, patch);
}

export async function deleteBill(
  bill_id: string | number,
  params: { user_id: string }
): Promise<any> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiDelete(`/bills/${bill_id}?${q}`);
}

/* =========================
   Manual Bills (OS)
========================= */

export type ManualBillFrequency = BillFrequency | "one_time";

export type ManualBill = {
  id: number;
  user_id: string;

  name: string;
  amount: number;
  frequency: ManualBillFrequency;
  due_day?: number | null;
  due_date?: string | null;
  category?: string | null;
  autopay?: boolean;
  active?: boolean;
  notes?: string | null;

  created_at?: string;
  updated_at?: string;
};

export async function listManualBills(params: { user_id: string }): Promise<ManualBill[]> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiGet<ManualBill[]>(`/os/manual-bills?${q}`);
}

export async function createManualBill(
  payload: Omit<ManualBill, "id" | "created_at" | "updated_at">,
  params: { user_id: string }
): Promise<ManualBill> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPost<ManualBill>(`/os/manual-bills?${q}`, payload);
}

export async function updateManualBill(
  mb_id: string | number,
  patch: Partial<Omit<ManualBill, "id" | "user_id" | "created_at" | "updated_at">>,
  params: { user_id: string }
): Promise<ManualBill> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPatch<ManualBill>(`/os/manual-bills/${mb_id}?${q}`, patch);
}

export async function deleteManualBill(mb_id: string | number, params: { user_id: string }) {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiDelete(`/os/manual-bills/${mb_id}?${q}`);
}

/* =========================
   Manual Transactions
========================= */

export type ManualTransaction = {
  id: number;
  user_id: string;
  amount: number;
  date: string;
  category?: string | null;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
};

export async function listManualTransactions(params: { user_id: string }): Promise<ManualTransaction[]> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiGet<ManualTransaction[]>(`/manual-transactions?${q}`);
}

export async function createManualTransaction(
  payload: Omit<ManualTransaction, "id" | "created_at" | "updated_at">,
  params: { user_id: string }
): Promise<ManualTransaction> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPost<ManualTransaction>(`/manual-transactions?${q}`, payload);
}

export async function updateManualTransaction(
  transaction_id: string | number,
  patch: Partial<Omit<ManualTransaction, "id" | "user_id" | "created_at" | "updated_at">>,
  params: { user_id: string }
): Promise<ManualTransaction> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPatch<ManualTransaction>(`/manual-transactions/${transaction_id}?${q}`, patch);
}

export async function deleteManualTransaction(
  transaction_id: string | number,
  params: { user_id: string }
): Promise<any> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiDelete(`/manual-transactions/${transaction_id}?${q}`);
}

/* =========================
           Debts
========================= */

export type Debt = {
  id: number;
  user_id: string;
  kind?: string | null;
  lender?: string | null;
  name: string;
  last4?: string | null;
  apr?: number | null;
  balance: number;
  credit_limit?: number | null;
  minimum_due?: number | null;
  due_day?: number | null;
  due_date?: string | null;
  statement_day?: number | null;
  active?: boolean | null;
  created_at?: string;
  updated_at?: string;
};

export async function listDebts(params: { user_id: string }): Promise<Debt[]> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiGet<Debt[]>(`/debts?${q}`);
}

export async function createDebt(
  payload: Omit<Debt, "id" | "created_at" | "updated_at">,
  params: { user_id: string }
): Promise<Debt> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPost<Debt>(`/debts?${q}`, payload);
}

export async function updateDebt(
  debt_id: string | number,
  patch: Partial<Omit<Debt, "id" | "user_id" | "created_at" | "updated_at">>,
  params: { user_id: string }
): Promise<Debt> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiPatch<Debt>(`/debts/${debt_id}?${q}`, patch);
}

export async function deleteDebt(
  debt_id: string | number,
  params: { user_id: string }
): Promise<any> {
  const q = new URLSearchParams({ user_id: params.user_id }).toString();
  return apiDelete(`/debts/${debt_id}?${q}`);
}

/* =========================
           Plaid
========================= */

export type PlaidLinkTokenResponse = {
  link_token: string;
  expiration?: string | null;
  request_id?: string | null;
};

export type PlaidAccountSummary = {
  id?: number;
  account_id: string;
  item_id?: string | null;
  institution_name?: string | null;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  current_balance?: number | null;
  available_balance?: number | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  is_cash_like?: boolean;
  is_liability?: boolean;
  sync_status?: string | null;
  last_synced_at?: string | null;
  last_balance_sync_at?: string | null;
};

export type PlaidExchangeResponse = {
  ok: boolean;
  item_id: string;
  request_id?: string | null;
  institution_name?: string | null;
  accounts: PlaidAccountSummary[];
  recent_transactions?: PlaidTransactionSummary[];
  persisted: boolean;
  synced_transactions?: number;
  sync_status?: string | null;
  sync_warning?: string | null;
  last_sync_at?: string | null;
  last_accounts_sync_at?: string | null;
  last_balances_sync_at?: string | null;
  last_transactions_sync_at?: string | null;
};

export type PlaidItemSummary = {
  item_id: string;
  institution_name?: string | null;
  status?: string | null;
  last_accounts_sync_at?: string | null;
  last_balances_sync_at?: string | null;
  last_transactions_sync_at?: string | null;
  last_sync_error?: string | null;
};

export type PlaidAccountsResponse = {
  ok: boolean;
  user_id: string;
  accounts: PlaidAccountSummary[];
  items: PlaidItemSummary[];
};

export type PlaidTransactionSummary = {
  id?: number;
  transaction_id: string;
  account_id?: string | null;
  item_id?: string | null;
  account_name?: string | null;
  institution_name?: string | null;
  posted_date?: string | null;
  authorized_date?: string | null;
  name?: string | null;
  merchant_name?: string | null;
  amount?: number | null;
  iso_currency_code?: string | null;
  unofficial_currency_code?: string | null;
  pending?: boolean;
  payment_channel?: string | null;
  category_primary?: string | null;
  category_detailed?: string | null;
};

export type PlaidTransactionsResponse = {
  ok: boolean;
  user_id: string;
  transactions: PlaidTransactionSummary[];
};

export type PlaidSyncItemResult = {
  item_id: string;
  institution_name?: string | null;
  sync_status?: string | null;
  last_sync_at?: string | null;
  last_accounts_sync_at?: string | null;
  last_balances_sync_at?: string | null;
  last_transactions_sync_at?: string | null;
  last_sync_error?: string | null;
  accounts_synced?: number;
  transactions_synced?: number;
  accounts?: PlaidAccountSummary[];
  recent_transactions?: PlaidTransactionSummary[];
  warnings?: string[];
};

export type PlaidSyncResponse = {
  ok: boolean;
  user_id: string;
  items_synced: number;
  accounts_synced?: number;
  transactions_synced?: number;
  start_date?: string;
  end_date?: string;
  item_results?: PlaidSyncItemResult[];
  warnings?: string[];
  last_sync_at?: string | null;
};

export async function createPlaidLinkToken(body: { user_id: string }): Promise<PlaidLinkTokenResponse> {
  return apiPost<PlaidLinkTokenResponse>("/plaid/link-token", body);
}

export async function exchangePlaidPublicToken(body: {
  user_id: string;
  public_token: string;
  institution_name?: string | null;
}): Promise<PlaidExchangeResponse> {
  return apiPost<PlaidExchangeResponse>("/plaid/exchange-public-token", body);
}

export async function getPlaidAccounts(user_id: string): Promise<PlaidAccountsResponse> {
  return apiGet<PlaidAccountsResponse>(`/plaid/accounts?user_id=${encodeURIComponent(user_id)}`);
}

export async function getPlaidTransactions(params: {
  user_id: string;
  limit?: number;
  start_date?: string;
  end_date?: string;
}): Promise<PlaidTransactionsResponse> {
  const qs = new URLSearchParams();
  qs.set("user_id", params.user_id);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.start_date) qs.set("start_date", params.start_date);
  if (params.end_date) qs.set("end_date", params.end_date);
  return apiGet<PlaidTransactionsResponse>(`/plaid/transactions?${qs.toString()}`);
}

export async function syncPlaidData(body: {
  user_id: string;
  lookback_days?: number;
  start_date?: string;
  end_date?: string;
}): Promise<PlaidSyncResponse> {
  return apiPost<PlaidSyncResponse>("/plaid/sync", body);
}

export type FinancialOsUpcomingItem = {
  id?: number;
  type?: "bill" | "manual_bill" | "debt_minimum" | string;
  source?: string | null;
  name?: string | null;
  amount?: number | null;
  due_date?: string | null;
  frequency?: string | null;
  category?: string | null;
  autopay?: boolean | null;
  apr?: number | null;
  last4?: string | null;
};

export type FinancialOsBreakdown = {
  total_cash?: number;
  pdf_cash?: number;
  plaid_cash_counted?: number;
  duplicates_skipped?: number;
  duplicates_skipped_balance?: number;
  upcoming_total?: number;
  upcoming_bills_total?: number;
  manual_obligations_total?: number;
  debt_minimums_total?: number;
  buffer?: number;
  final_safe_to_spend?: number;
};

export type OsStateResponse = {
  ok: boolean;
  user_id: string;
  cash_total: number;
  cash_sources?: {
    pdf_cash_total?: number;
    plaid_cash_total?: number;
    plaid_accounts_included?: Array<{
      id?: number;
      account_id: string;
      item_id?: string | null;
      institution_name?: string | null;
      name: string;
      official_name?: string | null;
      mask?: string | null;
      type?: string | null;
      subtype?: string | null;
      current_balance?: number | null;
      available_balance?: number | null;
      counted_balance?: number | null;
      sync_status?: string | null;
      last_balance_sync_at?: string | null;
    }>;
    plaid_duplicate_accounts_skipped?: Array<{
      account_id: string;
      name?: string | null;
      mask?: string | null;
      institution_name?: string | null;
      current_balance?: number | null;
      available_balance?: number | null;
      last_balance_sync_at?: string | null;
    }>;
  };
  upcoming_window_days?: number;
  upcoming_total?: number;
  upcoming_items?: FinancialOsUpcomingItem[];
  upcoming_summary?: {
    bill_total?: number;
    manual_bill_total?: number;
    debt_minimum_total?: number;
    bill_count?: number;
    manual_bill_count?: number;
    debt_minimum_count?: number;
  };
  manual_bills?: any[];
  essentials_cap_monthly?: {
    essentials_bills_total?: number;
    debt_minimums_total?: number;
    essentials_cap_total?: number;
  };
  calculation?: {
    cash_total?: number;
    upcoming_total?: number;
    safe_to_spend_formula?: string;
  };
  debt_utilization?: any;
};

export async function getOsState(params: { user_id: string; window_days?: number }): Promise<OsStateResponse> {
  const qs = new URLSearchParams();
  qs.set("user_id", params.user_id);
  if (params.window_days) qs.set("window_days", String(params.window_days));
  return apiGet<OsStateResponse>(`/os/state?${qs.toString()}`);
}

export type NextBestDollarResponse = {
  ok: boolean;
  user_id: string;
  window_days: number;
  buffer: number;
  cash_total: number;
  upcoming_total: number;
  safe_to_spend_today: number;
  available_sts?: number;
  stage?: string | null;
  upcoming_items?: FinancialOsUpcomingItem[];
  upcoming_summary?: {
    bill_total?: number;
    manual_bill_total?: number;
    debt_minimum_total?: number;
    bill_count?: number;
    manual_bill_count?: number;
    debt_minimum_count?: number;
  };
  cash_sources?: OsStateResponse["cash_sources"];
  calculation?: {
    formula?: string | null;
    cash_total?: number;
    upcoming_total?: number;
    buffer?: number;
    safe_to_spend_today?: number;
    available_sts?: number;
    recommended_extra_payment?: number | null;
  };
  breakdown?: FinancialOsBreakdown;
  recommendation?: {
    debt_id?: number;
    name?: string | null;
    last4?: string | null;
    apr?: number | null;
    available_sts?: number;
    recommended_extra_payment?: number | null;
    why?: string | null;
  } | null;
};

export async function getNextBestDollar(params: {
  user_id: string;
  window_days?: number;
  buffer?: number;
}): Promise<NextBestDollarResponse> {
  const qs = new URLSearchParams();
  qs.set("user_id", params.user_id);
  if (params.window_days != null) qs.set("window_days", String(params.window_days));
  if (params.buffer != null) qs.set("buffer", String(params.buffer));
  return apiGet<NextBestDollarResponse>(`/os/next-best-dollar?${qs.toString()}`);
}

export type FinancialHealthComponent = {
  key: string;
  label: string;
  weight: number;
  points: number;
  included: boolean;
  formula?: string | null;
  explanation?: string | null;
};

export type FinancialOsInsight = {
  key: string;
  title: string;
  severity: "info" | "warning" | "critical" | "success";
  explanation: string;
  suggested_action: string;
  sources?: string[];
  rule?: string | null;
};

export type FinancialOsIntelligenceResponse = {
  ok: boolean;
  user_id: string;
  window_days: number;
  buffer: number;
  context?: {
    cash_total?: number;
    upcoming_total?: number;
    safe_to_spend_today?: number;
    available_sts?: number;
    monthly_essentials_total?: number;
    monthly_essential_bills_total?: number;
    monthly_debt_minimums_total?: number;
    runway_months?: number | null;
    runway_target_months?: number | null;
    emergency_target_amount?: number | null;
    fi_cash_target_amount?: number | null;
    fi_cash_target_label?: string | null;
    debt_total_balance?: number;
    weighted_apr?: number | null;
    high_apr_threshold?: number | null;
    total_utilization_pct?: number | null;
  };
  financial_health?: {
    score?: number;
    formula?: string | null;
    components?: FinancialHealthComponent[];
  };
  stability_meter?: {
    label?: string | null;
    value?: number;
    formula?: string | null;
    explanation?: string | null;
  };
  debt_free_countdown?: {
    estimated_months_remaining?: number | null;
    priority_debt?: {
      id?: number;
      name?: string | null;
      apr?: number | null;
      balance?: number | null;
    } | null;
    modeled_debt_count?: number;
    excluded_debts?: Array<{
      id?: number;
      name?: string | null;
      reason?: string | null;
      balance?: number | null;
    }>;
    is_partial?: boolean;
    formula?: string | null;
    explanation?: string | null;
  };
  fi_progress?: {
    percent?: number;
    formula?: string | null;
    explanation?: string | null;
    components?: Array<{
      label?: string | null;
      weight?: number;
      progress?: number;
      explanation?: string | null;
    }>;
  };
  next_best_dollar_impact?: {
    available_sts?: number;
    recommended_extra_payment?: number;
    target_debt?: {
      id?: number;
      name?: string | null;
      apr?: number | null;
      balance?: number | null;
      minimum_due?: number | null;
    } | null;
    estimated_interest_saved?: number | null;
    estimated_months_faster?: number | null;
    estimated_payoff_months_with_extra?: number | null;
    formula?: string | null;
    assumptions?: string[];
    explanation?: string | null;
  };
  recommendation?: NextBestDollarResponse["recommendation"];
  insights?: {
    what_to_do_next?: FinancialOsInsight | null;
    items?: FinancialOsInsight[];
    source_coverage?: Record<string, {
      transactions?: number;
      latest_date?: string | null;
      source_label?: string | null;
    }>;
  };
};

export async function getFinancialOsIntelligence(params: {
  user_id: string;
  window_days?: number;
  buffer?: number;
}): Promise<FinancialOsIntelligenceResponse> {
  const qs = new URLSearchParams();
  qs.set("user_id", params.user_id);
  if (params.window_days != null) qs.set("window_days", String(params.window_days));
  if (params.buffer != null) qs.set("buffer", String(params.buffer));
  return apiGet<FinancialOsIntelligenceResponse>(`/os/intelligence?${qs.toString()}`);
}
