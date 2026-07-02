// Free LLM helper using Google Gemini (aistudio.google.com/apikey — no
// credit card required, generous free daily limit). Used by Script Lab,
// Virality Score, and Faceless Studio instead of a paid provider.
//
// Get a key: https://aistudio.google.com/apikey

const GEMINI_MODEL = "gemini-2.0-flash";

async function askGemini(prompt, maxTokens) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error("This tool needs GEMINI_API_KEY set on the server. Get a free key at https://aistudio.google.com/apikey");
    err.status = 501;
    throw err;
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
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
    const err = new Error(`Gemini API error: ${errText}`);
    err.status = 502;
    throw err;
  }

  const data = await response.json();
  const candidate = data.candidates && data.candidates[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("\n").trim() || "";
  return text;
}

function parseJsonReply(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

module.exports = { askGemini, parseJsonReply };
