import { PasswordPolicy } from "@/lib/api";

export const FALLBACK_PASSWORD_POLICY: PasswordPolicy = {
  min_length: 8,
  requires_uppercase: false,
  requires_lowercase: false,
  requires_number: false,
  requires_special: false,
};

export function normalizePasswordPolicy(policy?: PasswordPolicy | null): PasswordPolicy {
  return {
    min_length: Number(policy?.min_length || FALLBACK_PASSWORD_POLICY.min_length),
    requires_uppercase: Boolean(policy?.requires_uppercase),
    requires_lowercase: Boolean(policy?.requires_lowercase),
    requires_number: Boolean(policy?.requires_number),
    requires_special: Boolean(policy?.requires_special),
  };
}

export function validatePasswordAgainstPolicy(password: string, policy?: PasswordPolicy | null): string | null {
  const rules = normalizePasswordPolicy(policy);
  if ((password || "").length < rules.min_length) {
    return `Password must be at least ${rules.min_length} characters.`;
  }
  if (rules.requires_uppercase && !/[A-Z]/.test(password)) {
    return "Password must include at least one uppercase letter.";
  }
  if (rules.requires_lowercase && !/[a-z]/.test(password)) {
    return "Password must include at least one lowercase letter.";
  }
  if (rules.requires_number && !/\d/.test(password)) {
    return "Password must include at least one number.";
  }
  if (rules.requires_special && !/[^A-Za-z0-9]/.test(password)) {
    return "Password must include at least one special character.";
  }
  return null;
}

export function passwordStrength(password: string, policy?: PasswordPolicy | null) {
  const rules = normalizePasswordPolicy(policy);
  const value = password || "";
  const checks = [
    value.length >= rules.min_length,
    /[A-Z]/.test(value),
    /[a-z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
    value.length >= Math.max(rules.min_length + 4, 12),
  ];
  const score = checks.filter(Boolean).length;

  if (!value) {
    return { label: "Weak", tone: "text-zinc-400", bar: "bg-zinc-600/60", width: "0%" };
  }
  if (score <= 2) {
    return { label: "Weak", tone: "text-rose-300", bar: "bg-rose-400", width: "33%" };
  }
  if (score <= 4) {
    return { label: "Good", tone: "text-amber-300", bar: "bg-amber-400", width: "66%" };
  }
  return { label: "Strong", tone: "text-emerald-300", bar: "bg-emerald-400", width: "100%" };
}

export function passwordRuleLabels(policy?: PasswordPolicy | null) {
  const rules = normalizePasswordPolicy(policy);
  const items = [`At least ${rules.min_length} characters`];
  if (rules.requires_uppercase) items.push("At least one uppercase letter");
  if (rules.requires_lowercase) items.push("At least one lowercase letter");
  if (rules.requires_number) items.push("At least one number");
  if (rules.requires_special) items.push("At least one special character");
  return items;
}
