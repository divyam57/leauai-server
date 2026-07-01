const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header. Log in and retry." });
  }
  if (!process.env.SUPABASE_JWT_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: SUPABASE_JWT_SECRET is not set." });
  }

  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ["HS256"] });
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session. Log in again." });
  }
}

module.exports = { requireAuth };
