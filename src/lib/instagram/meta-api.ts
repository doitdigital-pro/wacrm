/**
 * Meta Instagram API helpers.
 */

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export interface MetaSendResult {
  messageId: string;
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string };
}

export interface PageInfo {
  name: string;
  id: string;
  username?: string;
}

export interface InstagramAccountInfo {
  id: string;
  name: string;
  username: string;
  profile_picture_url?: string;
  followers_count?: number;
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

export interface SendTextMessageArgs {
  /** The Facebook Page ID connected to the IG account (or IG account ID) */
  pageId: string;
  accessToken: string;
  /** The recipient's Instagram-scoped ID (IGSID) */
  to: string;
  text: string;
}

export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const { pageId, accessToken, to, text } = args;
  
  const isIgToken = accessToken.startsWith('IG');
  const baseUrl = isIgToken ? `https://graph.instagram.com/${META_API_VERSION}` : META_API_BASE;
  const endpoint = isIgToken ? 'me' : pageId;
  const url = `${baseUrl}/${endpoint}/messages`;
  
  const body = {
    recipient: { id: to },
    message: { text },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  
  const data = await response.json();
  return { messageId: data.message_id };
}

export type IgMediaKind = 'image' | 'video' | 'audio' | 'file';

export interface SendMediaMessageArgs {
  pageId: string;
  accessToken: string;
  to: string;
  kind: IgMediaKind;
  /** Public URL of the media file */
  link: string;
  /** Optional caption (not supported on audio) */
  caption?: string;
}

/**
 * Send a media message (image, video, audio, file/document) via Instagram.
 *
 * Instagram's messaging API uses an attachment-based payload:
 *   message.attachment.type = 'image' | 'video' | 'audio' | 'file'
 *   message.attachment.payload.url = <public URL>
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<MetaSendResult> {
  const { pageId, accessToken, to, kind, link, caption } = args;
  if (!link) throw new Error('sendMediaMessage requires a link.');

  const isIgToken = accessToken.startsWith('IG');
  const baseUrl = isIgToken ? `https://graph.instagram.com/${META_API_VERSION}` : META_API_BASE;
  const endpoint = isIgToken ? 'me' : pageId;
  const url = `${baseUrl}/${endpoint}/messages`;

  // Map our internal types to Instagram's attachment types
  const igType = kind === 'file' ? 'file' : kind;

  // Build the message payload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messagePayload: any = {
    attachment: {
      type: igType,
      payload: {
        url: link,
      },
    },
  };

  // If there's a caption and it's not audio, send it as a separate text after
  // (Instagram doesn't support captions on attachment messages natively,
  // but we can include it as text in a follow-up or as part of the message)

  const body = {
    recipient: { id: to },
    message: messagePayload,
  };

  console.log(`[IG Meta API] Sending ${kind} to ${to} via ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }

  const data = await response.json();
  const messageId = data.message_id;

  // If there's a caption, send it as a follow-up text message
  if (caption && kind !== 'audio') {
    try {
      await sendTextMessage({ pageId, accessToken, to, text: caption });
    } catch (err) {
      console.warn('[IG Meta API] Failed to send caption as follow-up text:', err);
    }
  }

  return { messageId };
}

export interface SendActionArgs {
  pageId: string;
  accessToken: string;
  to: string;
  action: 'mark_seen' | 'typing_on' | 'typing_off';
}

/**
 * Send sender action (like mark_seen or typing_on)
 */
export async function sendAction(
  args: SendActionArgs
): Promise<void> {
  const { pageId, accessToken, to, action } = args;
  
  const isIgToken = accessToken.startsWith('IG');
  const baseUrl = isIgToken ? `https://graph.instagram.com/${META_API_VERSION}` : META_API_BASE;
  const endpoint = isIgToken ? 'me' : pageId;
  const url = `${baseUrl}/${endpoint}/messages`;
  
  const body = {
    recipient: { id: to },
    sender_action: action,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
}

/**
 * Verify app credentials using App ID and App Secret.
 * Returns basic app info if valid.
 */
export async function verifyAppCredentials(args: {
  appId: string;
  appSecret: string;
}): Promise<{ id: string; name: string }> {
  const { appId, appSecret } = args;
  const url = `${META_API_BASE}/${appId}?access_token=${appId}|${appSecret}&fields=id,name`;
  const response = await fetch(url);

  if (!response.ok) {
    await throwMetaError(response, 'Failed to verify app credentials. Check your App ID and App Secret.');
  }

  const data = await response.json();
  if (!data.id) {
    throw new Error('Invalid app credentials: no app ID returned');
  }
  return { id: data.id, name: data.name || 'Unknown App' };
}

export async function getInstagramAccountInfo(args: {
  accessToken: string;
}): Promise<InstagramAccountInfo> {
  const { accessToken } = args;
  
  // If the token starts with IG, it's an Instagram Graph API token
  // Otherwise, it's a Facebook Graph API token
  const isIgToken = accessToken.startsWith('IG');
  const baseUrl = isIgToken ? `https://graph.instagram.com/${META_API_VERSION}` : META_API_BASE;
  
  const url = `${baseUrl}/me?access_token=${accessToken}&fields=id,name,username,profile_picture_url,followers_count`;
  const response = await fetch(url);

  if (!response.ok) {
    await throwMetaError(response, 'Failed to get account info. Check your Access Token.');
  }

  const data = await response.json();
  return {
    id: data.id,
    name: data.name || data.username || 'Unknown Account',
    username: data.username || '',
    profile_picture_url: data.profile_picture_url,
    followers_count: data.followers_count,
  };
}

/**
 * Exchange a short-lived token for a long-lived token using App Secret.
 */
export async function exchangeForLongLivedToken(args: {
  appId: string;
  appSecret: string;
  shortLivedToken: string;
}): Promise<{ access_token: string; token_type: string; expires_in: number }> {
  const { appId, appSecret, shortLivedToken } = args;
  const url = `${META_API_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    await throwMetaError(response, 'Failed to exchange token for long-lived token.');
  }

  return response.json();
}

export async function verifyPageInfo(args: {
  pageId: string;
  accessToken: string;
}): Promise<PageInfo> {
  const { pageId, accessToken } = args;
  const url = `${META_API_BASE}/${pageId}?access_token=${accessToken}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    await throwMetaError(response, `Failed to verify page credentials`);
  }

  const data = await response.json();
  return {
    name: data.name || data.username || 'Unknown Page',
    id: data.id,
    username: data.username,
  };
}

export async function subscribePageToApp(args: {
  pageId: string;
  accessToken: string;
}): Promise<void> {
  const { pageId, accessToken } = args;
  const url = `${META_API_BASE}/${pageId}/subscribed_apps`;
  
  // Need to subscribe to 'messages' and 'messaging_postbacks'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks'] }),
  });

  if (!response.ok) {
    await throwMetaError(response, `Failed to subscribe page to app webhook events`);
  }
}

