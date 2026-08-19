// Watermark Remover — POST /api/watermark
// Uses ffmpeg's "delogo" filter to blend out a rectangular region (where the
// watermark/logo sits) across the whole video, using surrounding pixels.
// This is a free, real technique — but it's a basic blend, not true AI
// inpainting, so results are best on solid-color logos over simple
// backgrounds, not perfect on busy/detailed footage.
const express = require("express");
const multer = require("multer");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

const router = express.Router();
const upload = multer({
  dest: path.join(__dirname, "..", "uploads"),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB cap — bigger risks crashing the free-tier server (512MB RAM)
});

const MAX_DURATION_S = 180; // 3 minutes — longer videos take too long to re-encode on a free-tier server
const MAX_WIDTH = 1280; // downscale — this is what actually keeps memory use in check, not the file size

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function getVideoInfo(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "default=noprint_wrappers=1", filePath,
  ]);
  const info = {};
  for (const line of stdout.split("\n")) {
    const [key, val] = line.split("=");
    if (key && val) info[key.trim()] = val.trim();
  }
  return {
    width: parseInt(info.width, 10),
    height: parseInt(info.height, 10),
    duration: parseFloat(info.duration),
  };
}

router.post("/", requireAuth, (req, res, next) => {
  upload.single("video")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "That video is too large (max 250MB on the free tier). Try a shorter clip or a lower-resolution export." });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded (field name: 'video')." });

    // Region as percentages of the frame (0-100) — the frontend computes
    // these from a drag-to-select box drawn over a preview of the video.
    const xPct = parseFloat(req.body.x);
    const yPct = parseFloat(req.body.y);
    const wPct = parseFloat(req.body.width);
    const hPct = parseFloat(req.body.height);
    if ([xPct, yPct, wPct, hPct].some((v) => isNaN(v) || v < 0) || wPct <= 0 || hPct <= 0) {
      return res.status(400).json({ error: "Drag a box over the watermark in the preview first." });
    }

    const { width, height, duration } = await getVideoInfo(req.file.path);
    if (duration > MAX_DURATION_S) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `That video is too long (max ${MAX_DURATION_S / 60} minutes on the free tier). Trim it first and try again.` });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "watermark_remover");

    // Compute the region against the POST-DOWNSCALE dimensions (percentages
    // are resolution-independent, so this just needs the scale filter placed
    // before delogo in the same chain).
    const targetWidth = Math.min(MAX_WIDTH, width);
    const targetHeight = Math.round(height * (targetWidth / width / 2)) * 2; // keep even for libx264
    const x = Math.max(0, Math.round((xPct / 100) * targetWidth));
    const y = Math.max(0, Math.round((yPct / 100) * targetHeight));
    const w = Math.max(8, Math.round((wPct / 100) * targetWidth));
    const h = Math.max(8, Math.round((hPct / 100) * targetHeight));

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const outFilename = `clean_${randomUUID()}.mp4`;
    const outPath = path.join(outDir, outFilename);

    await run("ffmpeg", [
      "-y", "-i", req.file.path,
      "-vf", `scale=${targetWidth}:${targetHeight},delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`,
      "-c:v", "libx264", "-preset", "veryfast",
      "-threads", "1",
      "-c:a", "copy",
      outPath,
    ]);

    fs.unlink(req.file.path, () => {});
    await logJob(req.user.id, "watermark_remover", "done", { x: xPct, y: yPct, width: wPct, height: hPct }, { url: `/outputs/${outFilename}` }, cost);
    res.json({ url: `/outputs/${outFilename}`, creditsRemaining: newBalance });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
