# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

"What can I cook?" is a React + TypeScript SPA with an Express backend. The user manages a pantry of ingredients (as tags with drag-and-drop support) and an "Always have" list, sets filters (max cook time, missing-ingredients tolerance, meal type), then hits "Find recipes." The Express server calls the Anthropic API, which streams back newline-delimited JSON — one recipe object per line. The frontend parses each line into a structured recipe card (meal pill, cook time, ingredient chips with missing-ingredient highlighting, status line, numbered steps) and applies the filters client-side for instant re-filtering without a refetch.

### Key features
- **Ingredient management:** add/remove tags, drag between the main list and an "Always have" drop zone (both persisted in `localStorage`).
- **Filters:** max cook time slider (10–90 min), missing-ingredients-allowed slider (0–5), meal toggle (All / Breakfast / Lunch / Dinner). All applied client-side after fetch.
- **Structured recipe cards:** parsed from JSONL, rendered as bordered cards with pastel accent colors, ingredient chips (orange for missing), and numbered step lists.
- **Streaming:** recipes appear one by one as the model outputs each JSON line.

### Design
Espresso-brown ink (`#3A2012`) on cream (`#FFF9EF`), with candy-pastel accent rotation. Fonts loaded via Google Fonts: **Anton** (logo + headings), **Archivo** (UI labels/buttons), **PT Serif** (recipe steps + helper copy).

## Commands

```bash
# Install dependencies
npm install

# Run both client (port 5173) and server (port 3001) concurrently
npm run dev

# Run only the Express server (watches via nodemon + tsx)
npm run dev:server

# Run only the Vite dev server
npm run dev:client

# Type-check and build for production
npm run build

# Lint
npm run lint
```

## Environment

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` before starting the server. The Anthropic client in `server/index.ts` picks it up via `dotenv/config`.

## Architecture

**Two-process dev setup:**
- `server/index.ts` — Express app on port 3001. Single route: `POST /api/cook`. Accepts `{ ingredients, alwaysHave, maxTime, maxMissing, meal }`, builds a constrained prompt, calls the Anthropic API with streaming + extended thinking (`adaptive`), and pipes SSE chunks (`data: {"text":"..."}`) to the response, terminated by `data: [DONE]`. The system prompt instructs the model to output **newline-delimited JSON** (one `{name, meal, time, ingredients, steps}` object per line, no prose or code fences).
- `src/App.tsx` — Single-component React app. Manages ingredient tags + "always have" list (both in `localStorage`), filter state (time/missing/meal), and a `Recipe[]` array. On fetch, it reads the SSE stream, accumulates text into a JSONL buffer, and parses each complete line into a `Recipe` object rendered as a card. Filters are applied client-side via `useMemo` for instant re-filtering.

**Data contract (`Recipe`):**
```ts
{ name: string; meal: "breakfast"|"lunch"|"dinner"; time: number; ingredients: string[]; steps: string[] }
```

**Ingredient matching:** a tolerant `hasIngredient()` check handles partial matches (e.g. "chicken" matches "chicken breast"). Pantry staples (salt, pepper, oil, butter, water, flour, sugar) are always assumed on hand and excluded from the model's ingredient lists.

**Proxy:** Vite's dev server proxies `/api/*` → `http://localhost:3001`, so the frontend always calls `/api/cook` without hardcoding the backend port.

**Streaming model:** The server uses `client.messages.stream(...)` from `@anthropic-ai/sdk` with `claude-opus-4-8` and `thinking: { type: "adaptive" }`. Only `text_delta` content block deltas are forwarded; thinking blocks are silently dropped. The frontend aborts mid-stream via `AbortController` (the Stop button).
