// Virality Score — POST /api/virality
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { script } = req.body;
    if (!script) return res.status(400).json({ error: "Provide `script` (the hook or full script) to score." });

    const { newBalance, cost } = await spendCredits(req.user.id, "virality_score");

    const prompt = `Score this short-form video script/hook for viral potential: "${script}"
Respond ONLY with JSON, no markdown fences, no preamble:
{"hook_score": 0-10, "retention_score": 0-10, "pacing_score": 0-10, "notes": "2-3 sentences of specific feedback"}`;

    const text = await askGemini(prompt, 400);

    let result;
    try {
      result = parseJsonReply(text);
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
