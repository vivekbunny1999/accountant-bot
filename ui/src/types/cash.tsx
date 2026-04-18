// src/types/cash.ts
export type CashAccount = {
  id: number;
  user_id: string;
  institution: string | null;
  account_label: string | null;
  account_name: string | null;
  account_last4: string | null;
  statement_period: string | null;
  statement_end_date: string | null;
  checking_begin_balance: number | null;
  checking_end_balance: number | null;
  savings_begin_balance: number | null;
  savings_end_balance: number | null;
  filename: string | null;
  created_at: string | null;
};

export type CashTxn = {
  id: number;
  posted_date: string | null;
  description: string | null;
  amount: number | null;
  txn_type: string | null;
  category: string | null;
};

export type UploadBankResponse = {
  ok: boolean;
  already_exists: boolean;
  cash_account_id: number;
  imported_txns: number;
  meta: {
    filename: string;
    institution: string | null;
    account_label: string | null;
    account_name: string | null;
    account_last4: string | null;
    statement_period: string | null;
    checking_begin_balance: number | null;
    checking_end_balance: number | null;
    savings_begin_balance: number | null;
    savings_end_balance: number | null;
    fingerprint: string | null;
  };
};