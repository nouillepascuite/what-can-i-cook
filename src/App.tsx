import {
  useState,
  useEffect,
  useRef,
  useMemo,
  type KeyboardEvent,
  type CSSProperties,
} from "react";

const STAPLES = [
  "salt",
  "pepper",
  "oil",
  "olive oil",
  "butter",
  "water",
  "flour",
  "sugar",
];

const ACCENTS = ["#F4C4DE", "#A9DCF0", "#C9E96E", "#E3A4F2", "#F2A55E", "#F28C8C"];

type Meal = "all" | "breakfast" | "lunch" | "dinner";

interface Recipe {
  name: string;
  meal: "breakfast" | "lunch" | "dinner";
  time: number;
  ingredients: string[];
  steps: string[];
}

const MEAL_LABELS: Record<Recipe["meal"], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

function loadList(key: string, fallback: string[]): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function hasIngredient(have: Set<string>, ingredient: string): boolean {
  const i = ingredient.toLowerCase().trim();
  if (have.has(i)) return true;
  for (const h of have) {
    if (h.length > 2 && (i.includes(h) || h.includes(i))) return true;
  }
  return false;
}

export default function App() {
  const [input, setInput] = useState("");
  const [tags, setTags] = useState<string[]>(() =>
    loadList("ingredients", [])
  );
  const [alwaysHave, setAlwaysHave] = useState<string[]>(() =>
    loadList("alwaysHave", [])
  );
  const [alwaysOpen, setAlwaysOpen] = useState(true);

  const [maxTime, setMaxTime] = useState(45);
  const [maxMissing, setMaxMissing] = useState(1);
  const [meal, setMeal] = useState<Meal>("all");

  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const draggedRef = useRef<{ name: string; from: "tags" | "always" } | null>(
    null
  );

  useEffect(() => {
    localStorage.setItem("ingredients", JSON.stringify(tags));
  }, [tags]);
  useEffect(() => {
    localStorage.setItem("alwaysHave", JSON.stringify(alwaysHave));
  }, [alwaysHave]);

  /* ---------- ingredient tags ---------- */
  function addTag() {
    const trimmed = input.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
    }
    setInput("");
  }
  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag();
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1));
    }
  }

  /* ---------- always have + drag/drop ---------- */
  function removeAlways(tag: string) {
    setAlwaysHave((prev) => prev.filter((t) => t !== tag));
  }
  function onDragStart(name: string, from: "tags" | "always") {
    return () => {
      draggedRef.current = { name, from };
    };
  }
  function allowDrop(e: React.DragEvent) {
    e.preventDefault();
  }
  function dropToAlways(e: React.DragEvent) {
    e.preventDefault();
    const d = draggedRef.current;
    draggedRef.current = null;
    if (!d) return;
    setAlwaysHave((prev) => (prev.includes(d.name) ? prev : [...prev, d.name]));
    setTags((prev) => prev.filter((t) => t !== d.name));
  }
  function dropToTags(e: React.DragEvent) {
    e.preventDefault();
    const d = draggedRef.current;
    draggedRef.current = null;
    if (!d || d.from !== "always") return;
    setAlwaysHave((prev) => prev.filter((t) => t !== d.name));
    setTags((prev) => (prev.includes(d.name) ? prev : [...prev, d.name]));
  }

  /* ---------- have set + filtering ---------- */
  const haveSet = useMemo(
    () =>
      new Set(
        [...tags, ...alwaysHave, ...STAPLES].map((t) => t.toLowerCase().trim())
      ),
    [tags, alwaysHave]
  );

  const filtered = useMemo(() => {
    return recipes
      .map((r) => {
        const missing = r.ingredients.filter(
          (n) => !hasIngredient(haveSet, n)
        );
        return { recipe: r, missing };
      })
      .filter((x) => x.recipe.time <= maxTime)
      .filter((x) => x.missing.length <= maxMissing)
      .filter((x) => meal === "all" || x.recipe.meal === meal)
      .sort(
        (a, b) =>
          a.missing.length - b.missing.length || a.recipe.time - b.recipe.time
      );
  }, [recipes, haveSet, maxTime, maxMissing, meal]);

  /* ---------- fetch (structured JSONL stream) ---------- */
  async function handleSubmit() {
    if (tags.length === 0 && alwaysHave.length === 0) return;

    setRecipes([]);
    setError("");
    setSearched(true);
    setLoading(true);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/cook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ingredients: tags,
          alwaysHave,
          maxTime,
          maxMissing,
          meal,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        setError("Something went wrong. Please try again.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let jsonl = "";

      const pushLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("```")) return;
        try {
          const obj = JSON.parse(trimmed) as Recipe;
          if (obj && obj.name && Array.isArray(obj.steps)) {
            setRecipes((prev) => [...prev, normalizeRecipe(obj)]);
          }
        } catch {
          /* incomplete or non-JSON line */
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const frames = sseBuffer.split("\n");
        sseBuffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          const payload = frame.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const { text, error: errMsg } = JSON.parse(payload);
            if (errMsg) {
              setError(errMsg);
            } else if (text) {
              jsonl += text;
              const lines = jsonl.split("\n");
              jsonl = lines.pop() ?? "";
              for (const l of lines) pushLine(l);
            }
          } catch {
            /* malformed SSE payload */
          }
        }
      }

      if (jsonl.trim()) {
        const trimmed = jsonl.trim();
        if (trimmed.startsWith("[")) {
          try {
            const arr = JSON.parse(trimmed) as Recipe[];
            setRecipes(arr.filter((r) => r?.name).map(normalizeRecipe));
          } catch {
            pushLine(trimmed);
          }
        } else {
          pushLine(trimmed);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError("Failed to connect. Is the server running?");
      }
    } finally {
      setLoading(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
    setLoading(false);
  }

  /* ---------- derived UI values ---------- */
  const tagCount = tags.length === 1 ? "1 item" : `${tags.length} items`;
  const timeLabel = maxTime >= 90 ? "Any" : `≤ ${maxTime} min`;
  const missingLabel =
    maxMissing === 0 ? "None" : maxMissing >= 5 ? "Any" : `Up to ${maxMissing}`;
  const timeFill = `${Math.round(((maxTime - 10) / 80) * 100)}%`;
  const missFill = `${Math.round((maxMissing / 5) * 100)}%`;

  const meals: { key: Meal; label: string }[] = [
    { key: "all", label: "All" },
    { key: "breakfast", label: "Breakfast" },
    { key: "lunch", label: "Lunch" },
    { key: "dinner", label: "Dinner" },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <h1 className="logo">
            What can
            <br />I cook
          </h1>
          <span className="tag-count">{tagCount}</span>
        </div>

        <input
          className="add-input"
          type="text"
          placeholder="Add ingredient…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addTag}
          disabled={loading}
          autoFocus
        />

        <div className="always">
          <button
            className="always-head"
            onClick={() => setAlwaysOpen((v) => !v)}
          >
            <span className="always-head-label">
              <span className="always-caret">{alwaysOpen ? "▼" : "▶"}</span>
              Always have
            </span>
            <span className="always-count">{alwaysHave.length}</span>
          </button>
          {alwaysOpen && (
            <div
              className="always-body"
              onDragOver={allowDrop}
              onDrop={dropToAlways}
            >
              {alwaysHave.map((it) => (
                <span
                  key={it}
                  className="always-chip"
                  draggable
                  onDragStart={onDragStart(it, "always")}
                >
                  {it}
                  <button
                    className="remove-btn"
                    onClick={() => removeAlways(it)}
                    aria-label={`Remove ${it}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {alwaysHave.length === 0 && (
                <span className="always-hint">
                  Drag ingredients here to always keep them on hand.
                </span>
              )}
            </div>
          )}
        </div>

        <ul
          className="ingredient-list scroll"
          onDragOver={allowDrop}
          onDrop={dropToTags}
        >
          {tags
            .filter((t) => !alwaysHave.includes(t))
            .map((tag) => (
              <li
                key={tag}
                className="ingredient-item"
                draggable
                onDragStart={onDragStart(tag, "tags")}
              >
                <span>{tag}</span>
                <button
                  className="remove-btn"
                  onClick={() => removeTag(tag)}
                  aria-label={`Remove ${tag}`}
                >
                  ×
                </button>
              </li>
            ))}
        </ul>

        <div className="staples-note">
          <p>
            Pantry staples — salt, pepper, oil, butter, flour, water, sugar —
            are always assumed on hand.
          </p>
        </div>

        <div className="sidebar-footer">
          <button
            className="cook-btn"
            onClick={handleSubmit}
            disabled={loading || (tags.length === 0 && alwaysHave.length === 0)}
          >
            {loading ? "Thinking…" : "Find recipes"}
          </button>
          {loading && (
            <button className="stop-btn" onClick={handleStop}>
              Stop
            </button>
          )}
        </div>
      </aside>

      <main className="main scroll">
        <div className="controls">
          <div className="controls-row">
            <div className="control">
              <div className="control-head">
                <span className="control-label">Max cook time</span>
                <span className="control-value">{timeLabel}</span>
              </div>
              <input
                className="slider"
                type="range"
                min={10}
                max={90}
                step={5}
                value={maxTime}
                onChange={(e) => setMaxTime(+e.target.value)}
                style={{ "--fill": timeFill, "--fc": "var(--blue)" } as CSSProperties}
              />
            </div>

            <div className="control">
              <div className="control-head">
                <span className="control-label">Missing allowed</span>
                <span className="control-value">{missingLabel}</span>
              </div>
              <input
                className="slider"
                type="range"
                min={0}
                max={5}
                step={1}
                value={maxMissing}
                onChange={(e) => setMaxMissing(+e.target.value)}
                style={{ "--fill": missFill, "--fc": "var(--miss)" } as CSSProperties}
              />
            </div>

            <div className="control" style={{ flex: "none", maxWidth: "none", minWidth: 0 }}>
              <span className="control-label">Meal</span>
              <div className="meal-toggle">
                {meals.map((m) => (
                  <button
                    key={m.key}
                    className={
                      "meal-btn" + (meal === m.key ? " meal-btn--active" : "")
                    }
                    onClick={() => setMeal(m.key)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="results">
          {searched && (recipes.length > 0 || loading) && (
            <div className="results-head">
              <h2 className="results-title">
                {filtered.length === 1
                  ? "1 recipe"
                  : `${filtered.length} recipes`}
              </h2>
              <span className="results-sub">
                {loading ? "Cooking up ideas…" : "From your pantry"}
              </span>
            </div>
          )}

          {filtered.length > 0 && (
            <div className="recipe-grid">
              {filtered.map(({ recipe, missing }, i) => {
                const accent = ACCENTS[i % ACCENTS.length];
                return (
                  <article
                    key={recipe.name + i}
                    className="recipe-card"
                    style={{ "--accent": accent } as CSSProperties}
                  >
                    <div className="recipe-top">
                      <div className="recipe-meta">
                        <span className="meal-pill">
                          {MEAL_LABELS[recipe.meal] ?? recipe.meal}
                        </span>
                        <span className="time-pill">{recipe.time} min</span>
                      </div>
                      <h3 className="recipe-name">{recipe.name}</h3>
                    </div>

                    <div className="chips">
                      {recipe.ingredients.map((ing) => (
                        <span
                          key={ing}
                          className={
                            "chip" +
                            (missing.includes(ing) ? " chip--missing" : "")
                          }
                        >
                          {ing}
                        </span>
                      ))}
                    </div>

                    <div>
                      {missing.length === 0 ? (
                        <span className="status--ok">You have everything</span>
                      ) : (
                        <span className="status--buy">
                          <b>Need to buy:</b> {missing.join(", ")}
                        </span>
                      )}
                    </div>

                    <ol className="steps">
                      {recipe.steps.map((text, n) => (
                        <li key={n} className="step">
                          <span className="step-num">{n + 1}</span>
                          <span className="step-text">{text}</span>
                        </li>
                      ))}
                    </ol>
                  </article>
                );
              })}
            </div>
          )}

          {!loading && !searched && (
            <div className="empty">
              <div className="empty-icon">?</div>
              <p className="empty-title">Ready when you are</p>
              <p className="empty-sub">
                Add a few ingredients on the left, then hit Find recipes to see
                what you can cook.
              </p>
            </div>
          )}
          {loading && recipes.length === 0 && (
            <div className="empty">
              <div className="empty-icon empty-icon--load">·</div>
              <p className="empty-title">Finding recipes</p>
              <p className="empty-sub">Reading your pantry…</p>
            </div>
          )}
          {!loading && searched && recipes.length > 0 && filtered.length === 0 && (
            <div className="empty">
              <div className="empty-icon">!</div>
              <p className="empty-title">No matches</p>
              <p className="empty-sub">
                Try allowing more missing ingredients, a longer cook time, or a
                different meal.
              </p>
            </div>
          )}
          {!loading && error && (
            <div className="empty">
              <div className="empty-icon">!</div>
              <p className="empty-title">Something went wrong</p>
              <p className="empty-sub">{error}</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function normalizeRecipe(r: Recipe): Recipe {
  const meal = (["breakfast", "lunch", "dinner"] as const).includes(
    r.meal as Recipe["meal"]
  )
    ? r.meal
    : "dinner";
  return {
    name: String(r.name),
    meal: meal as Recipe["meal"],
    time: Number(r.time) || 20,
    ingredients: Array.isArray(r.ingredients)
      ? r.ingredients.map((s) => String(s).toLowerCase().trim())
      : [],
    steps: Array.isArray(r.steps) ? r.steps.map((s) => String(s)) : [],
  };
}
