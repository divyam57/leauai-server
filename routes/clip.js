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

const CLIP_LENGTH = 20; // seconds, target length per clip
const MIN_GAP = 5; // seconds required between two clips so they don't overlap

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      // ffmpeg writes its normal analysis output to stderr even on success,
      // so we resolve with stderr regardless of `err` for filters like
      // ebur128 that always exit non-zero-ish noise — but a real failure
      // (bad file, missing codec) still needs to reject.
      if (err && !stdout && !stderr) return reject(new Error(err.message));
      resolve({ stdout, stderr });
    });
  });
}

async function getDuration(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ]);
  const val = parseFloat(stdout.trim());
  return isNaN(val) ? null : val;
}

// Runs ffmpeg's loudness meter over the whole file and returns a time
// series of { t, m } (timestamp in seconds, momentary loudness in LUFS).
async function analyzeLoudness(filePath) {
  try {
    const { stderr } = await run("ffmpeg", [
      "-i", filePath,
      "-vn", // audio-only — skip decoding video frames, we don't need them for this
      "-filter_complex", "ebur128=peak=true",
      "-f", "null", "-",
    ]);
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

// Finds the start time of the loudest sustained window of `length` seconds,
// optionally excluding a region already used by another chosen clip.
function findBestWindow(points, duration, length, exclude) {
  if (!points.length) return null;
  let bestStart = 0;
  let bestScore = -Infinity;
  const step = 1; // seconds
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

function ffmpegCut(inputPath, start, end, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-ss", String(start), "-to", String(end), "-i", inputPath,
      "-c:v", "libx264", "-c:a", "aac", "-preset", "veryfast", outputPath,
    ];
    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outputPath);
    });
  });
}

router.post("/", requireAuth, upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video file uploaded (field name: 'video')." });

    const { newBalance, cost } = await spendCredits(req.user.id, "auto_clip");

    console.log(`[clip] analyzing "${req.file.originalname}" (${(req.file.size / 1024 / 1024).toFixed(1)}MB)…`);
    const t0 = Date.now();
    const duration = (await getDuration(req.file.path)) || 30;
    console.log(`[clip] duration: ${duration.toFixed(1)}s`);

    // Decide clip length and how many clips fit.
    const clipLength = Math.max(3, Math.min(CLIP_LENGTH, duration - 0.5));
    const canFitTwo = duration >= CLIP_LENGTH * 2 + MIN_GAP;

    const points = await analyzeLoudness(req.file.path);
    console.log(`[clip] loudness analysis done in ${((Date.now() - t0) / 1000).toFixed(1)}s (${points.length} data points)`);

    const ranges = [];
    const firstStart = findBestWindow(points, duration, clipLength, null);
    if (firstStart !== null) {
      ranges.push({ start: firstStart, end: Math.min(duration, firstStart + clipLength) });
    } else {
      // Analysis inconclusive (e.g. silent video) — fall back to a
      // sensible default instead of failing outright.
      const fallbackStart = Math.max(0, (duration - clipLength) / 2);
      ranges.push({ start: fallbackStart, end: Math.min(duration, fallbackStart + clipLength) });
    }

    if (canFitTwo) {
      const secondStart = findBestWindow(points, duration, clipLength, ranges[0]);
      if (secondStart !== null) {
        ranges.push({ start: secondStart, end: Math.min(duration, secondStart + clipLength) });
      } else {
        // Fallback second clip: as far from the first as possible.
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
      await ffmpegCut(req.file.path, r.start.toFixed(2), r.end.toFixed(2), outPath);
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
    res.json({ clips: results, creditsRemaining: newBalance });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
