export type SpendingCategory =
  | "Uncategorized"
  | "Housing"
  | "Utilities"
  | "Groceries"
  | "Dining"
  | "Fuel"
  | "Transport"
  | "Insurance"
  | "Medical"
  | "Personal Care"
  | "Subscriptions"
  | "Shopping"
  | "Debt Payment"
  | "Fees & Interest"
  | "Income"
  | "Loan"
  | "Entertainment"
  | "Travel"
  | "Education"
  | "Gifts/Donations"
  | "Kids/Family"
  | "Business"
  | "Taxes"
  | "Other";

export const CATEGORY_OPTIONS: SpendingCategory[] = [
  "Uncategorized",
  "Housing",
  "Utilities",
  "Groceries",
  "Dining",
  "Fuel",
  "Transport",
  "Insurance",
  "Medical",
  "Personal Care",
  "Subscriptions",
  "Shopping",
  "Debt Payment",
  "Fees & Interest",
  "Income",
  "Loan",
  "Entertainment",
  "Travel",
  "Education",
  "Gifts/Donations",
  "Kids/Family",
  "Business",
  "Taxes",
  "Other",
];

type CategoryRuleLookup = Record<string, SpendingCategory>;

type StatementLike = {
  amount?: number | null;
  description?: string | null;
  merchant?: string | null;
  category?: string | null;
};

type CashLike = {
  amount?: number | null;
  description?: string | null;
  merchant?: string | null;
  name?: string | null;
  category?: string | null;
  txn_type?: string | null;
};

type ManualLike = {
  amount?: number | null;
  description?: string | null;
  category?: string | null;
};

type PlaidLike = {
  amount?: number | null;
  pending?: boolean | null;
  merchant_name?: string | null;
  name?: string | null;
  category_primary?: string | null;
  category_detailed?: string | null;
};

const keywordCategoryMatchers: Array<{
  category: SpendingCategory;
  patterns: string[];
}> = [
  { category: "Debt Payment", patterns: ["payment", "pymt", "autopay", "credit card payment"] },
  { category: "Fees & Interest", patterns: ["interest", "late fee", "annual fee", "overdraft", "service fee", "fee"] },
  { category: "Income", patterns: ["payroll", "salary", "paycheck", "direct dep", "direct deposit", "deposit", "bonus", "reimbursement"] },
  { category: "Housing", patterns: ["rent", "mortgage", "lease", "hoa", "landlord"] },
  { category: "Utilities", patterns: ["utility", "electric", "water", "internet", "wifi", "phone bill", "mobile", "verizon", "comcast"] },
  { category: "Groceries", patterns: ["grocery", "supermarket", "whole foods", "trader joe", "aldi", "kroger", "publix", "costco"] },
  { category: "Dining", patterns: ["restaurant", "coffee", "cafe", "doordash", "uber eats", "grubhub", "chipotle", "starbucks"] },
  { category: "Fuel", patterns: ["fuel", "gas station", "shell", "exxon", "chevron", "bp "] },
  { category: "Transport", patterns: ["uber", "lyft", "parking", "toll", "transit", "train", "bus"] },
  { category: "Insurance", patterns: ["insurance", "geico", "state farm", "progressive"] },
  { category: "Medical", patterns: ["medical", "pharmacy", "hospital", "doctor", "dentist", "clinic"] },
  { category: "Personal Care", patterns: ["salon", "barber", "spa", "beauty"] },
  { category: "Subscriptions", patterns: ["subscription", "netflix", "spotify", "hulu", "prime", "icloud"] },
  { category: "Shopping", patterns: ["amazon", "target", "walmart", "retail", "store", "shopping"] },
  { category: "Entertainment", patterns: ["movie", "theater", "concert", "gaming", "game"] },
  { category: "Travel", patterns: ["airbnb", "hotel", "flight", "airline", "travel"] },
  { category: "Education", patterns: ["tuition", "course", "school", "udemy", "coursera"] },
  { category: "Gifts/Donations", patterns: ["donation", "charity", "gift", "church"] },
  { category: "Kids/Family", patterns: ["daycare", "childcare", "school lunch"] },
  { category: "Business", patterns: ["office depot", "business", "workspace", "ad spend"] },
  { category: "Taxes", patterns: ["tax", "irs", "franchise tax"] },
  { category: "Loan", patterns: ["loan", "student loan", "auto loan"] },
];

