import * as vscode from 'vscode';
import { ApiConfig } from './api';

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

export function getModel(): string {
  return vscode.workspace.getConfiguration('kimi').get<string>('model', 'kimi-k2-0905-preview');
}

export async function setModel(model: string): Promise<void> {
  await vscode.workspace.getConfiguration('kimi').update('model', model, vscode.ConfigurationTarget.Global);
}

/** Режим автономности агента. */
export type PermissionMode = 'ask' | 'autoEdit' | 'fullAuto';

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: 'Спросить всегда',
  autoEdit: 'Авто-правки (команды — с подтверждением)',
  fullAuto: 'Полная автономность',
};

export function getPermissionMode(): PermissionMode {
  const c = vscode.workspace.getConfiguration('kimi');
  const m = c.get<string>('permissionMode', 'ask');
  if (m === 'ask' || m === 'autoEdit' || m === 'fullAuto') return m;
  // обратная совместимость со старой настройкой autoApprove
  if (c.get<boolean>('autoApprove', false)) return 'fullAuto';
  return 'ask';
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

export async function ensureApiKey(
  context: vscode.ExtensionContext,
  force = false
): Promise<string | undefined> {
  let key = await context.secrets.get('kimi.apiKey');
  if (!key || force) {
    const v = await vscode.window.showInputBox({
      title: 'Kimi API Key',
      prompt: 'Введите API-ключ Moonshot (platform.moonshot.ai → API Key Management)',
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
