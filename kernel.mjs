// kernel.mjs — 最小 Agent Harness 内核
// 设计原则:harness = 少数几个"缝"(seam) + 一个循环。插件只认识缝,插件之间零依赖。
// 缝 1 llm 网关 / 缝 2 工具注册表 / 缝 3 prompt 组装 / 缝 4 持久化 KV / 缝 5 事件总线

/** 缝 5:事件总线 —— 插件解耦的关键,工具执行器不知道谁在听 */
function createBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type)?.delete(fn); // 返回反注册函数
    },
    async emit(type, payload) {
      for (const fn of handlers.get(type) ?? []) await fn(payload);
    },
  };
}

/** 带 id 去重的通用注册表 */
function createRegistry(kind) {
  const map = new Map();
  return {
    register(item) {
      if (!item?.id) throw new Error(`${kind}.register 需要 { id, ... }`);
      if (map.has(item.id)) throw new Error(`${kind} "${item.id}" 重复注册`);
      map.set(item.id, item);
      return () => map.delete(item.id);
    },
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
}

/**
 * 创建内核 ctx —— 全部接缝都长在这个对象上
 */
export function createKernel(opts = {}) {
  const bus = createBus();

  const ctx = {
    // 缝 5:事件总线
    on: bus.on,
    emit: bus.emit,

    // 缝 1:llm 网关,由 llm 插件填充。
    // 约定:chat({ messages, tools, signal }) → { message: { role:'assistant', content, tool_calls? } }
    llm: null,

    // 缝 3:system prompt 分段注册表,按 priority 升序拼装
    prompt: {
      ...createRegistry('prompt'),
      assemble(extra = []) {
        const sections = [...this.list()]
          .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
          .map((s) => {
            const text = typeof s.text === 'function' ? s.text(ctx) : s.text;
            return `<section id="${s.id}">\n${text.trim()}\n</section>`;
          });
        return [...sections, ...extra].join('\n\n');
      },
    },

    // 缝 2:工具注册表
    // 约定:{ id, description, parameters(JSON Schema), execute(args, ctx) }
    tools: {
      ...createRegistry('tool'),
      /** 执行一次模型发起的工具调用,返回符合 OpenAI 约定的 tool 消息 */
      async call(toolCall, callCtx = ctx) {
        const name = toolCall.function?.name;
        const tool = this.get(name);
        await ctx.emit('tool:start', { name, args: toolCall.function?.arguments });
        let content;
        if (!tool) {
          content = `ERROR: 未知工具 "${name}"`;
        } else {
          try {
            const args = toolCall.function?.arguments
              ? JSON.parse(toolCall.function.arguments)
              : {};
            const out = await tool.execute(args, callCtx);
            content = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
          } catch (err) {
            // 工具报错回喂给模型,而不是崩掉循环
            content = `ERROR: ${err?.message ?? String(err)}`;
          }
        }
        const cap = opts.maxToolChars ?? 8000;
        if (content.length > cap)
          content = content.slice(0, cap) + `\n...[输出被截断,共 ${content.length} 字符]`;
        await ctx.emit('tool:end', { name, content });
        return { role: 'tool', tool_call_id: toolCall.id, content };
      },
    },

    // 缝 4:持久化 KV,由 store 插件填充。约定 get/set/delete/keys,值须可 JSON 序列化
    store: null,
  };
  return ctx;
}

/**
 * Agent 循环 —— 内核的全部"智能"就这么点。
 * 停止条件:模型不再发起工具调用;或达到 maxTurns。
 */
export async function runAgent(ctx, { messages, maxTurns = 40, signal } = {}) {
  const tools = ctx.tools.list().map((t) => ({
    type: 'function',
    function: {
      name: t.id,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));

  for (let turn = 1; turn <= maxTurns; turn++) {
    await ctx.emit('turn:start', { turn });
    const res = await ctx.llm.chat({ messages, tools, signal });
    messages.push(res.message);

    const calls = res.message.tool_calls ?? [];
    if (calls.length === 0) {
      await ctx.emit('agent:end', { turns: turn });
      return res.message; // 最终回答
    }
    for (const tc of calls) messages.push(await ctx.tools.call(tc));
  }
  throw new Error(`达到最大轮数 ${maxTurns},循环未收敛`);
}

/** OpenAI 消息约定的便捷构造 */
export const systemMessage = (content) => ({ role: 'system', content });
export const userMessage = (content) => ({ role: 'user', content });
