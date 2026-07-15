// Auto Clip Engine — POST /api/clip
//
// Upload a video, get back the 1-2 "best" moments automatically — no manual
// timestamps needed. Finds the loudest sustained segments (laughter,
// exclamations, punchlines, energy spikes tend to be louder than calm
// narration) using ffmpeg's built-in loudness meter, entirely free/local —
// no external API calls.
//
// Rules:
//   - Clip length target: 20s (shorter if the video itself is shorter).
//   - Video too short to fit two non-overlapping clips -> exactly 1 clip.
//   - Video long enough for two distinct, non-overlapping best moments -> 2 clips.
//   - Never fails outright: falls back to sensible defaults if analysis is
//     inconclusive.
//   - Hard-capped so a stuck request can never hang forever, and — critically
//     — the underlying ffmpeg process is actually KILLED on timeout instead
//     of left running in the background, which was silently eating CPU and
//     making every subsequent request slower and slower.
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

const CLIP_LENGTH = 20;
const MIN_GAP = 5;
const JOB_TIMEOUT_MS = parseInt(process.env.CLIP_TIMEOUT_MS || "150000", 10); // 150s hard cap

const activeUserJobs = new Set();
const MAX_CONCURRENT_JOBS = parseInt(process.env.CLIP_MAX_CONCURRENT || "1", 10); // 1 at a time — free tier CPU can't handle more
let activeJobCount = 0;

// Tracks the currently-running ffmpeg/ffprobe child process for THIS
// request so we can kill it if the request times out. Without this, a
// timed-out job's ffmpeg process kept running in the background, eating
// CPU and making every subsequent request slower.
function run(cmd, args, childTracker) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (childTracker) childTracker.current = null;
      if (err && !stdout && !stderr) return reject(new Error(err.message));
      resolve({ stdout, stderr });
    });
    if (childTracker) childTracker.current = child;
  });
}

async function getDuration(filePath, childTracker) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ], childTracker);
  const val = parseFloat(stdout.trim());
  return isNaN(val) ? null : val;
}

async function analyzeLoudness(filePath, childTracker) {
  try {
    const { stderr } = await run("ffmpeg", [
      "-i", filePath,
      "-vn",
      "-filter_complex", "ebur128=peak=true",
      "-f", "null", "-",
    ], childTracker);
    const points = [];
    for (const line of stderr.split("\n")) {
      if (!line.includes("Parsed_ebur128") || !line.includes("M:")) continue;
      const tMatch = line.match(/t:\s*([\d.]+)/);
      const mMatch = line.match(/M:\s*(-?[\d.]+|-inf)/);
      if (tMatch && mMatch) {
        const t = parseFloat(tMatch[1]);
        const m = mMatch[1] === "-inf" ? -100 : parseFloat(mMatch[1]);
        if (!isNaN(t) && !isNaN(m)) points.push({ t, m });
      }
    }
    return points;
  } catch {
    return [];
  }
}

function findBestWindow(points, duration, length, exclude) {
  if (!points.length) return null;
  let bestStart = 0;
  let bestScore = -Infinity;
  const step = 1;
  for (let start = 0; start <= duration - length; start += step) {
    const end = start + length;
    if (exclude && start < exclude.end + MIN_GAP && end > exclude.start - MIN_GAP) continue;
    const windowPoints = points.filter((p) => p.t >= start && p.t < end);
    if (!windowPoints.length) continue;
    const avg = windowPoints.reduce((s, p) => s + p.m, 0) / windowPoints.length;
    if (avg > bestScore) { bestScore = avg; bestStart = start; }
  }
  return bestScore === -Infinity ? null : bestStart;
}

