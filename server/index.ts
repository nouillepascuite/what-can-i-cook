import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, "..", "dist");

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic();

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

app.post("/api/cook", async (req, res) => {
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

app.use(express.static(distPath));
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = parseInt(process.env.PORT || "3001", 10);
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
