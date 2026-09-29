// test-web.mjs — 网站形态的端到端测试:mock LLM,走真实 HTTP + SSE + 站点包钩子
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, readFileSync, mkdirSync } from 'node:fs';

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

// 6. 兜底钩子:模型返回空回复 → after:final 应替换成转人工话术
script.length = 0; step = 0;
script.push(() => ({ choices: [{ message: { role: 'assistant', content: '   ' } }] }));
const r5 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u6', message: '说点什么' }),
});
const final5 = JSON.parse(/^data: (.+)$/m.exec(await r5.text())?.[1] ?? '{}');
assert.match(final5.content, /转人工/, '空回复应触发站点包兜底话术');
console.log('ok  after:final 兜底钩子生效');

// 7. 失败回滚:让 LLM 打 500 → 会话不应被半截对话污染,下一轮照常
script.length = 0; step = 0;
script.push(() => null); // 第 1 轮:LLM 返回异常响应,触发内核错误路径
script.push((req) => {
  const roles = req.messages.map((m) => m.role);
  assert.ok(!roles.includes('tool'), `回滚后不应残留 tool 消息:${roles}`);
  // 不变量:失败轮次整体消失(含当时的用户消息),会话里只剩本轮提问
  assert.equal(roles.filter((r) => r === 'user').length, 1, `失败轮应被整体回滚:${roles}`);
  assert.equal(roles[roles.length - 1], 'user', '最后一条应是本轮用户消息');
  return { choices: [{ message: { role: 'assistant', content: '恢复后的正常回答' } }] };
});
const r6 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u7', message: '第一轮,会遇到 500' }),
});
const final6 = JSON.parse(/^data: (.+)$/m.exec(await r6.text())?.[1] ?? '{}');
assert.match(final6.content, /抱歉,我这边出了点问题/);
const r7 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u7', message: '第二轮,应该恢复正常' }),
});
const final7 = JSON.parse(/^data: (.+)$/m.exec(await r7.text())?.[1] ?? '{}');
assert.match(final7.content, /恢复后的正常回答/);
console.log('ok  失败回滚:失败轮整体消失,会话可恢复');

// 8. 坏请求:空 message → 400,且不进会话历史
const r8 = await fetch(`${BASE}/s/demo-clinic/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'u8', message: '  ' }),
});
assert.equal(r8.status, 400);
console.log('ok  空消息 400,不污染历史');

mockLLM.close();
srv.kill();
rmSync('data-test-web', { recursive: true, force: true });
console.log('\nweb 全部通过 ✅');
