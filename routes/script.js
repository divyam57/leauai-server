// Script Lab — POST /api/script
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { topic, tone } = req.body;
    if (!topic) return res.status(400).json({ error: "Provide a `topic` in the request body." });

    const { newBalance, cost } = await spendCredits(req.user.id, "script_lab");

    const prompt = `Write a short-form video script (30-45 seconds spoken) about: "${topic}".
Tone: ${tone || "engaging, conversational"}.
Respond ONLY with JSON in this exact shape, no markdown fences, no preamble:
{"hook": "first line, must earn the next 3 seconds", "beats": ["beat 1", "beat 2", "beat 3", "beat 4"], "cta": "closing line"}`;

    const text = await askGemini(prompt, 800, true);

    let script;
    try {
      script = parseJsonReply(text);
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
