/**
 * Вход в Kimi через браузер — Device Code OAuth flow (RFC 8628),
 * тот же механизм, что использует официальный Kimi Code CLI (`kimi login`).
 * Публичные endpoints и client_id взяты из открытого репозитория
 * MoonshotAI/kimi-code (packages/oauth).
 *
 * Flow:
 *  1. POST {oauthHost}/api/oauth/device_authorization  → user_code + ссылка
 *  2. Пользователь открывает ссылку в браузере и подтверждает вход
 *  3. Клиент опрашивает POST {oauthHost}/api/oauth/token (grant_type=device_code)
 *  4. Токены сохраняются в SecretStorage; access token обновляется по refresh_token
 */

import * as vscode from 'vscode';

export type OAuthRegion = 'mainland-cn' | 'global';

interface RegionProfile {
  oauthHost: string;
  apiBase: string;
  label: string;
  detail: string;
}

export const OAUTH_REGIONS: Record<OAuthRegion, RegionProfile> = {
  'mainland-cn': {
    oauthHost: 'https://auth.kimi.com',
    apiBase: 'https://api.kimi.com/coding/v1',
    label: 'Kimi.com',
    detail: 'международный сайт kimi.com / аккаунт .com',
  },
  global: {
    oauthHost: 'https://auth.kimi.ai',
    apiBase: 'https://api.kimi.ai/coding/v1',
    label: 'Kimi.ai (Global)',
    detail: 'глобальный сайт kimi.ai',
  },
};

/** Публичный client_id официального Kimi Code CLI (из открытого кода MoonshotAI/kimi-code). */
const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

const K_ACCESS = 'kimi.oauth.accessToken';
const K_REFRESH = 'kimi.oauth.refreshToken';
const K_EXPIRES = 'kimi.oauth.expiresAt';
const K_REGION = 'kimi.oauth.region';

interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  /** unix-seconds */
  expiresAt: number;
}

interface DeviceAuthorization {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

async function postForm(
  url: string,
  params: Record<string, string>
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // не JSON — разбираемся по статусу
  }
  return { status: res.status, data };
}

function errorText(data: Record<string, unknown>, fallback: string): string {
  const d = data['error_description'] ?? data['message'] ?? data['error'];
  return typeof d === 'string' && d.length > 0 ? d : fallback;
}

async function requestDeviceAuthorization(oauthHost: string): Promise<DeviceAuthorization> {
  const { status, data } = await postForm(
    `${oauthHost}/api/oauth/device_authorization`,
    { client_id: CLIENT_ID }
  );
  if (status !== 200) {
    throw new Error(`Авторизация устройства не удалась (HTTP ${status}): ${errorText(data, 'unknown')}`);
  }
  const userCode = data['user_code'];
  const deviceCode = data['device_code'];
  const complete = data['verification_uri_complete'];
  if (
    typeof userCode !== 'string' || !userCode ||
    typeof deviceCode !== 'string' || !deviceCode ||
    typeof complete !== 'string' || !complete
  ) {
    throw new Error('Некорректный ответ сервера авторизации Kimi.');
  }
  return {
    userCode,
    deviceCode,
    verificationUri: typeof data['verification_uri'] === 'string' ? data['verification_uri'] : '',
    verificationUriComplete: complete,
    expiresIn: Number(data['expires_in'] ?? 600),
    interval: Number(data['interval'] ?? 5),
  };
}

