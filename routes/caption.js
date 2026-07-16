// Caption Generator — POST /api/caption
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
  limits: { fileSize: 250 * 1024 * 1024 },
});

const JOB_TIMEOUT_MS = parseInt(process.env.CAPTION_TIMEOUT_MS || "150000", 10); // 150s hard cap
const activeUserJobs = new Set();
const MAX_CONCURRENT_JOBS = parseInt(process.env.CAPTION_MAX_CONCURRENT || "1", 10);
let activeJobCount = 0;

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

// Tracks the currently-running ffmpeg child process so we can kill it if the
// request times out — otherwise it keeps running in the background, eating
// CPU and making every subsequent request slower (this was the exact bug
// that made Auto Clip hang, now fixed here too).
function ffmpegBurnCaptions(inputPath, srtPath, outputPath, styleKey, childTracker) {
  return new Promise((resolve, reject) => {
    const force_style = STYLES[styleKey] || STYLES.default;
    const safeSrt = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    const args = [
      "-y", "-i", inputPath,
      "-vf", `scale='min(1280,iw)':-2:flags=fast_bilinear,subtitles=${safeSrt}:force_style='${force_style}'`,
      "-c:v", "libx264", "-preset", "ultrafast",
      "-threads", "1",
      "-c:a", "aac",
      outputPath,
    ];
    const child = execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (childTracker) childTracker.current = null;
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
    if (childTracker) childTracker.current = child;
  });
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
  if (!req.file) return res.status(400).json({ error: "No video file uploaded (field name: 'video')." });

  let segments;
  try {
    segments = JSON.parse(req.body.segments || "[]");
  } catch {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "`segments` must be a JSON string." });
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "Provide at least one caption segment." });
  }

  if (activeUserJobs.has(req.user.id)) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: "You already have a caption render in progress. Please wait for it to finish before starting another." });
  }
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    fs.unlink(req.file.path, () => {});
    return res.status(503).json({ error: "Caption Generator is at capacity right now — please try again in a minute." });
  }

  activeUserJobs.add(req.user.id);
  activeJobCount++;
  let timedOut = false;
  const childTracker = { current: null };
  const tmpDir = path.join(__dirname, "..", "uploads");
  let srtPath = null;

  async function runPipeline() {
    const { newBalance, cost } = await spendCredits(req.user.id, "caption_composer");

    console.log(`[caption] processing "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(1)}MB)…`);
    const t0 = Date.now();

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });

    srtPath = path.join(tmpDir, `sub_${randomUUID()}.srt`);
    fs.writeFileSync(srtPath, segmentsToSrt(segments), "utf8");

    const outFilename = `captioned_${randomUUID()}.mp4`;
    const outPath = path.join(outDir, outFilename);

    await ffmpegBurnCaptions(req.file.path, srtPath, outPath, req.body.style, childTracker);
    console.log(`[caption] done, total time ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    fs.unlink(req.file.path, () => {});
    fs.unlink(srtPath, () => {});

    await logJob(req.user.id, "caption_composer", "done", { segments, style: req.body.style }, { url: `/outputs/${outFilename}` }, cost);

    if (timedOut) {
      console.log("[caption] result arrived after timeout, discarding");
      return;
    }
    res.json({ url: `/outputs/${outFilename}`, creditsRemaining: newBalance });
  }

  try {
    await Promise.race([
      runPipeline(),
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          if (childTracker.current) {
            console.log("[caption] timeout — killing ffmpeg process");
            childTracker.current.kill("SIGKILL");
          }
          reject(new Error("This video took too long to process. Try a shorter video, or try again in a minute."));
        }, JOB_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("[caption] failed:", err.message);
    if (!timedOut) {
      fs.unlink(req.file.path, () => {});
      if (srtPath) fs.unlink(srtPath, () => {});
    }
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message });
    }
  } finally {
    activeUserJobs.delete(req.user.id);
    activeJobCount--;
  }
});

module.exports = router;
