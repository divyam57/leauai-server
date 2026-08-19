// Fake-Text Video Generator — POST /api/faketext
// Chain: Gemini (conversation script) -> canvas (chat screenshots) ->
// ffmpeg (slideshow with per-message timing). No voice, no stock footage —
// intentionally lightweight so it can't crash a free-tier server the way
// Faceless Studio's full pipeline could.
const express = require("express");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");
const { askGemini, parseJsonReply } = require("../lib/gemini");
const { renderFrame } = require("../lib/faketext-render");

const router = express.Router();

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function generateConversation(topic) {
  const prompt = `Write a short, dramatic fake text-message conversation (6-10 messages) about: "${topic}".
Make it feel real and attention-grabbing — the kind of screenshot conversation that goes viral. Alternate between two people naturally (not strictly back-and-forth).
Also invent a short contact name for who "them" is.
Respond ONLY with JSON, no markdown fences, no preamble:
{"contactName": "name", "messages": [{"sender": "me" | "them", "text": "message text"}, ...6-10 total]}`;

  const text = await askGemini(prompt, 700, true);
  return parseJsonReply(text);
}

router.post("/", requireAuth, async (req, res) => {
  const tmpDir = path.join(__dirname, "..", "uploads", `faketext_${randomUUID()}`);
  try {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Provide a `topic` for the conversation." });

    const { newBalance, cost } = await spendCredits(req.user.id, "faketext_video");

    fs.mkdirSync(tmpDir, { recursive: true });

    const { contactName, messages } = await generateConversation(topic);
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Model didn't return a usable conversation.");
    }

    // Render one frame per cumulative message state, and give each frame a
    // duration proportional to its text length (so longer messages get more
    // read-time) using ffmpeg's concat demuxer image-slideshow trick.
    const concatLines = [];
    for (let i = 0; i < messages.length; i++) {
      const framePath = path.join(tmpDir, `frame_${i}.png`);
      const buffer = renderFrame(messages, i + 1, contactName);
      fs.writeFileSync(framePath, buffer);
      const duration = Math.min(3.5, Math.max(1.2, messages[i].text.length / 18));
      concatLines.push(`file '${framePath}'`);
      concatLines.push(`duration ${duration}`);
    }
    // The concat demuxer ignores the duration on the final entry unless the
    // last file is repeated once more — this is a well-known ffmpeg quirk.
    concatLines.push(`file '${path.join(tmpDir, `frame_${messages.length - 1}.png`)}'`);

    const concatListPath = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(concatListPath, concatLines.join("\n"));

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const outFilename = `faketext_${randomUUID()}.mp4`;
    const outPath = path.join(outDir, outFilename);

    await run("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", concatListPath,
      "-vf", "fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast",
      outPath,
    ]);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    await logJob(req.user.id, "faketext_video", "done", { topic }, { url: `/outputs/${outFilename}` }, cost);
    res.json({ url: `/outputs/${outFilename}`, contactName, messages, creditsRemaining: newBalance });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
