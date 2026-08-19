// AI Image Generator — POST /api/image
// Uses Pollinations.ai's free, keyless image generation API.
const express = require("express");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const { spendCredits, logJob } = require("../lib/credits");

const router = express.Router();

router.post("/", requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Provide a `prompt` describing the image." });

    const { newBalance, cost } = await spendCredits(req.user.id, "image_generator");

    const seed = Math.floor(Math.random() * 1_000_000);
    const genUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&nologo=true`;

    const response = await fetch(genUrl);
    if (!response.ok) throw new Error(`Image generation error: ${await response.text()}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const outDir = path.join(__dirname, "..", "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `image_${randomUUID()}.png`;
    fs.writeFileSync(path.join(outDir, filename), buffer);

    await logJob(req.user.id, "image_generator", "done", { prompt }, { url: `/outputs/${filename}` }, cost);
    res.json({ url: `/outputs/${filename}`, creditsRemaining: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
