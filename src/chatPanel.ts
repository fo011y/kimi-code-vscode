import * as vscode from 'vscode';
import { ApiConfig, ChatMessage, FALLBACK_MODELS, listModels, streamChat, TokenUsage } from './api';
import { runAgentLoop } from './agent';
import { getAuthState } from './auth';
import { CheckpointEntry, CheckpointStore } from './checkpoints';
import { autoDeployIfEnabled, autoPushIfEnabled, consumeChangesMade, setSnapshotHook } from './tools';
import {
  ensureAuth,
  getAuthQuiet,
  getApiConfig,
  getAttachOpenFile,
  getAttachSelection,
  getModel,
  getPermissionMode,
  getShowTimestamps,
  getUseCtrlEnterToSend,
  isPlanMode,
  setModel,
  setPermissionMode,
  PermissionMode,
} from './config';

const SESSIONS_KEY = 'kimi.sessions';
const ACTIVE_KEY = 'kimi.activeSession';

const HELP_TEXT = [
  '/clear — новый диалог (сброс контекста)',
  '/compact — сжать историю диалога в сводку',
  '/review — изменения за сессию: diff и откат (checkpoints)',
  '/plan, /ask, /auto, /fullauto — переключить режим автономности',
  '@путь/к/файлу — прикрепить файл к вопросу',
].join('\n');

interface Session {
  id: string;
  title: string;
  history: ChatMessage[];
  updatedAt: number;
}

