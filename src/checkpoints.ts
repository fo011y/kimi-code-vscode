import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface CheckpointEntry {
  /** Путь файла относительно корня проекта. */
  file: string;
  /** Абсолютный путь к снимку (существует, только если файл существовал). */
  backup: string;
  /** Существовал ли файл до изменения. */
  existed: boolean;
  time: number;
}

/**
 * Хранилище снимков: перед первой правкой каждого файла за сессию
 * сохраняет его исходное содержимое — для отката (rewind) и review-панели.
 */
export class CheckpointStore {
  private entries: CheckpointEntry[] = [];
  private readonly dir: string;

  constructor(storageRoot: string, sessionId: string) {
    this.dir = path.join(storageRoot, 'checkpoints', sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Снять снимок файла перед изменением (только первый раз за сессию). */
  snapshot(absPath: string, rootDir: string): void {
    const rel = path.relative(rootDir, absPath);
    if (rel.startsWith('..')) return;
    if (this.entries.some((e) => e.file === rel)) return;
    const existed = fs.existsSync(absPath);
    const backupName = `${String(this.entries.length).padStart(3, '0')}_${rel.replace(/[\\/:*?"<>|]/g, '_')}`;
    const backup = path.join(this.dir, backupName);
    try {
      if (existed) fs.copyFileSync(absPath, backup);
      this.entries.push({ file: rel, backup, existed, time: Date.now() });
    } catch {
      // не критично — откат для этого файла будет недоступен
    }
  }

  list(): CheckpointEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  /** Показать diff «снимок ↔ текущее состояние» для файла. */
  async showDiff(entry: CheckpointEntry, rootDir: string): Promise<void> {
    const abs = path.join(rootDir, entry.file);
    const lang = path.extname(entry.file).slice(1) || 'plaintext';
    const oldText = entry.existed && fs.existsSync(entry.backup) ? fs.readFileSync(entry.backup, 'utf8') : '';
    const newText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const left = await vscode.workspace.openTextDocument({ content: oldText, language: lang });
    const right = await vscode.workspace.openTextDocument({ content: newText, language: lang });
    await vscode.commands.executeCommand(
      'vscode.diff',
      left.uri,
      right.uri,
      `${entry.file} (снимок ↔ сейчас)`
    );
  }

  /** Откатить один файл к снимку. */
  async revert(entry: CheckpointEntry, rootDir: string): Promise<void> {
    const abs = path.join(rootDir, entry.file);
    if (entry.existed) {
      if (!fs.existsSync(entry.backup)) throw new Error(`Снимок не найден: ${entry.file}`);
      fs.copyFileSync(entry.backup, abs);
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs);
    }
    // файл откачен — убираем из списка, чтобы не откатить повторно чужие правки
    this.entries = this.entries.filter((e) => e !== entry);
  }

  /** Откатить все файлы сессии. */
  async revertAll(rootDir: string): Promise<number> {
    let n = 0;
    for (const entry of [...this.entries].reverse()) {
      try {
        await this.revert(entry, rootDir);
        n++;
      } catch {
        // пропускаем файл с ошибкой отката
      }
    }
    return n;
  }

  /** Найти запись по относительному пути. */
  find(relFile: string): CheckpointEntry | undefined {
    return this.entries.find((e) => e.file === relFile);
  }

  /** Принять изменения: снимок больше не нужен, удаляем запись и бэкап. */
  discard(entry: CheckpointEntry): void {
    this.entries = this.entries.filter((e) => e !== entry);
    try {
      if (entry.existed && fs.existsSync(entry.backup)) fs.rmSync(entry.backup);
    } catch {
      // не критично
    }
  }

  /** Принять все изменения сессии. */
  discardAll(): void {
    for (const entry of [...this.entries]) this.discard(entry);
  }
}
