// Free text-to-speech using Microsoft Edge's TTS service (the engine behind
// Edge's "Read Aloud" feature). No API key, no signup, no usage limit —
// unlike ElevenLabs' free tier, which blocks all voices via the API unless
// you're on a paid plan.
const { EdgeTTS } = require("@andresaya/edge-tts");

const DEFAULT_VOICE = process.env.TTS_VOICE || "en-US-AriaNeural";

// Returns an mp3 Buffer.
async function synthesizeSpeech(text, voice) {
  const tts = new EdgeTTS();
  await tts.synthesize(text, voice || DEFAULT_VOICE);
  return tts.toBuffer();
}

module.exports = { synthesizeSpeech, DEFAULT_VOICE };
