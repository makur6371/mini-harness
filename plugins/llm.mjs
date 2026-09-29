// plugins/llm.mjs — 缝 1 实现:OpenAI 兼容 chat 网关 + 指数退避重试
// 对应 DSH:packages/host/apiproxy(ctx.apiProxy)

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

export function loadLLMPlugin(env = process.env) {
  const baseUrl = (env.MINI_LLM_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = env.MINI_LLM_MODEL ?? 'deepseek-chat';
  const apiKey = env.MINI_LLM_API_KEY;

  async function chat({ messages, tools, signal }) {
    if (!apiKey)
      throw new Error(
        '缺少 MINI_LLM_API_KEY(OpenAI 兼容 key);可先跑 `node test.mjs` 用 mock 验证'
      );
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
      let res;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages, tools: tools.length ? tools : undefined }),
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
      const data = await res.json();
      return { message: data.choices?.[0]?.message, raw: data };
    }
    throw lastErr;
  }

  return function register(ctx) {
    ctx.llm = { chat, model, baseUrl };
  };
}
