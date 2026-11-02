import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { ToolDef } from './api';
import { getAutoDeploy, getAutoPush, getDeployCommand, getPermissionMode } from './config';

/** Флаг «проект изменён» — выставляется при успешной записи файла. */
let changesMade = false;

/** Прочитать и сбросить флаг изменений. */
export function consumeChangesMade(): boolean {
  const v = changesMade;
  changesMade = false;
  return v;
}

/** Хук снимка файла перед изменением (checkpoints). Устанавливает чат-панель. */
let snapshotHook: ((absPath: string) => void) | null = null;
export function setSnapshotHook(hook: ((absPath: string) => void) | null): void {
  snapshotHook = hook;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', '.vscode', '.idea',
  'coverage', 'target', '.next', '.cache', 'vendor', '__pycache__',
]);

const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'java', 'kt', 'go', 'rs',
  'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'md', 'txt', 'yml', 'yaml',
  'toml', 'xml', 'html', 'css', 'scss', 'less', 'sql', 'sh', 'bat', 'ps1', 'vue',
  'svelte', 'ini', 'cfg', 'env', 'gitignore', 'dockerfile', 'makefile', 'gradle',
]);

function root(): string {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error('Откройте папку проекта (File → Open Folder), чтобы агент мог работать с файлами.');
  return f.uri.fsPath;
}

