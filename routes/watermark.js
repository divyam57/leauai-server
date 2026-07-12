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
const upload = multer({ dest: path.join(__dirname, "..", "uploads") });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function getVideoDimensions(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", filePath,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  return { width: w, height: h };
}

router.post("/", requireAuth, upload.single("video"), async (req, res) => {
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

    const { newBalance, cost } = await spendCredits(req.user.id, "watermark_remover");

    const { width, height } = await getVideoDimensions(req.file.path);
    const x = Math.max(0, Math.round((xPct / 100) * width));
    const y = Math.max(0, Math.round((yPct / 100) * height));
    const w = Math.max(8, Math.round((wPct / 100) * width));
    const h = Math.max(8, Math.round((hPct / 100) * height));

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const outFilename = `clean_${randomUUID()}.mp4`;
    const outPath = path.join(outDir, outFilename);

    await run("ffmpeg", [
      "-y", "-i", req.file.path,
      "-vf", `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`,
      "-c:v", "libx264", "-preset", "veryfast",
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
