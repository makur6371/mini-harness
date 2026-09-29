// test.mjs — 不需要 API key 的端到端验证:
// mock 掉缝 1(llm),检验内核循环 + 工具缝 + prompt 缝 + 事件缝 + store 缝
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { createKernel, runAgent, systemMessage, userMessage } from './kernel.mjs';
import { loadBashPlugin } from './plugins/tools-bash.mjs';
import { loadPromptPlugin } from './plugins/prompt.mjs';
import { loadStorePlugin } from './plugins/store-json.mjs';

const tmp = 'data-test';
rmSync(tmp, { recursive: true, force: true });

// —— mock LLM:脚本化三步 —— 写文件 → 读回 → 收工
const script = [
  () => ({
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: JSON.stringify({ command: `printf 'mini-harness works' > ${tmp}/proof.txt` }),
          },
        },
      ],
    },
  }),
  () => ({
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: `cat ${tmp}/proof.txt` }) },
        },
      ],
    },
  }),
  () => ({ message: { role: 'assistant', content: 'DONE: 文件已写入并验证' } }),
];
let step = 0;
const mockLLM = {
  chat: async ({ messages, tools }) => {
    assert.ok(Array.isArray(tools) && tools.some((t) => t.function.name === 'bash'));
    assert.ok(messages[0].role === 'system');
    return script[step++](messages, tools);
  },
};

// —— 拼装(与 cli.mjs 相同,只把 llm 换成 mock)——
const ctx = createKernel();
loadStorePlugin({ file: `${tmp}/store.json` })(ctx);
ctx.llm = mockLLM;
loadBashPlugin({ cwd: process.cwd() })(ctx);
loadPromptPlugin()(ctx);

// 1. prompt 缝:两个段落都拼进去了
const sys = ctx.prompt.assemble();
assert.match(sys, /<section id="identity">/);
assert.match(sys, /<section id="rules">/);
console.log('ok  缝3 prompt 组装');

// 2. 工具缝:bash 已注册
assert.equal(ctx.tools.list().length, 1);
assert.equal(ctx.tools.get('bash').id, 'bash');
console.log('ok  缝2 工具注册');

// 3. 事件缝:循环过程可见
const events = [];
ctx.on('tool:start', (e) => events.push(`start:${e.name}`));
ctx.on('agent:end', (e) => events.push(`end:${e.turns}turns`));

// 4. 跑循环
const messages = [systemMessage(sys), userMessage('把 proof 写进文件再确认')];
const final = await runAgent(ctx, { messages });

assert.match(final.content, /DONE/);
assert.equal(readFileSync(`${tmp}/proof.txt`, 'utf8'), 'mini-harness works');
assert.deepEqual(events, ['start:bash', 'start:bash', 'end:3turns']);
assert.equal(messages.length, 7); // system + user + 2×(assistant+tool) + 最终 assistant
const toolMsg = messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c2'); // c1 是 printf 写文件,无 stdout 属正常
assert.equal(toolMsg.content, 'mini-harness works');
console.log('ok  内核循环:工具调用 → 结果回填 → 收敛');

// 5. 工具报错回喂而不是崩循环(坏 JSON 参数)
let phase = 0;
ctx.llm = {
  chat: async () =>
    phase++ === 0
      ? {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c3', type: 'function', function: { name: 'bash', arguments: 'not-json' } },
            ],
          },
        }
      : { message: { role: 'assistant', content: 'recovered' } },
};
const msgs2 = [systemMessage('x'), userMessage('y')];
const final2 = await runAgent(ctx, { messages: msgs2 });
const errMsg = msgs2.find((m) => m.role === 'tool');
assert.match(errMsg.content, /^ERROR:/);
assert.equal(final2.content, 'recovered');
console.log('ok  工具报错回喂,循环不崩');

// 6. store 缝:换一个内核实例也能读回(持久化生效)
ctx.store.set('k', { v: 42 });
const ctx2 = createKernel();
loadStorePlugin({ file: `${tmp}/store.json` })(ctx2);
assert.deepEqual(ctx2.store.get('k'), { v: 42 });
console.log('ok  缝4 store 持久化');

rmSync(tmp, { recursive: true, force: true });
console.log('\n全部通过 ✅');
