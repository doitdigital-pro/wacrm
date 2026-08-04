import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  SendMessageError,
  sendMessageToConversation,
  validateSendMessageParams,
} from '@/lib/whatsapp/send-message'
import { sendInstagramMessageToConversation } from '@/lib/instagram/send-message'
import { SendInstagramMessageError } from '@/lib/instagram/resolve-conversation'

const maxDuration = 60

/**
 * Validates the API key attached to the request. Returns the account ID if valid.
 */
async function validateApiKey(
  request: Request,
  supabase: ReturnType<typeof createClient>
): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.split(' ')[1]

  const { data: key, error } = await supabase
    .from('api_keys')
    .select('account_id, is_active')
    .eq('token', token)
    .single()

  if (error || !key?.is_active) return null
  return key.account_id
}

/**
 * Send a message via API (Dashboard or programmatic).
 */
export async function POST(request: Request) {
  // Use service role to bypass RLS since we authenticate via API key
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const accountId = await validateApiKey(request, supabase)
  if (!accountId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const {
      // Core fields: callers must provide (conversation_id) OR (contact_id + message_type)
      // If contact_id is provided, we find an existing conversation or create one. This is
      // used when a user clicks "Send message" from a Contact detail view where there isn't one
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
      channel = 'whatsapp',
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError || err instanceof SendInstagramMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null
    let resolvedChannel: string = channel

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id, channel')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversationId = data.id
      resolvedChannel = data.channel
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .single()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      // Check if a conversation exists on the requested channel.
      const { data: existingConvs, error: existErr } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contact_id)
        .eq('channel', channel)
        .order('updated_at', { ascending: false })
        .limit(1)

      let resolved: string | null = null
      if (!existErr && existingConvs && existingConvs.length > 0) {
        resolved = existingConvs[0].id
      }
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      let result;
      if (resolvedChannel === 'instagram') {
        result = await sendInstagramMessageToConversation(supabase, accountId, {
          conversationId,
          messageType: message_type,
          contentText: content_text,
          mediaUrl: media_url,
          filename,
          interactivePayload: interactive_payload,
          replyToMessageId: reply_to_message_id,
        })
        return NextResponse.json({
          success: true,
          message_id: result.messageId,
          instagram_message_id: result.instagramMessageId,
        })
      } else {
        result = await sendMessageToConversation(supabase, accountId, {
          conversationId,
          messageType: message_type,
          contentText: content_text,
          mediaUrl: media_url,
          filename,
          templateName: template_name,
          templateLanguage: template_language,
          templateParams: template_params,
          templateMessageParams: template_message_params,
          interactivePayload: interactive_payload,
          replyToMessageId: reply_to_message_id,
        })
        return NextResponse.json({
          success: true,
          message_id: result.messageId,
          meta_message_id: result.metaMessageId,
        })
      }
    } catch (err) {
      if (err instanceof SendMessageError || err instanceof SendInstagramMessageError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in send message API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
