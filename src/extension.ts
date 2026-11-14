import * as vscode from 'vscode';
import { ChatViewProvider } from './chatPanel';
import {
  ensureApiKey,
  ensureAuth,
  getApiConfig,
  getAuthQuiet,
  getModel,
  getOpenInEditor,
  getPermissionMode,
  PERMISSION_MODE_LABELS,
  PermissionMode,
} from './config';
import { ApiConfig, ChatMessage, contextWindowForModel, FALLBACK_MODELS, fetchBalance, fetchPlanUsage, listModels, streamChat } from './api';
import { getAuthState } from './auth';
import { S, fmt, LOCALE, applyLanguage } from './i18n';

function selectedCode(): { editor: vscode.TextEditor; text: string; rel: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage(S.selectCodeFirst);
    return undefined;
  }
  const text = editor.document.getText(editor.selection);
  if (!text.trim()) {
    vscode.window.showWarningMessage(S.selEmpty);
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
    title: S.editTitle,
    prompt: S.editPrompt,
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const auth = await ensureAuth(context);
  if (!auth) return;
  const cfg: ApiConfig = { ...getApiConfig(), apiKey: auth.token, baseUrl: auth.baseUrl };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: S.editProgress },
    async () => {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            S.editSystem,
        },
        {
          role: 'user',
          content: fmt(S.editUserTpl, rel, doc.languageId, selText, instruction),
        },
      ];

      const res = await streamChat(cfg, messages);
      let code = res.content.trim();
      const m = code.match(/```\w*\n?([\s\S]*?)```/);
      code = m ? m[1].replace(/\n$/, '') : code;
      if (!code.trim()) {
        vscode.window.showErrorMessage(S.emptyAnswer);
        return;
      }

      const start = doc.offsetAt(range.start);
      const end = doc.offsetAt(range.end);
      const original = doc.getText();
      const modified = original.slice(0, start) + code + original.slice(end);

      const left = await vscode.workspace.openTextDocument({ content: original, language: doc.languageId });
      const right = await vscode.workspace.openTextDocument({ content: modified, language: doc.languageId });
      await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, fmt(S.diffTitle, rel));

      const pick = await vscode.window.showInformationMessage(
        S.applyConfirm,
        { modal: true },
        S.applyBtn
      );
      if (pick !== S.applyBtn) return;

      await editor.edit((b) => b.replace(range, code));
    }
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const logChannel = vscode.window.createOutputChannel('Kimi Code');
  context.subscriptions.push(logChannel);

  const provider = new ChatViewProvider(context, logChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Авторезюме: окно было перезапущено посреди прогона — задача не завершена.
  // Флаг снимаем сразу, чтобы не зациклиться; запускаем с паузой, давая окну собраться.
  const pendingRun = context.workspaceState.get<{ sessionId: string; at: number }>('kimi.pendingRun');
  if (pendingRun && Date.now() - pendingRun.at < 24 * 3600 * 1000) {
    void context.workspaceState.update('kimi.pendingRun', undefined);
    setTimeout(() => {
      void provider.resumePendingRun(pendingRun.sessionId);
    }, 5000);
  } else if (pendingRun) {
    void context.workspaceState.update('kimi.pendingRun', undefined);
  }

  // кнопка Kimi в статус-баре (справа внизу) со статусом аккаунта
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'kimi.accountMenu';
  context.subscriptions.push(statusBar);

  const updateStatusBar = async (): Promise<void> => {
    const st = await getAuthState(context);
    if (st.kind === 'none') {
      statusBar.text = S.sbSignIn;
      statusBar.tooltip = S.sbSignInTooltip;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBar.text = '$(sparkle) Kimi';
      statusBar.tooltip = fmt(S.sbTooltip, st.kind === 'oauth' ? fmt(S.sbAccount, st.label) : 'API-ключ', getModel());
      statusBar.backgroundColor = undefined;
    }
    statusBar.show();
  };
  void updateStatusBar();

  // синхронизация флагов настроек с веб-панелью
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kimi.language')) {
        applyLanguage();
        provider.refreshLocale();
      }
      if (e.affectsConfiguration('kimi')) {
        provider.postSettings();
        void updateStatusBar();
      }
    })
  );

  const cmd = (id: string, fn: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('kimi.setApiKey', async () => {
    await ensureApiKey(context, true);
    vscode.window.showInformationMessage(S.keySaved);
    void provider.postAuthState();
    void updateStatusBar();
  });

  // принудительная смена языка интерфейса (меню аккаунта в чате → «🌐 Язык / Language»)
  cmd('kimi.setLanguage', async () => {
    const cfg = vscode.workspace.getConfiguration('kimi');
    const cur = cfg.get<string>('language', 'auto');
    const items = [
      { label: S.langAuto, value: 'auto' },
      { label: 'Русский', value: 'ru' },
      { label: 'English', value: 'en' },
    ].map((it) => ({ ...it, description: it.value === cur ? S.currentMark : '' }));
    const pick = await vscode.window.showQuickPick(items, { title: S.langTitle });
    if (!pick || pick.value === cur) return;
    await cfg.update('language', pick.value, vscode.ConfigurationTarget.Global);
  });

  cmd('kimi.login', async () => {
    const { loginInteractive } = await import('./auth');
    const ok = await loginInteractive(context);
    if (ok) {
      provider.postSettings();
      void provider.postAuthState();
      void updateStatusBar();
    }
  });

  // внутренняя команда: прямой выход без QuickPick (из меню веб-панели)
  cmd('kimi.logoutDirect', async (target?: string) => {
    const { logoutOAuth } = await import('./auth');
    if (target === 'oauth' || target === 'all') await logoutOAuth(context);
    if (target === 'apiKey' || target === 'all') await context.secrets.delete('kimi.apiKey');
    vscode.window.showInformationMessage(S.loggedOut);
    void provider.postAuthState();
    void updateStatusBar();
  });

  cmd('kimi.accountMenu', async () => {
    const st = await getAuthState(context);
    if (st.kind === 'none') {
      await vscode.commands.executeCommand('kimi.login');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: S.menuChat, id: 'chat' },
        { label: S.menuUsage, id: 'usage' },
        { label: S.menuModel, id: 'model' },
        { label: S.menuMode, id: 'mode' },
        { label: S.menuRelogin, id: 'relogin' },
        { label: S.menuLogout, id: 'logout' },
      ],
      { title: 'Kimi: ' + (st.kind === 'oauth' ? fmt(S.sbAccount, st.label) : 'API-ключ') }
    );
    if (!pick) return;
    if (pick.id === 'chat') await vscode.commands.executeCommand('kimi.focus');
    if (pick.id === 'usage') await vscode.commands.executeCommand('kimi.showUsage');
    if (pick.id === 'model') await vscode.commands.executeCommand('kimi.setModel');
    if (pick.id === 'mode') await vscode.commands.executeCommand('kimi.setMode');
    if (pick.id === 'relogin') await vscode.commands.executeCommand('kimi.login');
    if (pick.id === 'logout') await vscode.commands.executeCommand('kimi.logout');
  });

  cmd('kimi.showUsage', async () => {
    const auth = await getAuthQuiet(context);
    if (!auth) {
      vscode.window.showInformationMessage(S.signInFirst);
      return;
    }
    const model = getModel();
    const win = contextWindowForModel(model);
    const info = provider.getUsageInfo();
    const pct = info.lastPromptTokens > 0 ? Math.round((info.lastPromptTokens / win) * 100) : 0;
    const lines: string[] = [
      fmt(S.usageModel, model, Math.round(win / 1024)),
      fmt(S.usageContext, info.lastPromptTokens.toLocaleString(LOCALE), pct),
      fmt(S.usageSession, info.sessionTokens.toLocaleString(LOCALE)),
    ];
    if (auth.kind === 'apiKey') {
      const bal = await fetchBalance(auth.baseUrl, auth.token);
      lines.push(
        bal
          ? fmt(S.usageBalance, bal.available.toFixed(2), bal.cash.toFixed(2), bal.voucher.toFixed(2))
          : S.usageBalanceFail
      );
    } else {
      try {
        const u = await fetchPlanUsage(auth.baseUrl, auth.token);
        const fmtPct = (e?: { usedRatio: number }) =>
          e ? `${(e.usedRatio * 100).toFixed(1)}%` : '—';
        const fmtReset = (e?: { resetAt?: string }) => {
          if (!e?.resetAt) return '';
          const d = new Date(e.resetAt);
          return Number.isNaN(d.getTime())
            ? ''
            : fmt(S.usageReset, d.toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
        };
        if (u.planName) lines.push(fmt(S.usagePlan, u.planName));
        lines.push(fmt(S.usage5h, fmtPct(u.limit5h), fmtReset(u.limit5h)));
        if (u.limit7d) lines.push(fmt(S.usage7d, fmtPct(u.limit7d), fmtReset(u.limit7d)));
        if (u.monthTotal) lines.push(fmt(S.usageMonthTotal, fmtPct(u.monthTotal), fmtReset(u.monthTotal)));
        if (u.monthCode) lines.push(fmt(S.usageMonthCode, fmtPct(u.monthCode), fmtReset(u.monthCode)));
        if (u.extraBalanceCents != null) {
          lines.push(`Extra Usage: ${(u.extraBalanceCents / 100).toFixed(2)} ${u.extraCurrency ?? ''}`);
        }
      } catch (e) {
        lines.push(fmt(S.usageLimitsFail, e instanceof Error ? e.message : String(e)));
      }
    }
    const openBtn = S.openConsole;
    const r = await vscode.window.showInformationMessage(
      S.usageTitle,
      { modal: true, detail: lines.join('\n') },
      openBtn
    );
    if (r === openBtn) {
      void vscode.env.openExternal(vscode.Uri.parse('https://code.kimi.com/kimi-code'));
    }
  });

  cmd('kimi.logout', async () => {
    const { hasOAuthLogin, logoutOAuth } = await import('./auth');
    const hadOAuth = await hasOAuthLogin(context);
    const hadKey = (await context.secrets.get('kimi.apiKey')) !== undefined;
    if (!hadOAuth && !hadKey) {
      vscode.window.showInformationMessage(S.notSignedIn);
      return;
    }
    const what = await vscode.window.showQuickPick(
      [
        ...(hadOAuth ? [{ label: S.logoutOauthItem, target: 'oauth' as const }] : []),
        ...(hadKey ? [{ label: S.logoutKeyItem, target: 'apiKey' as const }] : []),
        { label: S.logoutAllItem, target: 'all' as const },
      ],
      { title: S.logoutTitle }
    );
    if (!what) return;
    if (what.target === 'oauth' || what.target === 'all') await logoutOAuth(context);
    if (what.target === 'apiKey' || what.target === 'all') await context.secrets.delete('kimi.apiKey');
    vscode.window.showInformationMessage(S.loggedOut);
    provider.postSettings();
    void provider.postAuthState();
    void updateStatusBar();
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
            ? S.modeDescPlan
            : m === 'ask'
              ? S.modeDescAsk
              : m === 'autoEdit'
                ? S.modeDescAutoEdit
                : S.modeDescFullAuto,
        mode: m,
      })),
      { title: S.modeTitle }
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
        description: m === current ? S.currentMark : '',
      })),
      { title: S.modelTitle }
    );
    if (pick) await provider.applyModel(pick.label);
  });

  cmd('kimi.explainSelection', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(fmt(S.explainPrompt, s.editor.document.languageId, s.text));
  });

  cmd('kimi.fixSelection', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(fmt(S.fixPrompt, s.editor.document.languageId, s.text));
  });

  cmd('kimi.refactorSelection', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(fmt(S.refactorPrompt, s.editor.document.languageId, s.text));
  });

  cmd('kimi.addTests', () => {
    const s = selectedCode();
    if (s) void provider.askFromCommand(fmt(S.testsPrompt, s.editor.document.languageId, s.text));
  });

  cmd('kimi.editSelection', () => editSelection(context));

  cmd('kimi.reviewChanges', () => provider.reviewChanges());

  cmd('kimi.sendSelectionToChat', () => provider.insertSelectionToInput());

  cmd('kimi.askAboutFile', () => provider.insertActiveFileToInput());

  cmd('kimi.openInEditor', () => provider.openInEditor());

  cmd('kimi.focus', () => {
    // режим «чат в центре» — фокус на вкладку редактора, иначе на сайдбар
    if (getOpenInEditor()) provider.openInEditor();
    else void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  });

  cmd('kimi.showLogs', () => logChannel.show());

  // Восстановление вкладки «Kimi Чат» в редакторе после перезапуска окна.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('kimi.chatPanel', {
      // eslint-disable-next-line @typescript-eslint/require-await
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        provider.attachEditorPanel(panel);
      },
    })
  );
}

export function deactivate(): void {
  // ничего освобождать не нужно
}
