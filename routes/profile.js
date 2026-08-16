// Profile / Onboarding — /api/profile
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { requireAuth } = require("../middleware/auth");
const supabaseAdmin = require("../lib/supabaseAdmin");

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, "..", "uploads"), limits: { fileSize: 5 * 1024 * 1024 } });

router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin.from("profiles").select("*").eq("id", req.user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// ---------- onboarding / profile update ----------
router.put("/", requireAuth, async (req, res) => {
  const { display_name, business_name, field_of_work } = req.body;
  const update = { onboarded: true };
  if (display_name !== undefined) update.display_name = display_name;
  if (business_name !== undefined) update.business_name = business_name;
  if (field_of_work !== undefined) update.field_of_work = field_of_work;

  const { data, error } = await supabaseAdmin.from("profiles").update(update).eq("id", req.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

// ---------- logo upload ----------
router.post("/logo", requireAuth, upload.single("logo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No logo uploaded (field name: 'logo')." });

  const outDir = path.join(__dirname, "..", "outputs");
  fs.mkdirSync(outDir, { recursive: true });
  const ext = path.extname(req.file.originalname) || ".png";
  const filename = `logo_${req.user.id}_${randomUUID()}${ext}`;
  fs.renameSync(req.file.path, path.join(outDir, filename));

  const logoUrl = `/outputs/${filename}`;
  const { data, error } = await supabaseAdmin.from("profiles").update({ logo_url: logoUrl }).eq("id", req.user.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data, logo_url: logoUrl });
});

module.exports = router;
