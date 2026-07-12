// Video Downloader — POST /api/download
// Uses yt-dlp (free, open-source) to fetch a video from a public link
// (Instagram Reels, YouTube Shorts, TikTok, etc.) without a watermark where
// the platform's own player doesn't add one.
//
// Note: downloading from these platforms sits in a legal gray area under
// their own Terms of Service — this tool only fetches what's already
// publicly accessible, same as many similar tools, but that's worth knowing.
const express = require("express");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

const router = express.Router();

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50, timeout: timeoutMs || 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

const ALLOWED_HOST_PATTERNS = [
  /(^|\.)instagram\.com$/i,
  /(^|\.)youtube\.com$/i,
  /^youtu\.be$/i,
  /(^|\.)tiktok\.com$/i,
];

function isAllowedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return ALLOWED_HOST_PATTERNS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

router.post("/", requireAuth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "Provide a `url` to download from." });
    if (!isAllowedUrl(url)) {
      return res.status(400).json({ error: "Only Instagram, YouTube, and TikTok links are supported." });
    }

    const { newBalance, cost } = await spendCredits(req.user.id, "video_download");

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const id = randomUUID();
    const outputTemplate = path.join(outDir, `dl_${id}.%(ext)s`);

    await run("yt-dlp", [
      "-f", "mp4/best",
      "--no-playlist",
      "--max-filesize", "200M",
      "-o", outputTemplate,
      url,
    ], 90000);

    const files = fs.readdirSync(outDir).filter((f) => f.startsWith(`dl_${id}.`));
    if (!files.length) throw new Error("Download completed but no output file was found.");
    const filename = files[0];

    await logJob(req.user.id, "video_download", "done", { url }, { url: `/outputs/${filename}` }, cost);
    res.json({ url: `/outputs/${filename}`, creditsRemaining: newBalance });
  } catch (err) {
    const msg = /unsupported url|no video/i.test(err.message)
      ? "Couldn't find a downloadable video at that link — check it's public and correct."
      : err.message;
    res.status(err.status || 500).json({ error: msg });
  }
});

module.exports = router;
