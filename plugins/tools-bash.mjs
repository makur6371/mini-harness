// plugins/tools-bash.mjs — 缝 2 实现:唯一的工具,bash。
// 对应 DSH:packages/subprocess(ctx.subprocess)
// 理念:读写文件、搜索、构建全是 bash 的语法糖 —— 工具宁粗勿细。

import { execFile } from 'node:child_process';

export function loadBashPlugin({ cwd = process.cwd(), timeoutMs = 120_000 } = {}) {
  return function register(ctx) {
    ctx.tools.register({
      id: 'bash',
      description:
        '在工作目录里执行一段 bash 脚本。读写文件、搜索、构建都用它。' +
        'stdout+stderr 会返回;命令失败时输出里带 [exit code: N]。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 bash 命令' },
        },
        required: ['command'],
      },
      async execute({ command }) {
        if (typeof command !== 'string' || !command.trim())
          throw new Error('command 不能为空');
        return await new Promise((resolve) => {
          execFile(
            '/bin/bash',
            ['-c', command],
            { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env },
            (err, stdout, stderr) => {
              const parts = [];
              if (stdout?.trim()) parts.push(stdout.trimEnd());
              if (stderr?.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
              if (err?.killed) parts.push(`[超时 ${timeoutMs}ms 被终止]`);
              else if (err && typeof err.code === 'number')
                parts.push(`[exit code: ${err.code}]`);
              resolve(parts.join('\n') || '(无输出)');
            }
          );
        });
      },
    });
  };
}
