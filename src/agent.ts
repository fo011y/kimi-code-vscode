import { ApiConfig, ChatMessage, streamChat, TokenUsage } from './api';
import { executeTool, toolDefinitions } from './tools';
import { S, fmt } from './i18n';
import { getAutoCompactTokens, getAutoContinues, getIntentContinues, getMaxAgentSteps, isPlanMode } from './config';

export interface AgentHooks {
  onToken(text: string): void;
  onTool(name: string, status: 'running' | 'done' | 'error', detail?: string): void;
  onUsage?(usage: TokenUsage): void;
  /** Служебные сообщения в чат (автоархивация контекста и т.п.). */
  onInfo?(text: string): void;
  /**
   * Ответ API 401 посреди работы: попытаться обновить авторизацию
   * (refresh OAuth-токена) и подменить cfg.apiKey. true → шаг повторяется.
   */
  onAuthRefresh?(): Promise<boolean>;
  signal?: AbortSignal;
}

/** Похоже ли сообщение об ошибке на отказ авторизации (протухший токен). */
export function isAuthError(e: unknown): boolean {
  const t = String((e as Error)?.message ?? e ?? '');
  return /\b401\b|invalid_authentication|unauthorized|invalid.*(api.?key|token)|token.*(expired|invalid)/i.test(t);
}

/**
 * Модель завершила ход текстом с обещанием продолжить работу
 * («проверю», «сейчас сделаю»…), но не вызвала ни одного инструмента.
 * Условные предложения пользователю («если хотите — проверю») не считаются.
 */
export function hasContinuationIntent(text: string): boolean {
  if (!text) return false;
  const tail = text.trim().slice(-400);
  if (/если (хотите|вам нужно|понадобится)|могу (также|ещё)|скажите, если|хотите, (чтобы|я)/i.test(tail)) {
    return false;
  }
  return /(проверю|посмотрю|найду|сделаю|запущу|соберу|исправлю|добавлю|обновлю|продолжу|приступаю|давайте|сейчас|let me|i'll|i will|going to|next i)/i.test(
    tail
  );
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
    else if (Array.isArray(m.content)) parts.push(S.sketchMedia);
    if (m.tool_calls?.length) {
      parts.push(
        S.sketchToolCalls +
          m.tool_calls
            .map((c) => `${c.function.name}(${(c.function.arguments || '').slice(0, 200)})`)
            .join('; ') +
          ']'
      );
    }
    return 'assistant: ' + (parts.join(' ') || S.sketchEmpty);
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

  onInfo?.(S.compactStart);
  try {
    const res = await streamChat(cfg, [
      {
        role: 'system',
        content: S.compactSystem,
      },
      { role: 'user', content: transcript },
    ]);
    const summary: ChatMessage[] = [
      { role: 'user', content: S.compactUserPrefix + res.content },
      { role: 'assistant', content: S.compactAck },
    ];
    messages.splice(2, s - 2, ...summary);
    onInfo?.(fmt(S.compactDone, middle.length, res.usage?.total_tokens ?? '?'));
    return true;
  } catch (e) {
    onInfo?.(fmt(S.compactFailed, String((e as Error)?.message ?? e)));
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
  let authRetries = 0;
  let intentContinues = 0;
  let lastFinalText = '';
  const maxIntentContinues = getIntentContinues(); // 0 = не подталкивать
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
        authRetries = 0; // запрос прошёл — сбрасываем счётчик авторетраев
      } catch (e) {
        // 401 посреди работы: access token протух — обновляем и повторяем шаг
        if (
          isAuthError(e) &&
          hooks.onAuthRefresh &&
          authRetries < 2 &&
          !hooks.signal?.aborted
        ) {
          authRetries++;
          hooks.onInfo?.(S.tokenRefresh);
          if (await hooks.onAuthRefresh()) {
            step--;
            continue;
          }
          throw new Error(
            S.sessionExpired
          );
        }
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

      if (res.toolCalls.length === 0) {
        // Модель закончила ход текстом. Если она пообещала продолжить работу
        // («проверю», «сейчас сделаю»…), но не вызвала инструменты — подталкиваем.
        if (!plan && intentContinues < maxIntentContinues && hasContinuationIntent(res.content)) {
          const finalText = res.content.trim();
          if (finalText && finalText === lastFinalText) return; // зациклилась — стоп
          lastFinalText = finalText;
          intentContinues++;
          hooks.onInfo?.(
            fmt(S.intentNudge, intentContinues, maxIntentContinues)
          );
          messages.push({
            role: 'user',
            content:
              S.intentNudgeUser,
          });
          continue;
        }
        return; // финальный ответ — задача выполнена
      }

      for (const call of res.toolCalls) {
        const name = call.function.name;
        hooks.onTool(name, 'running');
        let result: string;
        try {
          result = await executeTool(name, call.function.arguments, hooks.signal);
          hooks.onTool(name, 'done');
        } catch (e: any) {
          result = fmt(S.toolError, e?.message ?? String(e));
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
      fmt(S.stepsExhausted, maxSteps, continues, maxContinues)
    );
    messages.push({
      role: 'user',
      content:
        S.continuePrompt,
    });
  }

  const warn = S.stepsLimitWarn;
  hooks.onToken(warn);
  messages.push({ role: 'assistant', content: warn });
}
