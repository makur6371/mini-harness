// plugins/llm.mjs — 缝 1 实现:OpenAI 兼容 chat 网关 + 指数退避重试
// 对应 DSH:packages/host/apiproxy(ctx.apiProxy)

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export function loadLLMPlugin(opts = {}) {
  const env = process.env;
  const baseUrl = (env.MINI_LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.MINI_LLM_MODEL ?? 'deepseek-chat';
  const apiKey = env.MINI_LLM_API_KEY;
  const retries = opts.retries ?? 3;

  async function chat({ messages, tools, signal, onDelta }) {
    if (!apiKey)
      throw new Error(
        '缺少 MINI_LLM_API_KEY(OpenAI 兼容 key);可先跑 `node test.mjs` 用 mock 验证'
      );
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
      let res;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages,
            tools: tools.length ? tools : undefined,
            stream: Boolean(onDelta), // 传入 onDelta 即走 SSE 流式
            stream_options: onDelta ? { include_usage: false } : undefined,
          }),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = err;
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        lastErr = new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
        if (RETRYABLE.has(res.status)) continue;
        throw lastErr;
      }

      // —— 非流式:一次性返回 ——
      if (!onDelta) {
        const data = await res.json();
        return { message: data.choices?.[0]?.message, raw: data };
      }

      // —— 流式:拼装 delta;出现工具调用时自动降级为缓冲累积 ——
      const message = { role: 'assistant', content: '' };
      const toolBuf = new Map(); // index → {id,name,args}
      let sawToolCall = false;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop();
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              let chunk;
              try {
                chunk = JSON.parse(data);
              } catch {
                continue;
              }
              const delta = chunk.choices?.[0]?.delta ?? {};
              if (delta.content) {
                message.content += delta.content;
                onDelta(delta.content);
              }
              for (const tc of delta.tool_calls ?? []) {
                sawToolCall = true;
                const slot = toolBuf.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name += tc.function.name;
                if (tc.function?.arguments) slot.args += tc.function.arguments;
                toolBuf.set(tc.index, slot);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (sawToolCall) {
        message.tool_calls = [...toolBuf.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, s]) => ({
            id: s.id || `call_${s.name}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: { name: s.name, arguments: s.args || '{}' },
          }));
        message.content = message.content || null;
      }
      return { message };
    }
    throw lastErr;
  }

  return function register(ctx) {
    ctx.llm = { chat, model, baseUrl };
  };
}
