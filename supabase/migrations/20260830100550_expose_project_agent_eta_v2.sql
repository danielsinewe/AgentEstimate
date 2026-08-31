begin;
grant usage on schema project_agent_eta_v2 to anon, authenticated, service_role;
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, project_prospectli, project_footerfast_v2, project_agent_eta_v2';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
commit;;
