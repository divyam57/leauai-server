// Watermark Remover — POST /api/watermark
// Uses ffmpeg's "delogo" filter to blend out a rectangular region (where the
// watermark/logo sits) using surrounding pixels. This is a free, real
// technique — but it's a basic blend, not true AI inpainting, so results
// are best on solid-color logos over simple backgrounds, not perfect on
// busy/detailed photos.
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
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function getImageDimensions(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x", filePath,
  ]);
  const [w, h] = stdout.trim().split("x").map(Number);
  return { width: w, height: h };
}

router.post("/", requireAuth, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded (field name: 'image')." });

    // Region as percentages of the image (0-100), so the frontend doesn't
    // need to know the actual pixel dimensions.
    const xPct = parseFloat(req.body.x);
    const yPct = parseFloat(req.body.y);
    const wPct = parseFloat(req.body.width);
    const hPct = parseFloat(req.body.height);
    if ([xPct, yPct, wPct, hPct].some((v) => isNaN(v) || v < 0)) {
      return res.status(400).json({ error: "Provide x, y, width, height as percentages (0-100) marking the watermark's location." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "watermark_remover");

    const { width, height } = await getImageDimensions(req.file.path);
    const x = Math.round((xPct / 100) * width);
    const y = Math.round((yPct / 100) * height);
    const w = Math.max(8, Math.round((wPct / 100) * width));
    const h = Math.max(8, Math.round((hPct / 100) * height));

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const outFilename = `clean_${randomUUID()}.png`;
    const outPath = path.join(outDir, outFilename);

    await run("ffmpeg", [
      "-y", "-i", req.file.path,
      "-vf", `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`,
      "-frames:v", "1",
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
