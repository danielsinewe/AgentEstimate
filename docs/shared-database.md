# Shared database contract

Production, preview, and development deployments use the Supabase project
`qrdgyonmrznmrauyiesn` (Daniel Sinewe).

Agent ETA owns the `project_agent_eta_v2` schema. Application data must stay in
that schema; new database clients and migrations must not use the shared
`public` schema for Agent ETA tables.

The source project `renieqntejqzimbspiku` is retired and must not be restored as
an application dependency.
