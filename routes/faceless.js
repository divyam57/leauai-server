// Faceless Studio — POST /api/faceless
// Chain: Gemini (script) -> Edge TTS (voiceover, free) -> Pexels (stock clips
// matching each beat) -> ffmpeg (assemble + caption burn-in) -> finished mp4.
const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");
const { synthesizeSpeech } = require("../lib/tts");

const router = express.Router();

// Faceless Studio is heavy (multiple ffmpeg passes + several API calls per
// request). Render's free tier only has 512MB RAM — two of these running at
// once is enough to crash the whole server. This tracks in-flight jobs so we
// can reject duplicates instead of letting the process run out of memory.
const activeUserJobs = new Set();
const MAX_CONCURRENT_JOBS = parseInt(process.env.FACELESS_MAX_CONCURRENT || "1", 10);
let activeJobCount = 0;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function getAudioDuration(filePath) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath]);
  return parseFloat(out.trim());
}

async function generateScript(topic, tone) {
  const prompt = `Write a short-form video script (30-45 seconds spoken) about: "${topic}".
Tone: ${tone || "engaging, conversational"}.
For each beat, also give a 2-4 word visual search keyword describing what footage should be on screen.
Respond ONLY with JSON, no markdown fences, no preamble, in this exact shape:
{"hook": "first line", "hook_visual": "2-4 word search term", "beats": [{"text": "beat text", "visual": "2-4 word search term"}, ...4 beats total], "cta": "closing line", "cta_visual": "2-4 word search term"}`;

  const text = await askGemini(prompt, 900, true);
  return parseJsonReply(text);
}

async function generateVoice(text, outPath) {
  const buffer = await synthesizeSpeech(text);
  fs.writeFileSync(outPath, buffer);
}

