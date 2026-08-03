import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingInstagramContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';

// We can reuse SendMessageError from whatsapp for now or create a generic one.
// Let's create an Instagram-specific one to maintain separation.
export class SendInstagramMessageError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 500
  ) {
    super(message);
    this.name = 'SendInstagramMessageError';
  }
}

export interface ResolvedConversation {
  conversationId: string;
  contactId: string;
  contactCreated: boolean;
}

export async function resolveConversationByInstagram(
  db: SupabaseClient,
  accountId: string,
  instagramUserId: string,
  name?: string | null
): Promise<ResolvedConversation> {
  if (!instagramUserId) {
    throw new SendInstagramMessageError(
      'bad_request',
      "'instagramUserId' is required",
      400
    );
  }

  // Check if instagram is configured
  const { data: config } = await db
    .from('instagram_configs')
    .select('id')
    .eq('account_id', accountId)
    .maybeSingle();
    
  if (!config) {
    throw new SendInstagramMessageError(
      'instagram_not_configured',
      'Instagram not configured. Please set up your Instagram integration first.',
      400
    );
  }

  let ownerUserId: string;
  try {
    ownerUserId = await resolveAuditUserId(db, accountId);
  } catch (err) {
    if (err instanceof ContactError) {
      throw new SendInstagramMessageError('db_error', err.message, err.status);
    }
    throw err;
  }

  let contactId: string;
  let contactCreated = false;

  const existing = await findExistingInstagramContact(db, accountId, instagramUserId);
  if (existing) {
    contactId = existing.id;
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
  } else {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        instagram_user_id: instagramUserId,
        name: name || `IG_${instagramUserId}`,
      })
      .select('id')
      .single();

    if (createErr || !created) {
      if (isUniqueViolation(createErr)) {
        const raced = await findExistingInstagramContact(db, accountId, instagramUserId);
        if (raced) {
          contactId = raced.id;
        } else {
          throw new SendInstagramMessageError('db_error', 'Failed to create contact', 500);
        }
      } else {
        console.error('[resolve-conversation-ig] contact create error:', createErr);
        throw new SendInstagramMessageError('db_error', 'Failed to create contact', 500);
      }
    } else {
      contactId = created.id;
      contactCreated = true;
    }
  }

  const conversationId = await findOrCreateConversationRow(
    db,
    accountId,
    contactId,
    ownerUserId
  );

  return { conversationId, contactId, contactCreated };
}

async function findOrCreateConversationRow(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  ownerUserId: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel', 'instagram')
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) {
    console.error('[resolve-conversation-ig] conversation lookup error:', findErr);
    throw new SendInstagramMessageError('db_error', 'Failed to resolve conversation', 500);
  }

  if (existing && existing.length > 0) {
    return existing[0].id;
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel: 'instagram'
    })
    .select('id')
    .single();

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('channel', 'instagram')
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return raced[0].id;
      }
    }
    console.error('[resolve-conversation-ig] conversation create error:', convErr);
    throw new SendInstagramMessageError('db_error', 'Failed to create conversation', 500);
  }

  return newConv.id;
}
