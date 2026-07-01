// Auto Clip Engine — POST /api/clip
const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, "..", "uploads") });

function ffmpegCut(inputPath, start, end, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-ss", start, "-to", end, "-i", inputPath, "-c:v", "libx264", "-c:a", "aac", "-preset", "veryfast", outputPath];
    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
  });
}

router.post("/", requireAuth, upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file uploaded (field name: 'video')." });

    let clips;
    try {
      clips = JSON.parse(req.body.clips || "[]");
    } catch {
      return res.status(400).json({ error: "`clips` must be a JSON string." });
    }
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ error: "Provide at least one clip range in `clips`." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "auto_clip");

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });

    const results = [];
    for (const clip of clips) {
      if (!clip.start || !clip.end) continue;
      const filename = `clip_${randomUUID()}.mp4`;
      const outPath = path.join(outDir, filename);
      await ffmpegCut(req.file.path, clip.start, clip.end, outPath);
      results.push({ label: clip.label || null, url: `/outputs/${filename}` });
    }

    fs.unlink(req.file.path, () => {});
    await logJob(req.user.id, "auto_clip", "done", { clips }, { clips: results }, cost);
    res.json({ clips: results, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
