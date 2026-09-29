// public/embed.js — 一行 <script> 接入的访客聊天窗
// 由 server 端点 /embed.js 提供;所有样式在 Shadow DOM 里,不污染宿主页。
// 集成方式(唯一一行):
//   <script src="http://localhost:8787/embed.js" data-site="demo-clinic" defer></script>
(function () {
  if (window.__MINI_AGENT__) return;
  window.__MINI_AGENT__ = true;

  const me = document.currentScript;
  const site = me?.dataset?.site || 'demo-clinic';
  const origin = new URL(me.src, location.href).origin;
  const api = `${origin}/s/${site}/api/chat`;
  // sid 持久化:同一浏览器回访不失忆(sessionStorage 关页即清,localStorage 可跨回话)
  const sidKey = `mini-agent-sid:${site}`;
  const sid = sessionStorage.getItem(sidKey) || 's-' + Math.random().toString(36).slice(2, 9);
  sessionStorage.setItem(sidKey, sid);

  const css = `
    :host, :host * { box-sizing: border-box; font-family: system-ui, sans-serif; }
    .fab { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px;
      border-radius: 50%; border: none; cursor: pointer; color: #fff; font-size: 24px;
      background: var(--accent); box-shadow: 0 6px 20px rgba(0,0,0,.25); z-index: 999999; }
    .panel { position: fixed; right: 20px; bottom: 88px; width: 340px; height: 460px;
      background: #fff; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.22);
      display: flex; flex-direction: column; overflow: hidden; z-index: 999999; }
    .head { padding: 12px 14px; color: #fff; font-weight: 600; background: var(--accent); }
    .log { flex: 1; overflow-y: auto; padding: 10px; background: #f7f7f8; }
    .msg { max-width: 85%; padding: 8px 11px; border-radius: 12px; margin: 5px 0;
      font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .user { margin-left: auto; background: var(--accent); color: #fff; }
    .bot { margin-right: auto; background: #fff; border: 1px solid #e5e5e8; }
    .foot { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #eee; background: #fff; }
    input { flex: 1; border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    button.send { border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer;
      color: #fff; background: var(--accent); }
    .typing { color: #999; font-size: 12px; padding: 2px 6px; }
  `;

  let cfg = { title: '助手', welcome: '你好,有什么可以帮你?', theme: { accent: '#4f46e5' } };
  fetch(`${origin}/s/${site}/embed.json`)
    .then((r) => r.json())
    .then((c) => (cfg = c))
    .catch(() => {})
    .finally(build);

  function build() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // cfg.theme.accent 来自站点包(可信来源);仍只接受合法颜色值,再插入 CSS
    const accent = /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z()0-9%,.\s]+$/.test(String(cfg.theme.accent))
      ? cfg.theme.accent
      : '#4f46e5';
    style.textContent = `${css} :host{--accent:${accent}}`;
    root.appendChild(style);

    const wrap = document.createElement('div');
    // 标题/欢迎语用 textContent 注入,不做 HTML 拼接
    wrap.innerHTML = `
      <button class="fab" title=""></button>
      <div class="panel" style="display:none">
        <div class="head"></div>
        <div class="log"></div>
        <div class="foot">
          <input placeholder="输入你的问题…">
          <button class="send">发送</button>
        </div>
      </div>`;
    root.appendChild(wrap);
    wrap.querySelector('.fab').title = cfg.title;
    wrap.querySelector('.fab').textContent = '💬';
    wrap.querySelector('.head').textContent = cfg.title;

    const panel = wrap.querySelector('.panel');
    const fab = wrap.querySelector('.fab');
    const log = wrap.querySelector('.log');
    const input = wrap.querySelector('input');
    const send = wrap.querySelector('.send');
    fab.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      if (panel.style.display === 'flex') {
        if (!log.children.length) add('bot', cfg.welcome);
        input.focus();
      }
    });
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

    function add(role, text) {
      const d = document.createElement('div');
      d.className = `msg ${role}`;
      d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }

    let busy = false;
    async function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      busy = true;
      input.value = '';
      add('user', text);
      const tip = add('bot', '…');
      tip.className = 'msg bot typing';
      try {
        const res = await fetch(api, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, message: text }),
        });
        // 简单 SSE 解析:取 event: final
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const blocks = buf.split('\n\n');
          buf = blocks.pop();
          for (const b of blocks) {
            const ev = /^event: (.+)$/m.exec(b)?.[1];
            const data = /^data: (.+)$/m.exec(b)?.[1];
            if (ev === 'final' && data) {
              const { content } = JSON.parse(data);
              tip.className = 'msg bot';
              tip.textContent = content || '(空回复)';
            }
          }
        }
      } catch {
        tip.className = 'msg bot';
        tip.textContent = '网络出错了,请重试。';
      }
      busy = false;
    }
  }
})();
