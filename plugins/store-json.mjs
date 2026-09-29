// plugins/store-json.mjs — 缝 4 实现:JSON 文件 KV(tmp+rename 原子写)
// 对应 DSH:packages/storage/storage-json(ctx.storage)

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function loadStorePlugin({ file = 'data/store.json' } = {}) {
  return function register(ctx) {
    mkdirSync(dirname(file), { recursive: true });
    const readAll = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
    const writeAll = (data) => {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, file); // 原子替换
    };
    ctx.store = {
      get: (k) => readAll()[k],
      set: (k, v) => {
        const d = readAll();
        d[k] = v;
        writeAll(d);
      },
      delete: (k) => {
        const d = readAll();
        delete d[k];
        writeAll(d);
      },
      keys: () => Object.keys(readAll()),
    };
  };
}
