// Voice Forge — POST /api/voice
const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

// This must be a voice from YOUR OWN "My Voices" (added via the Voice
// Library "Add to my voices" button) — ElevenLabs' free/API plans block
// direct use of library voices that haven't been added to your account.
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "3AMU7jXQuQa3oRvRqUmb";

router.post("/", requireAuth, async (req, res) => {
  try {
    const { text, voiceId } = req.body;
    if (!text) return res.status(400).json({ error: "Provide `text` to synthesize." });

    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(501).json({ error: "Voice Forge needs ELEVENLABS_API_KEY set." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "voice_forge");

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId || DEFAULT_VOICE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: `ElevenLabs API error: ${errText}` });
    }

    await logJob(req.user.id, "voice_forge", "done", { text, voiceId }, { ok: true }, cost);
    res.set("Content-Type", "audio/mpeg");
    res.set("X-Credits-Remaining", String(newBalance));
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
