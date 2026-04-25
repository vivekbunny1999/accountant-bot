# Accountant Bot UI

## Local development

```bash
npm install
npm run dev
```

App URL: `http://127.0.0.1:3000`

If the backend is local, set `NEXT_PUBLIC_API_BASE_URL` in `ui/.env.local` to `http://127.0.0.1:8000`.

## Playwright E2E QA

Install Playwright browsers once after `npm install`:

```bash
npm run test:e2e:install
```

Required env vars:

- `E2E_BASE_URL`
- `E2E_TEST_EMAIL`
- `E2E_TEST_PASSWORD`

Optional env var:

- `E2E_API_BASE_URL`
  Recommended: `https://accountant-bot-tjj6.onrender.com`
  Used for backend API login during Playwright auth setup. If omitted, the tests fall back to `NEXT_PUBLIC_API_BASE_URL`, then to `https://accountant-bot-tjj6.onrender.com`.

Run the preview or local smoke suite:

```bash
npm run test:e2e
```

Build the markdown QA bundle after the test run:

```bash
npm run qa:bundle
```

Artifacts are written to:

- `ui/test-results/accountant-qa/pages/`
- `ui/test-results/accountant-qa/qa_bundle.md`

Playwright traces and failure screenshots are written under `ui/test-results/` and `ui/playwright-report/`.

## Vercel preview usage

Point `E2E_BASE_URL` at the deployed preview URL, then run:

```powershell
$env:E2E_BASE_URL="https://your-preview.vercel.app"
$env:E2E_API_BASE_URL="https://accountant-bot-tjj6.onrender.com"
npm run test:e2e
npm run qa:bundle
```

The suite is intentionally read-only for product behavior. It signs in with an existing test account and does not require creating new Plaid links.
