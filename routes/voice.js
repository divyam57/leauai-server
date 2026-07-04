// Voice Forge — POST /api/voice, GET /api/voice/list
// Free text-to-speech (Microsoft Edge TTS) — no API key required.
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { synthesizeSpeech, VOICE_PRESETS } = require("../lib/tts");

// Public list of available voices (no auth needed — just metadata, not audio).
router.get("/list", (req, res) => {
  const voices = Object.entries(VOICE_PRESETS).map(([id, v]) => ({ id, label: v.label }));
  res.json({ voices });
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { text, voiceId, speed } = req.body;
    if (!text) return res.status(400).json({ error: "Provide `text` to synthesize." });

    const { newBalance, cost } = await spendCredits(req.user.id, "voice_forge");

    let buffer;
    try {
      buffer = await synthesizeSpeech(text, voiceId, typeof speed === "number" ? speed : parseFloat(speed));
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
