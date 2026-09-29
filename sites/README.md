// sites/README.md — 垂直站点插件包
//
// 一个文件 = 一个站点的全部"垂直化",内核与服务器零改动。
// 钩子全部长在内核的事件缝 / 注册缝上,所以同一个包同时塑造:
//   1. 模型看到什么(system prompt 注入)
//   2. 模型能用什么(工具白名单)
//   3. 模型收不了场时怎么办(兜底话术)
//   4. 访客看到什么(前端渲染)
//
// 实现一个站点包 = 默认导出 async function(ctx, env) { ... }
// 端点:POST /s/:site/api/chat  (SSE 流)

export const SITE_PROTOCOL = `
站点包协议(默认导出 install(ctx, env)):
  ctx.prompt.register({ id, priority, text })   // 注入身份与规则
  ctx.on('before:chat',  fn(payload))           // 可改 payload.message / payload.reject(原因)
  ctx.on('after:final',  fn(payload))           // 可改 payload.content(如兜底话术替换)
  ctx.tools.register(tool)                      // 垂直工具,自动进入模型工具列表
  env.config / env.data                         // 服务器注入的站点配置与挂载点
`;
