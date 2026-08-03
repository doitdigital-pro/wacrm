import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTextMessage, sendAction } from '@/lib/instagram/meta-api';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { SendInstagramMessageError } from '@/lib/instagram/resolve-conversation';
import { InteractiveMessagePayload, interactivePayloadPreviewText } from '@/lib/whatsapp/interactive';

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  messageId: string;
  instagramMessageId: string;
}

export async function sendInstagramMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const { conversationId, messageType, contentText, interactivePayload, replyToMessageId } = params;

  if (!conversationId) {
    throw new SendInstagramMessageError('bad_request', 'conversation_id is required', 400);
  }

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendInstagramMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.instagram_user_id) {
    throw new SendInstagramMessageError('bad_request', 'Contact instagram ID not found', 400);
  }

  // Config
  const { data: config, error: configError } = await db
    .from('instagram_configs')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (configError || !config) {
    throw new SendInstagramMessageError(
      'instagram_not_configured',
      'Instagram not configured.',
      400
    );
  }

  // Instagram only supports text messages for now in our basic integration
  if (messageType !== 'text') {
    throw new SendInstagramMessageError('unsupported', 'Only text messages are supported on Instagram', 400);
  }
  if (!contentText) {
    throw new SendInstagramMessageError('bad_request', 'content_text is required', 400);
  }

  let igMessageId = '';
  try {
    const result = await sendTextMessage({
      pageId: config.page_id,
      accessToken: config.access_token,
      to: contact.instagram_user_id,
      text: contentText,
    });
    igMessageId = result.messageId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SendInstagramMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  // Persist the sent message.
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: contentText,
      message_id: igMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    throw new SendInstagramMessageError('db_error', `Failed to save to DB: ${msgError.message}`, 500);
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause active flow run if agent steps in
  try {
    await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
  } catch (err) {}

  return { messageId: messageRecord.id, instagramMessageId: igMessageId };
}
