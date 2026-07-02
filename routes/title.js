// Title Generator — POST /api/title
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Provide a `topic` (or existing title/description) in the request body." });

    const { newBalance, cost } = await spendCredits(req.user.id, "title_generator");

    const prompt = `Generate 8 high-CTR video titles for short-form content about: "${topic}".
Mix styles: curiosity gap, bold claim, number-based, question, "how to". Keep each under 60 characters.
Respond ONLY with JSON, no markdown fences, no preamble:
{"titles": ["title 1", "title 2", ...8 total]}`;

    const text = await askGemini(prompt, 400, true);

    let result;
    try {
      result = parseJsonReply(text);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON output.", raw: text });
    }

    await logJob(req.user.id, "title_generator", "done", { topic }, result, cost);
    res.json({ ...result, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
