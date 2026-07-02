// Voice Forge — POST /api/voice
// Free text-to-speech (Microsoft Edge TTS) — no API key required.
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { synthesizeSpeech } = require("../lib/tts");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text) return res.status(400).json({ error: "Provide `text` to synthesize." });

    const { newBalance, cost } = await spendCredits(req.user.id, "voice_forge");

    let buffer;
    try {
      buffer = await synthesizeSpeech(text, voiceId);
    } catch (e) {
      return res.status(502).json({ error: `Voice synthesis error: ${e.message}` });
    }

    await logJob(req.user.id, "voice_forge", "done", { text, voiceId }, { ok: true }, cost);
    res.set("Content-Type", "audio/mpeg");
    res.set("X-Credits-Remaining", String(newBalance));
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
