# LEAUAI.PRO — render server

Node/Express backend for the LEAUAI.PRO tools, with Supabase auth, credit
deduction, and Stripe billing wired in.

## Setup (local)

```bash
npm install
cp .env.example .env
# fill in .env with your real keys
npm start
```

Server runs on `http://localhost:8787` by default.

## Deploying (Render)

1. Push this repo to GitHub.
2. On Render: New + → Web Service → Public Git Repository → paste repo URL.
3. Language: Docker, Branch: main, Instance Type: Free (or paid).
4. Add environment variables (see `.env.example` for the full list):
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`
   - `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `PEXELS_API_KEY`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_CREATOR`, `STRIPE_PRICE_STUDIO`
   - `FRONTEND_URL`, `PORT`
5. Deploy. Render will build the Dockerfile (installs ffmpeg + npm deps).
6. Visit `https://<your-service>.onrender.com/health` to confirm it's live.

## API reference

### POST /api/clip
```
form-data:
  video: <file>
  clips: '[{"start":"00:00:10","end":"00:00:25","label":"hook"}]'
```

### POST /api/caption
```
form-data:
  video: <file>
  segments: '[{"start":0,"end":2.5,"text":"this is the hook"}]'
  style: "default" | "bold" | "minimal"
```

### POST /api/script
```json
{ "topic": "why most people quit gym memberships in February", "tone": "punchy" }
```

### POST /api/virality
```json
{ "script": "the full script or just the hook line to score" }
```

### POST /api/voice
```json
{ "text": "Welcome back to the channel.", "voiceId": "optional ElevenLabs voice ID" }
```
Returns raw `audio/mpeg` bytes.

### POST /api/faceless
```json
{ "topic": "why most people quit gym memberships in February", "tone": "punchy" }
```

### POST /api/billing/create-checkout-session
```json
{ "plan": "starter" | "creator" | "studio" }
```

All routes except the health check and Stripe webhook require
`Authorization: Bearer <supabase_access_token>`.
