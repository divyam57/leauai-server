// Proposals — /api/proposals
const express = require("express");
const { requireAuth } = require("../middleware/auth");
const supabaseAdmin = require("../lib/supabaseAdmin");
const { askGemini, parseJsonReply } = require("../lib/gemini");

const router = express.Router();

// ---------- list all proposals ----------
router.get("/", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("proposals")
    .select("*, clients(name, company)")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ proposals: data });
});

// ---------- get one proposal ----------
router.get("/:id", requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("proposals")
    .select("*, clients(name, company, email)")
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: "Proposal not found." });
  res.json({ proposal: data });
});

// ---------- generate a new proposal with AI ----------
router.post("/generate", requireAuth, async (req, res) => {
  try {
    const { clientId, newClient, projectType, description, budget, timeline, services, tone, paymentTerms } = req.body;
    if (!description) return res.status(400).json({ error: "Provide a project `description`." });

    // Resolve the client — either use an existing one, or create a new one inline.
    let finalClientId = clientId || null;
    if (!finalClientId && newClient && newClient.name) {
      const { data: created, error: clientErr } = await supabaseAdmin
        .from("clients")
        .insert({ user_id: req.user.id, name: newClient.name, company: newClient.company, email: newClient.email, phone: newClient.phone, added_via: "manual" })
        .select()
        .single();
      if (clientErr) return res.status(500).json({ error: clientErr.message });
      finalClientId = created.id;
    }

    let clientName = "the client";
    if (finalClientId) {
      const { data: c } = await supabaseAdmin.from("clients").select("name, company").eq("id", finalClientId).single();
      if (c) clientName = c.company ? `${c.name} (${c.company})` : c.name;
    }

    const toneLabel = tone || "professional";
    const paymentLabel = { full_upfront: "full payment upfront", "50_50": "50% upfront, 50% on completion", milestone: "milestone-based payments" }[paymentTerms] || "full payment upfront";
    const servicesList = Array.isArray(services) && services.length ? services.join(", ") : "as described in the project scope";

    const prompt = `Write a complete, client-ready freelance/consulting proposal for ${clientName}.

Project type: ${projectType || "Not specified"}
Project description: ${description}
Budget: ${budget || "To be discussed"}
Timeline: ${timeline || "To be discussed"}
Services included: ${servicesList}
Tone: ${toneLabel}
Payment terms: ${paymentLabel}

Respond ONLY with JSON, no markdown fences, no preamble, in this exact shape:
{
  "title": "short proposal title",
  "greeting": "1-2 sentence opening greeting to the client",
  "overview": "2-3 sentence project overview/understanding of their needs",
  "scope": ["scope item 1", "scope item 2", "..."],
  "deliverables": ["deliverable 1", "deliverable 2", "..."],
  "timeline": "timeline breakdown as a short paragraph or phases",
  "pricing": "pricing summary paragraph including the payment terms",
  "whyMe": "2-3 sentences on why they should choose you, generic but persuasive",
  "closing": "1-2 sentence closing call-to-action"
}`;

    const text = await askGemini(prompt, 1200, true);
    let content;
    try {
      content = parseJsonReply(text);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON output.", raw: text });
    }

    const { data: proposal, error } = await supabaseAdmin
      .from("proposals")
      .insert({
        user_id: req.user.id,
        client_id: finalClientId,
        project_type: projectType,
        description,
        budget,
        timeline,
        services: services || [],
        tone: toneLabel,
        payment_terms: paymentTerms || "full_upfront",
        content,
        status: "draft",
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ proposal });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- regenerate (same inputs, fresh AI pass) ----------
router.post("/:id/regenerate", requireAuth, async (req, res) => {
  try {
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("proposals")
      .select("*, clients(name, company)")
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .single();
    if (fetchErr || !existing) return res.status(404).json({ error: "Proposal not found." });

    const clientName = existing.clients ? (existing.clients.company ? `${existing.clients.name} (${existing.clients.company})` : existing.clients.name) : "the client";
    const paymentLabel = { full_upfront: "full payment upfront", "50_50": "50% upfront, 50% on completion", milestone: "milestone-based payments" }[existing.payment_terms] || "full payment upfront";
    const servicesList = Array.isArray(existing.services) && existing.services.length ? existing.services.join(", ") : "as described in the project scope";

    const prompt = `Write a complete, client-ready freelance/consulting proposal for ${clientName}. Make it distinctly different in wording/structure from a typical generic version — fresh phrasing.

Project type: ${existing.project_type || "Not specified"}
Project description: ${existing.description}
Budget: ${existing.budget || "To be discussed"}
Timeline: ${existing.timeline || "To be discussed"}
Services included: ${servicesList}
Tone: ${existing.tone}
Payment terms: ${paymentLabel}

Respond ONLY with JSON, no markdown fences, no preamble, in this exact shape:
{"title": "...", "greeting": "...", "overview": "...", "scope": ["..."], "deliverables": ["..."], "timeline": "...", "pricing": "...", "whyMe": "...", "closing": "..."}`;

    const text = await askGemini(prompt, 1200, true);
    let content;
    try {
      content = parseJsonReply(text);
    } catch {
      return res.status(502).json({ error: "Model returned non-JSON output.", raw: text });
    }

    const { data: updated, error } = await supabaseAdmin
      .from("proposals")
      .update({ content, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    res.json({ proposal: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------- manually edit proposal content ----------
router.put("/:id", requireAuth, async (req, res) => {
  const { content, status } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (content) update.content = content;
  if (status) update.status = status;

  const { data, error } = await supabaseAdmin
    .from("proposals")
    .update(update)
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ proposal: data });
});

// ---------- delete a proposal ----------
router.delete("/:id", requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("proposals")
    .delete()
    .eq("id", req.params.id)
    .eq("user_id", req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------- public read via share link (no auth — client-facing) ----------
router.get("/shared/:token", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("proposals")
    .select("title:content->title, content, status, created_at, clients(name, company)")
    .eq("share_token", req.params.token)
    .single();
  if (error || !data) return res.status(404).json({ error: "Proposal not found." });
  res.json({ proposal: data });
});

module.exports = router;
