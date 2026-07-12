const supabaseAdmin = require("./supabaseAdmin");

const TOOL_COSTS = {
  auto_clip: 5,
  caption_composer: 3,
  script_lab: 2,
  script_rewrite: 2,
  virality_score: 1,
  voice_forge: 2,
  title_generator: 1,
  hook_rewriter: 1,
  faketext_video: 3,
  video_download: 2,
  image_generator: 2,
  watermark_remover: 2,
};

async function spendCredits(userId, tool) {
  const cost = TOOL_COSTS[tool] ?? 1;

  const { data: credit, error: fetchErr } = await supabaseAdmin
    .from("credits")
    .select("balance")
    .eq("user_id", userId)
    .single();

  if (fetchErr || !credit) {
    const err = new Error("Could not load your credit balance.");
    err.status = 500;
    throw err;
  }
  if (credit.balance < cost) {
    const err = new Error(`Not enough credits. This costs ${cost}, you have ${credit.balance}.`);
    err.status = 402;
    throw err;
  }

  const newBalance = credit.balance - cost;
  const { error: updateErr } = await supabaseAdmin
    .from("credits")
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (updateErr) {
    const err = new Error("Failed to deduct credits.");
    err.status = 500;
    throw err;
  }

  return { newBalance, cost };
}

async function logJob(userId, tool, status, input, output, creditsSpent) {
  await supabaseAdmin.from("jobs").insert({
    user_id: userId,
    tool,
    status,
    input: input || {},
    output: output || null,
    credits_spent: creditsSpent || 0,
  });
}

module.exports = { spendCredits, logJob, TOOL_COSTS };
