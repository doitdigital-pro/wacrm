import { NextResponse } from 'next/server';
import { resolveConversation } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import { withAuth, ApiContext } from '@/lib/api/with-auth';
import { sendInstagramMessageToConversation } from '@/lib/instagram/send-message';
import { SendInstagramMessageError } from '@/lib/instagram/resolve-conversation';

const SUPPORTED_TYPES = ['text', 'template', 'image', 'document', 'audio', 'video', 'interactive'];

export const maxDuration = 60;

/**
 * POST /api/v1/messages
 * Send a message to a WhatsApp number. Resolves or creates a conversation automatically.
 */
async function sendMessageHandler(request: Request, ctx: ApiContext) {
  try {
    const body = await request.json();

    const {
      to,
      type = 'text',
      channel = 'whatsapp',
    } = body;

    if (!to || typeof to !== 'string') {
      return errorResp('Missing or invalid "to" (phone number)', 400);
    }
    if (!SUPPORTED_TYPES.includes(type)) {
      return errorResp(`Unsupported "type". Must be one of: ${SUPPORTED_TYPES.join(', ')}`, 400);
    }

    if (type === 'text' && (!body.text || typeof body.text !== 'string')) {
      return errorResp('Missing or invalid "text" for text message', 400);
    }

    const interactivePayload = type === 'interactive' ? body.interactive : null;
    
    let result;
    if (channel === 'instagram') {
      // Instagram route (uses a simplified resolver for now)
      // We assume `to` is the IGSID (Instagram Scoped ID)
      const { resolveConversationByInstagram } = await import('@/lib/instagram/resolve-conversation');
      
      const resolved = await resolveConversationByInstagram(
        ctx.supabase,
        ctx.accountId,
        to,
        typeof body.name === 'string' ? body.name : null
      );
      result = await sendInstagramMessageToConversation(
        ctx.supabase,
        ctx.accountId,
        {
          conversationId: resolved.conversationId,
          messageType: type,
          contentText: typeof body.text === 'string' ? body.text : null,
          mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
          filename: typeof body.filename === 'string' ? body.filename : null,
          interactivePayload,
          replyToMessageId:
            typeof body.reply_to_message_id === 'string'
              ? body.reply_to_message_id
              : null,
        }
      );
      
      return ok(
        {
          message_id: result.messageId,
          instagram_message_id: result.instagramMessageId,
          conversation_id: resolved.conversationId,
          status: 'sent',
        },
        201
      );
    } else {
      // WhatsApp route
      const resolved = await resolveConversation(
        ctx.supabase,
        ctx.accountId,
        to,
        typeof body.name === 'string' ? body.name : null
      );
      result = await sendMessageToConversation(ctx.supabase, ctx.accountId, {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName:
          typeof body.template_name === 'string' ? body.template_name : null,
        templateLanguage:
          typeof body.template_language === 'string'
            ? body.template_language
            : null,
        templateParams: Array.isArray(body.template_params)
          ? body.template_params
          : null,
        templateMessageParams: Array.isArray(body.template_message_params)
          ? body.template_message_params
          : null,
        interactivePayload,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      });

      return ok(
        {
          message_id: result.messageId,
          meta_message_id: result.metaMessageId,
          conversation_id: resolved.conversationId,
          status: 'sent',
        },
        201
      );
    }
  } catch (err: any) {
    if (err instanceof SendMessageError || err instanceof SendInstagramMessageError) {
      return errorResp(err.message, err.status, err.code);
    }
    console.error('[API] /v1/messages POST error:', err);
    return errorResp('Internal server error', 500);
  }
}

export const POST = withAuth(sendMessageHandler);

function ok(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

function errorResp(message: string, status: number, code?: string) {
  const body: any = { error: { message } };
  if (code) body.error.code = code;
  return NextResponse.json(body, { status });
}
