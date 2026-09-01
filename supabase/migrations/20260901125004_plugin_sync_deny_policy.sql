begin;

-- Credentials are managed exclusively through audited security-definer RPCs.
-- The explicit deny policy documents that no signed-in or anonymous client may
-- read token hashes or mutate connection rows through the Data API.
create policy "No direct plugin connection access"
on "project_agent_eta_v2".plugin_sync_connections
for all to anon, authenticated
using (false)
with check (false);

commit;