function ffmpegCut(inputPath, start, end, outputPath, childTracker) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-ss", String(start), "-to", String(end), "-i", inputPath,
      "-vf", "scale='min(1280,iw)':-2:flags=fast_bilinear",
      "-c:v", "libx264", "-c:a", "aac", "-preset", "ultrafast",
      "-threads", "1",
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

  if (activeUserJobs.has(req.user.id)) {
    fs.unlink(req.file.path, () => {});
    return res.status(409).json({ error: "You already have a clip render in progress. Please wait for it to finish before starting another." });
  }
  if (activeJobCount >= MAX_CONCURRENT_JOBS) {
    fs.unlink(req.file.path, () => {});
    return res.status(503).json({ error: "Auto Clip is at capacity right now — please try again in a minute." });
  }

  activeUserJobs.add(req.user.id);
  activeJobCount++;
  let timedOut = false;
  const childTracker = { current: null }; // tracks whatever ffmpeg/ffprobe process is running right now

  async function runPipeline() {
    const { newBalance, cost } = await spendCredits(req.user.id, "auto_clip");

    console.log(`[clip] analyzing "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(1)}MB)…`);
    const t0 = Date.now();
    const duration = (await getDuration(req.file.path, childTracker)) || 30;
    console.log(`[clip] duration: ${duration.toFixed(1)}s`);

    const clipLength = Math.max(3, Math.min(CLIP_LENGTH, duration - 0.5));
    const canFitTwo = duration >= CLIP_LENGTH * 2 + MIN_GAP;

    const points = await analyzeLoudness(req.file.path, childTracker);
    console.log(`[clip] loudness analysis done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${points.length} data points)`);

    const ranges = [];
    const firstStart = findBestWindow(points, duration, clipLength, null);
    if (firstStart !== null) {
      ranges.push({ start: firstStart, end: Math.min(duration, firstStart + clipLength) });
    } else {
      const fallbackStart = Math.max(0, (duration - clipLength) / 2);
      ranges.push({ start: fallbackStart, end: Math.min(duration, fallbackStart + clipLength) });
    }

    if (canFitTwo) {
      const secondStart = findBestWindow(points, duration, clipLength, ranges[0]);
      if (secondStart !== null) {
        ranges.push({ start: secondStart, end: Math.min(duration, secondStart + clipLength) });
      } else {
        const fallbackStart = ranges[0].start < duration / 2
          ? Math.max(ranges[0].end + MIN_GAP, duration - clipLength)
          : 0;
        if (fallbackStart + clipLength <= ranges[0].start - MIN_GAP || fallbackStart >= ranges[0].end + MIN_GAP) {
          ranges.push({ start: fallbackStart, end: Math.min(duration, fallbackStart + clipLength) });
        }
      }
    }

    ranges.sort((a, b) => a.start - b.start);

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });

    const results = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      console.log(`[clip] cutting clip ${i + 1}/${ranges.length} (${r.start.toFixed(1)}s-${r.end.toFixed(1)}s)…`);
      const filename = `clip_${randomUUID()}.mp4`;
      const outPath = path.join(outDir, filename);
      await ffmpegCut(req.file.path, r.start.toFixed(2), r.end.toFixed(2), outPath, childTracker);
      results.push({
        label: ranges.length > 1 ? `Best moment ${i + 1}` : "Best moment",
        url: `/outputs/${filename}`,
        start: Math.round(r.start),
        end: Math.round(r.end),
      });
    }
    console.log(`[clip] done, total time ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    fs.unlink(req.file.path, () => {});
    await logJob(req.user.id, "auto_clip", "done", { duration }, { clips: results }, cost);

    if (timedOut) {
      console.log("[clip] result arrived after timeout, discarding");
      return;
    }
    res.json({ clips: results, creditsRemaining: newBalance });
  }

  try {
    await Promise.race([
      runPipeline(),
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          // Critical: actually kill the ffmpeg process instead of letting
          // it keep running in the background — otherwise it keeps eating
          // CPU and makes every subsequent request slower.
          if (childTracker.current) {
            console.log("[clip] timeout — killing ffmpeg process");
            childTracker.current.kill("SIGKILL");
          }
          reject(new Error("This video took too long to process. Try a shorter video, or try again in a minute."));
        }, JOB_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.error("[clip] failed:", err.message);
    if (!timedOut && req.file) fs.unlink(req.file.path, () => {});
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message });
    }
  } finally {
    activeUserJobs.delete(req.user.id);
    activeJobCount--;
  }
});

module.exports = router;
