require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const clipRoute = require("./routes/clip");
const captionRoute = require("./routes/caption");
const scriptRoute = require("./routes/script");
const viralityRoute = require("./routes/virality");
const voiceRoute = require("./routes/voice");
const titleRoute = require("./routes/title");
const hookRoute = require("./routes/hook");
const faketextRoute = require("./routes/faketext");
const billingRoute = require("./routes/billing");
const { stripeWebhookHandler } = require("./routes/billing");

const app = express();
const PORT = process.env.PORT || 8787;

// Ensure upload/output directories exist
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "outputs"), { recursive: true });

app.use(cors({ origin: true }));

// Log every request — without this, Render's Logs tab stays silent even
// while requests are being processed, making it impossible to tell where
// a slow request (like Faceless Studio) is stuck.
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.path}`);
  res.on("finish", () => {
    console.log(`<-- ${req.method} ${req.path} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Stripe webhook needs the RAW body — must be mounted BEFORE express.json()
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

// Everything else uses normal JSON body parsing
app.use(express.json());

// Serve rendered output files (clips, captioned videos, faceless videos)
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

// Health check — useful for Render to confirm the service is alive
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "leauai-server" });
});
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Tool routes
app.use("/api/clip", clipRoute);
app.use("/api/caption", captionRoute);
app.use("/api/script", scriptRoute);
app.use("/api/virality", viralityRoute);
app.use("/api/voice", voiceRoute);
app.use("/api/title", titleRoute);
app.use("/api/hook", hookRoute);
app.use("/api/faketext", faketextRoute);
app.use("/api/billing", billingRoute);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler (catches anything that slips past try/catch in routes)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`leauai-server listening on port ${PORT}`);
});
