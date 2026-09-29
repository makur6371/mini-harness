// cli.mjs — 把 4 个首发插件拼上内核:REPL / 一次性任务 / 会话续聊
// 用法:
//   node cli.mjs                      交互模式
//   node cli.mjs "帮我统计当前目录"    一次性任务
//   node cli.mjs --list               列出历史会话
//   node cli.mjs --resume <id> "继续"  续聊历史会话

import readline from 'node:readline/promises';
import { createKernel, runAgent, systemMessage, userMessage } from './kernel.mjs';
import { loadLLMPlugin } from './plugins/llm.mjs';
import { loadBashPlugin } from './plugins/tools-bash.mjs';
import { loadPromptPlugin } from './plugins/prompt.mjs';
import { loadStorePlugin } from './plugins/store-json.mjs';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/** 拼装:这就是"harness = 内核 + 插件"的全部现场 */
function boot() {
  const ctx = createKernel();
  loadStorePlugin({ file: 'data/store.json' })(ctx); // 缝 4
  loadLLMPlugin()(ctx);                              // 缝 1
  loadBashPlugin({ cwd: process.cwd() })(ctx);       // 缝 2
  loadPromptPlugin()(ctx);                           // 缝 3
  return ctx;
}

async function main() {
  // 参数解析:--resume <id> + 位置参数(一次性任务)
  const argv = process.argv.slice(2);
  let resumeId = null;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume') {
      resumeId = argv[++i];
    } else if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
    }
  }
  const oneShot = positional.join(' ') || null;

  const ctx = boot();

  if (positional.includes('--list') || argv.includes('--list')) {
    for (const k of ctx.store.keys().filter((k) => k.startsWith('session:')).sort()) {
      const s = ctx.store.get(k);
      const first = [...s.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      console.log(`${s.id}  ${String(first).replace(/\n/g, ' ').slice(0, 60)}`);
    }
    return;
  }

  // —— 会话状态 ——
  const sessionId =
    new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) +
    '-' +
    Math.random().toString(36).slice(2, 6);
  let messages;
  let id;
  if (resumeId) {
    const s = ctx.store.get(`session:${resumeId}`);
    if (!s) {
      console.error(red(`找不到会话 ${resumeId}(试试 --list)`));
      process.exit(1);
    }
    id = s.id;
    messages = s.messages;
    console.log(dim(`# 续聊会话 ${id},共 ${messages.length} 条消息`));
  } else {
    id = sessionId;
    messages = [systemMessage(ctx.prompt.assemble())];
  }

  // —— UI 长在事件缝上(对应 DSH 的 dsh-client-ui-*)——
  ctx.on('tool:start', ({ name, args }) => {
    try {
      const a = JSON.parse(args);
      if (a.command) {
        console.log(dim(`  ⚙ $ ${String(a.command).slice(0, 120)}`));
        return;
      }
    } catch {}
    console.log(dim(`  ⚙ ${name}`));
  });
  ctx.on('tool:end', ({ content }) => {
    if (String(content).startsWith('ERROR'))
      console.log(dim(`  ↳ ${String(content).slice(0, 160)}`));
  });

  // Ctrl+C:运行中中断本轮;空闲时退出
  let currentAbort = null;
  process.on('SIGINT', () => {
    if (currentAbort) {
      currentAbort.abort();
      console.log(dim('\n(已中断本轮)'));
    } else {
      process.exit(0);
    }
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let stdinOpen = true;
  rl.on('close', () => {
    stdinOpen = false;
  });

  while (true) {
    const q = oneShot ?? (stdinOpen ? await rl.question(bold('你> ')) : null);
    if (q === null || !q.trim()) {
      if (q === null) break;
      continue;
    }
    if (!oneShot && (q === '/exit' || q === 'exit' || q === 'q')) break;

    const checkpoint = messages.length;
    const controller = new AbortController();
    currentAbort = controller;
    try {
      messages.push(userMessage(q));
      const res = await runAgent(ctx, { messages, signal: controller.signal });
      console.log(`${bold('AI> ')}${res.content ?? '(空回复)'}\n`);
      ctx.store.set(`session:${id}`, { id, at: Date.now(), messages });
      if (oneShot) break;
    } catch (err) {
      // 回滚到本轮之前的状态,别把半截对话留在历史里
      messages.length = checkpoint;
      console.error(red(`出错: ${err.message}`));
      if (oneShot) process.exit(1);
    } finally {
      currentAbort = null;
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