function systemPrompt(workspaceRoot: string | undefined, plan: boolean): string {
  const lines = [
    'Ты — Kimi, AI-ассистент программиста, встроенный в VS Code.',
    workspaceRoot ? `Рабочая папка проекта: ${workspaceRoot}` : 'Папка проекта не открыта.',
    'Всегда отвечай на языке пользователя.',
    'Код оформляй в markdown-блоках с указанием языка.',
    'В агентском режиме: сначала изучи нужные файлы инструментами read_file / list_files / search_in_files,',
    'затем вносите изменения через write_file. Не выполняй разрушительных команд.',
    'После правок проверяй проект инструментом get_diagnostics и исправляй появившиеся ошибки.',
    'Когда задача полностью выполнена и пользователь просил сохранить результат на GitHub — вызывай git_push с кратким сообщением коммита.',
    'Если пользователь просил задеплоить/опубликовать проект — после завершения правок вызывай deploy.',
    'Будь краток в пояснениях, но полон в коде.',
  ];
  if (plan) {
    lines.push(
      'РЕЖИМ ПЛАНИРОВАНИЯ: тебе доступны ТОЛЬКО инструменты чтения. Ничего не изменяй и не запускай. ' +
        'Изучи проект и составь подробный пошаговый план: какие файлы менять, что именно делать, в каком порядке. ' +
        'План выведи в конце ответа нумерованным списком.'
    );
  }
  return lines.join('\n');
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'kimi.chatView';

  private webviews = new Set<vscode.Webview>();
  private pending: Array<{ text: string; agent: boolean }> = [];
  private sessions: Session[] = [];
  private activeId = '';
  private checkpointStores = new Map<string, CheckpointStore>();
  private abort?: AbortController;
  private busy = false;
  private sessionTokens = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    this.sessions = context.workspaceState.get<Session[]>(SESSIONS_KEY, []);
    if (this.sessions.length === 0) {
      this.sessions.push({ id: String(Date.now()), title: 'Новый диалог', history: [], updatedAt: Date.now() });
    }
    const savedActive = context.workspaceState.get<string>(ACTIVE_KEY, '');
    this.activeId = this.sessions.some((s) => s.id === savedActive) ? savedActive : this.sessions[0].id;

    setSnapshotHook((abs) => {
      const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!r) return;
      try {
        this.checkpointsFor().snapshot(abs, r);
      } catch {
        // снимок не критичен
      }
    });
  }

  // ---------- сессии ----------

  private active(): Session {
    return this.sessions.find((s) => s.id === this.activeId) ?? this.sessions[0];
  }

  private checkpointsFor(): CheckpointStore {
    let st = this.checkpointStores.get(this.activeId);
    if (!st) {
      st = new CheckpointStore(this.context.globalStorageUri.fsPath, this.activeId);
      this.checkpointStores.set(this.activeId, st);
    }
    return st;
  }

  private saveSessions(): void {
    this.active().updatedAt = Date.now();
    void this.context.workspaceState.update(
      SESSIONS_KEY,
      this.sessions.map((s) => ({ ...s, history: s.history.slice(-100) }))
    );
    void this.context.workspaceState.update(ACTIVE_KEY, this.activeId);
  }

  private postSessions(): void {
    this.post({
      type: 'sessions',
      items: this.sessions.map((s) => ({ id: s.id, title: s.title, active: s.id === this.activeId })),
    });
  }

  private postHistory(): void {
    this.post({
      type: 'history',
      items: this.active().history.map((h) => ({ role: h.role, content: h.content ?? '' })),
    });
  }

  private createSession(): void {
    const s: Session = { id: String(Date.now()), title: 'Новый диалог', history: [], updatedAt: Date.now() };
    this.sessions.push(s);
    this.activeId = s.id;
    this.saveSessions();
    this.post({ type: 'clear' });
    this.postSessions();
  }

  private switchSession(id: string): void {
    if (id === this.activeId || !this.sessions.some((s) => s.id === id)) return;
    this.activeId = id;
    this.saveSessions();
    this.post({ type: 'clear' });
    this.postHistory();
    this.postSessions();
  }

  private deleteSession(id: string): void {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.sessions.splice(idx, 1);
    this.checkpointStores.delete(id);
    if (this.sessions.length === 0) {
      this.createSession();
      return;
    }
    if (this.activeId === id) {
      this.activeId = this.sessions[Math.max(0, idx - 1)].id;
      this.post({ type: 'clear' });
      this.postHistory();
    }
    this.saveSessions();
    this.postSessions();
  }

  private renameSession(id: string, title: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || !title.trim()) return;
    s.title = title.trim().slice(0, 60);
    this.saveSessions();
    this.postSessions();
  }

  newChat(): void {
    this.createSession();
  }

  // ---------- веб-панели ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attachWebview(view.webview);
    view.onDidDispose(() => this.webviews.delete(view.webview));
    const queued = this.pending.splice(0);
    for (const item of queued) void this.handleAsk(item.text, item.agent);
  }

  /** Открыть чат во вкладке редактора (та же сессия, зеркало сайдбара). */
  openInEditor(): void {
    const panel = vscode.window.createWebviewPanel(
      'kimi.chatPanel',
      'Kimi Чат',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.attachWebview(panel.webview);
    panel.onDidDispose(() => this.webviews.delete(panel.webview));
  }

  private attachWebview(webview: vscode.Webview): void {
    this.webviews.add(webview);
    webview.options = { enableScripts: true };
    webview.html = getHtml(webview);
    // Инициализируем только после сигнала 'ready' от webview:
    // иначе начальные сообщения (сессии, история) могут прийти
    // до установки обработчика в странице и потеряться — чат выглядит пустым.
    let inited = false;
    const initOnce = () => {
      if (inited) return;
      inited = true;
      this.initWebview(webview);
    };
    webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ready') {
        initOnce();
        return;
      }
      void this.onMessage(m);
    });
    setTimeout(initOnce, 1500); // запасной вариант на случай потери 'ready'
  }

  private initWebview(webview: vscode.Webview): void {
    const send = (m: unknown) => void webview.postMessage(m);
    send({ type: 'mode', mode: getPermissionMode() });
    send({
      type: 'settings',
      ctrlEnter: getUseCtrlEnterToSend(),
      timestamps: getShowTimestamps(),
    });
    send({
      type: 'sessions',
      items: this.sessions.map((s) => ({ id: s.id, title: s.title, active: s.id === this.activeId })),
    });
    if (this.active().history.length > 0) {
      send({
        type: 'history',
        items: this.active().history.map((h) => ({ role: h.role, content: h.content ?? '' })),
      });
    }
    void this.refreshModels();
    void this.postAuthState();
  }

  /** Отправить состояние аккаунта (кнопка входа) во все веб-панели. */
  async postAuthState(): Promise<void> {
    const st = await getAuthState(this.context);
    this.post({
      type: 'auth',
      state: st.kind === 'oauth' ? { kind: 'oauth', label: st.label } : { kind: st.kind },
    });
  }

  /** Переслать флаги настроек во все веб-панели (при изменении конфигурации). */
  postSettings(): void {
    this.post({
      type: 'settings',
      ctrlEnter: getUseCtrlEnterToSend(),
      timestamps: getShowTimestamps(),
    });
  }

  private async onMessage(m: any): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    switch (m?.type) {
      case 'ask':
        await this.handleAsk(String(m.text ?? ''), !!m.agent);
        break;
      case 'cancel':
        this.abort?.abort();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'setMode':
        await this.applyMode(m.mode);
        break;
      case 'setModel':
        await this.applyModel(String(m.model ?? ''));
        break;
      case 'refreshModels':
        await this.refreshModels();
        break;
      case 'authAction':
        if (m.action === 'relogin') await vscode.commands.executeCommand('kimi.login');
        else if (m.action === 'rekey') await vscode.commands.executeCommand('kimi.setApiKey');
        else if (m.action === 'logoutOAuth') await vscode.commands.executeCommand('kimi.logoutDirect', 'oauth');
        else if (m.action === 'clearKey') await vscode.commands.executeCommand('kimi.logoutDirect', 'apiKey');
        break;
      case 'newSession':
        this.createSession();
        break;
      case 'switchSession':
        this.switchSession(String(m.id));
        break;
      case 'deleteSession':
        this.deleteSession(String(m.id));
        break;
      case 'renameSession':
        this.renameSession(String(m.id), String(m.title ?? ''));
        break;
      case 'diffFile':
        if (root) {
          const e = this.checkpointsFor().find(String(m.file));
          if (e) await this.checkpointsFor().showDiff(e, root);
        }
        break;
      case 'acceptFile':
        this.discardFile(String(m.file));
        break;
      case 'rejectFile':
        await this.revertFile(String(m.file));
        break;
      case 'acceptAll':
        this.checkpointsFor().discardAll();
        this.postReviewUpdate();
        break;
      case 'rejectAll':
        if (root) {
          await this.checkpointsFor().revertAll(root);
          this.postReviewUpdate();
        }
        break;
    }
  }

  private discardFile(rel: string): void {
    const e = this.checkpointsFor().find(rel);
    if (e) {
      this.checkpointsFor().discard(e);
      this.postReviewUpdate();
    }
  }

  private async revertFile(rel: string): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const e = this.checkpointsFor().find(rel);
    if (root && e) {
      await this.checkpointsFor().revert(e, root);
      this.log.appendLine(`[review] откачен файл: ${rel}`);
      this.postReviewUpdate();
    }
  }

  private postReviewUpdate(): void {
    this.post({
      type: 'reviewUpdate',
      files: this.checkpointsFor().list().map((e) => ({ file: e.file, created: !e.existed })),
    });
  }

  // ---------- модель и режим ----------

  /** Переключение модели из чата или команды. */
  async applyModel(model: string): Promise<void> {
    if (!model.trim()) return;
    await setModel(model.trim());
    this.post({ type: 'model', model: model.trim() });
  }

  /** Загрузить список моделей с API и отправить в веб-панель. */
  async refreshModels(): Promise<void> {
    let models = FALLBACK_MODELS;
    try {
      const auth = await getAuthQuiet(this.context);
      if (auth) {
        models = await listModels({ ...getApiConfig(), apiKey: auth.token, baseUrl: auth.baseUrl });
      }
    } catch {
      // оставляем встроенный список
    }
    const current = getModel();
    if (!models.includes(current)) models = [current, ...models];
    this.post({ type: 'modelList', models, current });
  }

  /** Переключение режима автономности из чата или команды. */
  async applyMode(mode: PermissionMode): Promise<void> {
    if (mode !== 'plan' && mode !== 'ask' && mode !== 'autoEdit' && mode !== 'fullAuto') return;
    await setPermissionMode(mode);
    this.post({ type: 'mode', mode });
    if (mode === 'fullAuto') {
      vscode.window.showWarningMessage(
        'Kimi: включён режим полной автономности — правки файлов и команды выполняются без подтверждения.'
      );
    }
  }

  /** Вызов из команды (контекстное меню редактора и т.п.). */
  async askFromCommand(text: string, agent = false): Promise<void> {
    if (this.webviews.size === 0) {
      this.pending.push({ text, agent });
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
      return;
    }
    await this.handleAsk(text, agent);
  }

  /** Горячая клавиша: вставить ссылку на выделенный файл в поле ввода чата. */
  async insertSelectionToInput(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) {
      vscode.window.showWarningMessage('Сначала выделите код в редакторе.');
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    if (this.webviews.size === 0) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
    this.post({ type: 'insertText', text: `@${rel} ` });
  }

  /** Кнопка в заголовке редактора: вставить @-упоминание активного файла в поле ввода. */
  async insertActiveFileToInput(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      vscode.window.showWarningMessage('Откройте файл в редакторе.');
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    if (this.webviews.size === 0) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
    const mention = ed.selection.isEmpty
      ? `@${rel} `
      : `@${rel} (строки ${ed.selection.start.line + 1}–${ed.selection.end.line + 1}) `;
    this.post({ type: 'insertText', text: mention });
  }

  /** Review-панель (QuickPick): все изменённые за сессию файлы с diff и откатом. */
  async reviewChanges(): Promise<void> {
    const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootDir) {
      vscode.window.showWarningMessage('Откройте папку проекта.');
      return;
    }
    const cp = this.checkpointsFor();
    const entries = cp.list();
    if (entries.length === 0) {
      vscode.window.showInformationMessage('За эту сессию Kimi ещё не менял файлы.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(discard) Откатить ВСЕ изменения сессии',
          description: `${entries.length} файл(ов)`,
          entry: undefined as CheckpointEntry | undefined,
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator, entry: undefined },
        ...entries.map((e) => ({
          label: `$(file) ${e.file}`,
          description: e.existed ? 'изменён' : 'создан',
          entry: e as CheckpointEntry | undefined,
        })),
      ],
      { title: 'Kimi: изменения за сессию (checkpoints)' }
    );
    if (!pick) return;

    if (!pick.entry) {
      const ok = await vscode.window.showWarningMessage(
        `Откатить все изменения сессии (${entries.length} файл(ов))?`,
        { modal: true },
        'Откатить всё'
      );
      if (ok === 'Откатить всё') {
        const n = await cp.revertAll(rootDir);
        vscode.window.showInformationMessage(`Kimi: откачено файлов: ${n}.`);
        this.postReviewUpdate();
      }
      return;
    }

    const entry = pick.entry;
    await cp.showDiff(entry, rootDir);
    const action = await vscode.window.showInformationMessage(
      `Откатить «${entry.file}» к состоянию до правок Kimi?`,
      { modal: true },
      'Откатить'
    );
    if (action === 'Откатить') {
      await cp.revert(entry, rootDir);
      vscode.window.showInformationMessage(`Kimi: файл откачен: ${entry.file}`);
      this.postReviewUpdate();
    }
  }

  private post(m: unknown): void {
    for (const w of this.webviews) void w.postMessage(m);
  }

  // ---------- контекст ----------

  /** Сборка полного контекста вопроса: @файлы, выделение, открытый файл, диагностика IDE. */
  private async buildUserContent(userText: string): Promise<string> {
    let full = userText;

    // @-упоминания файлов
    const mentions = new Set<string>();
    const re = /(?:^|\s)@([^\s@]+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(userText)) !== null) mentions.add(mm[1]);
    let attached = 0;
    for (const token of mentions) {
      if (attached >= 4) break;
      try {
        let files = await vscode.workspace.findFiles(token, '**/node_modules/**', 1);
        if (files.length === 0) files = await vscode.workspace.findFiles(`**/${token}`, '**/node_modules/**', 1);
        if (files.length === 0) continue;
        const doc = await vscode.workspace.openTextDocument(files[0]);
        const rel = vscode.workspace.asRelativePath(files[0]);
        full += `\n\nФайл \`${rel}\` (прикреплён через @):\n\`\`\`${doc.languageId}\n${doc.getText().slice(0, 6000)}\n\`\`\``;
        attached++;
      } catch {
        // файл не найден — пропускаем
      }
    }

    const ed = vscode.window.activeTextEditor;

    // выделенный код
    let selectionAttached = false;
    if (ed && getAttachSelection() && !ed.selection.isEmpty) {
      const sel = ed.document.getText(ed.selection);
      if (sel.trim()) {
        const rel = vscode.workspace.asRelativePath(ed.document.uri);
        full += `\n\nВыделенный код из \`${rel}\`:\n\`\`\`${ed.document.languageId}\n${sel.slice(0, 8000)}\n\`\`\``;
        selectionAttached = true;
      }
    }

    // открытый файл целиком (если включено и выделения нет)
    if (ed && getAttachOpenFile() && !selectionAttached) {
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      full += `\n\nОткрытый файл \`${rel}\`:\n\`\`\`${ed.document.languageId}\n${ed.document.getText().slice(0, 8000)}\n\`\`\``;
    }

    // диагностика активного файла (ошибки/предупреждения линтера)
    if (ed) {
      const diags = vscode.languages
        .getDiagnostics(ed.document.uri)
        .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
        .slice(0, 5);
      if (diags.length > 0) {
        const rel = vscode.workspace.asRelativePath(ed.document.uri);
        const lines = diags.map(
          (d) =>
            `- строка ${d.range.start.line + 1}: [${d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN'}] ${d.message.split('\n')[0].slice(0, 200)}`
        );
        full += `\n\nДиагностика IDE для \`${rel}\`:\n${lines.join('\n')}`;
      }
    }

    return full;
  }

  // ---------- слэш-команды ----------

  private async handleSlash(text: string): Promise<boolean> {
    const cmd = text.split(/\s/)[0].toLowerCase();
    switch (cmd) {
      case '/clear':
        this.newChat();
        return true;
      case '/review':
        await this.reviewChanges();
        return true;
      case '/compact':
        await this.compactHistory();
        return true;
      case '/plan':
        await this.applyMode('plan');
        return true;
      case '/ask':
        await this.applyMode('ask');
        return true;
      case '/auto':
        await this.applyMode('autoEdit');
        return true;
      case '/fullauto':
        await this.applyMode('fullAuto');
        return true;
      case '/help':
        this.post({ type: 'info', text: HELP_TEXT });
        return true;
      default:
        return false;
    }
  }

  /** /compact: сжать историю диалога в сводку через модель. */
  private async compactHistory(): Promise<void> {
    const hist = this.active().history;
    if (hist.length === 0) {
      this.post({ type: 'info', text: 'История пуста — сжимать нечего.' });
      return;
    }
    const auth = await ensureAuth(this.context);
    if (!auth) return;
    const cfg: ApiConfig = { ...getApiConfig(), apiKey: auth.token, baseUrl: auth.baseUrl };
    this.post({ type: 'info', text: '🗜 Сжимаю историю диалога…' });
    try {
      const transcript = hist
        .map((m) => `${m.role}: ${m.content ?? ''}`)
        .join('\n\n')
        .slice(0, 24000);
      const res = await streamChat(cfg, [
        {
          role: 'system',
          content:
            'Сожми диалог программиста с AI-ассистентом в краткую сводку (10–15 пунктов): цели, принятые решения, изменённые файлы, важный технический контекст. Пиши на языке диалога.',
        },
        { role: 'user', content: transcript },
      ]);
      this.active().history = [
        { role: 'user', content: `Сводка предыдущего диалога:\n${res.content}` },
        { role: 'assistant', content: 'Принято. Продолжаем с учётом этой сводки.' },
      ];
      this.saveSessions();
      this.post({
        type: 'info',
        text: `🗜 История сжата в сводку (${res.usage?.total_tokens ?? '?'} токенов).`,
      });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---------- основной цикл ----------

  private async handleAsk(userText: string, agent: boolean): Promise<void> {
    const trimmed = userText.trim();
    if (!trimmed || this.busy) return;

    if (trimmed.startsWith('/') && (await this.handleSlash(trimmed))) return;

    this.busy = true;
    this.abort = new AbortController();

    this.post({ type: 'user', text: userText });
    this.post({ type: 'start' });

    try {
      const auth = await ensureAuth(this.context);
      if (!auth) {
        this.post({ type: 'error', text: 'Вы не вошли в аккаунт. Выполните команду «Kimi: Войти через сайт» или «Kimi: Указать API-ключ».' });
        return;
      }
      const cfg: ApiConfig = { ...getApiConfig(), apiKey: auth.token, baseUrl: auth.baseUrl };

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const plan = isPlanMode();
      const userContent = await this.buildUserContent(userText);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt(root, plan) },
        ...this.active().history.slice(-20),
        { role: 'user', content: userContent },
      ];

      let acc = '';
      let requestTokens = 0;
      const onToken = (t: string) => {
        acc += t;
        this.post({ type: 'delta', text: t });
      };
      const onUsage = (u: TokenUsage) => {
        requestTokens += u.total_tokens;
        this.sessionTokens += u.total_tokens;
        this.post({ type: 'usage', request: requestTokens, session: this.sessionTokens });
      };

      if (agent) {
        consumeChangesMade(); // сбросить флаг изменений от прошлой задачи
        await runAgentLoop(cfg, messages, {
          onToken,
          onUsage,
          onTool: (name, status, detail) => {
            this.log.appendLine(`[tool] ${name} → ${status}${detail ? `: ${detail}` : ''}`);
            this.post({ type: 'tool', name, status, detail });
          },
          signal: this.abort.signal,
        });

        // автопайплайн: пуш на GitHub → деплой (срабатывает, если включено и агент менял файлы)
        const changed = consumeChangesMade();
        const pipeline: Array<[string, () => Promise<string | null>]> = [
          ['git_push (auto)', () => autoPushIfEnabled(changed, userText)],
          ['deploy (auto)', () => autoDeployIfEnabled(changed)],
        ];
        for (const [label, fn] of pipeline) {
          try {
            const out = await fn();
            if (out !== null) {
              this.post({ type: 'tool', name: label, status: 'done', detail: out.split('\n')[0].slice(0, 120) });
            }
          } catch (pe) {
            this.post({
              type: 'tool',
              name: label,
              status: 'error',
              detail: pe instanceof Error ? pe.message : String(pe),
            });
          }
        }

        // панель принятия правок: файлы, изменённые агентом за сессию
        if (changed) this.postReviewUpdate();
      } else {
        const res = await streamChat(cfg, messages, { onToken, signal: this.abort.signal });
        if (res.usage) onUsage(res.usage);
      }

      // авто-название сессии по первому сообщению
      if (this.active().title === 'Новый диалог') {
        this.active().title = userText.replace(/\s+/g, ' ').slice(0, 30);
        this.postSessions();
      }

      this.active().history.push(
        { role: 'user', content: userContent },
        { role: 'assistant', content: acc }
      );
      this.saveSessions();
      this.post({ type: 'done' });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        this.post({ type: 'done', aborted: true });
      } else {
        this.log.appendLine(`[error] ${e?.message ?? String(e)}`);
        this.post({ type: 'error', text: e?.message ?? String(e) });
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---------- HTML веб-панели ----------

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function getHtml(webview: vscode.Webview): string {
  const n = nonce();
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex; flex-direction: column; height: 100vh;
  }
  #tabs {
    display: flex; flex-wrap: wrap; gap: 2px; padding: 4px 6px 0 6px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .tab {
    font-size: 0.8em; padding: 3px 8px; cursor: pointer; opacity: 0.7;
    border-radius: 4px 4px 0 0; max-width: 140px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; user-select: none;
  }
  .tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .tab.active {
    opacity: 1; background: var(--vscode-input-background);
    border-bottom: 2px solid var(--vscode-textLink-foreground);
  }
  .tab .x { margin-left: 6px; opacity: 0.5; }
  .tab .x:hover { opacity: 1; color: var(--vscode-errorForeground); }
  .tab.plus { font-weight: bold; }
  #messages { flex: 1; overflow-y: auto; padding: 10px; }
  .msg { margin-bottom: 12px; padding: 8px 10px; border-radius: 6px; line-height: 1.45; word-wrap: break-word; }
  .msg.user {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    white-space: pre-wrap;
  }
  .msg.assistant { background: transparent; padding: 2px 2px; }
  .msg.error {
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    white-space: pre-wrap;
  }
  .msg pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 8px; border-radius: 4px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
  }
  .msg code { font-family: var(--vscode-editor-font-family); }
  .ts { font-size: 0.7em; opacity: 0.5; display: block; margin-bottom: 2px; }
  .tool {
    font-size: 0.85em; opacity: 0.85; margin: 4px 0 4px 8px;
    padding: 3px 8px; border-left: 2px solid var(--vscode-textLink-foreground);
    white-space: pre-wrap;
  }
  .tool.error { border-left-color: var(--vscode-errorForeground); }
  .toolgroup { margin: 6px 0; }
  .toolgroup .tg-head {
    font-size: 0.85em; opacity: 0.9; cursor: pointer; user-select: none;
    padding: 2px 0;
  }
  .toolgroup .tg-head:hover { opacity: 1; }
  .toolgroup .tg-list { display: block; }
  .toolgroup.collapsed .tg-list { display: none; }
  .toolgroup.collapsed .tg-head { opacity: 0.7; }
  .authwrap { position: relative; }
  .authmenu {
    position: absolute; bottom: 30px; right: 0; z-index: 20; min-width: 220px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-editor-foreground));
    border: 1px solid var(--vscode-menu-border, #454545);
    border-radius: 6px; padding: 4px 0;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
  }
  .authmenu .mi {
    padding: 6px 14px; cursor: pointer; font-size: 0.92em;
    white-space: nowrap; user-select: none;
  }
  .authmenu .mi:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, inherit);
  }
  .authmenu .mi.head { opacity: 0.55; cursor: default; }
  .authmenu .mi.head:hover { background: transparent; }
  .authmenu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-border, #454545); }
  .review {
    margin: 8px 0; padding: 8px; border-radius: 6px;
    border: 1px solid var(--vscode-textLink-foreground);
    background: var(--vscode-input-background);
  }
  .rhead { font-weight: bold; margin-bottom: 6px; }
  .rrow { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .rfile {
    flex: 1; font-size: 0.85em; cursor: pointer; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-editor-font-family);
  }
  .rfile:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .rrow button { padding: 2px 8px; font-size: 0.85em; }
  #inputArea {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 8px;
  }
  #input {
    width: 100%; min-height: 56px; resize: vertical;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 6px;
    font-family: var(--vscode-font-family);
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; align-items: center; margin-top: 6px; gap: 8px; }
  .row label { font-size: 0.85em; opacity: 0.85; display: flex; align-items: center; gap: 4px; cursor: pointer; }
  .spacer { flex: 1; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 4px; padding: 5px 12px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 4px; padding: 3px 4px; font-size: 0.85em;
    max-width: 150px;
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  #hint { font-size: 0.8em; opacity: 0.6; margin-top: 4px; }
  #usage { font-size: 0.75em; opacity: 0.55; margin-top: 2px; min-height: 1em; }
</style>
</head>
<body>
  <div id="tabs"></div>
  <div id="messages"></div>
  <div id="inputArea">
    <textarea id="input" placeholder="Спросите Kimi… (Enter — отправить, @файл — прикрепить, /help — команды)"></textarea>
    <div class="row">
      <label><input type="checkbox" id="agent" checked> Агент</label>
      <select id="mode" title="Режим автономности">
        <option value="plan">Планирование</option>
        <option value="ask">Спросить всегда</option>
        <option value="autoEdit">Авто-правки</option>
        <option value="fullAuto">Полная автономность</option>
      </select>
      <button id="newChat" class="secondary" title="Новая сессия">Новый чат</button>
      <span class="spacer"></span>
      <button id="send">Отправить</button>
    </div>
    <div class="row">
      <label title="Модель Kimi">Модель</label>
      <select id="model" title="Модель Kimi"></select>
      <button id="refreshModels" class="secondary" title="Обновить список моделей с API">⟳</button>
      <span class="spacer"></span>
      <span class="authwrap">
        <button id="authBtn" class="secondary" title="Аккаунт Kimi: вход, статус, выход">…</button>
        <div id="authMenu" class="authmenu" style="display:none"></div>
      </span>
    </div>
    <div id="hint"></div>
    <div id="usage"></div>
  </div>
<script nonce="${n}">
(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var tabsEl = document.getElementById('tabs');
  var inputEl = document.getElementById('input');
  var agentEl = document.getElementById('agent');
  var sendBtn = document.getElementById('send');
  var newChatBtn = document.getElementById('newChat');
  var modeEl = document.getElementById('mode');
  var modelEl = document.getElementById('model');
  var refreshModelsBtn = document.getElementById('refreshModels');
  var authBtn = document.getElementById('authBtn');
  var hintEl = document.getElementById('hint');
  var usageEl = document.getElementById('usage');

  var settings = { ctrlEnter: false, timestamps: false };

  var HINTS = {
    plan: '📋 Планирование: Kimi только читает проект и составляет план — ничего не меняет.',
    ask: 'Агентский режим: Kimi читает проект, но каждая правка и команда — с вашего подтверждения.',
    autoEdit: 'Авто-правки: файлы меняются без вопросов, команды в терминале — с подтверждением.',
    fullAuto: '⚠️ Полная автономность: полный карт-бланш — Kimi сам правит файлы, запускает команды, пушит на GitHub и деплоит, ни о чём не спрашивая.'
  };

  function applyMode(mode) {
    modeEl.value = mode;
    hintEl.textContent = HINTS[mode] || '';
    hintEl.style.color = mode === 'fullAuto' ? 'var(--vscode-errorForeground)' : '';
    hintEl.style.opacity = mode === 'fullAuto' ? '1' : '';
  }

  modeEl.addEventListener('change', function () {
    vscode.postMessage({ type: 'setMode', mode: modeEl.value });
    applyMode(modeEl.value);
  });

  modelEl.addEventListener('change', function () {
    vscode.postMessage({ type: 'setModel', model: modelEl.value });
  });

  refreshModelsBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'refreshModels' });
  });

  // ---------- меню аккаунта (всплывающее, внутри панели) ----------
  var authMenu = document.getElementById('authMenu');
  var currentAuth = { kind: 'none' };

  function closeAuthMenu() {
    authMenu.style.display = 'none';
  }

  function authMenuItem(text, action) {
    var d = document.createElement('div');
    d.className = 'mi';
    d.textContent = text;
    d.addEventListener('click', function (e) {
      e.stopPropagation();
      closeAuthMenu();
      vscode.postMessage({ type: 'authAction', action: action });
    });
    return d;
  }

  function renderAuthMenu() {
    authMenu.innerHTML = '';
    if (currentAuth.kind === 'oauth') {
      var head = document.createElement('div');
      head.className = 'mi head';
      head.textContent = 'Аккаунт: ' + (currentAuth.label || 'Kimi');
      authMenu.appendChild(head);
      var sep = document.createElement('div');
      sep.className = 'sep';
      authMenu.appendChild(sep);
      authMenu.appendChild(authMenuItem('🌐 Сменить способ входа', 'relogin'));
      authMenu.appendChild(authMenuItem('🚪 Выйти из аккаунта', 'logoutOAuth'));
    } else if (currentAuth.kind === 'apiKey') {
      var head2 = document.createElement('div');
      head2.className = 'mi head';
      head2.textContent = 'Вход по API-ключу';
      authMenu.appendChild(head2);
      var sep2 = document.createElement('div');
      sep2.className = 'sep';
      authMenu.appendChild(sep2);
      authMenu.appendChild(authMenuItem('🔑 Сменить API-ключ', 'rekey'));
      authMenu.appendChild(authMenuItem('🌐 Войти через сайт (OAuth)', 'relogin'));
      authMenu.appendChild(authMenuItem('🚪 Удалить API-ключ', 'clearKey'));
    } else {
      authMenu.appendChild(authMenuItem('🌐 Войти через сайт (OAuth)', 'relogin'));
      authMenu.appendChild(authMenuItem('🔑 Ввести API-ключ', 'rekey'));
    }
  }

  authBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (authMenu.style.display === 'none') {
      renderAuthMenu();
      authMenu.style.display = 'block';
    } else {
      closeAuthMenu();
    }
  });

  document.addEventListener('click', function (e) {
    if (authMenu.style.display !== 'none' && !authMenu.contains(e.target) && e.target !== authBtn) {
      closeAuthMenu();
    }
  });

  function setAuthState(st) {
    currentAuth = st && st.kind ? st : { kind: 'none' };
    if (currentAuth.kind === 'none') {
      authBtn.textContent = '🔒 Войти';
      authBtn.style.color = 'var(--vscode-errorForeground)';
    } else if (currentAuth.kind === 'oauth') {
      authBtn.textContent = '✓ ' + (currentAuth.label || 'Kimi');
      authBtn.style.color = 'var(--vscode-testing-iconPassed)';
    } else {
      authBtn.textContent = '✓ API-ключ';
      authBtn.style.color = 'var(--vscode-testing-iconPassed)';
    }
  }

  function setModelList(models, current) {
    modelEl.innerHTML = '';
    for (var i = 0; i < models.length; i++) {
      var opt = document.createElement('option');
      opt.value = models[i];
      opt.textContent = models[i];
      modelEl.appendChild(opt);
    }
    if (current) modelEl.value = current;
  }

  function fmtTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  var busy = false;
  var currentEl = null;
  var currentText = '';
  var reviewEl = null;

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function md(src) {
    var parts = src.split('\`\`\`');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i].replace(/^[a-zA-Z0-9_-]*\\n/, '');
        out += '<pre><code>' + esc(code) + '</code></pre>';
      } else {
        var t = esc(parts[i]);
        t = t.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
        t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
        t = t.replace(/^#{1,4}\\s*(.+)$/gm, '<b>$1</b>');
        t = t.replace(/\\n/g, '<br>');
        out += t;
      }
    }
    return out;
  }

  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function tsSpan() {
    if (!settings.timestamps) return null;
    var d = new Date();
    var s = document.createElement('span');
    s.className = 'ts';
    s.textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return s;
  }

  function addMsg(cls, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + cls;
    var ts = tsSpan();
    if (ts) div.appendChild(ts);
    var body = document.createElement('div');
    if (cls === 'assistant') body.innerHTML = md(text);
    else body.textContent = text;
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollDown();
    return body;
  }

  // Группа инструментов текущего хода агента: строки обновляются на месте
  // (⏳ → ✅), а после ответа блок сворачивается в одну строку-сводку.
  var toolGroup = null;

  function toolLineText(name, status, detail) {
    var icon = status === 'running' ? '⏳' : status === 'done' ? '✅' : '❌';
    return icon + ' ' + name + (status === 'running' ? '…' : '') + (detail ? ' — ' + detail : '');
  }

  function ensureToolGroup() {
    if (toolGroup) return toolGroup;
    var root = document.createElement('div');
    root.className = 'toolgroup';
    var head = document.createElement('div');
    head.className = 'tg-head';
    head.textContent = '🔧 Инструменты';
    var list = document.createElement('div');
    list.className = 'tg-list';
    head.addEventListener('click', function () {
      root.classList.toggle('collapsed');
    });
    root.appendChild(head);
    root.appendChild(list);
    messagesEl.appendChild(root);
    toolGroup = { root: root, head: head, list: list, lines: [], total: 0 };
    return toolGroup;
  }

  function updateToolGroupHead() {
    if (!toolGroup) return;
    var pending = 0;
    for (var i = 0; i < toolGroup.lines.length; i++) {
      if (!toolGroup.lines[i].done) pending++;
    }
    toolGroup.head.textContent =
      '🔧 Инструменты (' + toolGroup.total + ')' + (pending > 0 ? ' — выполняется…' : '');
  }

  function addTool(name, status, detail) {
    var g = ensureToolGroup();
    var line = null;
    if (status !== 'running') {
      // закрыть самый старый «висячий» вызов с тем же именем
      for (var i = 0; i < g.lines.length; i++) {
        if (!g.lines[i].done && g.lines[i].name === name) { line = g.lines[i]; break; }
      }
    }
    if (line) {
      line.done = true;
      line.el.className = 'tool' + (status === 'error' ? ' error' : '');
      line.el.textContent = toolLineText(name, status, detail);
    } else {
      g.total++;
      var div = document.createElement('div');
      div.className = 'tool' + (status === 'error' ? ' error' : '');
      div.textContent = toolLineText(name, status, detail);
      g.list.appendChild(div);
      g.lines.push({ el: div, name: name, done: status !== 'running' });
    }
    updateToolGroupHead();
    scrollDown();
  }

  /** Свернуть блок инструментов в одну строку после ответа агента. */
  function collapseToolGroup() {
    if (!toolGroup) return;
    toolGroup.root.classList.add('collapsed');
    toolGroup.head.textContent =
      '✅ Шаги агента (' + toolGroup.total + ') — нажмите, чтобы развернуть';
    toolGroup = null;
  }

  function addInfo(text) {
    var div = document.createElement('div');
    div.className = 'tool';
    div.textContent = 'ℹ️ ' + text;
    messagesEl.appendChild(div);
    scrollDown();
  }

  // ---------- панель принятия правок ----------

  function renderReview(files) {
    if (reviewEl) { reviewEl.remove(); reviewEl = null; }
    if (!files || !files.length) return;
    var div = document.createElement('div');
    div.className = 'review';
    var head = document.createElement('div');
    head.className = 'rhead';
    head.textContent = '📝 Изменения Kimi (' + files.length + ')';
    div.appendChild(head);
    files.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'rrow';
      var name = document.createElement('span');
      name.className = 'rfile';
      name.textContent = (f.created ? '＋ ' : '✎ ') + f.file;
      name.title = 'Показать diff';
      name.addEventListener('click', function () {
        vscode.postMessage({ type: 'diffFile', file: f.file });
      });
      row.appendChild(name);
      var ok = document.createElement('button');
      ok.textContent = '✓'; ok.title = 'Принять изменения в этом файле';
      ok.addEventListener('click', function () {
        vscode.postMessage({ type: 'acceptFile', file: f.file });
      });
      var no = document.createElement('button');
      no.textContent = '✗'; no.title = 'Откатить этот файл'; no.className = 'secondary';
      no.addEventListener('click', function () {
        vscode.postMessage({ type: 'rejectFile', file: f.file });
      });
      row.appendChild(ok); row.appendChild(no);
      div.appendChild(row);
    });
    var foot = document.createElement('div');
    foot.className = 'rrow';
    var okAll = document.createElement('button');
    okAll.textContent = 'Принять все';
    okAll.addEventListener('click', function () {
      vscode.postMessage({ type: 'acceptAll' });
    });
    var noAll = document.createElement('button');
    noAll.textContent = 'Откатить все'; noAll.className = 'secondary';
    noAll.addEventListener('click', function () {
      vscode.postMessage({ type: 'rejectAll' });
    });
    foot.appendChild(okAll); foot.appendChild(noAll);
    div.appendChild(foot);
    messagesEl.appendChild(div);
    reviewEl = div;
    scrollDown();
  }

  // ---------- вкладки сессий ----------

  function renderSessions(items) {
    tabsEl.innerHTML = '';
    (items || []).forEach(function (s) {
      var tab = document.createElement('span');
      tab.className = 'tab' + (s.active ? ' active' : '');
      tab.textContent = s.title;
      tab.title = s.title + ' (двойной клик — переименовать)';
      tab.addEventListener('click', function () {
        vscode.postMessage({ type: 'switchSession', id: s.id });
      });
      tab.addEventListener('dblclick', function () {
        var t = prompt('Название сессии:', s.title);
        if (t) vscode.postMessage({ type: 'renameSession', id: s.id, title: t });
      });
      var x = document.createElement('span');
      x.className = 'x';
      x.textContent = '✕';
      x.title = 'Удалить сессию';
      x.addEventListener('click', function (ev) {
        ev.stopPropagation();
        vscode.postMessage({ type: 'deleteSession', id: s.id });
      });
      tab.appendChild(x);
      tabsEl.appendChild(tab);
    });
    var plus = document.createElement('span');
    plus.className = 'tab plus';
    plus.textContent = '＋';
    plus.title = 'Новая сессия';
    plus.addEventListener('click', function () {
      vscode.postMessage({ type: 'newSession' });
    });
    tabsEl.appendChild(plus);
  }

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? 'Стоп' : 'Отправить';
    inputEl.disabled = false;
  }

  function send() {
    if (busy) {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    var text = inputEl.value;
    if (!text.trim()) return;
    inputEl.value = '';
    vscode.postMessage({ type: 'ask', text: text, agent: agentEl.checked });
    setBusy(true);
  }

  sendBtn.addEventListener('click', send);
  newChatBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'newChat' });
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (settings.ctrlEnter) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); send(); }
    } else if (!e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.addEventListener('message', function (event) {
    var m = event.data;
    switch (m.type) {
      case 'user':
        currentEl = null;
        addMsg('user', m.text);
        break;
      case 'start':
        currentText = '';
        currentEl = addMsg('assistant', '');
        break;
      case 'delta':
        if (!currentEl) currentEl = addMsg('assistant', '');
        currentText += m.text;
        currentEl.innerHTML = md(currentText);
        scrollDown();
        break;
      case 'tool':
        addTool(m.name, m.status, m.detail);
        break;
      case 'info':
        addInfo(m.text);
        break;
      case 'usage':
        usageEl.textContent = '⚡ запрос: ' + fmtTokens(m.request) + ' ток. · сессия: ' + fmtTokens(m.session) + ' ток.';
        break;
      case 'insertText':
        inputEl.value += m.text;
        inputEl.focus();
        break;
      case 'history':
        messagesEl.innerHTML = '';
        reviewEl = null;
        toolGroup = null;
        for (var i = 0; i < (m.items || []).length; i++) {
          var it = m.items[i];
          if (it.role === 'user') addMsg('user', it.content.split('\\n')[0].slice(0, 300));
          else if (it.role === 'assistant') addMsg('assistant', it.content);
        }
        break;
      case 'sessions':
        renderSessions(m.items);
        break;
      case 'settings':
        settings.ctrlEnter = !!m.ctrlEnter;
        settings.timestamps = !!m.timestamps;
        break;
      case 'review':
      case 'reviewUpdate':
        renderReview(m.files);
        break;
      case 'done':
        currentEl = null;
        currentText = '';
        collapseToolGroup();
        setBusy(false);
        inputEl.focus();
        break;
      case 'error':
        addMsg('error', m.text);
        collapseToolGroup();
        setBusy(false);
        break;
      case 'clear':
        messagesEl.innerHTML = '';
        currentEl = null;
        currentText = '';
        reviewEl = null;
        toolGroup = null;
        setBusy(false);
        break;
      case 'mode':
        applyMode(m.mode);
        break;
      case 'modelList':
        setModelList(m.models || [], m.current);
        break;
      case 'model':
        modelEl.value = m.model;
        break;
      case 'auth':
        setAuthState(m.state);
        break;
    }
  });

  inputEl.focus();
  // сигнал хосту: страница загружена, можно слать начальное состояние
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
