import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveConversationByInstagram } from '@/lib/instagram/resolve-conversation';
import { decrypt } from '@/lib/whatsapp/encryption';

export const maxDuration = 60;

type IgAttachment = {
  type: string; // 'image' | 'video' | 'audio' | 'file' | 'share' | 'story_mention' etc.
  payload?: { url?: string };
};

type WebhookBody = {
  object?: string;
  entry?: Array<{
    messaging?: Array<{
      message?: {
        text?: string;
        mid?: string;
        attachments?: IgAttachment[];
      };
      sender?: { id: string };
      recipient?: { id: string };
      timestamp?: number;
    }>;
  }>;
};

let _adminClient: ReturnType<typeof createClient> | null = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 });
    }

    const { data: configsData, error: configError } = await supabaseAdmin()
      .from('instagram_configs')
      .select('id, verify_token');

    if (configError || !configsData) {
      console.error('Error fetching IG configs for verification:', configError);
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
    }

    const configs = configsData as { id: string; verify_token: string | null }[];

    let matched = false;
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        const decryptedToken = decrypt(config.verify_token);
        if (decryptedToken === verifyToken) {
          matched = true;
          break;
        }
      } catch (err) {
        console.error(`Failed to decrypt verify_token for config ${config.id}`, err);
      }
    }

    if (matched || verifyToken === process.env.INSTAGRAM_VERIFY_TOKEN) {
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 });
  } catch (error) {
    console.error('Error in IG webhook GET verification:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  const rawBody = await request.text();
  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    await processWebhook(body);
  } catch (error) {
    console.error('Error processing IG webhook:', error);
  }

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(body: WebhookBody) {
  if (body.object !== 'instagram' || !body.entry) return;

  for (const entry of body.entry) {
    if (!entry.messaging) continue;

    for (const event of entry.messaging) {
      if (!event.message || !event.sender || !event.recipient) continue;

      const senderId = event.sender.id;
      const pageId = event.recipient.id;
      const message = event.message;

      // Determine content type and extract media URL if present
      const attachment = message.attachments?.[0];
      let contentType = 'text';
      let contentText = message.text || null;
      let mediaUrl: string | null = null;

      if (attachment) {
        const attType = attachment.type;
        // Map Instagram attachment types to our internal types
        if (attType === 'image' || attType === 'video' || attType === 'audio' || attType === 'file') {
          contentType = attType === 'file' ? 'document' : attType;
          mediaUrl = attachment.payload?.url || null;
        } else if (attType === 'share' || attType === 'story_mention') {
          // Shares and story mentions - treat as text with a note
          contentType = 'text';
          contentText = contentText || `[${attType === 'share' ? 'Shared post' : 'Story mention'}]`;
        } else {
          contentType = 'text';
          contentText = contentText || `[Unsupported attachment: ${attType}]`;
        }
      }

      // Skip if there's no text AND no media
      if (!contentText && !mediaUrl) continue;

      // Find the IG config by instagram_account_id (or page_id as fallback)
      const { data: configRowsData, error: configError } = await supabaseAdmin()
        .from('instagram_configs')
        .select('*')
        .or(`instagram_account_id.eq.${pageId},page_id.eq.${pageId}`);

      if (configError || !configRowsData || configRowsData.length === 0) {
        console.error(`[IG Webhook] No config found for recipient ID: ${pageId}. Make sure this ID is saved as the "Cuenta de Instagram (ID numérico)" in your settings.`);
        continue;
      }

      const configRows = configRowsData as { account_id: string; access_token: string }[];
      const config = configRows[0];

      // Fetch the sender's real Instagram profile name
      let senderName = `IG_${senderId}`;
      try {
        const decryptedToken = decrypt(config.access_token);
        console.log(`[IG Webhook] Fetching profile for sender ${senderId} (token prefix: ${decryptedToken.substring(0, 4)}...)`);
        
        const { getInstagramUserProfile } = await import('@/lib/instagram/meta-api');
        const profile = await getInstagramUserProfile({
          igScopedId: senderId,
          accessToken: decryptedToken,
        });
        
        console.log(`[IG Webhook] Profile result for ${senderId}: name="${profile.name}", username="${profile.username}"`);
        
        // Prefer username with @ for display, fall back to name
        if (profile.username) {
          senderName = profile.username;
        } else if (profile.name && !profile.name.startsWith('IG_')) {
          senderName = profile.name;
        }
      } catch (err) {
        console.error(`[IG Webhook] Failed to fetch sender profile for ${senderId}:`, err);
      }

      // Resolve contact and conversation
      const { conversationId, contactId } = await resolveConversationByInstagram(
        supabaseAdmin(),
        config.account_id,
        senderId,
        senderName
      );

      // Insert message
      const { error: msgError } = await (supabaseAdmin() as any)
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_type: 'customer',
          content_type: contentType,
          content_text: contentText,
          media_url: mediaUrl,
          message_id: message.mid,
          status: 'delivered',
          created_at: new Date(event.timestamp || Date.now()).toISOString(),
        });

      if (msgError) {
        console.error('Error inserting IG message:', msgError);
        continue;
      }

      // Update conversation
      const previewText = contentText || (mediaUrl ? `📎 ${contentType}` : '');
      await (supabaseAdmin() as any)
        .from('conversations')
        .update({
          last_message_text: previewText,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);
    }
  }
}
