// Backend-only Supabase client using the SERVICE ROLE key.
// NEVER expose this key or this client to the frontend — it bypasses RLS.
const { createClient } = require("@supabase/supabase-js");

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "[supabaseAdmin] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — " +
    "auth, credits, and billing routes will fail until you add them."
  );
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key",
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = supabaseAdmin;
