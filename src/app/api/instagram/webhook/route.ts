import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveConversationByInstagram } from '@/lib/instagram/resolve-conversation';
import { decrypt } from '@/lib/whatsapp/encryption';

export const maxDuration = 60;

type WebhookBody = {
  object?: string;
  entry?: Array<{
    messaging?: Array<{
      message?: { text?: string; mid?: string };
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

      if (!message.text) continue; // Only handling text for now

      // Find the IG config by instagram_account_id (or page_id as fallback)
      const { data: configRowsData, error: configError } = await supabaseAdmin()
        .from('instagram_configs')
        .select('*')
        .or(`instagram_account_id.eq.${pageId},page_id.eq.${pageId}`);

      if (configError || !configRowsData || configRowsData.length === 0) {
        console.error('No IG config found for recipient ID:', pageId);
        
        // DEBUG: If no config matches, let's insert a debug message into the FIRST available IG config 
        // so the user can see what recipient.id Meta actually sent!
        const { data: anyConfig } = await supabaseAdmin().from('instagram_configs').select('*').limit(1).maybeSingle();
        if (anyConfig) {
          const { conversationId } = await resolveConversationByInstagram(supabaseAdmin(), anyConfig.account_id, senderId, `DEBUG_${senderId}`);
          await (supabaseAdmin() as any).from('messages').insert({
            conversation_id: conversationId,
            sender_type: 'customer',
            content_type: 'text',
            content_text: `DEBUG: Config not found for recipient ${pageId}. Payload object: ${body.object}`,
            message_id: message.mid || `debug_${Date.now()}`,
            status: 'delivered',
            created_at: new Date().toISOString(),
          });
          await (supabaseAdmin() as any).from('conversations').update({ last_message_text: `DEBUG: ${pageId}`, last_message_at: new Date().toISOString() }).eq('id', conversationId);
        }
        continue;
      }

      const configRows = configRowsData as { account_id: string }[];
      const config = configRows[0];

      // Resolve contact and conversation
      const { conversationId, contactId } = await resolveConversationByInstagram(
        supabaseAdmin(),
        config.account_id,
        senderId,
        `IG_${senderId}`
      );

      // Insert message
      const { error: msgError } = await (supabaseAdmin() as any)
        .from('messages')
        .insert({
          conversation_id: conversationId,
          sender_type: 'customer',
          content_type: 'text',
          content_text: message.text,
          message_id: message.mid,
          status: 'delivered',
          created_at: new Date(event.timestamp || Date.now()).toISOString(),
        });

      if (msgError) {
        console.error('Error inserting IG message:', msgError);
        continue;
      }

      // Update conversation
      await (supabaseAdmin() as any)
        .from('conversations')
        .update({
          last_message_text: message.text,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversationId);
    }
  }
}