async function fetchStockClip(query, outPath) {
  const searchRes = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=1`, {
    headers: { Authorization: process.env.PEXELS_API_KEY },
  });
  if (!searchRes.ok) throw new Error(`Pexels API error: ${await searchRes.text()}`);
  const data = await searchRes.json();
  const video = data.videos && data.videos[0];
  if (!video) throw new Error(`No stock footage found for "${query}"`);

  const files = video.video_files.filter((f) => f.width && f.height && f.height >= f.width);
  const best = (files.length ? files : video.video_files).sort((a, b) => a.width - b.width)[0];

  const fileRes = await fetch(best.link);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
}

function secondsToSrtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

const JOB_TIMEOUT_MS = parseInt(process.env.FACELESS_TIMEOUT_MS || "240000", 10); // 4 minutes

router.post("/", requireAuth, async (req, res) => {
  const { topic, tone } = req.body;
  if (!topic) return res.status(400).json({ error: "Provide a `topic` in the request body." });

  if (activeUserJobs.has(req.user.id)) {
    return res.status(409).json({ error: "You already have a Faceless Studio render in progress. Please wait for it to finish before starting another." });
  }
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({ error: "Faceless Studio is at capacity right now — please try again in a minute." });
  }

  activeUserJobs.add(req.user.id);
  activeJobCount++;

  let timedOut = false;
  const tmpDir = path.join(__dirname, "..", "uploads", `faceless_${randomUUID()}`);

  async function runPipeline() {
    const missing = ["GEMINI_API_KEY", "PEXELS_API_KEY"].filter((k) => !process.env[k]);
    if (missing.length) {
      const err = new Error(`Faceless Studio needs ${missing.join(", ")} set.`);
      err.status = 501;
      throw err;
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "faceless_studio");

    fs.mkdirSync(tmpDir, { recursive: true });

    console.log("[faceless] generating script…");
    const script = await generateScript(topic, tone);
    console.log("[faceless] script done");
    const segments = [
      { text: script.hook, visual: script.hook_visual },
      ...script.beats,
      { text: script.cta, visual: script.cta_visual },
    ];

    const segmentAudio = [];
    for (let i = 0; i < segments.length; i++) {
      console.log(`[faceless] generating voice segment ${i + 1}/${segments.length}…`);
      const audioPath = path.join(tmpDir, `vo_${i}.mp3`);
      await generateVoice(segments[i].text, audioPath);
      const duration = await getAudioDuration(audioPath);
      segmentAudio.push({ ...segments[i], audioPath, duration });
      console.log(`[faceless] voice segment ${i + 1} done (${duration.toFixed(1)}s)`);
    }

    const clipPaths = [];
    let cursor = 0;
    const srtLines = [];
    for (let i = 0; i < segmentAudio.length; i++) {
      const seg = segmentAudio[i];
      console.log(`[faceless] fetching stock footage ${i + 1}/${segmentAudio.length} ("${seg.visual || topic}")…`);
      const rawClip = path.join(tmpDir, `raw_${i}.mp4`);
      await fetchStockClip(seg.visual || topic, rawClip);
      console.log(`[faceless] footage ${i + 1} downloaded, trimming…`);

      const trimmedClip = path.join(tmpDir, `trim_${i}.mp4`);
      await run("ffmpeg", [
        "-y", "-i", rawClip,
        "-t", String(seg.duration),
        "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-an", "-c:v", "libx264", "-preset", "veryfast",
        trimmedClip,
      ]);
      clipPaths.push(trimmedClip);
      console.log(`[faceless] clip ${i + 1} trimmed`);

      srtLines.push(`${i + 1}\n${secondsToSrtTime(cursor)} --> ${secondsToSrtTime(cursor + seg.duration)}\n${seg.text}\n`);
      cursor += seg.duration;
    }

    console.log("[faceless] concatenating video clips…");
    const concatListPath = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(concatListPath, clipPaths.map((p) => `file '${p}'`).join("\n"));
    const silentVideoPath = path.join(tmpDir, "silent.mp4");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", silentVideoPath]);
    console.log("[faceless] video concat done");

    console.log("[faceless] concatenating audio segments…");
    const audioConcatListPath = path.join(tmpDir, "audio_concat.txt");
    fs.writeFileSync(audioConcatListPath, segmentAudio.map((s) => `file '${s.audioPath}'`).join("\n"));
    const fullAudioPath = path.join(tmpDir, "full_audio.mp3");
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", audioConcatListPath, "-c", "copy", fullAudioPath]);
    console.log("[faceless] audio concat done");

    console.log("[faceless] muxing video + audio…");
    const muxedPath = path.join(tmpDir, "muxed.mp4");
    await run("ffmpeg", ["-y", "-i", silentVideoPath, "-i", fullAudioPath, "-c:v", "copy", "-c:a", "aac", "-shortest", muxedPath]);
    console.log("[faceless] mux done");

    console.log("[faceless] burning in captions (final pass)…");
    const srtPath = path.join(tmpDir, "captions.srt");
    fs.writeFileSync(srtPath, srtLines.join("\n"), "utf8");
    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const outFilename = `faceless_${randomUUID()}.mp4`;
    const outPath = path.join(outDir, outFilename);
    const safeSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    await run("ffmpeg", [
      "-y", "-i", muxedPath,
      "-vf", `subtitles=${safeSrt}:force_style='FontName=Arial,Bold=1,FontSize=26,PrimaryColour=&H003DFFC8,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Alignment=2,MarginV=70'`,
      "-c:a", "copy",
      outPath,
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log("[faceless] done");

    await logJob(req.user.id, "faceless_studio", "done", { topic, tone }, { url: `/outputs/${outFilename}` }, cost);

    if (timedOut) {
      // The client already got a timeout response — don't try to write to
      // a response that's already been sent.
      console.log("[faceless] result arrived after timeout, discarding");
      return;
    }
    res.json({
      url: `/outputs/${outFilename}`,
      hook: script.hook,
      beats: script.beats.map((b) => b.text),
      cta: script.cta,
      creditsRemaining: newBalance,
    });
  }

  try {
    await Promise.race([
      runPipeline(),
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error("Faceless Studio took too long and timed out. Please try again — if this keeps happening, try a shorter topic."));
        }, JOB_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("[faceless] failed:", err.message);
    if (!timedOut) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message });
    }
  } finally {
    activeUserJobs.delete(req.user.id);
    activeJobCount--;
  }
});

module.exports = router;
