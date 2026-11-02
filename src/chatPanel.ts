import * as vscode from 'vscode';
import { ApiConfig, ChatMessage, FALLBACK_MODELS, listModels, streamChat, TokenUsage } from './api';
import { runAgentLoop } from './agent';
import { CheckpointEntry, CheckpointStore } from './checkpoints';
import { autoDeployIfEnabled, autoPushIfEnabled, consumeChangesMade, setSnapshotHook } from './tools';
import {
  ensureApiKey,
  getApiConfig,
  getModel,
  getPermissionMode,
  isPlanMode,
  setModel,
  setPermissionMode,
  PermissionMode,
} from './config';

const HISTORY_KEY = 'kimi.chatHistory';

const HELP_TEXT = [
  '/clear — новый диалог (сброс контекста)',
  '/compact — сжать историю диалога в сводку',
  '/review — изменения за сессию: diff и откат (checkpoints)',
  '/plan, /ask, /auto, /fullauto — переключить режим автономности',
  '@путь/к/файлу — прикрепить файл к вопросу',
].join('\n');

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

  private view?: vscode.WebviewView;
  private pending: Array<{ text: string; agent: boolean }> = [];
  private history: ChatMessage[] = [];
  private abort?: AbortController;
  private busy = false;
  private checkpoints: CheckpointStore;
  private sessionTokens = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.history = context.workspaceState.get<ChatMessage[]>(HISTORY_KEY, []);
    this.checkpoints = new CheckpointStore(context.globalStorageUri.fsPath, String(Date.now()));
    setSnapshotHook((abs) => {
      const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!r) return;
      try {
        this.checkpoints.snapshot(abs, r);
      } catch {
        // снимок не критичен
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(view.webview);
    view.webview.onDidReceiveMessage((m) => {
      if (m?.type === 'ask') void this.handleAsk(String(m.text ?? ''), !!m.agent);
      else if (m?.type === 'cancel') this.abort?.abort();
      else if (m?.type === 'newChat') this.newChat();
      else if (m?.type === 'setMode') void this.applyMode(m.mode);
      else if (m?.type === 'setModel') void this.applyModel(String(m.model ?? ''));
      else if (m?.type === 'refreshModels') void this.refreshModels();
    });
    this.post({ type: 'mode', mode: getPermissionMode() });
    if (this.history.length > 0) {
      this.post({
        type: 'history',
        items: this.history.map((h) => ({ role: h.role, content: h.content ?? '' })),
      });
    }
    void this.refreshModels();
    const queued = this.pending.splice(0);
    for (const item of queued) void this.handleAsk(item.text, item.agent);
  }

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
      const apiKey = await this.context.secrets.get('kimi.apiKey');
      if (apiKey) {
        models = await listModels({ ...getApiConfig(), apiKey });
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

  newChat(): void {
    this.history = [];
    this.saveHistory();
    // новая сессия — новые снимки
    this.checkpoints = new CheckpointStore(this.context.globalStorageUri.fsPath, String(Date.now()));
    this.view?.webview.postMessage({ type: 'clear' });
  }

  /** Вызов из команды (контекстное меню редактора и т.п.). */
  async askFromCommand(text: string, agent = false): Promise<void> {
    if (!this.view) {
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
    if (!this.view) {
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
    this.post({ type: 'insertText', text: `@${rel} ` });
  }

  /** Review-панель: все изменённые за сессию файлы с diff и откатом. */
  async reviewChanges(): Promise<void> {
    const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootDir) {
      vscode.window.showWarningMessage('Откройте папку проекта.');
      return;
    }
    const entries = this.checkpoints.list();
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
        const n = await this.checkpoints.revertAll(rootDir);
        vscode.window.showInformationMessage(`Kimi: откачено файлов: ${n}.`);
      }
      return;
    }

    const entry = pick.entry;
    await this.checkpoints.showDiff(entry, rootDir);
    const action = await vscode.window.showInformationMessage(
      `Откатить «${entry.file}» к состоянию до правок Kimi?`,
      { modal: true },
      'Откатить'
    );
    if (action === 'Откатить') {
      await this.checkpoints.revert(entry, rootDir);
      vscode.window.showInformationMessage(`Kimi: файл откачен: ${entry.file}`);
    }
  }

  private post(m: unknown): void {
    void this.view?.webview.postMessage(m);
  }

  private saveHistory(): void {
    void this.context.workspaceState.update(HISTORY_KEY, this.history.slice(-20));
  }

  /** Сборка полного контекста вопроса: @файлы, выделение, диагностика IDE. */
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

    // выделенный код
    const ed = vscode.window.activeTextEditor;
    if (ed && !ed.selection.isEmpty) {
      const sel = ed.document.getText(ed.selection);
      if (sel.trim()) {
        const rel = vscode.workspace.asRelativePath(ed.document.uri);
        full += `\n\nВыделенный код из \`${rel}\`:\n\`\`\`${ed.document.languageId}\n${sel.slice(0, 8000)}\n\`\`\``;
      }
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

  /** Обработка слэш-команд. Возвращает true, если текст был командой. */
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
    if (this.history.length === 0) {
      this.post({ type: 'info', text: 'История пуста — сжимать нечего.' });
      return;
    }
    const apiKey = await ensureApiKey(this.context);
    if (!apiKey) return;
    const cfg: ApiConfig = { ...getApiConfig(), apiKey };
    this.post({ type: 'info', text: '🗜 Сжимаю историю диалога…' });
    try {
      const transcript = this.history
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
      this.history = [
        { role: 'user', content: `Сводка предыдущего диалога:\n${res.content}` },
        { role: 'assistant', content: 'Принято. Продолжаем с учётом этой сводки.' },
      ];
      this.saveHistory();
      this.post({
        type: 'info',
        text: `🗜 История сжата в сводку (${res.usage?.total_tokens ?? '?'} токенов).`,
      });
    } catch (e) {
      this.post({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  private async handleAsk(userText: string, agent: boolean): Promise<void> {
    const trimmed = userText.trim();
    if (!trimmed || this.busy) return;

    if (trimmed.startsWith('/') && (await this.handleSlash(trimmed))) return;

    this.busy = true;
    this.abort = new AbortController();

    this.post({ type: 'user', text: userText });
    this.post({ type: 'start' });

    try {
      const apiKey = await ensureApiKey(this.context);
      if (!apiKey) {
        this.post({ type: 'error', text: 'Не задан API-ключ. Выполните команду «Kimi: Указать API-ключ».' });
        return;
      }
      const cfg: ApiConfig = { ...getApiConfig(), apiKey };

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const plan = isPlanMode();
      const userContent = await this.buildUserContent(userText);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt(root, plan) },
        ...this.history.slice(-20),
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
          onTool: (name, status, detail) => this.post({ type: 'tool', name, status, detail }),
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
      } else {
        const res = await streamChat(cfg, messages, { onToken, signal: this.abort.signal });
        if (res.usage) onUsage(res.usage);
      }

      this.history.push(
        { role: 'user', content: userContent },
        { role: 'assistant', content: acc }
      );
      this.saveHistory();
      this.post({ type: 'done' });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        this.post({ type: 'done', aborted: true });
      } else {
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
  .tool {
    font-size: 0.85em; opacity: 0.85; margin: 4px 0 4px 8px;
    padding: 3px 8px; border-left: 2px solid var(--vscode-textLink-foreground);
    white-space: pre-wrap;
  }
  .tool.error { border-left-color: var(--vscode-errorForeground); }
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
      <button id="newChat" class="secondary" title="Очистить диалог">Новый чат</button>
      <span class="spacer"></span>
      <button id="send">Отправить</button>
    </div>
    <div class="row">
      <label title="Модель Kimi">Модель</label>
      <select id="model" title="Модель Kimi"></select>
      <button id="refreshModels" class="secondary" title="Обновить список моделей с API">⟳</button>
    </div>
    <div id="hint"></div>
    <div id="usage"></div>
  </div>
<script nonce="${n}">
(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var agentEl = document.getElementById('agent');
  var sendBtn = document.getElementById('send');
  var newChatBtn = document.getElementById('newChat');
  var modeEl = document.getElementById('mode');
  var modelEl = document.getElementById('model');
  var refreshModelsBtn = document.getElementById('refreshModels');
  var hintEl = document.getElementById('hint');
  var usageEl = document.getElementById('usage');

  var HINTS = {
    plan: '📋 Планирование: Kimi только читает проект и составляет план — ничего не меняет.',
    ask: 'Агентский режим: Kimi читает проект, но каждая правка и команда — с вашего подтверждения.',
    autoEdit: 'Авто-правки: файлы меняются без вопросов, команды в терминале — с подтверждением.',
    fullAuto: '⚠️ Полная автономность: Kimi сам правит файлы и запускает команды, ни о чём не спрашивая.'
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
    return n >= 1000 ? (n / 1000).toFixed(1).replace('.', ' ') + 'k' : String(n);
  }

  var busy = false;
  var currentEl = null;
  var currentText = '';

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

  function addMsg(cls, text) {
    var div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (cls === 'assistant') div.innerHTML = md(text);
    else div.textContent = text;
    messagesEl.appendChild(div);
    scrollDown();
    return div;
  }

  function addTool(name, status, detail) {
    var div = document.createElement('div');
    div.className = 'tool' + (status === 'error' ? ' error' : '');
    var icon = status === 'running' ? '⏳' : status === 'done' ? '✅' : '❌';
    div.textContent = icon + ' ' + name + (status === 'running' ? '…' : '') + (detail ? ' — ' + detail : '');
    messagesEl.appendChild(div);
    scrollDown();
  }

  function addInfo(text) {
    var div = document.createElement('div');
    div.className = 'tool';
    div.textContent = 'ℹ️ ' + text;
    messagesEl.appendChild(div);
    scrollDown();
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
    if (e.key === 'Enter' && !e.shiftKey) {
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
        for (var i = 0; i < (m.items || []).length; i++) {
          var it = m.items[i];
          if (it.role === 'user') addMsg('user', it.content.split('\\n')[0].slice(0, 300));
          else if (it.role === 'assistant') addMsg('assistant', it.content);
        }
        break;
      case 'done':
        currentEl = null;
        currentText = '';
        setBusy(false);
        inputEl.focus();
        break;
      case 'error':
        addMsg('error', m.text);
        setBusy(false);
        break;
      case 'clear':
        messagesEl.innerHTML = '';
        currentEl = null;
        currentText = '';
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
    }
  });

  inputEl.focus();
})();
</script>
</body>
</html>`;
}
