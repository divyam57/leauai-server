// Clients — /api/clients
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { requireAuth } = require("../middleware/auth");
const supabaseAdmin = require("../lib/supabaseAdmin");

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, "..", "uploads"), limits: { fileSize: 5 * 1024 * 1024 } });

// ---------- list all clients ----------
router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: data });
});

// ---------- get one client + their proposal/meeting/payment history ----------
router.get("/:id", requireAuth, async (req, res) => {
  const { data: client, error } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();
  if (error || !client) return res.status(404).json({ error: "Client not found." });

  const [{ data: proposals }, { data: meetings }, { data: payments }] = await Promise.all([
    supabaseAdmin.from("proposals").select("*").eq("client_id", client.id).eq("user_id", req.user.id).order("created_at", { ascending: false }),
    supabaseAdmin.from("meetings").select("*").eq("client_id", client.id).eq("user_id", req.user.id).order("scheduled_at", { ascending: false }),
    supabaseAdmin.from("payments").select("*").eq("client_id", client.id).eq("user_id", req.user.id).order("created_at", { ascending: false }),
  ]);

  res.json({ client, proposals: proposals || [], meetings: meetings || [], payments: payments || [] });
});

// ---------- add one client manually ----------
router.post("/", requireAuth, async (req, res) => {
  const { name, company, email, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: "Client name is required." });

  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({ user_id: req.user.id, name, company, email, phone, notes, added_via: "manual" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ client: data });
});

// ---------- update a client ----------
router.put("/:id", requireAuth, async (req, res) => {
  const { name, company, email, phone, notes, status } = req.body;
  const { data, error } = await supabaseAdmin
    .from("clients")
    .update({ name, company, email, phone, notes, status })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ client: data });
});

// ---------- delete a client ----------
router.delete("/:id", requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("clients")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- sample CSV template for bulk upload ----------
router.get("/bulk/template", requireAuth, (req, res) => {
  const csv = "name,company,email,phone,notes\nJohn Doe,Acme Inc,john@acme.com,+1234567890,Met at conference\n";
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=clients_template.csv");
  res.send(csv);
});

// ---------- bulk CSV upload ----------
router.post("/bulk", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No CSV file uploaded (field name: 'file')." });

  try {
    const text = fs.readFileSync(req.file.path, "utf8");
    fs.unlink(req.file.path, () => {});

    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: "CSV needs a header row plus at least one client." });

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const nameIdx = headers.indexOf("name");
    if (nameIdx === -1) return res.status(400).json({ error: "CSV must have a 'name' column." });

    const companyIdx = headers.indexOf("company");
    const emailIdx = headers.indexOf("email");
    const phoneIdx = headers.indexOf("phone");
    const notesIdx = headers.indexOf("notes");

    const rows = [];
    const errors = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      const name = cols[nameIdx];
      if (!name) {
        errors.push({ row: i + 1, error: "Missing name" });
        continue;
      }
      rows.push({
        user_id: req.user.id,
        name,
        company: companyIdx > -1 ? cols[companyIdx] : null,
        email: emailIdx > -1 ? cols[emailIdx] : null,
        phone: phoneIdx > -1 ? cols[phoneIdx] : null,
        notes: notesIdx > -1 ? cols[notesIdx] : null,
        added_via: "bulk",
      });
    }

    if (!rows.length) return res.status(400).json({ error: "No valid rows found.", errors });

    const { data, error } = await supabaseAdmin.from("clients").insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ added: data.length, errors, clients: data });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
