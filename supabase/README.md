# Agent ETA Supabase foundation

The migration keeps the estimator useful without an account and makes cloud features explicitly opt-in:

- `private_runs` stores only derived run fields for the signed-in owner.
- `user_sync_settings` records cloud-sync and benchmark-consent state. Enabling sync does not import existing local history.
- `benchmark_contributions` is filled through `contribute_private_run`; anonymous users cannot read it. Server-stamped consent and immutable run-origin fields enforce future-only contribution, and explicit history imports are never eligible.
- `public_metric_snapshots` is the only anonymously readable table. Its service-only refresh suppresses cohorts below 25 runs or 20 distinct contributors.

Raw prompts, repository names, filesystem paths, source code, and exact repository identifiers are intentionally absent from every table.

## Local validation

Use an up-to-date Supabase CLI, then run:

```sh
npx --yes supabase@latest start
npx --yes supabase@latest db reset
npx --yes supabase@latest db lint --local
```

GitHub auth is disabled in local config until credentials are supplied. Set `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET`, then enable the provider in `config.toml` for local OAuth testing. Configure the production callback URL in the Supabase dashboard; do not commit either secret.

The `delete-account` Edge Function hard-deletes only the authenticated caller. It verifies the bearer token again inside the function and requires the verified Auth user’s `last_sign_in_at` to be no more than 10 minutes old. Missing, malformed, future, or older timestamps fail closed with `reauth_required`; refreshing a token does not count as signing in again. The browser mirrors this preflight, but the Edge Function is authoritative. A user who misses the window must sign out and back in with GitHub before confirming deletion again.

The function keeps the service-role key server-side and accepts browser requests only from exact origins in `AGENT_ETA_ALLOWED_ORIGINS`. For local serving, supply a comma-separated allowlist without paths or trailing slashes, for example `http://localhost:5173,http://127.0.0.1:5173`.

## Deployment

Link the intended Supabase project and apply the migration through the normal migration path:

```sh
npx --yes supabase@latest link --project-ref YOUR_PROJECT_REF
npx --yes supabase@latest db push
npx --yes supabase@latest secrets set AGENT_ETA_ALLOWED_ORIGINS=https://YOUR_EXACT_APP_ORIGIN
npx --yes supabase@latest functions deploy delete-account
```

The web app uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Never place a service-role key in a `VITE_` variable. A trusted server or scheduled job should call `refresh_agent_eta_public_metrics`; the function is executable only by `service_role`.

Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to the deployed Edge Function. Neither value belongs in the browser environment. Enumerate every allowed production or preview origin explicitly; wildcards and missing `Origin` headers are rejected.

## Rollback

For an unreleased local database, apply `rollbacks/20260830080536_create_private_sync_and_benchmarks.down.sql` manually. It destroys all four tables and their data. Once deployed, prefer a reviewed forward migration that preserves user data.
