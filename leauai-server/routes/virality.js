// Virality Score — POST /api/virality
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { script } = req.body;
    if (!script) return res.status(400).json({ error: "Provide `script` (the hook or full script) to score." });

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(501).json({ error: "Virality Score needs ANTHROPIC_API_KEY set." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "virality_score");

    const prompt = `Score this short-form video script/hook for viral potential: "${script}"
Respond ONLY with JSON, no markdown fences, no preamble:
{"hook_score": 0-10, "retention_score": 0-10, "pacing_score": 0-10, "notes": "2-3 sentences of specific feedback"}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
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

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON output.", raw: text });
    }

    await logJob(req.user.id, "virality_score", "done", { script }, result, cost);
    res.json({ ...result, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
