# Accountant Bot

Accountant Bot is a FastAPI + Next.js Financial OS project with a local-first SQLite workflow and a simple path to cloud staging.

## Local Run

### Backend

1. Create a virtual environment and install dependencies:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

2. Copy the backend env file and keep the default local SQLite URL:

```bash
copy .env.example .env
```

3. Run the API:

```bash
uvicorn api:app --reload --host 127.0.0.1 --port 8000
```

### Frontend

1. Install dependencies:

```bash
cd ui
npm install
```

2. Copy the frontend env file:

```bash
copy .env.example .env.local
```

3. Run the app:

```bash
npm run dev
```

Frontend local URL: `http://127.0.0.1:3000`  
Backend local URL: `http://127.0.0.1:8000`

## Automated Preview QA

The repo includes a Playwright-based QA loop for the deployed UI in `ui/`.

### GitHub secrets required

- `E2E_BASE_URL`
- `E2E_TEST_EMAIL`
- `E2E_TEST_PASSWORD`

### Local commands

Install UI dependencies and Playwright once:

```bash
cd ui
npm install
npm run test:e2e:install
```

Run the E2E suite against local UI or any deployed preview:

```bash
set E2E_BASE_URL=http://127.0.0.1:3000
set E2E_TEST_EMAIL=your-test-user@example.com
set E2E_TEST_PASSWORD=your-test-password
npm run test:e2e
npm run qa:bundle
```

Artifacts are generated in `ui/test-results/accountant-qa/`:

- per-page screenshots
- per-page visible text files
- per-page console error and failed-request metadata
- Playwright JSON summary
- `qa_bundle.md`

### Run against Vercel preview

Set `E2E_BASE_URL` to the Vercel preview URL for the UI deployment and run the same commands above. The workflow in `.github/workflows/e2e-preview.yml` does this automatically on `pull_request` when the secrets are available.

### How Codex should use failing artifacts

1. Open `ui/test-results/accountant-qa/qa_bundle.md` first.
2. Compare the failing test summary with the page screenshots and visible text.
3. Use console errors and failed network requests to separate data/load problems from presentation problems.
4. Fix the smallest safe issue first, rerun `npm run test:e2e`, then rebuild `npm run qa:bundle`.

### Why this creates a Codex -> Vercel -> QA -> fix loop

1. Codex changes the UI without changing business logic.
2. Vercel builds a preview URL.
3. Playwright hits that deployed URL with a stable test account.
4. The run produces screenshots, page text, traces, and a markdown QA bundle.
5. Codex can review those artifacts, fix regressions, and repeat the loop quickly.

## Environment Variables

### Backend

- `DATABASE_URL`
  Local default: `sqlite:///./accountant_bot.db`
  Staging example: `postgresql+psycopg2://USER:PASSWORD@HOST:5432/DBNAME`

- `CORS_ORIGINS`
  Comma-separated allowed frontend origins.
  Local example: `http://127.0.0.1:3000,http://localhost:3000`
  Staging example: `https://accountant-bot-staging.vercel.app`

- `FRONTEND_URL`
  Optional single frontend origin to append to the CORS allowlist.
  Example: `https://accountant-bot.vercel.app`

- `CORS_ORIGIN_REGEX`
  Optional regex for preview deployments when Vercel URLs change per branch.
  Example: `https://accountant-bot-.*\.vercel\.app`

### Frontend

- `NEXT_PUBLIC_API_BASE_URL`
  Base URL for the FastAPI backend.
  Local example: `http://127.0.0.1:8000`
  Staging example: `https://accountant-bot-api-staging.onrender.com`

## Staging Deploy Notes

Recommended simple staging split:

- Frontend: Vercel
- Backend: Render, Railway, or Fly.io
- Database: managed Postgres in staging

### Backend staging checklist

1. Create a cloud service that runs:

```bash
uvicorn api:app --host 0.0.0.0 --port $PORT
```

2. Set backend env vars:

- `DATABASE_URL=<managed Postgres URL>`
- `CORS_ORIGINS=<your staging frontend URL>`
- `FRONTEND_URL=<your main Vercel frontend URL>`
- `CORS_ORIGIN_REGEX=<optional Vercel preview regex>`

3. Install dependencies from `requirements.txt`.

4. Keep local SQLite for development; staging should use Postgres by setting `DATABASE_URL`.

### Frontend staging checklist

1. Import the `ui/` app into Vercel.
2. Set:

- `NEXT_PUBLIC_API_BASE_URL=<your staging backend URL>`

3. Deploy the `ui` project root.

## GitHub Workflow Setup

Before pushing to GitHub:

1. Keep real `.env` and `.env.local` files uncommitted.
2. Commit:

- source files
- `.env.example`
- `ui/.env.example`
- `requirements.txt`
- `README.md`

3. Push the repo to GitHub.
4. Connect staging services to the GitHub repo so new pushes can be reviewed in staging.

## Notes

- SQLite remains the default for local development.
- Postgres is enabled by environment variable only, so local behavior stays the same.
- SQLite-only startup schema helpers are skipped automatically in non-SQLite environments to avoid breaking staging.
- The preview QA suite does not create Plaid links and expects an existing seeded test account.
