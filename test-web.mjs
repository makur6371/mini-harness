// test-web.mjs — 网站形态的端到端测试:mock LLM,走真实 HTTP + SSE + 站点包钩子
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';

rmSync('data-test-web', { recursive: true, force: true });
mkdirSync('data-test-web', { recursive: true });

// 用环境变量把 llm 插件指向 mock —— 依旧是"只换缝1实现,其余不动"
// mock 方式:起一个本地 OpenAI 兼容假服务
import { createServer } from 'node:http';
const script = [];
let step = 0;
const mockLLM = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const next = script[step++]?.(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next));
  });
});
await new Promise((r) => mockLLM.listen(0, '127.0.0.1', r));
const port = mockLLM.address().port;

// 剧本:问价 → 调 query_services → 用工具结果回答;再问无关 → 守门拒绝
script.push((req) => ({
  choices: [{
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'query_services', arguments: '{}' } }],
    },
  }],
}));
script.push((req) => {
  const toolMsg = req.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg && /超声波洁牙/.test(toolMsg.content), '工具结果应进入上下文');
  return { choices: [{ message: { role: 'assistant', content: '洁牙 199-299 元,约 40 分钟,当日可约~' } }] };
});
script.push((req) => ({
  choices: [{ message: { role: 'assistant', content: '这个问题超出了口腔咨询范围,我可以帮你约个线下检查~' } }],
}));

// 起真实 server(子进程),指向 mock LLM
const SRV_PORT = 8790 + Math.floor(Math.random() * 500); // 随机端口,避免残留进程导致 EADDRINUSE
const srv = spawn('node', ['server.mjs'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(SRV_PORT),
    SITE: 'demo-clinic',
    DATA_DIR: 'data-test-web/sites',
    MINI_LLM_API_KEY: 'mock',
    MINI_LLM_BASE_URL: `http://127.0.0.1:${port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
let srvLog = '';
srv.stdout.on('data', (d) => (srvLog += d));
const waitBoot = await new Promise((resolve) => {
  const t = setInterval(() => {
    if (srvLog.includes('已挂载')) { clearInterval(t); resolve(true); }
  }, 100);
  setTimeout(() => resolve(false), 5000);
});
assert.ok(waitBoot, 'server 应在 5s 内挂载站点');

const BASE = `http://127.0.0.1:${SRV_PORT}`;
const j = async (p, opt) => (await fetch(BASE + p, opt)).json();

// 1. embed.json 反映站点包的呈现配置
const emb = await j('/s/demo-clinic/embed.json');
assert.equal(emb.title, '皓齿口腔 · 小皓');
assert.equal(emb.theme.accent, '#0ea5e9');
console.log('ok  embed.json 由站点包塑造');

// 2. 咨询型:模型调垂直工具 → 拿价目 → 回答
const r1 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u1', message: '洁牙多少钱?' }),
});
const sseText = await r1.text();
assert.ok(r1.headers.get('content-type').includes('text/event-stream'), '应是 SSE');
const final1 = JSON.parse(/^data: (.+)$/m.exec(sseText)?.[1] ?? '{}');
assert.match(final1.content, /199-299 元/);
console.log('ok  咨询型:垂直工具被调用并形成回答');

// 3. 同 sessionId 多轮:第二轮的请求里应带上第一轮历史(记忆来自会话,不是内核)
script.length = 0; step = 0;
script.push((req) => {
  const users = req.messages.filter((m) => m.role === 'user').length;
  assert.equal(users, 2, '同一 sessionId 应保留两轮用户消息');
  const sys = req.messages[0];
  assert.match(sys.content, /皓齿口腔/, 'system prompt 应注入站点包身份');
  const toolNames = JSON.stringify(req.tools);
  assert.ok(toolNames.includes('book_appointment'), '工具白名单来自站点包');
  assert.ok(!toolNames.includes('"bash"'), '访客形态绝不暴露 bash');
  return { choices: [{ message: { role: 'assistant', content: '好的,请告诉我姓名和手机号~' } }] };
});
const r2 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u1', message: '我想约洁牙' }),
});
await r2.text();
console.log('ok  多轮记忆 + 站点包身份/白名单生效,且无 bash');

// 4. 办事型:预约工具(校验手机号,坏号码应回喂错误后由 mock 收敛)
script.length = 0; step = 0;
script.push((req) => ({
  choices: [{
    message: {
      role: 'assistant', content: null,
      tool_calls: [{ id: 't2', type: 'function', function: {
        name: 'book_appointment',
        arguments: JSON.stringify({ name: '测试', phone: '13800000000', service: '超声波洁牙', date: '明天下午' }),
      } }],
    },
  }],
}));
script.push(() => ({ choices: [{ message: { role: 'assistant', content: '预约成功,预约号见短信~' } }] }));
const r3 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u2', message: '帮我预约明天下午洁牙,测试 13800000000' }),
});
const final3 = JSON.parse(/^data: (.+)$/m.exec(await r3.text())?.[1] ?? '{}');
assert.match(final3.content, /预约成功/);
const saved = JSON.parse(readFileSync('data-test-web/sites/demo-clinic/store.json', 'utf8'));
const bk = Object.values(saved).find((v) => v.phone === '13800000000'); // 缝4 KV:appointment:<id> 键
assert.ok(bk, '预约应通过 store 缝落盘');
assert.equal(bk.status, 'pending');
console.log('ok  办事型:预约落盘(store 缝)');

// 5. 未知站点 404
const r4 = await fetch(`${BASE}/s/nope/api/chat`, { method: 'POST', body: '{}' });
assert.equal(r4.status, 404);
console.log('ok  未知站点隔离');

mockLLM.close();
srv.kill();
rmSync('data-test-web', { recursive: true, force: true });
console.log('\nweb 全部通过 ✅');

import { readFileSync } from 'node:fs';
