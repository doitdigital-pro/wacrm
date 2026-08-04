import type { SupabaseClient } from '@supabase/supabase-js';
import { sendTextMessage, sendMediaMessage } from '@/lib/instagram/meta-api';
import type { IgMediaKind } from '@/lib/instagram/meta-api';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { SendInstagramMessageError } from '@/lib/instagram/resolve-conversation';
import { InteractiveMessagePayload, interactivePayloadPreviewText } from '@/lib/whatsapp/interactive';
import { decrypt } from '@/lib/whatsapp/encryption';

const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document']);

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
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
  const { conversationId, messageType, contentText, mediaUrl, filename, interactivePayload, replyToMessageId } = params;

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

  const isMediaKind = MEDIA_TYPES.has(messageType);

  // Validate inputs
  if (messageType === 'text') {
    if (!contentText) {
      throw new SendInstagramMessageError('bad_request', 'content_text is required for text messages', 400);
    }
  } else if (isMediaKind) {
    if (!mediaUrl) {
      throw new SendInstagramMessageError('bad_request', 'media_url is required for media messages', 400);
    }
  } else {
    throw new SendInstagramMessageError('unsupported', `Message type "${messageType}" is not supported on Instagram. Supported: text, image, video, audio, document.`, 400);
  }

  let igMessageId = '';
  const decryptedToken = decrypt(config.access_token);

  try {
    if (messageType === 'text') {
      const result = await sendTextMessage({
        pageId: config.page_id,
        accessToken: decryptedToken,
        to: contact.instagram_user_id,
        text: contentText!,
      });
      igMessageId = result.messageId;
    } else if (isMediaKind) {
      // Map 'document' to 'file' for Instagram's API
      const igKind: IgMediaKind = messageType === 'document' ? 'file' : messageType as IgMediaKind;
      
      const result = await sendMediaMessage({
        pageId: config.page_id,
        accessToken: decryptedToken,
        to: contact.instagram_user_id,
        kind: igKind,
        link: mediaUrl!,
        caption: contentText || undefined,
      });
      igMessageId = result.messageId;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SendInstagramMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  // Build preview text for the conversation list
  const previewText = contentText || (isMediaKind ? `📎 ${messageType}` : '');

  // Persist the sent message.
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType,
      content_text: contentText || null,
      media_url: mediaUrl || null,
      filename: filename || null,
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
      last_message_text: previewText,
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
