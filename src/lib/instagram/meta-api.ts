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

/**
 * Send a free-form Instagram text message via the Send API.
 * Only works inside the 24-hour customer service window.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const { pageId, accessToken, to, text } = args;
  const url = `${META_API_BASE}/${pageId}/messages`;
  
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
  const url = `${META_API_BASE}/${pageId}/messages`;
  
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

export async function verifyPageInfo(args: {
  pageId: string;
  accessToken: string;
}): Promise<PageInfo> {
  const { pageId, accessToken } = args;
  // This endpoint returns the name and id of the page/ig account to verify tokens.
  const url = `${META_API_BASE}/${pageId}?access_token=${accessToken}`;
  const response = await fetch(url);
  
  if (!response.ok) {
    await throwMetaError(response, `Failed to verify page credentials`);
  }

  const data = await response.json();
  return {
    name: data.name || data.username || 'Unknown Page',
    id: data.id,
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

