// test-stream.mjs — 协议保真:用真实 OpenAI/DeepSeek 的 SSE 字节流喂 llm.mjs,验证流式解析器。
// 覆盖最易出 bug 的真实场景:tool_call 参数跨帧拆分、并行多 tool、keepalive 注释行、帧跨 TCP 读。
// 纯本地,无网络。这补掉 PURPOSE 审计表里"真模型流式没测"的一半(协议层)。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createKernel } from './kernel.mjs';
import { loadLLMPlugin } from './plugins/llm.mjs';

// 一帧 OpenAI 格式 SSE:data: {choices:[{index:0,delta,finish_reason}]}\n\n
const frame = (delta, finishReason = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

// mock:把 raw 字节流按 chunkSize 切碎、逐块带延迟写出(模拟 TCP 分包 + 帧跨读)
function mockStream(port, raw, chunkSize = 7) {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const t = setInterval(() => {
      if (i >= raw.length) { res.end(); clearInterval(t); return; }
      res.write(raw.slice(i, i + chunkSize));
      i += chunkSize;
    }, 3);
  });
}
const freePort = () =>
  new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

async function runChat(baseUrl, opts = {}) {
  process.env.MINI_LLM_BASE_URL = baseUrl;
  process.env.MINI_LLM_API_KEY = 'mock';
  const ctx = createKernel();
  loadLLMPlugin()(ctx);
  const deltas = [];
  const { message } = await ctx.llm.chat({
    messages: opts.messages ?? [{ role: 'user', content: 'hi' }],
    tools: opts.tools ?? [],
    onDelta: (d) => deltas.push(d),
  });
  return { message, deltas };
}

// 1. 纯文本流式:role 首发 + 多段 content + stop
{
  const port = await freePort();
  const srv = mockStream(
    port,
    frame({ role: 'assistant' }) + frame({ content: '你' }) + frame({ content: '好' }) + frame({}, 'stop') + DONE
  );
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const { message, deltas } = await runChat(`http://127.0.0.1:${port}`);
  assert.equal(message.role, 'assistant');
  assert.equal(message.content, '你好');
  assert.deepEqual(deltas, ['你', '好']); // onDelta 只在 content delta 触发
  assert.equal(message.tool_calls, undefined);
  srv.close();
  console.log('ok  纯文本流式:content 正确累积,onDelta 逐段触发');
}

// 2. 单 tool_call,参数跨 3 帧拆分(真实流式最易出 bug 处)
{
  const port = await freePort();
  const stream =
    frame({ role: 'assistant' }) +
    frame({ content: null }) +
    frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'query_stock', arguments: '' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '{"sku":' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"A123' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }) +
    frame({}, 'tool_calls') + DONE;
  const srv = mockStream(port, stream);
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const { message, deltas } = await runChat(`http://127.0.0.1:${port}`, {
    tools: [{ type: 'function', function: { name: 'query_stock' } }],
  });
  assert.equal(message.content, null, '有 tool_call 时 content 应为 null');
  assert.equal(message.tool_calls.length, 1);
  const tc = message.tool_calls[0];
  assert.equal(tc.id, 'call_1');
  assert.equal(tc.type, 'function');
  assert.equal(tc.function.name, 'query_stock');
  assert.equal(tc.function.arguments, '{"sku":"A123"}', '拆分参数应正确拼接');
  assert.deepEqual(deltas, [], '纯 tool_call 无 content,不该触发 onDelta');
  srv.close();
  console.log('ok  tool_call 参数跨帧拆分:arguments 正确拼接');
}

// 3. 并行多 tool_call(多 index 交错)
{
  const port = await freePort();
  const stream =
    frame({ tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'f0', arguments: '{"a":' } }] }) +
    frame({ tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'f1', arguments: '{"b":' } }] }) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }) +
    frame({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] }) +
    frame({}, 'tool_calls') + DONE;
  const srv = mockStream(port, stream, 11);
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const { message } = await runChat(`http://127.0.0.1:${port}`);
  assert.equal(message.tool_calls.length, 2);
  assert.equal(message.tool_calls[0].function.name, 'f0');
  assert.equal(message.tool_calls[1].function.name, 'f1');
  assert.equal(message.tool_calls[0].function.arguments, '{"a":1}');
  assert.equal(message.tool_calls[1].function.arguments, '{"b":2}');
  srv.close();
  console.log('ok  并行多 tool_call:按 index 正确分桶 + 排序');
}

// 4. keepalive 注释行 + 帧跨 TCP 读(chunkSize=3 切碎)应被容错
{
  const port = await freePort();
  const stream = ': keepalive\n\n' + frame({ content: 'hi' }) + ': ping\n\n' + frame({}, 'stop') + DONE;
  const srv = mockStream(port, stream, 3);
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  const { message } = await runChat(`http://127.0.0.1:${port}`);
  assert.equal(message.content, 'hi');
  srv.close();
  console.log('ok  keepalive 注释行被跳过 + 帧跨 TCP 读被正确缓冲拼接');
}

console.log('\n协议保真测试全部通过 ✅');