function parseToken(data: Record<string, unknown>): TokenInfo {
  const accessToken = data['access_token'];
  const refreshToken = data['refresh_token'];
  const expiresIn = Number(data['expires_in']);
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('OAuth: нет access_token');
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('OAuth: нет refresh_token');
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('OAuth: нет expires_in');
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function pollForToken(
  oauthHost: string,
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
  token: vscode.CancellationToken,
  progress: vscode.Progress<{ message?: string }>
): Promise<TokenInfo> {
  let interval = Math.max(1, intervalSec);
  const deadline = Date.now() + Math.max(60, expiresInSec) * 1000;
  while (Date.now() < deadline) {
    if (token.isCancellationRequested) throw new Error('Вход отменён пользователем.');
    await sleep(interval * 1000);
    const { status, data } = await postForm(`${oauthHost}/api/oauth/token`, {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (status === 200 && typeof data['access_token'] === 'string') {
      return parseToken(data);
    }
    const code = typeof data['error'] === 'string' ? data['error'] : '';
    switch (code) {
      case 'authorization_pending':
        progress.report({ message: 'Ожидание подтверждения в браузере…' });
        break;
      case 'slow_down':
        interval += 5;
        break;
      case 'expired_token':
        throw new Error('Код входа истёк. Попробуйте войти снова.');
      case 'access_denied':
        throw new Error('Вход отклонён на странице Kimi.');
      default:
        throw new Error(`Ошибка входа (HTTP ${status}): ${errorText(data, code || 'unknown')}`);
    }
  }
  throw new Error('Время ожидания входа истекло. Попробуйте снова.');
}

async function storeTokens(context: vscode.ExtensionContext, region: OAuthRegion, t: TokenInfo): Promise<void> {
  await context.secrets.store(K_ACCESS, t.accessToken);
  await context.secrets.store(K_REFRESH, t.refreshToken);
  await context.secrets.store(K_EXPIRES, String(t.expiresAt));
  await context.secrets.store(K_REGION, region);
}

async function readTokens(context: vscode.ExtensionContext): Promise<(TokenInfo & { region: OAuthRegion }) | undefined> {
  const [accessToken, refreshToken, expiresAt, region] = await Promise.all([
    context.secrets.get(K_ACCESS),
    context.secrets.get(K_REFRESH),
    context.secrets.get(K_EXPIRES),
    context.secrets.get(K_REGION),
  ]);
  if (!accessToken || !refreshToken || !expiresAt) return undefined;
  return {
    accessToken,
    refreshToken,
    expiresAt: Number(expiresAt),
    region: region === 'global' ? 'global' : 'mainland-cn',
  };
}

/** Базовый URL API для OAuth-режима (зависит от региона входа). */
export async function getOAuthBaseUrl(context: vscode.ExtensionContext): Promise<string> {
  const region = await context.secrets.get(K_REGION);
  return OAUTH_REGIONS[region === 'global' ? 'global' : 'mainland-cn'].apiBase;
}

/** Есть ли сохранённый OAuth-логин. */
export async function hasOAuthLogin(context: vscode.ExtensionContext): Promise<boolean> {
  return (await context.secrets.get(K_REFRESH)) !== undefined;
}

export type AuthState =
  | { kind: 'oauth'; label: string }
  | { kind: 'apiKey' }
  | { kind: 'none' };

/** Текущее состояние аккаунта для UI (без сетевых запросов). */
export async function getAuthState(context: vscode.ExtensionContext): Promise<AuthState> {
  if (await hasOAuthLogin(context)) {
    const region = await context.secrets.get(K_REGION);
    return { kind: 'oauth', label: region === 'global' ? 'Kimi.ai' : 'Kimi.com' };
  }
  if ((await context.secrets.get('kimi.apiKey')) !== undefined) return { kind: 'apiKey' };
  return { kind: 'none' };
}

/**
 * Действующий access token: обновляет по refresh_token, если истекает
 * (запас 60 секунд). Возвращает undefined, если логина нет или refresh
 * отклонён (тогда сохранённые токены очищаются).
 */
export async function getOAuthAccessToken(
  context: vscode.ExtensionContext
): Promise<{ token: string; baseUrl: string } | undefined> {
  const t = await readTokens(context);
  if (!t) return undefined;
  const baseUrl = OAUTH_REGIONS[t.region].apiBase;
  const now = Math.floor(Date.now() / 1000);
  if (t.expiresAt - 60 > now) return { token: t.accessToken, baseUrl };

  const { status, data } = await postForm(`${OAUTH_REGIONS[t.region].oauthHost}/api/oauth/token`, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: t.refreshToken,
  }).catch(() => ({ status: 0, data: {} as Record<string, unknown> }));

  if (status === 200 && typeof data['access_token'] === 'string') {
    const nt = parseToken(data);
    await storeTokens(context, t.region, nt);
    return { token: nt.accessToken, baseUrl };
  }
  if (status === 401 || status === 403 || data['error'] === 'invalid_grant') {
    await logoutOAuth(context);
    return undefined;
  }
  // временный сбой сети/сервера — пробуем жить на старом токене, если он ещё не истёк
  if (t.expiresAt > now) return { token: t.accessToken, baseUrl };
  return undefined;
}

/** Полный выход: удалить OAuth-токены (API-ключ не трогаем). */
export async function logoutOAuth(context: vscode.ExtensionContext): Promise<void> {
  await Promise.all([
    context.secrets.delete(K_ACCESS),
    context.secrets.delete(K_REFRESH),
    context.secrets.delete(K_EXPIRES),
    context.secrets.delete(K_REGION),
  ]);
}

/** Интерактивный вход через браузер. Возвращает true при успехе. */
export async function loginInteractive(context: vscode.ExtensionContext): Promise<boolean> {
  const stored = await context.secrets.get(K_REGION);
  const regions: OAuthRegion[] = ['mainland-cn', 'global'];
  const pick = await vscode.window.showQuickPick(
    regions.map((r) => ({
      label: `${r === stored ? '$(check) ' : ''}${OAUTH_REGIONS[r].label}`,
      description: OAUTH_REGIONS[r].detail,
      region: r,
    })),
    { title: 'Kimi: выберите регион вашего аккаунта' }
  );
  if (!pick) return false;
  const region = pick.region;
  const profile = OAUTH_REGIONS[region];

  let device: DeviceAuthorization;
  try {
    device = await requestDeviceAuthorization(profile.oauthHost);
  } catch (e) {
    vscode.window.showErrorMessage(`Kimi: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  // Открываем страницу подтверждения и показываем код пользователю
  void vscode.env.openExternal(vscode.Uri.parse(device.verificationUriComplete));
  void vscode.window
    .showInformationMessage(
      `Kimi: откроется страница входа. Ваш код: ${device.userCode}`,
      'Скопировать код',
      'Открыть страницу ещё раз'
    )
    .then((btn) => {
      if (btn === 'Скопировать код') void vscode.env.clipboard.writeText(device.userCode);
      if (btn === 'Открыть страницу ещё раз') {
        void vscode.env.openExternal(vscode.Uri.parse(device.verificationUriComplete));
      }
    });

  try {
    const tokens = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Kimi: вход через браузер (код ${device.userCode})`,
        cancellable: true,
      },
      (progress, ct) =>
        pollForToken(profile.oauthHost, device.deviceCode, device.interval, device.expiresIn, ct, progress)
    );
    await storeTokens(context, region, tokens);
    vscode.window.showInformationMessage(`Kimi: вход выполнен (${profile.label}). API-ключ больше не нужен.`);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Kimi: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