export function parseDateLoose(value?: string | null): Date | null {
  if (!value) return null;

  let match = /^(\d{4})[-/](\d{2})[-/](\d{2})/.exec(value);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value);
  if (match) return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]));

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  return null;
}

export function amountAbs(value: { amount?: number | null } | number | null | undefined): number {
  if (typeof value === "number") return Math.abs(Number(value) || 0);
  return Math.abs(Number(value?.amount) || 0);
}

function normalizeCategoryLabel(value?: string | null): SpendingCategory | null {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;

  const directMap: Record<string, SpendingCategory> = {
    uncategorized: "Uncategorized",
    housing: "Housing",
    utilities: "Utilities",
    groceries: "Groceries",
    dining: "Dining",
    fuel: "Fuel",
    transport: "Transport",
    transportation: "Transport",
    insurance: "Insurance",
    medical: "Medical",
    healthcare: "Medical",
    "personal care": "Personal Care",
    subscriptions: "Subscriptions",
    shopping: "Shopping",
    "debt payment": "Debt Payment",
    "fees & interest": "Fees & Interest",
    fees: "Fees & Interest",
    interest: "Fees & Interest",
    income: "Income",
    loan: "Loan",
    entertainment: "Entertainment",
    travel: "Travel",
    education: "Education",
    "gifts/donations": "Gifts/Donations",
    gifts: "Gifts/Donations",
    donations: "Gifts/Donations",
    "kids/family": "Kids/Family",
    business: "Business",
    taxes: "Taxes",
    other: "Other",
  };

  if (directMap[raw]) return directMap[raw];
  return keywordCategoryFromText(raw);
}

export function signatureForParts(...parts: Array<string | null | undefined>): string {
  const raw = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return raw.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() || "unknown";
}

function keywordCategoryFromText(value?: string | null): SpendingCategory | null {
  const text = String(value || "").toLowerCase();
  if (!text) return null;

  for (const matcher of keywordCategoryMatchers) {
    if (matcher.patterns.some((pattern) => text.includes(pattern))) {
      return matcher.category;
    }
  }

  return null;
}

function defaultCategoryFromText(text: string): SpendingCategory {
  return keywordCategoryFromText(text) || "Uncategorized";
}

export function isStatementCreditLike(txn: StatementLike) {
  const amount = Number(txn.amount || 0);
  const text = `${txn.description ?? ""} ${txn.merchant ?? ""}`.toLowerCase();
  return (
    amount < 0 ||
    text.includes("pymt") ||
    text.includes("payment") ||
    text.includes("refund") ||
    text.includes("reversal") ||
    text.includes("credit")
  );
}

export function categoryForStatement(txn: StatementLike, rules?: CategoryRuleLookup): SpendingCategory {
  const explicit = normalizeCategoryLabel(txn.category);
  if (explicit) return explicit;

  const ruleKey = signatureForParts(txn.merchant, txn.description);
  if (rules?.[ruleKey]) return rules[ruleKey];

  return defaultCategoryFromText(`${txn.description ?? ""} ${txn.merchant ?? ""}`);
}

export function isCashSpend(txn: CashLike) {
  return Number(txn.amount || 0) < 0;
}

