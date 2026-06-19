import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import * as cookie from "cookie";
import { OAuth2Client } from "google-auth-library";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "..", "dist");

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic();

/* ---------- Auth infrastructure ---------- */

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/auth/google/callback`
);

interface Session {
  email: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === "production";

function signSession(id: string): string {
  const sig = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(id)
    .digest("hex");
  return `${id}.${sig}`;
}

function verifySession(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(id)
    .digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return null;
  return id;
}

function setSessionCookie(res: Response, token: string) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize("session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: THIRTY_DAYS / 1000,
    })
  );
}

function clearSessionCookie(res: Response) {
  res.setHeader(
    "Set-Cookie",
    cookie.serialize("session", "", {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      path: "/",
      maxAge: 0,
    })
  );
}

function getSessionEmail(req: Request): string | null {
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.session;
  if (!token) return null;
  const id = verifySession(token);
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || Date.now() > session.expiresAt) {
    if (session) sessions.delete(id);
    return null;
  }
  return session.email;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const email = getSessionEmail(req);
  if (!email) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/* ---------- Auth routes ---------- */

app.get("/auth/google", (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase();

    if (!email || !ALLOWED_EMAILS.has(email)) {
      res.status(403).send(`
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&family=PT+Serif:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet" />
          <title>Access Denied</title>
          <style>
            body { background: #FFF9EF; color: #3A2012; font-family: 'Archivo', sans-serif; display: flex; align-items: center; justify-content: center; height: 100dvh; margin: 0; }
            .box { text-align: center; max-width: 400px; padding: 40px; }
            h1 { font-family: 'Anton', sans-serif; font-size: 28px; text-transform: uppercase; margin-bottom: 16px; }
            p { font-family: 'PT Serif', serif; font-size: 15px; line-height: 1.55; color: rgba(58,32,18,0.65); margin-bottom: 24px; }
            a { display: inline-block; padding: 10px 24px; background: #FFF964; border: 2px solid #3A2012; border-radius: 12px; font-family: 'Anton', sans-serif; font-size: 14px; text-transform: uppercase; text-decoration: none; color: #3A2012; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>Not on the list</h1>
            <p>Sorry, <strong>${email || "your account"}</strong> is not on the invite list. Ask the app owner for access.</p>
            <a href="/">Back</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, { email, expiresAt: Date.now() + THIRTY_DAYS });
    setSessionCookie(res, signSession(sessionId));
    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("Authentication failed. Please try again.");
  }
});

app.get("/auth/me", (req, res) => {
  const email = getSessionEmail(req);
  if (!email) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json({ email });
});

app.post("/auth/logout", (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.session;
  if (token) {
    const id = verifySession(token);
    if (id) sessions.delete(id);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ---------- API ---------- */

const SYSTEM_PROMPT = `You are a practical culinary assistant. Given the ingredients a user has on hand, suggest 6 simple recipes.

Output ONLY newline-delimited JSON: one compact JSON object per line, and nothing else — no prose, no markdown, no code fences. Each line must be a complete, valid JSON object of the form:
{"name":"Recipe Name","meal":"breakfast"|"lunch"|"dinner","time":20,"ingredients":["pasta","garlic","tomato"],"steps":["First step.","Second step."]}

Rules:
- "ingredients": the key ingredients the recipe needs, lowercase, using the user's wording where it matches. Do NOT list common pantry staples (salt, pepper, oil, butter, water, flour, sugar) — assume those are on hand.
- "time" is the total time in whole minutes.
- "meal" is one of breakfast, lunch, or dinner.
- "steps": 3 to 6 short, clear, numbered-in-order instructions (do not include the number inside the string).
- Favour recipes that mostly use what the user already has. You may include recipes that need a few ingredients they are missing, but keep missing ingredients to a minimum.
- Output one recipe per line. Do not wrap the output in an array.`;

interface CookRequest {
  ingredients?: string[];
  alwaysHave?: string[];
  maxTime?: number;
  maxMissing?: number;
  meal?: "all" | "breakfast" | "lunch" | "dinner";
}

app.post("/api/cook", requireAuth, async (req, res) => {
  const {
    ingredients = [],
    alwaysHave = [],
    maxTime = 45,
    maxMissing = 1,
    meal = "all",
  }: CookRequest = req.body;

  const have = [...ingredients, ...alwaysHave];

  if (have.length === 0) {
    res.status(400).json({ error: "No ingredients provided" });
    return;
  }

  const constraints: string[] = [
    `The user has these ingredients: ${have.join(", ")}.`,
    `Prefer recipes that take ${maxTime} minutes or less.`,
    maxMissing === 0
      ? `Only suggest recipes the user can make with what they have (no missing ingredients).`
      : `It is fine if a recipe needs up to ${maxMissing} ingredient(s) the user does not have.`,
  ];
  if (meal !== "all") {
    constraints.push(`Focus on ${meal} recipes.`);
  }

  const userMessage = `${constraints.join(" ")} What can I cook? Remember: respond ONLY with one JSON object per line.`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await client.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    for await (const chunk of stream) {
      if (
        chunk.type === "content_block_delta" &&
        chunk.delta.type === "text_delta"
      ) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Anthropic API error:", err);
    res.write(`data: ${JSON.stringify({ error: "Failed to get recipes" })}\n\n`);
    res.end();
  }
});

/* ---------- Static files + SPA fallback ---------- */

app.use(express.static(distPath));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
