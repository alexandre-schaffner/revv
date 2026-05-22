-- Drop the (provider, provider_user_id) unique index — (provider, login) is now the sole unique key.
DROP INDEX IF EXISTS "remote_users_provider_id_idx";