function resolveInRoot(p: string): string {
  if (!p) throw new Error('Пустой путь.');
  const r = root();
  const full = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(r, p));
  const rel = path.relative(r, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Путь вне рабочей папки запрещён: ${p}`);
  }
  return full;
}

type ApprovalKind = 'edit' | 'command';

/**
 * Проверяет режим автономности и при необходимости спрашивает пользователя.
 *  - ask:      спрашивать всегда;
 *  - autoEdit: правки файлов — без вопросов, команды — с подтверждением;
 *  - fullAuto: никогда не спрашивать.
 */
async function confirm(kind: ApprovalKind, title: string, detail?: string): Promise<boolean> {
  const mode = getPermissionMode();
  if (mode === 'fullAuto') return true;
  if (mode === 'autoEdit' && kind === 'edit') return true;
  const pick = await vscode.window.showInformationMessage(
    title,
    { modal: true, detail },
    'Разрешить'
  );
  return pick === 'Разрешить';
}

function walk(dir: string, depth: number, out: string[], cap: number): void {
  if (depth < 0 || out.length >= cap) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(full + path.sep);
      walk(full, depth - 1, out, cap);
    } else {
      out.push(full);
    }
  }
}

function langOf(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return ext || 'plaintext';
}

// ---------- реализации инструментов ----------

function toolReadFile(args: any): string {
  const full = resolveInRoot(String(args.path || ''));
  if (!fs.existsSync(full)) throw new Error(`Файл не найден: ${args.path}`);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) throw new Error(`${args.path} — это папка, используйте list_files.`);
  let text = fs.readFileSync(full, 'utf8');
  const MAX = 20000;
  if (text.length > MAX) {
    text = text.slice(0, MAX) + `\n\n… [обрезано: файл ${text.length} символов, показаны первые ${MAX}]`;
  }
  return text;
}

function toolListFiles(args: any): string {
  const dir = args.dir ? resolveInRoot(String(args.dir)) : root();
  const depth = Math.min(Math.max(Number(args.depth ?? 3), 1), 6);
  const out: string[] = [];
  walk(dir, depth, out, 400);
  const r = root();
  const lines = out.map((p) => path.relative(r, p)).sort();
  if (lines.length === 0) return '(пусто)';
  return lines.join('\n');
}

function toolSearchInFiles(args: any): string {
  const query = String(args.query || '');
  if (!query) throw new Error('Пустой запрос поиска.');
  const dir = args.dir ? resolveInRoot(String(args.dir)) : root();
  const files: string[] = [];
  walk(dir, 6, files, 3000);

  let re: RegExp | null = null;
  if (args.regex) {
    try {
      re = new RegExp(query, args.ignoreCase === false ? '' : 'i');
    } catch {
      throw new Error(`Невалидное регулярное выражение: ${query}`);
    }
  }
  const needle = args.ignoreCase === false ? query : query.toLowerCase();

  const matches: string[] = [];
  const r = root();
  for (const full of files) {
    if (matches.length >= 60) break;
    if (full.endsWith(path.sep)) continue;
    const ext = path.extname(full).slice(1).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let text: string;
    try {
      const stat = fs.statSync(full);
      if (stat.size > 512 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(r, full);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= 60) break;
      const line = lines[i];
      const hit = re ? re.test(line) : (args.ignoreCase === false ? line.includes(needle) : line.toLowerCase().includes(needle));
      if (hit) matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }
  return matches.length ? matches.join('\n') : 'Ничего не найдено.';
}

async function toolWriteFile(args: any): Promise<string> {
  const rel = String(args.path || '');
  const full = resolveInRoot(rel);
  const content = String(args.content ?? '');
  const oldText = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;

  const lang = langOf(full);
  const left = await vscode.workspace.openTextDocument({ content: oldText ?? '', language: lang });
  const right = await vscode.workspace.openTextDocument({ content, language: lang });
  await vscode.commands.executeCommand(
    'vscode.diff',
    left.uri,
    right.uri,
    `Kimi → ${path.basename(full)} (предложено)`
  );

  const ok = await confirm(
    'edit',
    `Kimi хочет ${oldText === null ? 'создать' : 'изменить'} файл: ${path.relative(root(), full)}`,
    'Сравнение открыто в редакторе. Применить изменения?'
  );
  if (!ok) return 'Изменение отклонено пользователем.';

  snapshotHook?.(full); // снимок для отката (checkpoints)
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  changesMade = true;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
  await vscode.window.showTextDocument(doc);
  return `Файл записан: ${path.relative(root(), full)} (${content.length} символов).`;
}

// ---------- git ----------

function runGit(args: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    exec(
      `git ${args}`,
      { cwd: root(), timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err ? ((err.code as number) ?? 1) : 0,
          out: ((stdout || '') + (stderr ? `\n${stderr}` : '')).trim(),
        });
      }
    );
  });
}

/** add -A → commit → push (с настройкой upstream при первом пуше ветки). */
async function gitCommitPush(message: string): Promise<string> {
  const inside = await runGit('rev-parse --is-inside-work-tree');
  if (inside.code !== 0) {
    throw new Error('Папка проекта не является git-репозиторием. Сначала выполните git init и добавьте remote.');
  }
  const log: string[] = [];

  const add = await runGit('add -A');
  if (add.code !== 0) throw new Error(`git add: ${add.out}`);

  const staged = await runGit('diff --cached --quiet');
  if (staged.code === 0) return 'Нет изменений для коммита.';

  const safeMsg = message.replace(/"/g, '\\"');
  const commit = await runGit(`commit -m "${safeMsg}"`);
  if (commit.code !== 0) throw new Error(`git commit: ${commit.out}`);
  log.push(commit.out);

  let push = await runGit('push');
  if (push.code !== 0 && /upstream|set-upstream|no tracking/i.test(push.out)) {
    const branch = await runGit('rev-parse --abbrev-ref HEAD');
    const name = branch.out.split('\n')[0].trim() || 'HEAD';
    push = await runGit(`push -u origin ${name}`);
  }
  if (push.code !== 0) throw new Error(`git push: ${push.out}`);
  log.push(push.out || 'push: ok');

  return log.join('\n');
}

async function toolGitPush(args: any): Promise<string> {
  const msg = String(args.message || 'kimi: update');
  const ok = await confirm(
    'command',
    'Kimi хочет запушить изменения на GitHub:',
    `git add -A && git commit -m "${msg}" && git push`
  );
  if (!ok) return 'Пуш отклонён пользователем.';
  return gitCommitPush(msg);
}

/**
 * Автопуш после завершения задачи агента:
 * срабатывает только если включён kimi.autoPush и агент реально менял файлы.
 */
export async function autoPushIfEnabled(changed: boolean, summary: string): Promise<string | null> {
  if (!getAutoPush() || !changed) return null;
  const short = summary.replace(/\s+/g, ' ').trim().slice(0, 60) || 'update';
  const ok = await confirm(
    'command',
    'Kimi: запушить изменения на GitHub?',
    `git add -A && git commit -m "kimi: ${short}" && git push`
  );
  if (!ok) return 'Автопуш отклонён пользователем.';
  return gitCommitPush(`kimi: ${short}`);
}

/**
 * Автодеплой после завершения задачи агента:
 * срабатывает только если включён kimi.autoDeploy, задана kimi.deployCommand
 * и агент реально менял файлы. Таймаут деплоя — 10 минут.
 */
export async function autoDeployIfEnabled(changed: boolean): Promise<string | null> {
  if (!getAutoDeploy() || !changed) return null;
  const cmd = getDeployCommand();
  if (!cmd.trim()) return 'Деплой пропущен: не задана команда kimi.deployCommand.';
  const ok = await confirm('command', 'Kimi: выполнить деплой проекта?', cmd);
  if (!ok) return 'Деплой отклонён пользователем.';
  return runShell(cmd, 600_000);
}

function runShell(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: root(), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || '') + (stderr ? `\nSTDERR:\n${stderr}` : '');
      if (err && !out.trim()) out = `Ошибка выполнения (код ${err.code ?? '?'}): ${err.message}`;
      else if (err) out += `\n[завершено с кодом ${err.code}]`;
      resolve(out.trim().slice(0, 8000) || '(нет вывода)');
    });
  });
}

async function toolRunCommand(args: any): Promise<string> {
  const cmd = String(args.command || '');
  if (!cmd.trim()) throw new Error('Пустая команда.');
  const ok = await confirm('command', 'Kimi хочет выполнить команду в терминале:', cmd);
  if (!ok) return 'Команда отклонена пользователем.';
  return runShell(cmd, 60_000);
}

async function toolDeploy(_args: any): Promise<string> {
  const cmd = getDeployCommand();
  if (!cmd.trim()) {
    return (
      'Команда деплоя не настроена. Задайте её в настройке kimi.deployCommand, ' +
      'например: "npm run build && npm run deploy", "vercel --prod" или "netlify deploy --prod".'
    );
  }
  const ok = await confirm('command', 'Kimi хочет выполнить деплой проекта:', cmd);
  if (!ok) return 'Деплой отклонён пользователем.';
  return runShell(cmd, 600_000);
}

// ---------- диагностика IDE ----------

/** Ошибки и предупреждения из панели «Проблемы» VS Code (линтеры, компиляторы). */
function toolGetDiagnostics(args: any): string {
  const onlyErrors = args?.onlyErrors !== false;
  const lines: string[] = [];
  const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (lines.length >= 50) break;
    if (r && !uri.fsPath.startsWith(r)) continue;
    const rel = r ? path.relative(r, uri.fsPath) : uri.fsPath;
    for (const d of diags) {
      if (lines.length >= 50) break;
      if (onlyErrors && d.severity > vscode.DiagnosticSeverity.Error) continue;
      const sev =
        d.severity === vscode.DiagnosticSeverity.Error
          ? 'ERROR'
          : d.severity === vscode.DiagnosticSeverity.Warning
            ? 'WARN'
            : 'INFO';
      lines.push(
        `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message.split('\n')[0].slice(0, 200)}`
      );
    }
  }
  return lines.length ? lines.join('\n') : 'Проблем не найдено — проект чистый. ✅';
}

// ---------- публичный интерфейс ----------

export function toolDefinitions(readonly = false): ToolDef[] {
  const defs: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Прочитать содержимое файла из рабочей папки.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Путь относительно корня проекта' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'Показать дерево файлов и папок проекта.',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: 'Папка (по умолчанию корень проекта)' },
            depth: { type: 'number', description: 'Глубина обхода, 1–6 (по умолчанию 3)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_in_files',
        description: 'Найти строку или регулярное выражение в текстовых файлах проекта.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Строка или regex для поиска' },
            dir: { type: 'string', description: 'Папка поиска (по умолчанию весь проект)' },
            regex: { type: 'boolean', description: 'Трактовать query как регулярное выражение' },
            ignoreCase: { type: 'boolean', description: 'Игнорировать регистр (по умолчанию true)' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Создать или полностью перезаписать файл. Пользователь увидит diff и подтвердит изменение.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Путь файла относительно корня проекта' },
            content: { type: 'string', description: 'Полное новое содержимое файла' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'git_push',
        description:
          'Закоммитить все изменения проекта и запушить в удалённый репозиторий (GitHub). ' +
          'Используй, когда задача выполнена и нужно сохранить результат на GitHub, или когда пользователь просит запушить.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Текст коммита: кратко, по-английски, в стиле conventional commits (например "fix: handle empty input")',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'deploy',
        description:
          'Задеплоить проект: выполняет настроенную команду деплоя (kimi.deployCommand), например сборку и публикацию. ' +
          'Используй после завершения задачи, когда пользователь просил задеплоить/опубликовать проект. Таймаут 10 минут.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_diagnostics',
        description:
          'Получить ошибки и предупреждения из панели «Проблемы» VS Code (линтеры, компиляторы) по всему проекту. ' +
          'Используй после правок, чтобы убедиться, что код компилируется без ошибок.',
        parameters: {
          type: 'object',
          properties: {
            onlyErrors: { type: 'boolean', description: 'Только ошибки без предупреждений (по умолчанию true)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Выполнить shell-команду в корне проекта (с подтверждением пользователя). Таймаут 60 секунд.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'Команда для выполнения' } },
          required: ['command'],
        },
      },
    },
  ];

  if (!readonly) return defs;
  // режим планирования: только инструменты чтения
  const READ_ONLY = new Set(['read_file', 'list_files', 'search_in_files', 'get_diagnostics']);
  return defs.filter((d) => READ_ONLY.has(d.function.name));
}

export async function executeTool(name: string, argsJson: string): Promise<string> {
  let args: any = {};
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    throw new Error(`Невалидные аргументы инструмента ${name}`);
  }
  switch (name) {
    case 'read_file':
      return toolReadFile(args);
    case 'list_files':
      return toolListFiles(args);
    case 'search_in_files':
      return toolSearchInFiles(args);
    case 'write_file':
      return toolWriteFile(args);
    case 'run_command':
      return toolRunCommand(args);
    case 'git_push':
      return toolGitPush(args);
    case 'deploy':
      return toolDeploy(args);
    case 'get_diagnostics':
      return toolGetDiagnostics(args);
    default:
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}
