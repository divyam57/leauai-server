// Dashboard — /api/dashboard
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const supabaseAdmin = require("../lib/supabaseAdmin");

const router = express.Router();

router.get("/stats", requireAuth, async (req, res) => {
  const userId = req.user.id;

  const [{ data: proposals }, { data: clients }] = await Promise.all([
    supabaseAdmin.from("proposals").select("id, status, budget, created_at, clients(name)").eq("user_id", userId),
    supabaseAdmin.from("clients").select("id").eq("user_id", userId),
  ]);

  const list = proposals || [];
  const total = list.length;
  const accepted = list.filter((p) => p.status === "accepted").length;
  const pending = list.filter((p) => p.status === "sent").length;

  const now = new Date();
  const thisMonthValue = list
    .filter((p) => {
      const d = new Date(p.created_at);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && p.status === "accepted";
    })
    .reduce((sum, p) => sum + (parseFloat(String(p.budget).replace(/[^0-9.]/g, "")) || 0), 0);

  const recent = [...list]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5)
    .map((p) => ({ id: p.id, clientName: p.clients ? p.clients.name : "Unknown", status: p.status, budget: p.budget, created_at: p.created_at }));

  res.json({
    totalProposals: total,
    accepted,
    pending,
    thisMonthValue,
    totalClients: (clients || []).length,
    recentProposals: recent,
  });
});

module.exports = router;
