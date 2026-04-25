# Local auth setup (Phase 1)

This is what you need to run to test the new login flow on your machine
**before** anything is deployed to Vercel.

## 1. Prerequisites

Docker must be installed and running — the CLI boots Postgres + Auth in
containers. On Ubuntu:

```bash
sudo apt install docker.io docker-compose-v2
sudo usermod -aG docker $USER     # log out / back in so docker works without sudo
docker ps                         # should succeed with no output and no error
```

## 2. Install project dependencies

The Supabase CLI is installed as a **dev dependency** (a recent change by
Supabase — global `npm install -g supabase` is no longer supported).

```bash
npm install
```

This installs `@supabase/supabase-js` (the browser client) AND `supabase`
(the CLI) into `node_modules`. Use `npx supabase …` to invoke the CLI, or
the npm scripts below.

Verify:

```bash
npx supabase --version
```

## 3. Start the local Supabase stack

From the repo root:

```bash
npm run db:start        # equivalent to: npx supabase start
```

First run will pull Docker images (a few minutes). Subsequent starts are
~5 seconds. When it's ready you'll see output like:

```
         API URL: http://localhost:54321
     GraphQL URL: http://localhost:54321/graphql/v1
          DB URL: postgresql://postgres:postgres@localhost:54322/postgres
      Studio URL: http://localhost:54323
    Inbucket URL: http://localhost:54324   <- magic-link emails land here
      JWT secret: super-secret-jwt-token-with-at-least-32-characters-long
        anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

The **migration in `supabase/migrations/`** runs automatically — the schema
and the seed invite for `paritoshvyas1@gmail.com` are in place.

## 4. Configure the webapp

Copy `.env.example` → `.env` (if you don't already have one) and set:

```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<paste the "anon key" from step 3>
```

Keep your existing `VITE_SARVAM_API_KEY` / `VITE_GROQ_API_KEY` / etc. lines —
auth doesn't change the AI pipeline in Phase 1.

## 5. Run the webapp

```bash
npm run dev
```

Open `http://localhost:5173`.

You should see the **login page** (not the translator). That confirms the
AuthGate is working.

## 6. Test magic-link sign-in

1. Type your invited email (`paritoshvyas1@gmail.com` per the seed).
2. Click **Email me a login link**.
3. Open `http://localhost:54324` (Inbucket) in another tab.
4. Click the top message → click the login link inside.
5. You land back on `localhost:5173`, now logged in; the translator appears
   and a **"signed in as …"** badge is in the top-right corner.

## 7. Test the invite-only gate

1. Click **Sign out** (top-right).
2. Try magic-link with a **different** email.
3. Inbucket will still show the email, but clicking the link gives
   `Email <x> is not invited…`. The signup rolls back in the DB.

## 8. Add more invites

In Supabase Studio (`http://localhost:54323`):

- Sidebar → **Table Editor** → `invitations` → **Insert row**.
- `email`, `org_id` (= `00000000-0000-0000-0000-000000000001` for the seed
  org), `role` (`agent` or `admin`).

Or via SQL in the SQL Editor:

```sql
insert into invitations (email, org_id, role)
values ('newuser@company.com', '00000000-0000-0000-0000-000000000001', 'agent');
```

## 9. Testing OAuth locally (optional for Phase 1)

Google / Microsoft / GitHub OAuth each need a **client ID + secret** and
redirect URIs pointing at `http://localhost:54321/auth/v1/callback`. For
Phase 1, magic-link is enough — skip OAuth until you're wiring the prod
Supabase project (which has its own redirect URIs and providers).

## 10. When you're done locally

```bash
npm run db:stop         # equivalent to: npx supabase stop
```

Handy scripts:

| npm script        | does                                 |
|-------------------|--------------------------------------|
| `npm run db:start`  | start local Postgres + Auth         |
| `npm run db:stop`   | stop containers                      |
| `npm run db:reset`  | wipe local DB and re-run migrations  |
| `npm run db:studio` | print Studio / Inbucket URLs + keys  |

## Going to prod later

1. Create a hosted Supabase project (free tier is fine to start).
2. Link it: `npx supabase link --project-ref <ref>`.
3. Push the schema: `npx supabase db push`.
4. Add the hosted Supabase URL + anon key as **`VITE_SUPABASE_URL`** and
   **`VITE_SUPABASE_ANON_KEY`** in Vercel's env settings.
5. Redeploy.

---

## Phase 2 — API auth + usage logging (now wired)

All `/api/*` serverless functions now require a Supabase JWT. Every
successful upstream AI call (Sarvam / Groq / ElevenLabs / OpenAI) writes
a `usage_events` row attributed to the signed-in user's org.

### Additional env vars needed

The serverless functions need **server-side** Supabase credentials in
addition to the browser-side ones. Add these to `.env` (local) and
Vercel env settings (prod):

```env
# Server-only — never prefix with VITE_
SUPABASE_URL=http://localhost:54321                 # local
SUPABASE_SERVICE_ROLE_KEY=<"service_role key" from `npm run db:start`>
```

For Vercel, replace the local URL with your hosted project URL:

```bash
vercel env add SUPABASE_URL               production
vercel env add SUPABASE_SERVICE_ROLE_KEY  production
```

### How to run locally with auth fully on

1. Dev mode (`npm run dev`) still uses Vite proxies `/sarvam`, `/groq`,
   `/openai`, `/elevenlabs` — those **skip auth** (no usage tracking).
   This lets you iterate on UI/audio without logging in every time.
2. To test the auth flow end-to-end, use `vercel dev` instead.
   The Vercel CLI is installed as a dev dependency (don't try
   `npm install -g vercel` — same EACCES issue as supabase):

   ```bash
   npm install            # picks up vercel from package.json
   npm run dev:full       # equivalent to: npx vercel dev
   ```

   That runs the serverless `/api/*` functions locally. With
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set, every call is
   JWT-gated and writes a `usage_events` row.

   First run will prompt you to log in to Vercel (`npx vercel login`)
   and link the repo to a Vercel project.

### Verifying usage logging

After a few translations:

- Open Supabase Studio at `http://localhost:54323`
- Table Editor → `usage_events` → you should see one row per upstream
  AI call with `user_id`, `org_id`, `event_type`, `provider`, `chars`,
  `api_cost_cents`, etc.

### Admin dashboard

If your profile has `role='admin'`, click the **Admin** link in the
top-right badge. Shows last 30 days of usage: total events, estimated
cost, per-user breakdown, and the 100 most recent events.

### OAuth

Still optional for Phase 2. To enable Google / Microsoft / GitHub:

1. Create OAuth credentials in the provider's console; set callback to
   `http://localhost:54321/auth/v1/callback` (local) and your hosted
   Supabase URL for prod.
2. In `supabase/config.toml`, flip `enabled = true` under
   `[auth.external.google]` (etc.) and add `client_id` + `secret`.
3. Restart `npm run db:start`.

Magic-link is enough for pilots.
