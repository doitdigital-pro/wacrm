-- ============================================================
-- 037_add_instagram_support
--
-- This migration updates the schema to support Instagram as a channel:
-- 1. Makes contacts.phone nullable and adds instagram_user_id.
-- 2. Adds channel to conversations (default 'whatsapp').
-- 3. Updates the conversation unique constraint to include channel.
-- 4. Creates instagram_configs table.
-- ============================================================

-- 1. Contacts modifications
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_user_id TEXT;

-- Enforce that a contact must have either a phone or an instagram_user_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'contacts_identifier_check'
    ) THEN
        ALTER TABLE contacts ADD CONSTRAINT contacts_identifier_check CHECK (phone IS NOT NULL OR instagram_user_id IS NOT NULL);
    END IF;
END $$;

-- Unique index for instagram_user_id per account
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_instagram 
  ON contacts (account_id, instagram_user_id) 
  WHERE instagram_user_id IS NOT NULL;

-- 2. Conversations modifications
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'instagram'));

-- 3. Update unique constraint on conversations
-- Drop the old unique index (created in migration 036)
DROP INDEX IF EXISTS idx_conversations_account_contact;
-- Create new one that includes the channel
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel 
  ON conversations (account_id, contact_id, channel);

-- 4. Create instagram_configs table
CREATE TABLE IF NOT EXISTS instagram_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  verify_token TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure only one instagram config per account
CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_configs_account_id ON instagram_configs (account_id);

-- RLS for instagram_configs (mirrors whatsapp_config policies from 017_account_sharing.sql)
ALTER TABLE instagram_configs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS instagram_configs_select ON instagram_configs;
  DROP POLICY IF EXISTS instagram_configs_insert ON instagram_configs;
  DROP POLICY IF EXISTS instagram_configs_update ON instagram_configs;
  DROP POLICY IF EXISTS instagram_configs_delete ON instagram_configs;
END $$;

CREATE POLICY instagram_configs_select ON instagram_configs FOR SELECT USING (is_account_member(account_id));
CREATE POLICY instagram_configs_insert ON instagram_configs FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_configs_update ON instagram_configs FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_configs_delete ON instagram_configs FOR DELETE USING (is_account_member(account_id, 'admin'));

-- Trigger for updated_at
DROP TRIGGER IF EXISTS set_updated_at ON instagram_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
