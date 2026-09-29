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

async function handleChat(sites, siteId, body, res) {
  const ctx = sites.get(siteId);
  if (!ctx) {
    res.writeHead(404).end('unknown site');
    return;
  }

  // —— 入参校验:坏消息不能进历史(历史一旦污染,后续每轮都会 400)——
  const { sessionId: rawSid, message } = body ?? {};
  if (typeof message !== 'string' || !message.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'message 必须是非空字符串' }));
    return;
  }
  const sessionId = String(rawSid || 'anon').slice(0, 64);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // —— 同会话串行化:同一访客的并发请求排队,避免交叉写坏同一份 messages ——
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const job = prev.then(() => serveTurn(ctx, sessionId, message.trim(), res));
  sessionLocks.set(
    sessionId,
    job.catch(() => {}) // 锁链不能断
  );
  await job;
}

/** 每会话一把"锁":promise 链 */
const sessionLocks = new Map();

async function serveTurn(ctx, sessionId, message, res) {
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
  } catch (err) {
    messages.length = Math.min(checkpoint, messages.length); // 回滚
    done('final', { content: '抱歉,我这边出了点问题,请稍后再试。' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const isGet = req.method === 'GET' || req.method === 'HEAD';
  try {
    if (isGet && url.pathname === '/healthz') {
      res.writeHead(200).end('ok');
    } else if (isGet && url.pathname === '/embed.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(readFileSync('public/embed.js'));
    } else if (isGet && (m = url.pathname.match(/^\/s\/([\w-]+)\/embed\.json$/))) {
      const ctx = sites.get(m[1]);
      if (!ctx) return res.writeHead(404).end('{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          siteId: m[1],
          title: ctx.embed?.title ?? '助手',
          welcome: ctx.embed?.welcome ?? '你好,有什么可以帮你?',
          theme: ctx.embed?.theme ?? { accent: '#4f46e5' },
        })
      );
    } else if (req.method === 'POST' && (m = url.pathname.match(/^\/s\/([\w-]+)\/api\/chat$/))) {
      let body = '';
      for await (const c of req) body += c;
      await handleChat(sites, m[1], body ? JSON.parse(body) : {}, res);
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err?.message ?? err));
  }
});

let sites;
let m;

sites = await loadSites();
server.listen(PORT, () => {
  console.log(`[mini-harness server] http://localhost:${PORT} (sites: ${[...sites.keys()].join(', ')})`);
});
