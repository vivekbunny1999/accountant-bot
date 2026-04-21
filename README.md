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

## Environment Variables

### Backend

- `DATABASE_URL`
  Local default: `sqlite:///./accountant_bot.db`
  Staging example: `postgresql+psycopg2://USER:PASSWORD@HOST:5432/DBNAME`

- `CORS_ORIGINS`
  Comma-separated allowed frontend origins.
  Local example: `http://127.0.0.1:3000,http://localhost:3000`
  Staging example: `https://accountant-bot-staging.vercel.app`

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
