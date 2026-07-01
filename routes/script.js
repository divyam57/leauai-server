// Script Lab — POST /api/script
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { topic, tone } = req.body;
    if (!topic) return res.status(400).json({ error: "Provide a `topic` in the request body." });

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(501).json({ error: "Script Lab needs ANTHROPIC_API_KEY set." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "script_lab");

    const prompt = `Write a short-form video script (30-45 seconds spoken) about: "${topic}".
Tone: ${tone || "engaging, conversational"}.
Respond ONLY with JSON in this exact shape, no markdown fences, no preamble:
{"hook": "first line, must earn the next 3 seconds", "beats": ["beat 1", "beat 2", "beat 3", "beat 4"], "cta": "closing line"}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `Anthropic API error: ${errText}` });
    }

    const data = await response.json();
    const text = data.content.map((b) => b.text || "").join("\n").trim();
    const cleaned = text.replace(/```json|```/g, "").trim();

    let script;
    try {
      script = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON output.", raw: text });
    }

    await logJob(req.user.id, "script_lab", "done", { topic, tone }, script, cost);
    res.json({ ...script, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
