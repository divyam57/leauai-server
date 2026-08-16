require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const clientsRoute = require("./routes/clients");
const proposalsRoute = require("./routes/proposals");
const profileRoute = require("./routes/profile");
const dashboardRoute = require("./routes/dashboard");

const app = express();
const PORT = process.env.PORT || 8787;

// Ensure upload/output directories exist
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "outputs"), { recursive: true });

app.use(cors({ origin: true }));

// Log every request — helps debugging via Render's Logs tab
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`--> ${req.method} ${req.path}`);
  res.on("finish", () => {
    console.log(`<-- ${req.method} ${req.path} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(express.json());

// Serve uploaded logos etc.
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

// Health check — useful for Render to confirm the service is alive
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "roxbow-server" });
});
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Routes
app.use("/api/clients", clientsRoute);
app.use("/api/proposals", proposalsRoute);
app.use("/api/profile", profileRoute);
app.use("/api/dashboard", dashboardRoute);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`roxbow-server listening on port ${PORT}`);
});
