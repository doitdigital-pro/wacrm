import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { verifyAppCredentials, getInstagramAccountInfo, subscribePageToApp } from '@/lib/instagram/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

export async function GET() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { connected: false, reason: 'no_account', message: 'Your profile is not linked to an account.' },
        { status: 200 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('instagram_configs')
      .select('app_id, app_secret, access_token, page_id, instagram_account_id, status, connected_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching instagram_configs:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No Instagram configuration saved yet.',
          has_app_id: false,
          has_access_token: false,
        },
        { status: 200 }
      )
    }

    // Return safe metadata (no secrets)
    const hasAppId = Boolean(config.app_id)
    const hasAppSecret = Boolean(config.app_secret)
    const hasAccessToken = Boolean(config.access_token)
    const hasPageId = Boolean(config.page_id)

    // If we have all credentials, verify them
    if (hasAppId && hasAppSecret && hasAccessToken) {
      let appSecret: string
      let accessToken: string
      try {
        appSecret = decrypt(config.app_secret)
        accessToken = decrypt(config.access_token)
      } catch (err) {
        console.error('[instagram/config GET] Token decryption failed:', err)
        return NextResponse.json(
          {
            connected: false,
            reason: 'token_corrupted',
            needs_reset: true,
            has_app_id: hasAppId,
            has_access_token: hasAccessToken,
            message: 'The stored credentials cannot be decrypted. Please reset the configuration.',
          },
          { status: 200 }
        )
      }

      try {
        // Verify the access token is still valid
        const accountInfo = await getInstagramAccountInfo({ accessToken })
        return NextResponse.json({
          connected: true,
          has_app_id: hasAppId,
          has_access_token: hasAccessToken,
          has_page_id: hasPageId,
          app_id: config.app_id,
          instagram_account_id: config.instagram_account_id || accountInfo.id,
          account_info: {
            id: accountInfo.id,
            name: accountInfo.name,
            username: accountInfo.username,
            profile_picture_url: accountInfo.profile_picture_url,
            followers_count: accountInfo.followers_count,
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('[instagram/config GET] Token validation failed:', message)
        return NextResponse.json(
          {
            connected: false,
            reason: 'token_invalid',
            has_app_id: hasAppId,
            has_access_token: hasAccessToken,
            app_id: config.app_id,
            message: `Access token is invalid or expired: ${message}`,
          },
          { status: 200 }
        )
      }
    }

    return NextResponse.json({
      connected: false,
      reason: 'incomplete_config',
      has_app_id: hasAppId,
      has_access_token: hasAccessToken,
      has_page_id: hasPageId,
      app_id: config.app_id,
      message: 'Configuration is incomplete. Please provide App ID, App Secret, and Access Token.',
    })
  } catch (error) {
    console.error('Error in Instagram config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { app_id, page_id, verify_token } = body
    let { app_secret, access_token } = body

    if (!app_id) {
      return NextResponse.json(
        { error: 'App ID is required' },
        { status: 400 }
      )
    }

    // Check existing config to fill in missing secrets
    const { data: existing } = await supabase
      .from('instagram_configs')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existing) {
      if (!app_secret && existing.app_secret) {
        try {
          app_secret = decrypt(existing.app_secret)
        } catch (err) {
          return NextResponse.json({ error: 'Stored App Secret is corrupted. Please re-enter it.' }, { status: 400 })
        }
      }
      if (!access_token && existing.access_token) {
        try {
          access_token = decrypt(existing.access_token)
        } catch (err) {
          return NextResponse.json({ error: 'Stored Access Token is corrupted. Please re-enter it.' }, { status: 400 })
        }
      }
    }

    if (!app_secret) {
      return NextResponse.json(
        { error: 'App Secret is required' },
        { status: 400 }
      )
    }

    if (!access_token) {
      return NextResponse.json(
        { error: 'Access Token is required' },
        { status: 400 }
      )
    }

    // 1. Verify App ID + App Secret
    let appInfo: { id: string; name: string }
    try {
      appInfo = await verifyAppCredentials({ appId: app_id, appSecret: app_secret })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('App credentials verification failed:', message)
      return NextResponse.json(
        { error: `Invalid App credentials: ${message}` },
        { status: 400 }
      )
    }

    // 2. Verify access token and get Instagram account info
    let accountInfo: { id: string; name: string; username: string }
    try {
      accountInfo = await getInstagramAccountInfo({ accessToken: access_token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Access token validation failed:', message)
      return NextResponse.json(
        { error: `Invalid Access Token: ${message}` },
        { status: 400 }
      )
    }

    // 3. Check if this app_id is already claimed by another account
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('instagram_configs')
      .select('account_id')
      .eq('app_id', app_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking app_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        { error: 'This Instagram App ID is already linked to another account on this instance.' },
        { status: 409 }
      )
    }

    // 4. Encrypt sensitive fields
    let encryptedAppSecret: string
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAppSecret = encrypt(app_secret)
      encryptedAccessToken = encrypt(access_token)
      // If verify_token is passed in body, encrypt it. Otherwise, keep existing if it's an update where the user didn't change it.
      // Wait, the UI sends verify_token if it was edited. If it wasn't edited, it sends null?
      // Let's check UI logic: if (verifyTokenValue) payload.verify_token = verifyTokenValue;
      // So if it's undefined in body, it means the user didn't edit it, or it's empty.
      // If verify_token is explicitly null or empty, they cleared it. 
      // If it's undefined, we keep the existing one.
      if (verify_token !== undefined) {
        encryptedVerifyToken = verify_token ? encrypt(verify_token) : null;
      } else {
        encryptedVerifyToken = existing ? existing.verify_token : null;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        { error: 'Failed to encrypt credentials. Check ENCRYPTION_KEY environment variable.' },
        { status: 500 }
      )
    }

    // 5. Try to subscribe page to webhook events (optional - page_id may be provided)
    let subscribedAt: string | null = null
    let subscriptionError: string | null = null

    if (page_id) {
      try {
        await subscribePageToApp({ pageId: page_id, accessToken: access_token })
        subscribedAt = new Date().toISOString()
      } catch (err) {
        subscriptionError = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('Page subscribed_apps failed:', subscriptionError)
      }
    }

    const baseRow = {
      app_id,
      app_secret: encryptedAppSecret,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      page_id: page_id || '',
      instagram_account_id: accountInfo.id,
      status: subscriptionError ? 'disconnected' : 'connected',
      connected_at: subscriptionError ? null : (subscribedAt || new Date().toISOString()),
      updated_at: new Date().toISOString(),
    }

    // Upsert config
    const { data: existingRecord } = await supabase
      .from('instagram_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()

    if (existingRecord) {
      const { error: updateError } = await supabase
        .from('instagram_configs')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating instagram_configs:', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('instagram_configs')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })

      if (insertError) {
        console.error('Error inserting instagram_configs:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    if (subscriptionError) {
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: subscriptionError,
        app_info: appInfo,
        account_info: accountInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: Boolean(page_id),
      app_info: appInfo,
      account_info: accountInfo,
    })
  } catch (error) {
    console.error('Error in Instagram config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { error: deleteError } = await supabase
      .from('instagram_configs')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting instagram_configs:', deleteError)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in Instagram config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
