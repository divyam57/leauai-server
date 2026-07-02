// Free LLM helper using Google Gemini (aistudio.google.com/apikey — no
// credit card required, generous free daily limit). Used by Script Lab,
// Virality Score, and Faceless Studio instead of a paid provider.
//
// Get a key: https://aistudio.google.com/apikey

const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.1-flash-lite"];

async function askGemini(prompt, maxTokens) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error("This tool needs GEMINI_API_KEY set on the server. Get a free key at https://aistudio.google.com/apikey");
    err.status = 501;
    throw err;
  }

  let lastError;
  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: maxTokens || 700 },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        lastError = new Error(`Gemini API error (${model}): ${errText}`);
        // If this model is unavailable (quota exhausted or deprecated/renamed), try the next one.
        if (response.status === 429 || response.status === 404) continue;
        lastError.status = 502;
        throw lastError;
      }

      const data = await response.json();
      const candidate = data.candidates && data.candidates[0];
      return candidate?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
    } catch (e) {
      lastError = e;
    }
  }

  lastError.status = lastError.status || 502;
  throw lastError;
}

function parseJsonReply(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

module.exports = { askGemini, parseJsonReply };
