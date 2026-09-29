// plugins/prompt.mjs — 缝 3 实现:system prompt 分段注册与拼装
// 对应 DSH:packages/core/system-prompt
// 每个插件都可以往 system prompt 贡献一段话,由内核统一拼装。

export function loadPromptPlugin() {
  return function register(ctx) {
    ctx.prompt.register({
      id: 'identity',
      priority: 0,
      text: '你是一个终端里的编码 Agent。通过调用 bash 工具完成用户的任务,用用户的语言回答。',
    });
    ctx.prompt.register({
      id: 'rules',
      priority: 10,
      text: [
        '规则:',
        '- 先看清现状再动手;多步任务先在脑内列步骤。',
        '- 文件读写优先用 bash(printf/cat/grep);命令失败要读报错再修,不要盲试。',
        '- 产出的文件放在当前工作目录;任务完成后用一句话总结改了什么。',
      ].join('\n'),
    });
  };
}
