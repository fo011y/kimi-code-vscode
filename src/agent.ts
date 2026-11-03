import { ApiConfig, ChatMessage, streamChat, TokenUsage } from './api';
import { executeTool, toolDefinitions } from './tools';
import { getAutoCompactTokens, getAutoContinues, getMaxAgentSteps, isPlanMode } from './config';

export interface AgentHooks {
  onToken(text: string): void;
  onTool(name: string, status: 'running' | 'done' | 'error', detail?: string): void;
  onUsage?(usage: TokenUsage): void;
  /** Служебные сообщения в чат (автоархивация контекста и т.п.). */
  onInfo?(text: string): void;
  signal?: AbortSignal;
}

/** Похоже ли сообщение об ошибке на переполнение контекста модели. */
export function isContextOverflowError(e: unknown): boolean {
  const t = String((e as Error)?.message ?? e ?? '');
  return /context.?length|too long|max(imum)? context|exceeds?.*(token|context)|token limit|prompt.*too.*long|request.*too.*large|413/i.test(t);
}

/** Короткое текстовое представление сообщения для сводки. */
function sketch(m: ChatMessage): string {
  if (m.role === 'assistant') {
    const parts: string[] = [];
    if (typeof m.content === 'string') parts.push(m.content.slice(0, 2000));
    else if (Array.isArray(m.content)) parts.push('[медиа-контент]');
    if (m.tool_calls?.length) {
      parts.push(
        '[вызовы инструментов: ' +
          m.tool_calls
            .map((c) => `${c.function.name}(${(c.function.arguments || '').slice(0, 200)})`)
            .join('; ') +
          ']'
      );
    }
    return 'assistant: ' + (parts.join(' ') || '(пусто)');
  }
  if (m.role === 'tool') {
    return `tool(${m.name ?? '?'}): ` + (m.content ?? '').slice(0, 800);
  }
  return `${m.role}: ${(m.content ?? '').slice(0, 2000)}`;
}

/**
 * Автоархивация контекста агента: сжимает середину диалога в сводку,
 * сохраняя system, исходную задачу и последние сообщения (с учётом
 * целостности пар tool_calls → tool). Возвращает true, если сжатие выполнено.
 */
async function compactContext(
  cfg: ApiConfig,
  messages: ChatMessage[],
  onInfo?: (text: string) => void
): Promise<boolean> {
  // точка среза: последние ~6 сообщений оставляем как есть
  let s = Math.max(2, messages.length - 6);
  // нельзя начинать с tool-результата — ищем user/assistant
  while (s < messages.length && messages[s].role === 'tool') s++;
  if (s <= 2 || s >= messages.length) return false; // сжимать нечего

  const middle = messages.slice(2, s);
  const transcript = middle.map(sketch).join('\n\n').slice(0, 30000);

  onInfo?.('🗜 Лимит контекста — архивирую сессию и продолжаю работу…');
  try {
    const res = await streamChat(cfg, [
      {
        role: 'system',
        content:
          'Сожми ход работы AI-агента в краткую сводку (8–15 пунктов): что требовалось, что уже сделано, ' +
          'какие файлы изменены, какие команды выполнены, важные находки и контекст, что осталось сделать. ' +
          'Пиши на языке диалога. Сводка заменит середину диалога, поэтому сохрани всё критичное для продолжения работы.',
      },
      { role: 'user', content: transcript },
    ]);
    const summary: ChatMessage[] = [
      { role: 'user', content: `Архив предыдущей работы (автосжатие):\n${res.content}` },
      { role: 'assistant', content: 'Принято. Продолжаю задачу с учётом этой сводки.' },
    ];
    messages.splice(2, s - 2, ...summary);
    onInfo?.(`🗜 Контекст заархивирован: ${middle.length} сообщений → сводка (${res.usage?.total_tokens ?? '?'} ток.). Работа продолжается.`);
    return true;
  } catch (e) {
    onInfo?.(`⚠️ Автоархивация не удалась: ${(e as Error)?.message ?? e}`);
    return false;
  }
}

/**
 * Агентный цикл: модель вызывает инструменты, мы выполняем их
 * и возвращаем результаты, пока модель не даст финальный ответ.
 * При приближении к лимиту контекста сессия автоматически
 * архивируется (сжимается в сводку), и работа продолжается.
 */
export async function runAgentLoop(
  cfg: ApiConfig,
  messages: ChatMessage[],
  hooks: AgentHooks
): Promise<void> {
  const plan = isPlanMode();
  const tools = toolDefinitions(plan); // в plan-режиме — только чтение
  const maxSteps = getMaxAgentSteps();
  const compactAt = getAutoCompactTokens(); // 0 = автоархивация выключена
  const maxContinues = getAutoContinues(); // 0 = без автопродолжения

  let continues = 0;
  for (;;) {
    for (let step = 0; step < maxSteps; step++) {
      if (hooks.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      let res;
      try {
        res = await streamChat(cfg, messages, {
          tools,
          onToken: hooks.onToken,
          signal: hooks.signal,
        });
      } catch (e) {
        // переполнение контекста → архивируем и повторяем шаг
        if (
          compactAt > 0 &&
          isContextOverflowError(e) &&
          !hooks.signal?.aborted &&
          (await compactContext(cfg, messages, hooks.onInfo))
        ) {
          step--;
          continue;
        }
        throw e;
      }
      if (res.usage) hooks.onUsage?.(res.usage);

      const assistantMsg: ChatMessage = { role: 'assistant' };
      if (res.content) assistantMsg.content = res.content;
      if (res.toolCalls.length > 0) assistantMsg.tool_calls = res.toolCalls;
      messages.push(assistantMsg);

      if (res.toolCalls.length === 0) return; // финальный ответ — задача выполнена

      for (const call of res.toolCalls) {
        const name = call.function.name;
        hooks.onTool(name, 'running');
        let result: string;
        try {
          result = await executeTool(name, call.function.arguments, hooks.signal);
          hooks.onTool(name, 'done');
        } catch (e: any) {
          result = `Ошибка инструмента: ${e?.message ?? String(e)}`;
          hooks.onTool(name, 'error', e?.message);
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: result.slice(0, 20000),
        });
      }

      // превентивная архивация: промпт уже раздут — сжимаем до следующего шага
      if (
        compactAt > 0 &&
        res.usage &&
        res.usage.prompt_tokens > compactAt
      ) {
        await compactContext(cfg, messages, hooks.onInfo);
      }
    }

    // Лимит шагов исчерпан, но задача не завершена: автопродолжение —
    // агент работает до полного выполнения, без остановок.
    if (hooks.signal?.aborted || continues >= maxContinues) break;
    continues++;
    hooks.onInfo?.(
      `🔁 Лимит шагов (${maxSteps}) исчерпан — продолжаю работу автоматически (цикл ${continues}/${maxContinues})…`
    );
    messages.push({
      role: 'user',
      content:
        'Продолжай выполнение задачи с того места, где остановился. ' +
        'Не переспрашивай и не останавливайся, пока задача не будет полностью выполнена.',
    });
  }

  const warn = '\n\n⚠️ Достигнут лимит шагов агента. Ответ может быть неполным — спросите «продолжи».';
  hooks.onToken(warn);
  messages.push({ role: 'assistant', content: warn });
}
