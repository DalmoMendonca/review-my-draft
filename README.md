# Review My Draft

A minimalist writing review app (React + Netlify Functions + OpenAI).

## What it does

- Lets a user type or paste a draft up to `20,000` characters.
- Reviews the draft from a selected persona perspective.
- Shows inline highlighted spans + margin comments.
- Lets the user accept/decline each suggestion.
- Lets the user workshop each suggestion in a short AI back-and-forth thread.

## Project map (beginner-friendly)

- `src/main.jsx`: app bootstrap (mounts React to `#root`).
- `src/App.jsx`: main UI and interaction flow.
- `src/styles.css`: layout and visual styling.
- `src/personas.js`: persona metadata used by the UI menu.
- `netlify/functions/review.js`: main review pipeline (multi-pass OpenAI review + safety normalization).
- `netlify/functions/workshop.js`: follow-up chat for one suggestion.
- `tests/review.test.mjs`: reliability tests for review + workshop functions.

## Run locally

1. Install deps:
```bash
npm install
```

2. Create local env file:
```bash
cp .env.example .env
```

3. Start local app + Netlify functions:
```bash
npm i -g netlify-cli
netlify dev
```

4. Run checks:
```bash
npm run lint
npm test
npm run build
```

Use the URL shown by Netlify (usually `http://localhost:8888`).

## Environment variables

- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (optional, default: `gpt-4o-mini`)
- `OPENAI_WORKSHOP_MODEL` (optional, default: `OPENAI_MODEL`)
- `OPENAI_MODEL_FALLBACKS` (optional, comma-separated models)
- `OPENAI_TIMEOUT_MS` (optional, default: `22000`)
- `WORKSHOP_TIMEOUT_MS` (optional, default: `26000`)
- `FUNCTION_EXECUTION_BUDGET_MS` (optional, default: `28000`)
- `REVIEW_CHUNK_TRIGGER_CHARS` (optional, default: `8000`)
- `REVIEW_CHUNK_TARGET_CHARS` (optional, default: `4200`)
- `REVIEW_CHUNK_OVERLAP_CHARS` (optional, default: `280`)
- `REVIEW_MAX_CHUNKS` (optional, default: `6`)

## Deploy (Netlify)

1. Push code to GitHub.
2. In Netlify, import the GitHub repo.
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add the environment variables above in Netlify Site Settings.

Netlify auto-detects `netlify/functions`.
