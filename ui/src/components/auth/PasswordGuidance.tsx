"use client";

import { PasswordPolicy } from "@/lib/api";
import { passwordRuleLabels, passwordStrength } from "@/lib/password-policy";

export function PasswordGuidance({
  password,
  policy,
  className = "",
}: {
  password: string;
  policy?: PasswordPolicy | null;
  className?: string;
}) {
  const strength = passwordStrength(password, policy);
  const rules = passwordRuleLabels(policy);

  return (
    <div className={`rounded-2xl border border-white/10 bg-black/15 p-4 ${className}`.trim()}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="uppercase tracking-[0.18em] text-zinc-500">Password strength</span>
        <span className={`font-medium ${strength.tone}`}>{strength.label}</span>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full transition-all ${strength.bar}`} style={{ width: strength.width }} />
      </div>

      <div className="mt-3 space-y-2 text-xs text-zinc-300">
        {rules.map((rule) => (
          <div key={rule}>{rule}</div>
        ))}
        <div className="text-zinc-500">For a stronger password, mix uppercase, lowercase, numbers, and symbols.</div>
      </div>
    </div>
  );
}
