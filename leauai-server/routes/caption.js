// Caption Composer — POST /api/caption
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

function secondsToSrtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function segmentsToSrt(segments) {
  return segments.map((seg, i) => `${i + 1}\n${secondsToSrtTime(seg.start)} --> ${secondsToSrtTime(seg.end)}\n${seg.text}\n`).join("\n");
}

const STYLES = {
  default: "FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=60",
  bold: "FontName=Arial,Bold=1,FontSize=26,PrimaryColour=&H003DFFC8,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Alignment=2,MarginV=70",
  minimal: "FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,BorderStyle=3,BackColour=&H80000000,Alignment=2,MarginV=50",
};

function ffmpegBurnCaptions(inputPath, srtPath, outputPath, styleKey) {
  return new Promise((resolve, reject) => {
    const force_style = STYLES[styleKey] || STYLES.default;
    const safeSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    const args = ["-y", "-i", inputPath, "-vf", `subtitles=${safeSrt}:force_style='${force_style}'`, "-c:a", "copy", outputPath];
    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
  });
}

router.post("/", requireAuth, upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file uploaded (field name: 'video')." });

    let segments;
    try {
      segments = JSON.parse(req.body.segments || "[]");
    } catch {
      return res.status(400).json({ error: "`segments` must be a JSON string." });
    }
    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: "Provide at least one caption segment." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "caption_composer");

    const tmpDir = path.join(__dirname, "..", "uploads");
    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });

    const srtPath = path.join(tmpDir, `sub_${randomUUID()}.srt`);
    fs.writeFileSync(srtPath, segmentsToSrt(segments), "utf8");

    const outFilename = `captioned_${randomUUID()}.mp4`;
    const outPath = path.join(outDir, outFilename);

    await ffmpegBurnCaptions(req.file.path, srtPath, outPath, req.body.style);

    fs.unlink(req.file.path, () => {});
    fs.unlink(srtPath, () => {});

    await logJob(req.user.id, "caption_composer", "done", { segments, style: req.body.style }, { url: `/outputs/${outFilename}` }, cost);
    res.json({ url: `/outputs/${outFilename}`, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
