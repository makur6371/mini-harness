// scripts/cdp.mjs — 零依赖 CDP 驱动(Node 22 自带 fetch + WebSocket)。
// 替代 puppeteer-core:不装任何 npm 包,直接驱动系统 chrome。API 仅覆盖测试所需。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });

/** 启动 chrome 并返回一个 page 句柄,带 goto/evaluate/waitForFunction/setViewport/screenshot/close */
export async function launch(opts = {}) {
  const exe = opts.executablePath || process.env.MINI_CHROME_PATH || '/usr/bin/google-chrome';
  const home = opts.homeDir;
  mkdirSync(home, { recursive: true });
  const port = opts.port || (await freePort());
  const proc = spawn(
    exe,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${home}/profile`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let browserWs;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        browserWs = (await r.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(100);
  }
  if (!browserWs) {
    try { proc.kill(); } catch {}
    throw new Error('chrome CDP 未就绪');
  }

  let pageWs;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    const ts = await r.json();
    const p = ts.find((t) => t.type === 'page');
    if (p) { pageWs = p.webSocketDebuggerUrl; break; }
    await sleep(100);
  }
  if (!pageWs) { proc.kill(); throw new Error('无 page target'); }

  const ws = new WebSocket(pageWs);
  let id = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = id++;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    async setViewport({ width, height, deviceScaleFactor = 1 }) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor, mobile: false,
      });
    },
    async goto(url) {
      const loaded = new Promise((res) => {
        const h = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); }
        };
        ws.addEventListener('message', h);
        setTimeout(res, 5000); // 兜底
      });
      await send('Page.navigate', { url });
      await loaded;
      await sleep(400); // 等 widget 初始化
    },
    async evaluate(fn, ...args) {
      const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails)
        throw new Error('eval: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
      return r.result?.result?.value;
    },
    async waitForFunction(fn, { timeout = 15000 } = {}, ...args) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          const v = await page.evaluate(fn, ...args);
          if (v) return v;
        } catch {}
        await sleep(100);
      }
      throw new Error('waitForFunction 超时');
    },
    async screenshot({ path, fullPage = false } = {}) {
      let clip;
      if (fullPage) {
        const sz = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.scrollHeight,
        ]);
        clip = { x: 0, y: 0, width: sz[0], height: sz[1], scale: 1 };
      }
      const r = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
        ...(fullPage ? { clip } : {}),
      });
      const buf = Buffer.from(r.result.data, 'base64');
      if (path) writeFileSync(path, buf);
      return buf;
    },
    async close() {
      try { ws.close(); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      await sleep(300); // 等 chrome 退出,否则 profile 目录删不掉
      try { proc.kill('SIGKILL'); } catch {}
      await sleep(100);
    },
  };
  return page;
}
