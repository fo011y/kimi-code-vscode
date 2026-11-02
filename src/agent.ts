import { ApiConfig, ChatMessage, streamChat } from './api';
import { executeTool, toolDefinitions } from './tools';
import { getMaxAgentSteps } from './config';

export interface AgentHooks {
  onToken(text: string): void;
  onTool(name: string, status: 'running' | 'done' | 'error', detail?: string): void;
  signal?: AbortSignal;
}

/**
 * Агентный цикл: модель вызывает инструменты, мы выполняем их
 * и возвращаем результаты, пока модель не даст финальный ответ.
 */
export async function runAgentLoop(
  cfg: ApiConfig,
  messages: ChatMessage[],
  hooks: AgentHooks
): Promise<void> {
  const tools = toolDefinitions();
  const maxSteps = getMaxAgentSteps();

  for (let step = 0; step < maxSteps; step++) {
    if (hooks.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const res = await streamChat(cfg, messages, {
      tools,
      onToken: hooks.onToken,
      signal: hooks.signal,
    });

    const assistantMsg: ChatMessage = { role: 'assistant' };
    if (res.content) assistantMsg.content = res.content;
    if (res.toolCalls.length > 0) assistantMsg.tool_calls = res.toolCalls;
    messages.push(assistantMsg);

    if (res.toolCalls.length === 0) return; // финальный ответ

    for (const call of res.toolCalls) {
      const name = call.function.name;
      hooks.onTool(name, 'running');
      let result: string;
      try {
        result = await executeTool(name, call.function.arguments);
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
  }

  const warn = '\n\n⚠️ Достигнут лимит шагов агента. Ответ может быть неполным — спросите «продолжи».';
  hooks.onToken(warn);
  messages.push({ role: 'assistant', content: warn });
}
