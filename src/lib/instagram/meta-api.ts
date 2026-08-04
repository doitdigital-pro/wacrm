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
 */
export async function getInstagramUserProfile(args: {
  igScopedId: string;
  accessToken: string;
}): Promise<{ name: string; username: string; profile_picture_url?: string }> {
  const { igScopedId, accessToken } = args;
  
  const isIgToken = accessToken.startsWith('IG');
  const baseUrl = isIgToken ? `https://graph.instagram.com/${META_API_VERSION}` : META_API_BASE;
  
  const url = `${baseUrl}/${igScopedId}?access_token=${accessToken}&fields=name,username,profile_picture_url`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`[Meta API] Failed to fetch profile for ${igScopedId}:`, await response.text());
      return { name: `IG_${igScopedId}`, username: '' };
    }
    
    const data = await response.json();
    return {
      name: data.name || data.username || `IG_${igScopedId}`,
      username: data.username || '',
      profile_picture_url: data.profile_picture_url,
    };
  } catch (err) {
    console.error(`[Meta API] Error fetching profile for ${igScopedId}:`, err);
    return { name: `IG_${igScopedId}`, username: '' };
  }
}
