// Free text-to-speech using Microsoft Edge's TTS service (the engine behind
// Edge's "Read Aloud" feature). No API key, no signup, no usage limit —
// unlike ElevenLabs' free tier, which blocks all voices via the API unless
// you're on a paid plan.
const { EdgeTTS } = require("@andresaya/edge-tts");

// Curated voice presets. Keys are what the frontend sends as `voiceId`.
// Real Microsoft neural voice names, tuned with pitch/rate for character.
const VOICE_PRESETS = {
  indian_female: { label: "Priya — Indian, Female", voice: "en-IN-NeerjaNeural" },
  indian_male: { label: "Arjun — Indian, Male", voice: "en-IN-PrabhatNeural" },
  foreign_female: { label: "Sophie — British, Female", voice: "en-GB-SoniaNeural" },
  deep_male: { label: "Adam — Deep Male", voice: "en-US-GuyNeural" },
  kid: { label: "Leo — Kid Voice", voice: "en-US-AnaNeural" },
  cartoon_kid: { label: "Ziggy — Cartoon Kid", voice: "en-US-AnaNeural", pitch: "+45Hz", rate: "+8%" },
};

const DEFAULT_PRESET = "indian_female";

// Returns an mp3 Buffer. `voiceKey` should be one of VOICE_PRESETS' keys.
async function synthesizeSpeech(text, voiceKey) {
  const preset = VOICE_PRESETS[voiceKey] || VOICE_PRESETS[DEFAULT_PRESET];
  const tts = new EdgeTTS();
  const options = {};
  if (preset.pitch) options.pitch = preset.pitch;
  if (preset.rate) options.rate = preset.rate;
  await tts.synthesize(text, preset.voice, options);
  return tts.toBuffer();
}

module.exports = { synthesizeSpeech, VOICE_PRESETS, DEFAULT_PRESET };
