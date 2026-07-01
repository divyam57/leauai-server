// Real Stripe integration. Requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
// and three Price IDs (one per plan) in your .env file.
//
// POST /api/billing/create-checkout-session   (auth required)
//   body: { plan: "starter" | "creator" | "studio" }
//   returns: { url } — redirect the browser to this Stripe Checkout URL
//
// POST /api/billing/webhook   (Stripe calls this directly, NOT the frontend)

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const supabaseAdmin = require("../lib/supabaseAdmin");

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
}

const PLAN_PRICE_IDS = {
  starter: process.env.STRIPE_PRICE_STARTER,
  creator: process.env.STRIPE_PRICE_CREATOR,
  studio: process.env.STRIPE_PRICE_STUDIO,
};

const PLAN_CREDITS = { starter: 120, creator: 320, studio: 900 };

router.post("/create-checkout-session", requireAuth, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(501).json({ error: "Billing needs STRIPE_SECRET_KEY set in your .env file." });
    }
    const { plan } = req.body;
    const priceId = PLAN_PRICE_IDS[plan];
    if (!priceId) {
      return res.status(400).json({ error: "Unknown plan. Use starter, creator, or studio." });
    }

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, email")
      .eq("id", req.user.id)
      .single();

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { supabase_user_id: req.user.id },
      });
      customerId = customer.id;
      await supabaseAdmin.from("profiles").update({ stripe_customer_id: customerId }).eq("id", req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || "http://localhost:5500"}/dashboard.html?checkout=success`,
      cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5500"}/index.html?checkout=cancelled`,
      metadata: { supabase_user_id: req.user.id, plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function stripeWebhookHandler(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(501).send("Stripe webhook not configured.");
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.supabase_user_id;
      const plan = session.metadata?.plan;
      if (userId && plan) {
        await supabaseAdmin
          .from("profiles")
          .update({
            plan,
            subscription_status: "active",
            stripe_subscription_id: session.subscription,
          })
          .eq("id", userId);

        await supabaseAdmin
          .from("credits")
          .update({
            balance: PLAN_CREDITS[plan] || 50,
            monthly_allotment: PLAN_CREDITS[plan] || 50,
            renews_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          })
          .eq("user_id", userId);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await supabaseAdmin
        .from("profiles")
        .update({ subscription_status: "cancelled" })
        .eq("stripe_subscription_id", sub.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    res.status(500).send("Webhook handler error");
  }
}

module.exports = router;
module.exports.stripeWebhookHandler = stripeWebhookHandler;
