-- ============================================================
-- 038_instagram_app_credentials
--
-- Adds app_id and app_secret to instagram_configs so the
-- configuration matches Meta's recommended OAuth flow:
--   1. Enter App ID + App Secret (identifies your Meta app)
--   2. Generate or paste an access token per IG account
--   3. Store the instagram_account_id for routing
-- ============================================================

ALTER TABLE instagram_configs
  ADD COLUMN IF NOT EXISTS app_id TEXT,
  ADD COLUMN IF NOT EXISTS app_secret TEXT,
  ADD COLUMN IF NOT EXISTS instagram_account_id TEXT;

-- app_id + app_secret together identify the Meta app.
-- access_token is now the long-lived token generated via the
-- "Generate token" flow in Meta's dashboard (was already there).
-- instagram_account_id is the IG Business/Creator account ID
-- (distinct from the Facebook Page ID) used to route webhooks.

COMMENT ON COLUMN instagram_configs.app_id IS 'Meta App ID (Identificador de la app de Instagram)';
COMMENT ON COLUMN instagram_configs.app_secret IS 'Meta App Secret encrypted (Clave secreta de la app)';
COMMENT ON COLUMN instagram_configs.instagram_account_id IS 'Instagram Business/Creator account ID for webhook routing';
