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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个站点一个独立内核:插件包只塑造自己站点的行为 */
async function bootSite(siteId, install) {
  const ctx = createKernel();
  const dataDir = `${DATA_DIR}/${siteId}`;
  loadStorePlugin({ file: `${dataDir}/store.json` })(ctx); // 缝4:每站点独立数据
  loadLLMPlugin()(ctx);                                    // 缝1:共享网关(模型/密钥统一管)

  // 访客会话 → 各自独立的 messages;多轮记忆就来自这里
  const sessions = new Map();
  ctx.sessions = {
    get(id) {
      if (!sessions.has(id)) sessions.set(id, [systemMessage(ctx.prompt.assemble())]);
      return sessions.get(id);
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
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const { sessionId, message } = body ?? {};
  const messages = ctx.sessions.get(sessionId || 'anon');

  // —— 钩子:before:chat(守门/改写)——
  const payload = { message, reject: null };
  await ctx.emit('before:chat', payload);
  if (payload.reject) {
    sse(res, 'final', { content: payload.reject });
    res.end();
    return;
  }
  messages.push(userMessage(payload.message));

  // —— 钩子:after:final(兜底话术替换)——
  try {
    const final = await runAgent(ctx, { messages, maxTurns: 12 });
    const out = { content: final.content ?? '' };
    await ctx.emit('after:final', out);
    sse(res, 'final', { content: out.content });
  } catch (err) {
    sse(res, 'final', { content: '抱歉,我这边出了点问题,请稍后再试。' });
  } finally {
    res.end();
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
