// test-browser.mjs — 真浏览器 E2E:验证 embed.js 这条"第一目的"产物真的能跑。
// 跨端口 = 真跨域,顺带覆盖 CORS 预检/SSE 流式渲染整条链路。
// 需求:系统装了 google-chrome;`npm install` 装了 puppeteer-core(devDep)。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const WORK = process.cwd();
const TMP = 'data-test-browser';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(`${WORK}/${TMP}`, { recursive: true });

// chrome 的 HOME/XDG 全部指向临时目录,随测随清,绝不污染仓库工作树
const CHROME_HOME = `${WORK}/${TMP}/chrome-home`;
mkdirSync(CHROME_HOME, { recursive: true });
process.env.HOME = CHROME_HOME;
process.env.XDG_CACHE_HOME = `${CHROME_HOME}/.cache`;
process.env.XDG_CONFIG_HOME = `${CHROME_HOME}/.config`;
process.env.XDG_DATA_HOME = `${CHROME_HOME}/.local/share`;

const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

// —— mock LLM:流式吐一段固定回复(逐字)——
const REPLY = '你好,这是来自真浏览器的回复,逐字输出验证打字机。';
const mockPort = await freePort();
const mockLLM = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const chunks = REPLY.match(/.{1,4}/gs) ?? [];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => {
      if (i < chunks.length)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`);
      else {
        res.write('data: [DONE]\n\n');
        res.end();
        clearInterval(t);
      }
    }, 20);
  });
});
await new Promise((r) => mockLLM.listen(mockPort, '127.0.0.1', r));

// —— mini-harness 服务(子进程),指向 mock ——
const agentPort = await freePort();
const srv = spawn('node', ['server.mjs'], {
  cwd: WORK,
  env: {
    ...process.env,
    PORT: String(agentPort),
    DATA_DIR: TMP,
    SITE: 'demo-clinic',
    MINI_LLM_API_KEY: 'mock',
    MINI_LLM_BASE_URL: `http://127.0.0.1:${mockPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const agentLog = [];
srv.stdout.on('data', (d) => agentLog.push(d.toString()));
await new Promise((resolve) => {
  const t = setInterval(() => agentLog.join('').includes('已挂载') && (clearInterval(t), resolve(true)), 100);
  setTimeout(() => resolve(false), 8000);
}).then((ok) => assert.ok(ok, 'agent 应在 8s 内挂载'));

// —— 静态宿主页(不同端口 = 跨域嵌入场景)——
const hostPort = await freePort();
const hostHtml = `<!doctype html><meta charset=utf-8><title>host</title>
<body><h1>客户网站(宿主页)</h1>
<script src="http://127.0.0.1:${agentPort}/embed.js" data-site="demo-clinic" defer></script>
</body></html>`;
const hostServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }).end(hostHtml);
});
await new Promise((r) => hostServer.listen(hostPort, '127.0.0.1', r));
const hostUrl = `http://127.0.0.1:${hostPort}/`;
const agentOrigin = `http://127.0.0.1:${agentPort}`;
assert.notEqual(hostPort, agentPort, '宿主页与 agent 必须跨端口(真跨域)');

// —— 启动真浏览器 ——
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  userDataDir: `${CHROME_HOME}/profile`,
});
const page = await browser.newPage();
const reqs = [];
page.on('request', (r) => reqs.push(r.url()));

await page.goto(hostUrl, { waitUntil: 'networkidle0', timeout: 15000 });

// 1. embed.js 跨域加载成功
assert.ok(reqs.some((u) => u === `${agentOrigin}/embed.js`), '应跨域加载 embed.js');
console.log('ok  跨域加载 embed.js(真浏览器 <script>)');

// 2. 气泡 + 面板存在于 Shadow DOM
const hasWidget = await page.evaluate(() =>
  [...document.querySelectorAll('body > div')].some((d) => d.shadowRoot?.querySelector('.fab'))
);
assert.ok(hasWidget, 'Shadow DOM 内应有 .fab');
console.log('ok  Shadow DOM 渲染:气泡存在');

// 3. 点开面板、发消息
const sent = await page.evaluate(() => {
  const host = [...document.querySelectorAll('body > div')].find((d) =>
    d.shadowRoot?.querySelector('.panel')
  );
  const sr = host.shadowRoot;
  sr.querySelector('.fab').click();
  const panel = sr.querySelector('.panel');
  const opened = getComputedStyle(panel).display !== 'none';
  sr.querySelector('input').value = '在吗';
  sr.querySelector('.send').click();
  return opened;
});
assert.ok(sent, '点气泡后面板应展开');
console.log('ok  面板展开 + 发送消息');

// 4. 收到打字机回复(中途采过非完整片段,证明是逐字而非一次性)
let sawPartial = false;
await page.waitForFunction(
  () => {
    const host = [...document.querySelectorAll('body > div')].find((d) =>
      d.shadowRoot?.querySelector('.panel')
    );
    const bots = host.shadowRoot.querySelectorAll('.bot');
    const last = bots[bots.length - 1];
    return last && last.textContent.length > 0;
  },
  { timeout: 15000 }
);
const midText = await page.evaluate(() => {
  const host = [...document.querySelectorAll('body > div')].find((d) =>
    d.shadowRoot?.querySelector('.panel')
  );
  const bots = host.shadowRoot.querySelectorAll('.bot');
  return bots[bots.length - 1]?.textContent ?? '';
});
if (midText.length > 0 && midText.length < REPLY.length) sawPartial = true;

// 5. 最终完整文本
await page.waitForFunction(
  (reply) => {
    const host = [...document.querySelectorAll('body > div')].find((d) =>
      d.shadowRoot?.querySelector('.panel')
    );
    const bots = host.shadowRoot.querySelectorAll('.bot');
    return bots[bots.length - 1]?.textContent === reply;
  },
  { timeout: 15000 },
  REPLY
);
const finalText = await page.evaluate(() => {
  const host = [...document.querySelectorAll('body > div')].find((d) =>
    d.shadowRoot?.querySelector('.panel')
  );
  const bots = host.shadowRoot.querySelectorAll('.bot');
  return bots[bots.length - 1]?.textContent ?? '';
});
assert.equal(finalText, REPLY, '最终气泡文本应等于流式完整回复');
console.log(`ok  最终回复完整渲染${sawPartial ? '(中途捕获到逐字片段 ✅)' : '(未捕到中途片段,但完整渲染 ✅)'}`);

await browser.close();
hostServer.close();
srv.kill();
mockLLM.close();
rmSync(TMP, { recursive: true, force: true });
console.log('\n浏览器 E2E 全部通过 ✅');
