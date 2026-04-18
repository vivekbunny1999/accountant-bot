// src/lib/api.tsx

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000";

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
  const res = await fetch(`${BASE}/statements`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

export async function deleteStatementByCode(statement_code: string): Promise<void> {
  const res = await fetch(`${BASE}/statements/by-code/${encodeURIComponent(statement_code)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
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
  const url = `${BASE}/upload/capitalone-pdf?replace=${replace}`;

  const res = await fetch(url, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Upload failed: ${res.status} ${txt}`);
  }

  return res.json();
}

export async function getStatementByCode(statement_code: string): Promise<Statement> {
  const res = await fetch(`${BASE}/statements/by-code/${encodeURIComponent(statement_code)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
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
  const res = await fetch(`${BASE}/statements/${statement_id}/transactions`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  return res.json();
}

/* =========================
        Cash Accounts
========================= */

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(await res.text().catch(() => `Failed: ${res.status}`));
  return (await res.json()) as T;
}

async function apiDelete<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text().catch(() => `Delete failed: ${res.status}`));

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

async function apiPatch<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(await res.text().catch(() => `Patch failed: ${res.status}`));

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

async function apiPost<T>(path: string, body: any): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text().catch(() => `Post failed: ${res.status}`));

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
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
  const res = await fetch(`${BASE}/upload/capitalone-bank-pdf?${q}`, {
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
  is_active?: boolean;       // default true
  autopay?: boolean;         // optional
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

export async function getOsState(params: { user_id: string; window_days?: number } = { user_id: "demo" }) {
  const qs = new URLSearchParams();
  qs.set("user_id", params.user_id);
  if (params.window_days) qs.set("window_days", String(params.window_days));
  return apiGet<any>(`/os/state?${qs.toString()}`);
}