// Script Generator — POST /api/script
// Two modes: write a fresh script from a topic, OR rewrite an existing
// script into a new fresh version (pass `existingScript` instead of `topic`).
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { topic, tone, existingScript } = req.body;
    if (!topic && !existingScript) {
      return res.status(400).json({ error: "Provide either a `topic` (to write fresh) or an `existingScript` (to rewrite)." });
    }

    const isRewrite = !!existingScript;
    const { newBalance, cost } = await spendCredits(req.user.id, isRewrite ? "script_rewrite" : "script_lab");

    const prompt = isRewrite
      ? `Rewrite this short-form video script into a fresh, distinct version — same core idea, new wording, new hook, new structure. Make it feel completely different, not just reworded sentence-by-sentence.
Tone: ${tone || "engaging, conversational"}.
Original script: "${existingScript}"
Respond ONLY with JSON in this exact shape, no markdown fences, no preamble:
{"hook": "first line, must earn the next 3 seconds", "beats": ["beat 1", "beat 2", "beat 3", "beat 4"], "cta": "closing line"}`
      : `Write a short-form video script (30-45 seconds spoken) about: "${topic}".
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

    await logJob(req.user.id, isRewrite ? "script_rewrite" : "script_lab", "done", { topic, tone, existingScript }, script, cost);
    res.json({ ...script, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
