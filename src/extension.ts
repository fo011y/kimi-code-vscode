import * as vscode from 'vscode';
import { ChatViewProvider } from './chatPanel';
import {
  ensureApiKey,
  ensureAuth,
  getApiConfig,
  getModel,
  getPermissionMode,
  PERMISSION_MODE_LABELS,
  PermissionMode,
} from './config';
import { ApiConfig, ChatMessage, FALLBACK_MODELS, listModels, streamChat } from './api';

function selectedCode(): { editor: vscode.TextEditor; text: string; rel: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Сначала выделите код в редакторе.');
    return undefined;
  }
  const text = editor.document.getText(editor.selection);
  if (!text.trim()) {
    vscode.window.showWarningMessage('Выделение пустое.');
    return undefined;
  }
  return { editor, text, rel: vscode.workspace.asRelativePath(editor.document.uri) };
}

/** Команда «Изменить выделенное по инструкции» с diff-предпросмотром. */
async function editSelection(context: vscode.ExtensionContext): Promise<void> {
  const sel = selectedCode();
  if (!sel) return;
  const { editor, text: selText, rel } = sel;
  const range = editor.selection;
  const doc = editor.document;

  const instruction = await vscode.window.showInputBox({
    title: 'Kimi: правка кода',
    prompt: 'Что изменить в выделенном коде?',
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const auth = await ensureAuth(context);
  if (!auth) return;
  const cfg: ApiConfig = { ...getApiConfig(), apiKey: auth.token, baseUrl: auth.baseUrl };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Kimi редактирует код…' },
    async () => {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'Ты — редактор кода. Возвращай ТОЛЬКО изменённый фрагмент кода в одном markdown-блоке, без пояснений. Сохраняй стиль и отступы оригинала.',
        },
        {
          role: 'user',
          content: `Файл: ${rel} (${doc.languageId})\nФрагмент:\n\`\`\`${doc.languageId}\n${selText}\n\`\`\`\nЗадача: ${instruction}`,
        },
      ];

      const res = await streamChat(cfg, messages);
      let code = res.content.trim();
      const m = code.match(/```\w*\n?([\s\S]*?)```/);
      code = m ? m[1].replace(/\n$/, '') : code;
      if (!code.trim()) {
        vscode.window.showErrorMessage('Kimi вернул пустой ответ.');
        return;
      }

      const start = doc.offsetAt(range.start);
      const end = doc.offsetAt(range.end);
      const original = doc.getText();
      const modified = original.slice(0, start) + code + original.slice(end);

      const left = await vscode.workspace.openTextDocument({ content: original, language: doc.languageId });
      const right = await vscode.workspace.openTextDocument({ content: modified, language: doc.languageId });
      await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `Kimi: правка ${rel}`);

      const pick = await vscode.window.showInformationMessage(
        'Применить правку Kimi к выделенному коду?',
        { modal: true },
        'Применить'
      );
      if (pick !== 'Применить') return;

      await editor.edit((b) => b.replace(range, code));
    }
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const logChannel = vscode.window.createOutputChannel('Kimi Code');
  context.subscriptions.push(logChannel);

  const provider = new ChatViewProvider(context, logChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider)
  );

  // синхронизация флагов настроек с веб-панелью
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kimi')) provider.postSettings();
    })
  );

  const cmd = (id: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('kimi.setApiKey', async () => {
    await ensureApiKey(context, true);
    vscode.window.showInformationMessage('API-ключ Kimi сохранён.');
  });

  cmd('kimi.login', async () => {
    const { loginInteractive } = await import('./auth');
    const ok = await loginInteractive(context);
    if (ok) provider.postSettings();
  });

  cmd('kimi.logout', async () => {
    const { hasOAuthLogin, logoutOAuth } = await import('./auth');
    const hadOAuth = await hasOAuthLogin(context);
    const hadKey = (await context.secrets.get('kimi.apiKey')) !== undefined;
    if (!hadOAuth && !hadKey) {
      vscode.window.showInformationMessage('Kimi: вы не вошли в аккаунт.');
      return;
    }
    const what = await vscode.window.showQuickPick(
      [
        ...(hadOAuth ? [{ label: '$(globe) Выйти из аккаунта Kimi (OAuth)', target: 'oauth' as const }] : []),
        ...(hadKey ? [{ label: '$(key) Удалить API-ключ', target: 'apiKey' as const }] : []),
        { label: '$(trash) Выйти везде', target: 'all' as const },
      ],
      { title: 'Kimi: выход' }
    );
    if (!what) return;
    if (what.target === 'oauth' || what.target === 'all') await logoutOAuth(context);
    if (what.target === 'apiKey' || what.target === 'all') await context.secrets.delete('kimi.apiKey');
    vscode.window.showInformationMessage('Kimi: вы вышли из аккаунта.');
    provider.postSettings();
  });

  cmd('kimi.newChat', () => provider.newChat());

  cmd('kimi.setMode', async () => {
    const modes: PermissionMode[] = ['plan', 'ask', 'autoEdit', 'fullAuto'];
    const current = getPermissionMode();
    const pick = await vscode.window.showQuickPick(
      modes.map((m) => ({
        label: m === current ? `$(check) ${PERMISSION_MODE_LABELS[m]}` : PERMISSION_MODE_LABELS[m],
        description:
          m === 'plan'
            ? 'Kimi только читает проект и составляет план'
            : m === 'ask'
              ? 'каждая правка и команда — с подтверждением'
              : m === 'autoEdit'
                ? 'файлы — без вопросов, команды — с подтверждением'
                : '⚠️ всё без вопросов, Kimi работает самостоятельно',
        mode: m,
      })),
      { title: 'Kimi: режим автономности' }
    );
    if (pick) await provider.applyMode(pick.mode);
  });

  cmd('kimi.setModel', async () => {
    let models = FALLBACK_MODELS;
    const auth = await ensureAuth(context);
    if (auth) {
      try {
        models = await listModels({ ...getApiConfig(), apiKey: auth.token, baseUrl: auth.baseUrl });
      } catch {
        // офлайн — используем встроенный список
      }
    }
    const current = getModel();
    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m,
        description: m === current ? '$(check) текущая' : '',
      })),
      { title: 'Kimi: выбор модели' }
    );
    if (pick) await provider.applyModel(pick.label);
  });

  cmd('kimi.explainSelection', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(`Объясни, что делает этот код:\n\`\`\`${s.editor.document.languageId}\n${s.text}\n\`\`\``);
  });

  cmd('kimi.fixSelection', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(`Найди и исправь ошибки в этом коде. Покажи исправленный вариант и кратко объясни, что было не так:\n\`\`\`${s.editor.document.languageId}\n${s.text}\n\`\`\``);
  });

  cmd('kimi.refactorSelection', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(`Отрефактори этот код: улучши читаемость и структуру, не меняя поведение:\n\`\`\`${s.editor.document.languageId}\n${s.text}\n\`\`\``);
  });

  cmd('kimi.addTests', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(`Напиши юнит-тесты для этого кода (подбери подходящий фреймворк по языку):\n\`\`\`${s.editor.document.languageId}\n${s.text}\n\`\`\``);
  });

  cmd('kimi.editSelection', () => editSelection(context));

  cmd('kimi.reviewChanges', () => provider.reviewChanges());

  cmd('kimi.sendSelectionToChat', () => provider.insertSelectionToInput());

  cmd('kimi.askAboutFile', () => provider.insertActiveFileToInput());

  cmd('kimi.openInEditor', () => provider.openInEditor());

  cmd('kimi.focus', () => vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`));

  cmd('kimi.showLogs', () => logChannel.show());
}

export function deactivate(): void {
  // ничего освобождать не нужно
}
