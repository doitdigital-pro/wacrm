'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  Zap,
  AlertTriangle,
  RotateCcw,
  User,
  Users,
  ExternalLink,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';

interface AccountInfo {
  id: string;
  name: string;
  username: string;
  profile_picture_url?: string;
  followers_count?: number;
}

export function InstagramConfig() {
  const t = useTranslations('Settings.instagram');
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);

  // App credentials
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [appSecretEdited, setAppSecretEdited] = useState(false);

  // Access token
  const [accessToken, setAccessToken] = useState('');
  const [showAccessToken, setShowAccessToken] = useState(false);
  const [accessTokenEdited, setAccessTokenEdited] = useState(false);

  // Webhook
  const [verifyToken, setVerifyToken] = useState('');
  const [savedVerifyToken, setSavedVerifyToken] = useState(false);

  // Optional page ID
  const [pageId, setPageId] = useState('');

  // Connection status
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [statusMessage, setStatusMessage] = useState('');
  const [needsReset, setNeedsReset] = useState(false);
  const [accountInfo, setAccountInfo] = useState<AccountInfo | null>(null);
  const [savedAppId, setSavedAppId] = useState('');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [config, setConfig] = useState<any>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/instagram/webhook`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('instagram_configs')
        .select('app_id, page_id, instagram_account_id, status, connected_at, verify_token')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) console.error('Failed to load config row:', error);

      if (data) {
        setConfig(data);
        setAppId(data.app_id || '');
        setSavedAppId(data.app_id || '');
        setPageId(data.page_id || '');
        setAppSecret(MASKED);
        setAccessToken(MASKED);
        setAppSecretEdited(false);
        setAccessTokenEdited(false);
        setVerifyToken(data.verify_token ? MASKED : '');
        setSavedVerifyToken(!!data.verify_token);
      } else {
        setConfig(null);
        setAppId('');
        setSavedAppId('');
        setPageId('');
        setAppSecret('');
        setAccessToken('');
        setVerifyToken('');
        setSavedVerifyToken(false);
        setAppSecretEdited(false);
        setAccessTokenEdited(false);
      }

      if (data) {
        try {
          const res = await fetch('/api/instagram/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setNeedsReset(false);
            setStatusMessage('');
            setAccountInfo(payload.account_info || null);
          } else {
            setConnectionStatus('disconnected');
            setNeedsReset(payload.needs_reset || false);
            setStatusMessage(payload.message || '');
            setAccountInfo(null);
          }
        } catch {
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setNeedsReset(false);
        setStatusMessage('');
        setAccountInfo(null);
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load Instagram configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  async function handleSave() {
    if (!appId.trim()) {
      toast.error('App ID is required');
      return;
    }

    const isNewConfig = !config;
    const appSecretValue = appSecretEdited && appSecret !== MASKED ? appSecret.trim() : null;
    const accessTokenValue = accessTokenEdited && accessToken !== MASKED ? accessToken.trim() : null;
    const verifyTokenValue = verifyToken !== MASKED ? verifyToken.trim() : null;

    if (isNewConfig && (!appSecretValue || !accessTokenValue)) {
      toast.error('App Secret and Access Token are required for initial setup');
      return;
    }

    if (!isNewConfig && !appSecretEdited && !accessTokenEdited && verifyToken === MASKED && config.page_id === pageId) {
      toast.error('No changes detected');
      return;
    }

    // For an update, only require what's being changed
    if (!isNewConfig && appSecretEdited && !appSecretValue) {
      toast.error('Please enter a valid App Secret');
      return;
    }
    if (!isNewConfig && accessTokenEdited && !accessTokenValue) {
      toast.error('Please enter a valid Access Token');
      return;
    }
    // Build payload
    const payload: Record<string, unknown> = {
      app_id: appId.trim(),
      page_id: pageId.trim() || null,
    };

    if (appSecretValue) payload.app_secret = appSecretValue;
    if (accessTokenValue) payload.access_token = accessTokenValue;
    if (verifyTokenValue) payload.verify_token = verifyTokenValue;

    // For new config, both are mandatory (checked above)
    // For update, if neither secret is being changed, we need to prevent saving with no secret
    if (!isNewConfig && !appSecretValue && !accessTokenValue && !verifyTokenValue && config.page_id === pageId) {
      toast.error('To update, please re-enter at least one of: App Secret, Access Token');
      return;
    }

    try {
      setSaving(true);
      const res = await fetch('/api/instagram/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        return;
      }

      if (data.account_info) {
        toast.success(
          `Connected to @${data.account_info.username || data.account_info.name}`
        );
      } else {
        toast.success('Configuration saved successfully');
      }

      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/instagram/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setNeedsReset(false);
        setStatusMessage('');
        setAccountInfo(payload.account_info || null);
        toast.success(
          payload.account_info?.username
            ? `Connected to @${payload.account_info.username}`
            : 'Connection successful'
        );
      } else {
        setConnectionStatus('disconnected');
        setNeedsReset(payload.needs_reset || false);
        setStatusMessage(payload.message || '');
        setAccountInfo(null);
        toast.error(payload.message || 'Connection test failed');
      }
    } catch {
      setConnectionStatus('disconnected');
      toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the current Instagram config. Continue?')) return;
    try {
      setResetting(true);
      const res = await fetch('/api/instagram/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuration cleared. You can now re-enter your credentials.');
      setConfig(null);
      setAppId(''); setSavedAppId(''); setPageId('');
      setAppSecret(''); setAccessToken(''); setVerifyToken('');
      setAppSecretEdited(false); setAccessTokenEdited(false); setSavedVerifyToken(false);
      setConnectionStatus('disconnected');
      setNeedsReset(false); setStatusMessage(''); setAccountInfo(null);
    } catch {
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title="Instagram" description="Connect your Instagram account to receive messages" />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Instagram"
        description="Connect your Instagram account to receive and reply to messages"
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">

          {/* Connection status banner */}
          {needsReset ? (
            <Alert className="bg-amber-950/40 border-amber-600/40">
              <AlertTriangle className="size-4 text-amber-400" />
              <AlertTitle className="text-amber-200">Credentials cannot be decrypted</AlertTitle>
              <AlertDescription className="text-amber-100/80 text-sm">
                The stored credentials are corrupted. Reset the configuration and re-enter your credentials.
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white flex gap-2"
                >
                  {resetting ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                  Reset Configuration
                </Button>
              </AlertDescription>
            </Alert>
          ) : connectionStatus === 'connected' && accountInfo ? (
            <Alert className="bg-emerald-950/30 border-emerald-700/50">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <AlertTitle className="text-emerald-200">Connected</AlertTitle>
              <AlertDescription>
                <div className="flex items-center gap-3 mt-2">
                  {accountInfo.profile_picture_url && (
                    <img
                      src={accountInfo.profile_picture_url}
                      alt={accountInfo.name}
                      className="size-10 rounded-full object-cover"
                    />
                  )}
                  <div>
                    <p className="text-sm font-medium text-foreground">{accountInfo.name}</p>
                    {accountInfo.username && (
                      <p className="text-xs text-muted-foreground">@{accountInfo.username}</p>
                    )}
                    {accountInfo.followers_count !== undefined && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Users className="size-3" />
                        {accountInfo.followers_count.toLocaleString()} followers
                      </p>
                    )}
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          ) : connectionStatus === 'disconnected' && statusMessage ? (
            <Alert className="bg-card border-border">
              <XCircle className="size-4 text-red-500" />
              <AlertTitle className="text-foreground">Not Connected</AlertTitle>
              <AlertDescription className="text-muted-foreground text-sm">{statusMessage}</AlertDescription>
            </Alert>
          ) : null}

          {/* ── Section 1: App credentials ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-foreground text-base">1. Credenciales de la App de Instagram</CardTitle>
              <CardDescription className="text-muted-foreground text-sm">
                Encuentra estos datos en la sección <strong>Configuración de la API con inicio de sesión con Instagram</strong>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground text-sm">
                  Identificador de la app de Instagram <span className="text-red-400">*</span>
                </Label>
                <Input
                  placeholder="e.g. 1796683971259474"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground font-mono"
                />
                {savedAppId && (
                  <p className="text-xs text-muted-foreground">App ID actual: {savedAppId}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground text-sm">
                  Clave secreta de la app de Instagram <span className="text-red-400">*</span>
                </Label>
                <div className="relative">
                  <Input
                    type={showAppSecret ? 'text' : 'password'}
                    placeholder="b42c4a622a4e1055f46e..."
                    value={appSecret}
                    onChange={(e) => { setAppSecret(e.target.value); setAppSecretEdited(true); }}
                    onFocus={() => { if (appSecret === MASKED) { setAppSecret(''); setAppSecretEdited(true); } }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAppSecret(!showAppSecret)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showAppSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {config && !appSecretEdited && (
                  <p className="text-xs text-muted-foreground">Guardada de forma segura — clic para editar</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Section 2: Access Token ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-foreground text-base">2. Instagram API Token</CardTitle>
              <CardDescription className="text-muted-foreground text-sm">
                Encuentra estos datos en la sección <strong>1. Generar tokens de acceso</strong>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground text-sm">
                  Token <span className="text-red-400">*</span>
                </Label>
                <div className="relative">
                  <Input
                    type={showAccessToken ? 'text' : 'password'}
                    placeholder="EAABsbCS..."
                    value={accessToken}
                    onChange={(e) => { setAccessToken(e.target.value); setAccessTokenEdited(true); }}
                    onFocus={() => { if (accessToken === MASKED) { setAccessToken(''); setAccessTokenEdited(true); } }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAccessToken(!showAccessToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showAccessToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {config && !accessTokenEdited && (
                  <p className="text-xs text-muted-foreground">Guardado de forma segura — clic para editar</p>
                )}
                <p className="text-xs text-muted-foreground">
                  💡 Asegúrate de generar el token haciendo clic en <strong>Generar token</strong> junto a tu cuenta de Instagram.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pageId" className="text-muted-foreground text-sm">
                  Cuenta de Instagram (ID numérico) <span className="text-red-400">*</span>
                </Label>
                <Input
                  id="pageId"
                  placeholder="Ej. 17841403986098732"
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Copia el número que aparece directamente debajo del nombre de tu cuenta de Instagram.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ── Section 3: Webhook URL ── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-foreground text-base">3. Configurar webhooks</CardTitle>
              <CardDescription className="text-muted-foreground text-sm">
                Copia estos datos en la sección <strong>2. Configurar webhooks</strong>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-muted-foreground text-sm">URL de devolución de llamada (Callback URL)</Label>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={webhookUrl}
                      className="bg-muted border-border text-muted-foreground font-mono text-xs"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyWebhookUrl}
                      className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-muted-foreground text-sm">
                    Token de verificación <span className="text-muted-foreground/60 font-normal">(opcional)</span>
                  </Label>
                  <Input
                    placeholder="Escribe una palabra secreta (ej. mi_secreto_123)"
                    value={verifyToken}
                    onChange={(e) => setVerifyToken(e.target.value)}
                    onFocus={() => { if (verifyToken === MASKED) setVerifyToken(''); }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground font-mono"
                  />
                  {savedVerifyToken && verifyToken === MASKED && (
                    <p className="text-xs text-muted-foreground">Guardado de forma segura — clic para editar</p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <><Loader2 className="size-4 animate-spin mr-2" />Guardando...</>
              ) : (
                'Guardar Configuración'
              )}
            </Button>

            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !config}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {testing ? (
                <><Loader2 className="size-4 animate-spin mr-2" />Probando...</>
              ) : (
                <><Zap className="size-4 mr-2" />Probar Conexión</>
              )}
            </Button>

            {config && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {resetting ? (
                  <><Loader2 className="size-4 animate-spin mr-2" />Eliminando...</>
                ) : (
                  <><RotateCcw className="size-4 mr-2" />Eliminar Config</>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* ── Right column: Instructions ── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-foreground text-base">Guía de Configuración</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="space-y-1">
                <p className="font-medium text-foreground">Paso 1 — Ve a tu App de Meta</p>
                <p className="text-muted-foreground text-xs">
                  Entra a tu aplicación en{' '}
                  <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener noreferrer"
                    className="text-primary hover:underline">developers.facebook.com/apps
                  </a>.
                </p>
              </div>

              <div className="space-y-1">
                <p className="font-medium text-foreground">Paso 2 — Entra a Instagram API Setup</p>
                <p className="text-muted-foreground text-xs">
                  En el menú lateral izquierdo, haz clic en <strong>Configuración de la API con inicio de sesión con Instagram</strong>.
                </p>
              </div>

              <div className="space-y-1">
                <p className="font-medium text-foreground">Paso 3 — Copia y Pega</p>
                <p className="text-muted-foreground text-xs">
                  Copia todos los datos que aparecen en esa pantalla a los campos de la izquierda en WACRM (Identificador, Clave Secreta, Token, y el ID numérico de la cuenta).
                </p>
              </div>

              <div className="space-y-1">
                <p className="font-medium text-foreground">Paso 4 — Configura los Webhooks</p>
                <p className="text-muted-foreground text-xs">
                  Pega la <strong>URL de devolución de llamada</strong> y el <strong>Token de verificación</strong> en la sección inferior de esa misma pantalla en Meta, y dale al botón de "Verificar".
                </p>
              </div>
            </CardContent>
          </Card>

          {connectionStatus === 'connected' && accountInfo && (
            <Card className="border-emerald-700/30 bg-emerald-950/20">
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 mb-2">
                  <User className="size-4 text-emerald-400" />
                  <span className="text-sm font-medium text-emerald-200">Active Account</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Account ID: <code className="bg-muted px-1 rounded">{accountInfo.id}</code>
                </p>
                {accountInfo.username && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Username: <strong>@{accountInfo.username}</strong>
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}