export function categoryForCash(txn: CashLike, rules?: CategoryRuleLookup): SpendingCategory {
  const explicit = normalizeCategoryLabel(txn.category);
  if (explicit) return explicit;

  const ruleKey = signatureForParts(txn.merchant, txn.description, txn.name);
  if (rules?.[ruleKey]) return rules[ruleKey];

  return defaultCategoryFromText(`${txn.description ?? ""} ${txn.merchant ?? ""} ${txn.name ?? ""}`);
}

function manualLooksLikeMoneyIn(txn: ManualLike) {
  const category = normalizeCategoryLabel(txn.category);
  if (category === "Income") return true;

  const text = `${txn.description ?? ""} ${txn.category ?? ""}`.toLowerCase();
  return (
    text.includes("income") ||
    text.includes("refund") ||
    text.includes("reimburse") ||
    text.includes("deposit") ||
    text.includes("paycheck") ||
    text.includes("salary")
  );
}

export function isManualSpend(txn: ManualLike) {
  const amount = Number(txn.amount || 0);
  if (amount === 0) return false;
  if (amount > 0) return true;
  return !manualLooksLikeMoneyIn(txn);
}

export function categoryForManual(txn: ManualLike, rules?: CategoryRuleLookup): SpendingCategory {
  const explicit = normalizeCategoryLabel(txn.category);
  if (explicit) return explicit;

  const ruleKey = signatureForParts(txn.description, txn.category);
  if (rules?.[ruleKey]) return rules[ruleKey];

  return defaultCategoryFromText(`${txn.description ?? ""} ${txn.category ?? ""}`);
}

export function manualDisplayDirection(txn: ManualLike) {
  return isManualSpend(txn) ? "spend" : "money_in";
}

export function plaidLooksLikeNonSpend(txn: PlaidLike) {
  const text = `${txn.merchant_name ?? ""} ${txn.name ?? ""} ${txn.category_primary ?? ""} ${txn.category_detailed ?? ""}`.toLowerCase();
  return (
    text.includes("payment") ||
    text.includes("refund") ||
    text.includes("reversal") ||
    text.includes("credit") ||
    text.includes("deposit") ||
    text.includes("transfer") ||
    text.includes("payroll")
  );
}

export function isPlaidSpend(txn: PlaidLike) {
  return Number(txn.amount || 0) > 0 && !txn.pending && !plaidLooksLikeNonSpend(txn);
}

export function categoryForPlaid(txn: PlaidLike, rules?: CategoryRuleLookup): SpendingCategory {
  const ruleKey = signatureForParts(txn.merchant_name, txn.name);
  if (rules?.[ruleKey]) return rules[ruleKey];

  const direct = normalizeCategoryLabel(txn.category_primary) || normalizeCategoryLabel(txn.category_detailed);
  if (direct) return direct;

  return defaultCategoryFromText(
    `${txn.merchant_name ?? ""} ${txn.name ?? ""} ${txn.category_primary ?? ""} ${txn.category_detailed ?? ""}`
  );
}

function normalizeDebtToken(value?: string | null) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function statementsTrackedByDebt(
  statements: Array<{ card_last4?: string | null; card_name?: string | null; account_label?: string | null; new_balance?: number | null }>,
  debts: Array<{ last4?: string | null; name?: string | null; lender?: string | null; balance?: number | null }>
) {
  return statements.reduce(
    (summary, statement) => {
      const statementLast4 = normalizeDebtToken(statement.card_last4);
      const statementName = normalizeDebtToken(statement.card_name || statement.account_label);

      const tracked = debts.some((debt) => {
        const debtLast4 = normalizeDebtToken(debt.last4);
        if (statementLast4 && debtLast4 && statementLast4 === debtLast4) return true;

        const debtName = normalizeDebtToken(debt.name || debt.lender);
        return Boolean(statementName && debtName && statementName === debtName);
      });

      const balance = Number(statement.new_balance || 0);
      if (tracked) {
        summary.tracked += balance;
      } else {
        summary.untracked += balance;
      }
      return summary;
    },
    { tracked: 0, untracked: 0 }
  );
}
