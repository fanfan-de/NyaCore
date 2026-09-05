/** 每次构建用新进程读取同一 CLI 模块，模块依赖不会进入长驻监督器缓存。 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let configFile
try {
  const tools = await import(pathToFileURL(join(process.argv[2], 'dist/config.js')).href)
  const parsed = tools.parseArguments(process.argv.slice(4), process.argv[3])
  configFile = parsed.configFile
  const result = parsed.help
    ? { ok: true, helpText: tools.helpText }
    : {
        ok: true, configFile,
        args: ['--config', configFile, ...(parsed.demo ? ['--demo'] : [])],
        config: await tools.readConfig(configFile),
      }
  process.send?.({ type: 'task-journal:configuration', ...result }, () => process.disconnect())
} catch (error) {
  console.error('[dev] configuration error', error)
  process.exitCode = 2
  process.send?.({ type: 'task-journal:configuration', ok: false, configFile }, () => process.disconnect())
}
