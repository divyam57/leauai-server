// Hook Rewriter — POST /api/hook
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { hook } = req.body;
    if (!hook) return res.status(400).json({ error: "Provide your current `hook` (opening line) in the request body." });

    const { newBalance, cost } = await spendCredits(req.user.id, "hook_rewriter");

    const prompt = `Rewrite this short-form video hook (the opening line, first 3 seconds) into 6 stronger alternatives that earn more watch-through: "${hook}"
Vary the angle: shock/curiosity, direct callout, bold stat/claim, relatable pain point, contrarian take, question. Keep each under 20 words.
Respond ONLY with JSON, no markdown fences, no preamble:
{"hooks": [{"text": "hook text", "angle": "short label like 'Curiosity gap'"}, ...6 total]}`;

    const text = await askGemini(prompt, 500, true);

    let result;
    try {
      result = parseJsonReply(text);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON output.", raw: text });
    }

    await logJob(req.user.id, "hook_rewriter", "done", { hook }, result, cost);
    res.json({ ...result, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
