/** 开发宿主拥有退出策略，Include/HMR 只管理配置和组件。 */
import { fileURLToPath } from 'node:url'
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'
import { Include } from '@nya/include'
import { Hmr } from '@nya/hmr'
import { ConsoleLogger } from '@nya/logger-console'

const app = new Context()
const once = process.argv.includes('--once')
let stopping
function stop(code = 0) {
  if (stopping) return stopping
  process.exitCode = code
  const deadline = setTimeout(() => {
    console.error('关闭超过 5 秒；宿主强制退出，资源清理未确认完成。')
    process.exit(1)
  }, 5000)
  stopping = app.fiber.dispose().catch(error => {
    console.error(error)
    process.exitCode = 1
  }).finally(() => {
    clearTimeout(deadline)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  })
  return stopping
}
function interrupt() { void stop() }
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

try {
  await app.installComponent(ConsoleLogger, { timestamps: false })
  await app.installComponent(Loader)
  await app.installComponent(Include, {
    id: 'app', path: fileURLToPath(new URL('./config.yml', import.meta.url)),
  })
  await app.installComponent(Hmr, {
    entries: [new URL('./worker.mjs', import.meta.url).href],
    include: app.include,
    watch: !once,
    onReport(report) {
      console.log('HMR', report.status, report.phase, 'pid=' + report.pid, 'generation=' + report.generation)
      for (const error of report.errors) console.error(error)
      // 回调可能处于控制器操作内，退出放到后续事件循环，避免反向等待。
      if (report.status === 'restart-required') setImmediate(() => { void stop(75) })
    },
  })
  const report = await app.hmr.start()
  if (!['applied', 'unchanged'].includes(report.status)) await stop(1)
  else if (once) await stop()
  else console.log('修改 config.yml、jobs.yml 或 message.mjs；Ctrl+C 关闭。退出码 75 表示需要重新启动宿主。')
} catch (error) {
  console.error(error)
  await stop(1)
}
