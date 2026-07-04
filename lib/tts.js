// Free text-to-speech using Microsoft Edge's TTS service (the engine behind
// Edge's "Read Aloud" feature). No API key, no signup, no usage limit —
// unlike ElevenLabs' free tier, which blocks all voices via the API unless
// you're on a paid plan.
//
// Note on quality: this is the best available FREE, keyless TTS option.
// It's good, but it is not at ElevenLabs' level of realism — that's a paid
// product for a reason. If ElevenLabs-tier voice quality becomes a hard
// requirement later, that means a paid TTS provider (ElevenLabs, PlayHT,
// etc.) with your own API key.
const { EdgeTTS } = require("@andresaya/edge-tts");

// Curated voice presets. Keys are what the frontend sends as `voiceId`.
// Real Microsoft neural voice names. The "Multilingual" voices are Microsoft's
// newer, more natural-sounding generation.
const VOICE_PRESETS = {
  indian_female: { label: "Priya — Indian, Female", voice: "en-IN-NeerjaNeural" },
  indian_male: { label: "Arjun — Indian, Male", voice: "en-IN-PrabhatNeural" },
  foreign_female: { label: "Sophie — British, Female", voice: "en-GB-SoniaNeural" },
  deep_male: { label: "Adam — Deep Male", voice: "en-US-AndrewMultilingualNeural" },
  kid: { label: "Leo — Kid Voice", voice: "en-US-AnaNeural" },
  cartoon_kid: { label: "Ziggy — Cartoon Kid", voice: "en-US-AnaNeural", basePitch: 45 },
};

const DEFAULT_PRESET = "indian_female";
const DEFAULT_SPEED = 30; // matches the frontend slider's default position

// Maps the frontend's 0-100 "speed" slider to an Edge TTS rate percentage.
// 30 = normal speed (0%). Each step away from 30 shifts rate by 2%.
function speedToRatePercent(speed) {
  const s = typeof speed === "number" && !isNaN(speed) ? speed : DEFAULT_SPEED;
  const clamped = Math.max(0, Math.min(100, s));
  const percent = (clamped - DEFAULT_SPEED) * 2;
  return Math.max(-50, Math.min(100, Math.round(percent)));
}

// Returns an mp3 Buffer. `voiceKey` is one of VOICE_PRESETS' keys.
// `speed` is a 0-100 value from the frontend slider (default 30 = normal).
async function synthesizeSpeech(text, voiceKey, speed) {
  const preset = VOICE_PRESETS[voiceKey] || VOICE_PRESETS[DEFAULT_PRESET];
  const tts = new EdgeTTS();

  const ratePercent = speedToRatePercent(speed);
  const options = {};
  if (ratePercent !== 0) options.rate = `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`;
  if (preset.basePitch) options.pitch = `+${preset.basePitch}Hz`;

  await tts.synthesize(text, preset.voice, options);
  return tts.toBuffer();
}

module.exports = { synthesizeSpeech, VOICE_PRESETS, DEFAULT_PRESET, DEFAULT_SPEED };
