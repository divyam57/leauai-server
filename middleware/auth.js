// Verifies the Supabase access token sent by the frontend in the
// Authorization: Bearer <token> header.
//
// Supabase now signs tokens with rotating asymmetric keys (ECC/RSA) by
// default, published at:
//   <SUPABASE_URL>/auth/v1/.well-known/jwks.json
// We verify against that JWKS endpoint instead of a static HS256 secret,
// so this keeps working even if the project rotates its signing keys.
//
// Falls back to the legacy HS256 shared secret (SUPABASE_JWT_SECRET) if
// that's still what your project uses — set it in .env and it'll be tried
// automatically for tokens whose header doesn't specify an asymmetric alg.
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

let jwks = null;
function getJwks() {
  if (!jwks && process.env.SUPABASE_URL) {
    jwks = jwksClient({
      jwksUri: `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes
      rateLimit: true,
    });
  }
  return jwks;
}

function getSigningKey(kid) {
  return new Promise((resolve, reject) => {
    const client = getJwks();
    if (!client) return reject(new Error("SUPABASE_URL not configured."));
    client.getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

async function verifyToken(token) {
  const decodedHeader = jwt.decode(token, { complete: true });
  if (!decodedHeader) throw new Error("Malformed token.");

  const alg = decodedHeader.header.alg;

  // Modern Supabase projects: asymmetric keys (ES256/RS256), verified via JWKS.
  if (alg === "ES256" || alg === "RS256") {
    const publicKey = await getSigningKey(decodedHeader.header.kid);
    return jwt.verify(token, publicKey, { algorithms: [alg] });
  }

  // Legacy Supabase projects: shared HS256 secret.
  if (alg === "HS256") {
    if (!process.env.SUPABASE_JWT_SECRET) {
      throw new Error("SUPABASE_JWT_SECRET is not set (required for HS256 tokens).");
    }
    return jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ["HS256"] });
  }

  throw new Error(`Unsupported token algorithm: ${alg}`);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header. Log in and retry." });
  }

  try {
    const payload = await verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    console.error("Auth verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired session. Log in again." });
  }
}

module.exports = { requireAuth };
