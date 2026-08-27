/** 本文件在完整构建前删除 Core 的旧生成产物，避免发布已移除的模块。 */

import { rm } from 'node:fs/promises'

await rm(new URL('../lib/', import.meta.url), {
  force: true,
  recursive: true,
})