/**
 * Fetch the Instagram user's profile information using their IGSID.
 * 
 * According to Meta docs, the correct fields for messaging participants are:
 *   name, username, profile_pic, follower_count, is_user_follow_business
 * 
 * Requires the `instagram_business_manage_messages` permission.
 * The user must have initiated a conversation first.
 */
export async function getInstagramUserProfile(args: {
  igScopedId: string;
  accessToken: string;
}): Promise<{ name: string; username: string; profile_pic?: string }> {
  const { igScopedId, accessToken } = args;
  
  // Try Instagram Graph API (for IGAA tokens), then Facebook Graph API as fallback
  const urls = [
    `https://graph.instagram.com/${META_API_VERSION}/${igScopedId}?fields=name,username,profile_pic&access_token=${accessToken}`,
    `https://graph.facebook.com/${META_API_VERSION}/${igScopedId}?fields=name,username,profile_pic&access_token=${accessToken}`,
  ];
  
  for (const url of urls) {
    try {
      console.log(`[Meta API] Fetching profile for IGSID ${igScopedId} from: ${url.split('?')[0]}`);
      const response = await fetch(url);
      
      if (!response.ok) {
        const errBody = await response.text();
        console.error(`[Meta API] Profile fetch failed (${response.status}):`, errBody);
        continue; // try next URL
      }
      
      const data = await response.json();
      console.log(`[Meta API] Profile data for ${igScopedId}:`, JSON.stringify(data));
      
      const name = data.name || data.username;
      if (name) {
        return {
          name,
          username: data.username || '',
          profile_pic: data.profile_pic,
        };
      }
    } catch (err) {
      console.error(`[Meta API] Error fetching profile for ${igScopedId}:`, err);
    }
  }
  
  console.warn(`[Meta API] Could not fetch profile for ${igScopedId}, using fallback name`);
  return { name: `IG_${igScopedId}`, username: '' };
}
