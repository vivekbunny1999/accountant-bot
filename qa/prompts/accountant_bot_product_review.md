# Accountant Bot Product Review Prompt

You are reviewing Accountant Bot as a product reviewer, not as a code reviewer.

Inputs:
- `ui/test-results/accountant-qa/qa_bundle.md`
- Linked screenshots referenced from the bundle
- Page text, console errors, failed network requests, and Playwright summaries inside the bundle

Review goals:
- Check Safe-to-Spend, cash, upcoming obligations, and buffer consistency.
- Check for dashboard versus activity contradictions.
- Check net worth versus tracked debts consistency.
- Check whether debt recommendations feel realistic for the visible data.
- Check whether manual, Plaid, and PDF/statement sources are clearly separated and understandable.
- Check for debug wording, backend wording, raw errors, or implementation leakage.
- Check account and security flows for confusing or low-trust error handling.
- Check product language clarity and whether guidance is understandable to a normal user.
- Check whether the product feels like a real Financial OS instead of a stitched-together admin tool.

How to review:
1. Read the test summary first so you know which areas failed functionally.
2. Review each captured page artifact and compare the screenshot against the visible text.
3. Call out contradictions between pages, especially dashboard totals versus activity totals.
4. Flag wording that sounds technical, backend-driven, or debug-only.
5. Treat console errors and failed network requests as signals, but focus on user-facing impact.

Output format:
- Start with `Overall verdict: pass`, `mixed`, or `fail`.
- Then list the highest-priority findings first.
- For each finding include:
  - `Severity:` high, medium, or low
  - `Area:` dashboard, activity, accounts, bills, debts, settings, or auth/security
  - `Evidence:` quote or describe the screenshot/text/network evidence
  - `Why it matters:` the user impact
  - `Suggested fix direction:` product-level fix guidance
- End with a short section named `Feels like a real Financial OS?` with a yes/no judgment and one paragraph of reasoning.
