// scripts/screenshot.mjs — 生成 docs/screenshot.png:widget 嵌在 demo 页里、带一段真实对话。
// 复用 test-browser 的真 chrome 基建。跑法:node scripts/screenshot.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const WORK = process.cwd();
const TMP = 'data-screenshot';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(`${WORK}/${TMP}`, { recursive: true });

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

// 模型回一句像样的诊所话术(逐字流式,截图里看起来是真实对话)
const REPLY = '超声波洁牙 199–299 元,约 40 分钟,当日可约,周末也行。需要的话我帮你查本周空档、直接挂号~';
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
    }, 12);
  });
});
await new Promise((r) => mockLLM.listen(mockPort, '127.0.0.1', r));

// agent 固定 8787:demo.html 里的 <script> 写死了这个地址
const srv = spawn('node', ['server.mjs'], {
  cwd: WORK,
  env: {
    ...process.env,
    PORT: '8787',
    DATA_DIR: TMP,
    SITE: 'demo-clinic',
    MINI_LLM_API_KEY: 'mock',
    MINI_LLM_BASE_URL: `http://127.0.0.1:${mockPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
srv.stdout.on('data', (d) => log.push(d.toString()));
await new Promise((resolve) => {
  const t = setInterval(() => log.join('').includes('已挂载') && (clearInterval(t), resolve(true)), 100);
  setTimeout(() => resolve(false), 8000);
});

// 静态服务 public/demo.html(demo.html 的 <script> 指向 localhost:8787)
const demoHtml = readFileSync('public/demo.html', 'utf8');
const hostPort = await freePort();
const host = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(demoHtml));
await new Promise((r) => host.listen(hostPort, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: process.env.MINI_CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check'],
  userDataDir: `${CHROME_HOME}/profile`,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await page.goto(`http://localhost:${hostPort}/`, { waitUntil: 'networkidle0', timeout: 15000 });

// 打开面板、发问、等逐字回复写完
await page.evaluate(() => {
  const host = [...document.querySelectorAll('body > div')].find((d) => d.shadowRoot?.querySelector('.panel'));
  host.shadowRoot.querySelector('.fab').click();
});
await new Promise((r) => setTimeout(r, 300));
await page.evaluate((q) => {
  const host = [...document.querySelectorAll('body > div')].find((d) => d.shadowRoot?.querySelector('.panel'));
  const sr = host.shadowRoot;
  sr.querySelector('input').value = q;
  sr.querySelector('.send').click();
}, '洁牙大概多少钱?');

await page.waitForFunction(
  (reply) => {
    const host = [...document.querySelectorAll('body > div')].find((d) => d.shadowRoot?.querySelector('.panel'));
    const bots = host.shadowRoot.querySelectorAll('.bot');
    return bots[bots.length - 1]?.textContent === reply;
  },
  { timeout: 15000 },
  REPLY
);
await new Promise((r) => setTimeout(r, 400)); // 让 final 收尾渲染稳

if (!existsSync('docs')) mkdirSync('docs');
await page.screenshot({ path: 'docs/screenshot.png', fullPage: true });
console.log('已生成 docs/screenshot.png');

await browser.close();
host.close();
srv.kill();
mockLLM.close();
rmSync(TMP, { recursive: true, force: true });
