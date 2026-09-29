// server.mjs — 网站形态的挂载层:多站点、每站点一内核
// 用法:
//   node server.mjs                       # 加载 sites/*.site.mjs
//   SITE=demo-clinic PORT=8787 node server.mjs   # 只起一个站点,便于调试
//
// 端点:
//   GET  /embed.js                 嵌入脚本(一行 <script> 接入)
//   GET  /s/:site/embed.json       该站点的嵌入配置(标题/欢迎语/主题色)
//   POST /s/:site/api/chat         聊天端点,SSE 流式返回
//   GET  /healthz                  健康检查

import { createServer } from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createKernel, runAgent, systemMessage, userMessage } from './kernel.mjs';
import { loadLLMPlugin } from './plugins/llm.mjs';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || 'data/sites';

// —— 站点会话的持久化走缝4(内核的 store 缝不绑定任何后端)——
import { loadStorePlugin } from './plugins/store-json.mjs';

/** 每个站点一个独立内核:插件包只塑造自己站点的行为 */
async function bootSite(siteId, install) {
  const ctx = createKernel();
  const dataDir = `${DATA_DIR}/${siteId}`;
  loadStorePlugin({ file: `${dataDir}/store.json` })(ctx); // 缝4:每站点独立数据
  loadLLMPlugin()(ctx);                                    // 缝1:共享网关(模型/密钥统一管)

  // 访客会话:各自独立 messages;带 TTL(30 分钟)与总量上限(200)防内存膨胀
  const sessions = new Map();
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const SESSION_MAX = 200;
  ctx.sessions = {
    get(id) {
      const hit = sessions.get(id);
      if (hit) clearTimeout(hit.timer);
      const entry = hit ?? { messages: [systemMessage(ctx.prompt.assemble())] };
      entry.timer = setTimeout(() => sessions.delete(id), SESSION_TTL_MS);
      entry.timer.unref?.(); // 不阻止进程退出
      if (!hit) {
        sessions.set(id, entry);
        if (sessions.size > SESSION_MAX) {
          const oldest = sessions.keys().next().value; // 近似 LRU:淘汰最早创建的
          clearTimeout(sessions.get(oldest)?.timer);
          sessions.delete(oldest);
        }
      }
      return entry.messages;
    },
  };

  await install(ctx, {
    siteId,
    dataDir,
    config: existsSync(`${dataDir}/config.json`)
      ? JSON.parse(readFileSync(`${dataDir}/config.json`, 'utf8'))
      : {},
  });

  restoreSessions(ctx, siteId); // 重启恢复会话
  return ctx;
}

async function loadSites() {
  const only = process.env.SITE;
  const files = readdirSync('sites').filter((f) => f.endsWith('.site.mjs') && !f.startsWith('_'));
  const sites = new Map();
  for (const f of files) {
    const siteId = f.replace(/\.site\.mjs$/, '');
    if (only && siteId !== only) continue;
    const mod = await import(`./sites/${f}`);
    sites.set(siteId, await bootSite(siteId, mod.default));
    console.log(`[site] ${siteId} 已挂载`);
  }
  return sites;
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 会话锁 + 每会话/每 IP 令牌桶限流 */
const sessionLocks = new Map();
const buckets = new Map(); // "ip|sid" → { tokens, updated }
const RATE = { capacity: 20, refillPerMin: 20 }; // 令牌桶:20 发,每分钟回 20

function allowRate(key) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: RATE.capacity, updated: now };
  b.tokens = Math.min(RATE.capacity, b.tokens + ((now - b.updated) / 60000) * RATE.refillPerMin);
  b.updated = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

