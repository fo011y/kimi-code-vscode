import * as vscode from 'vscode';
import { ApiConfig } from './api';
import { getOAuthAccessToken, loginInteractive } from './auth';
import { S } from './i18n';

export type ApiConfigNoKey = Omit<ApiConfig, 'apiKey'>;

export function getApiConfig(): ApiConfigNoKey {
  const c = vscode.workspace.getConfiguration('kimi');
  return {
    baseUrl: c.get<string>('baseUrl', 'https://api.moonshot.ai/v1'),
    model: c.get<string>('model', 'kimi-k2-0905-preview'),
    maxTokens: c.get<number>('maxTokens', 8192),
    temperature: c.get<number>('temperature', 0.6),
  };
}

export function getMaxAgentSteps(): number {
  return vscode.workspace.getConfiguration('kimi').get<number>('maxAgentSteps', 25);
}

/**
 * Автопродолжение при лимите шагов: сколько раз агент сам продолжает
 * работу после исчерпания maxAgentSteps (работает до полного выполнения задачи).
 * 0 — выключено (старое поведение: предупреждение и остановка).
 */
export function getAutoContinues(): number {
  return vscode.workspace.getConfiguration('kimi').get<number>('maxAutoContinues', 50);
}

/**
 * Автоподталкивание, когда агент завершил ход обещанием продолжить
 * («проверю», «сейчас сделаю»), но не вызвал инструменты.
 * Сколько таких подталкиваний допустимо подряд. 0 — выключено.
 */
export function getIntentContinues(): number {
  return vscode.workspace.getConfiguration('kimi').get<number>('intentAutoContinues', 10);
}

export function getModel(): string {
  return vscode.workspace.getConfiguration('kimi').get<string>('model', 'kimi-k2-0905-preview');
}

export async function setModel(model: string): Promise<void> {
  await vscode.workspace.getConfiguration('kimi').update('model', model, vscode.ConfigurationTarget.Global);
}

/** Режим автономности агента. */
export type PermissionMode = 'plan' | 'ask' | 'autoEdit' | 'fullAuto';

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: S.modePlan,
  ask: S.modeAsk,
  autoEdit: S.modeAutoEdit,
  fullAuto: S.modeFullAuto,
};

export function getPermissionMode(): PermissionMode {
  const c = vscode.workspace.getConfiguration('kimi');
  const m = c.get<string>('permissionMode', 'ask');
  if (m === 'plan' || m === 'ask' || m === 'autoEdit' || m === 'fullAuto') return m;
  // обратная совместимость со старой настройкой autoApprove
  if (c.get<boolean>('autoApprove', false)) return 'fullAuto';
  return 'ask';
}

export function isPlanMode(): boolean {
  return getPermissionMode() === 'plan';
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
  await vscode.workspace
    .getConfiguration('kimi')
    .update('permissionMode', mode, vscode.ConfigurationTarget.Global);
}

/** Автоматически коммитить и пушить изменения на GitHub после задачи агента. */
export function getAutoPush(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('autoPush', false);
}

/** Автоматически выполнять команду деплоя после задачи агента. */
export function getAutoDeploy(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('autoDeploy', false);
}

/** Команда деплоя проекта (shell). */
export function getDeployCommand(): string {
  return vscode.workspace.getConfiguration('kimi').get<string>('deployCommand', '');
}

/** Уважать .gitignore при обходе файлов агентом. */
export function getRespectGitignore(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('respectGitIgnore', true);
}

/**
 * Порог автоархивации контекста в токенах промпта.
 * При превышении агент сжимает середину диалога в сводку и продолжает работу.
 * 0 — выключено.
 */
export function getAutoCompactTokens(): number {
  return vscode.workspace.getConfiguration('kimi').get<number>('autoCompactTokens', 150000);
}

/**
 * Авто-пинок зависшего запроса: секунды без ответа от API,
 * после которых запрос прерывается и агент просится продолжить (до 3 раз).
 * 0 — выключено. Во время выполнения инструментов таймер на паузе.
 */
export function getAutoNudgeSeconds(): number {
  return vscode.workspace.getConfiguration('kimi').get<number>('autoNudgeSeconds', 90);
}

/** Дополнительные папки вне рабочей области, к которым агент получает доступ. */
export function getTrustedFolders(): string[] {
  const v = vscode.workspace.getConfiguration('kimi').get<string[]>('trustedFolders', []);
  return Array.isArray(v) ? v : [];
}

/** Прикреплять выделенный код к сообщениям. */
export function getAttachSelection(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('attachSelection', true);
}

/** Прикреплять открытый файл целиком (если нет выделения). */
export function getAttachOpenFile(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('attachOpenFile', false);
}

/** Отправка по Ctrl+Enter вместо Enter. */
export function getUseCtrlEnterToSend(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('useCtrlEnterToSend', false);
}

/** Показывать метки времени у сообщений. */
export function getShowTimestamps(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('showMessageTimestamps', true);
}

/** Открывать чат вкладкой в центре редактора (как Claude Code), а не только в боковой панели. */
export function getOpenInEditor(): boolean {
  return vscode.workspace.getConfiguration('kimi').get<boolean>('openInEditor', true);
}

// ---------- единая авторизация: OAuth (сайт) или API-ключ ----------

export interface AuthInfo {
  token: string;
  baseUrl: string;
  kind: 'oauth' | 'apiKey';
}

/** Авторизация без диалогов: OAuth-токен приоритетнее API-ключа. */
export async function getAuthQuiet(context: vscode.ExtensionContext): Promise<AuthInfo | undefined> {
  const oauth = await getOAuthAccessToken(context);
  if (oauth) return { token: oauth.token, baseUrl: oauth.baseUrl, kind: 'oauth' };
  const key = await context.secrets.get('kimi.apiKey');
  if (key) return { token: key, baseUrl: getApiConfig().baseUrl, kind: 'apiKey' };
  return undefined;
}

/**
 * Гарантированно вернуть авторизацию, при необходимости спросив способ входа:
 * через сайт Kimi (OAuth) или API-ключ.
 */
export async function ensureAuth(
  context: vscode.ExtensionContext,
  force = false
): Promise<AuthInfo | undefined> {
  if (!force) {
    const quiet = await getAuthQuiet(context);
    if (quiet) return quiet;
  }
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: S.loginOauthLabel,
        description: S.recommended,
        detail: S.loginOauthDetail,
        authKind: 'oauth' as const,
      },
      {
        label: S.loginKeyLabel,
        description: 'platform.moonshot.ai',
        detail: S.loginKeyDetail,
        authKind: 'apiKey' as const,
      },
    ],
    { title: S.loginTitle }
  );
  if (!pick) return undefined;
  if (pick.authKind === 'oauth') {
    const ok = await loginInteractive(context);
    if (!ok) return undefined;
    return getAuthQuiet(context);
  }
  const key = await ensureApiKey(context, true);
  return key ? { token: key, baseUrl: getApiConfig().baseUrl, kind: 'apiKey' } : undefined;
}

export async function ensureApiKey(
  context: vscode.ExtensionContext,
  force = false
): Promise<string | undefined> {
  let key = await context.secrets.get('kimi.apiKey');
  if (!key || force) {
    const v = await vscode.window.showInputBox({
      title: 'Kimi API Key',
      prompt: S.apiKeyPrompt,
      password: true,
      ignoreFocusOut: true,
    });
    if (v && v.trim()) {
      key = v.trim();
      await context.secrets.store('kimi.apiKey', key);
    }
  }
  return key;
}
