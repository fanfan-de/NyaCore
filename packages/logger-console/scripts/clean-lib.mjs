/** 删除旧构建产物，避免发布已经移除的模块。 */

import { rm } from 'node:fs/promises'

await rm(new URL('../lib/', import.meta.url), {
  force: true,
  recursive: true,
})