function corsHeaders(site, req) {
  // Origin 白名单:站点包 ctx.embed.allowedOrigins(数组或函数)优先,默认放行同源与 localhost 调试
  let allow = '*';
  const origin = req.headers.origin;
  const rules = site?.embed?.allowedOrigins;
  if (rules) {
    const list = typeof rules === 'function' ? rules(req) : rules;
    if (list?.includes(origin)) allow = origin;
  } else if (origin && !/^(https?:\/\/(localhost|127\.0\.0\.1))/.test(origin)) {
    allow = origin; // 生产默认:回显任意来源(嵌入场景无法预知客户域名),显式白名单可收紧
  }
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-agent-token',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

/** embed token 门:站点包 ctx.embed.tokens 非空时,请求须带匹配的 X-Agent-Token。
 *  注:脚本标签里的 token 在页面源码里可见(同 Google Maps key 的固有限制),
 *  真正的防刷靠它+限流+Origin 白名单组合,而非把它当密钥。 */
function tokenOk(site, req) {
  const tokens = site?.embed?.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return true; // 未配置 = 开放(开发/调试)
  return tokens.includes(req.headers['x-agent-token']);
}

async function handleChat(sites, siteId, body, req, res) {
  const ctx = sites.get(siteId);
  if (!ctx) {
    res.writeHead(404).end('unknown site');
    return;
  }

  // —— 入参校验:坏消息不能进历史(历史一旦污染,后续每轮都会 400)——
  const { sessionId: rawSid, message } = body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    res.writeHead(400, { 'content-type': 'application/json', ...corsHeaders(ctx, req) });
    res.end(JSON.stringify({ error: 'message 必须是非空字符串' }));
    return;
  }

  // —— token 门:站点配了 tokens 就必须带 ——
  if (!tokenOk(ctx, req)) {
    res.writeHead(401, { 'content-type': 'application/json', ...corsHeaders(ctx, req) });
    res.end(JSON.stringify({ error: '无效或缺失的 X-Agent-Token' }));
    return;
  }

  const sessionId = String(rawSid || 'anon').slice(0, 64);

  // —— 限流:每 IP+会话 令牌桶 ——
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';
  if (!allowRate(`${ip}|${sessionId}`)) {
    res.writeHead(429, {
      'content-type': 'application/json',
      ...corsHeaders(sites.get(siteId), req),
    });
    res.end(JSON.stringify({ error: '请求太频繁,请稍后再试' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...corsHeaders(sites.get(siteId), req),
  });

  // —— 同会话串行化:同一访客的并发请求排队,避免交叉写坏同一份 messages ——
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const job = prev.then(() => serveTurn(ctx, siteId, sessionId, message.trim(), res));
  sessionLocks.set(
    sessionId,
    job.catch(() => {}) // 锁链不能断
  );
  await job;
}

/** 锁表定时清理,防无限增长 */
setInterval(() => {
  if (sessionLocks.size > 1000) sessionLocks.clear();
}, 60_000).unref?.();
setInterval(() => buckets.clear(), 300_000).unref?.();

async function serveTurn(ctx, siteId, sessionId, message, res) {
  const messages = ctx.sessions.get(sessionId);

  // 访客关页/断连 → 中止本轮 LLM 调用,别再为已离开的人烧 token
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const done = (event, data) => {
    if (!res.writableEnded) sse(res, event, data);
    res.end();
  };

  // —— 钩子:before:chat(守门/改写,通过修改 payload 生效)——
  const payload = { message, reject: null };
  await ctx.emit('before:chat', payload);
  if (payload.reject) {
    done('final', { content: payload.reject });
    return;
  }

  // 打字机:逐段推送 delta;遇到工具轮发 reset 让前端清掉工具轮前的残留文本
  const origChat = ctx.llm.chat.bind(ctx.llm);
  let sawTool = false;
  const offTool = ctx.on('tool:start', () => {
    if (!sawTool) {
      sawTool = true;
      if (!res.writableEnded) sse(res, 'reset', {});
    }
  });
  ctx.llm.chat = (args) =>
    origChat({
      ...args,
      onDelta: (text) => {
        if (!res.writableEnded) sse(res, 'delta', { text });
      },
    });

  // checkpoint:失败时回滚,会话永不带伤上阵(CLI 同款机制)
  const checkpoint = messages.length;
  messages.push(userMessage(payload.message));
  try {
    const final = await runAgent(ctx, { messages, maxTurns: 12, signal: abort.signal });
    const out = { content: final.content ?? '' };
    await ctx.emit('after:final', out); // 兜底:handler 直接改 out.content
    // 历史裁剪:保 system 首条 + 最近 40 条,防止长会话无限膨胀
    if (messages.length > 60) messages.splice(1, messages.length - 41);
    done('final', { content: out.content });
    persistSession(ctx, siteId, sessionId, messages);
  } catch (err) {
    messages.length = Math.min(checkpoint, messages.length); // 回滚
    persistSession(ctx, siteId, sessionId, messages);
    done('final', { content: '抱歉,我这边出了点问题,请稍后再试。' });
  } finally {
    ctx.llm.chat = origChat; // 还原缝,别把 delta 适配器泄漏到下一轮
    offTool();
  }
}

/** 会话持久化:走缝4,重启不失忆;失败静默(持久化不能打断对话) */
function persistSession(ctx, siteId, sessionId, messages) {
  try {
    const trimmed = messages.slice(-40);
    if (trimmed[0]?.role !== 'system') {
      const sys = messages.find((m) => m.role === 'system');
      if (sys) trimmed.unshift(sys);
    }
    ctx.store.set(`session:${siteId}:${sessionId}`, {
      at: Date.now(),
      messages: trimmed,
    });
  } catch {}
}

/** 恢复持久化的会话(启动时) */
function restoreSessions(ctx, siteId) {
  try {
    const prefix = `session:${siteId}:`;
    for (const k of ctx.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      const v = ctx.store.get(k);
      if (v?.messages?.length) {
        const sid = k.slice(prefix.length);
        const msgs = ctx.sessions.get(sid); // 触发创建,返回 messages 数组
        msgs.length = 0;
        msgs.push(...v.messages);
      }
    }
  } catch (err) {
    console.warn(`[site] 会话恢复失败: ${err?.message ?? err}`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  const siteMatch = url.pathname.match(/^\/s\/([\w-]+)(\/.*)?$/);
  const siteId = siteMatch?.[1];
  const site = siteId ? sites.get(siteId) : null;
  const cors = site ? corsHeaders(site, req) : {};
  try {
    // CORS 预检:嵌入场景必然跨域
    if (req.method === 'OPTIONS' && site) {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (isGet && url.pathname === '/healthz') {
      res.writeHead(200, cors).end('ok');
    } else if (isGet && url.pathname === '/embed.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', ...cors });
      res.end(readFileSync('public/embed.js'));
    } else if (isGet && siteMatch && siteMatch[2] === '/embed.json') {
      if (!site) return res.writeHead(404, cors).end('{}');
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(
        JSON.stringify({
          siteId,
          title: site.embed?.title ?? '助手',
          welcome: site.embed?.welcome ?? '你好,有什么可以帮你?',
          theme: site.embed?.theme ?? { accent: '#4f46e5' },
        })
      );
    } else if (req.method === 'POST' && siteMatch && siteMatch[2] === '/api/chat') {
      if (!site) return res.writeHead(404, cors).end('unknown site');
      let body = '';
      for await (const c of req) body += c;
      await handleChat(sites, siteId, body ? JSON.parse(body) : {}, req, res);
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err?.message ?? err));
  }
});

let sites;

sites = await loadSites();
server.listen(PORT, () => {
  console.log(`[mini-harness server] http://localhost:${PORT} (sites: ${[...sites.keys()].join(', ')})`);
});
