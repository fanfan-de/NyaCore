/** 进程入口：配置错误返回 2；普通结束只设置退出码，关闭超时由宿主强退。 */

import { helpText, parseArguments, readConfig } from './config.js'
import { runHost } from './host.js'

async function main() {
  let arguments_
  try {
    arguments_ = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error('configuration error', error)
    process.exitCode = 2
    return
  }
  if (arguments_.help) {
    console.log(helpText)
    return
  }

  // 配置读取阶段也接收信号；进入 host 前同步交接，避免留下重复监听。
  const controller = new AbortController()
  let interrupted: 'SIGINT' | 'SIGTERM' | undefined
  const interrupt = (signal: 'SIGINT' | 'SIGTERM') => {
    interrupted ??= signal
    controller.abort()
  }
  const onInterrupt = () => interrupt('SIGINT')
  const onTerminate = () => interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  let config
  try {
    config = await readConfig(arguments_.configFile, controller.signal)
  } catch (error) {
    if (!interrupted) {
      console.error('configuration error', error)
      process.exitCode = 2
    }
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
  if (interrupted) {
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143
    console.log('shutdown completed')
    return
  }
  if (config) await runHost(config, { demo: arguments_.demo })
}

// 开发监督器只通过 IPC 请求既有信号关闭路径；普通 CLI 没有这个进程级资源。
const development = process.connected
const onDevelopmentShutdown = (message: unknown) => {
  if (!message || typeof message !== 'object') return
  const request = message as { type?: unknown; signal?: unknown }
  if (request.type !== 'task-journal:shutdown') return
  if (request.signal === 'SIGINT' || request.signal === 'SIGTERM') process.emit(request.signal)
}
const onDevelopmentDisconnect = () => { process.emit('SIGTERM') }
if (development) {
  process.on('message', onDevelopmentShutdown)
  process.on('disconnect', onDevelopmentDisconnect)
  process.send?.({ type: 'task-journal:ipc-ready' }, () => {})
}

void main().catch(error => {
  console.error('host failed', error)
  process.exitCode = 1
}).finally(() => {
  if (!development) return
  process.off('message', onDevelopmentShutdown)
  process.off('disconnect', onDevelopmentDisconnect)
  if (process.connected) process.disconnect()
})
