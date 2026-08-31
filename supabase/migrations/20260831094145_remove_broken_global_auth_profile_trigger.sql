
    drop trigger if exists create_app_profile_after_auth_user_insert on auth.users;
    drop function if exists public.create_app_profile_for_new_user();
  ;
