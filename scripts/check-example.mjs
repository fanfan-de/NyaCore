/** 在仓库外使用实际产物重建并运行教程，验证文件持久化、路径和退出状态。 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createExampleBundle } from './pack-example.mjs'

function execute(args, directory, expected = 0, timeout = 30000) {
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) throw result.error
  assert.equal(result.status, expected,
    `unexpected example exit status:\n${result.stdout}\n${result.stderr}`)
  return `${result.stdout}\n${result.stderr}`
}

export function checkExample(temporaryRoot, packages, runNpm) {
  const directory = createExampleBundle(join(temporaryRoot, 'task-journal consumer'), packages)
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], directory)
  runNpm(['run', 'build'], directory)
  // 独立目录也必须支持开发宿主；测试在临时 fixture 中真正修改、构建和重启。
  execute(['--test', 'tests/development.test.mjs'], directory, 0, 60000)

  const configurationDirectory = join(directory, '配置 space')
  mkdirSync(configurationDirectory)
  const configurationFile = join(configurationDirectory, 'config.json')
  writeFileSync(configurationFile, JSON.stringify({
    storage: { file: './records/journal.jsonl' },
    job: { intervalMs: 10, label: 'package-consumer' },
    logLevel: 'info',
    startupTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
  }))
  const args = ['dist/main.js', '--demo', '--config', configurationFile]
  const firstOutput = execute(args, directory)
  for (const phase of [
    'application ready', 'job disabled', 'job restored',
    'storage disabled', 'storage restored', 'demo completed', 'shutdown completed',
  ]) assert.ok(firstOutput.includes(phase), `demo did not report ${phase}:\n${firstOutput}`)

  const dataFile = join(configurationDirectory, 'records/journal.jsonl')
  const readRecords = () => readFileSync(dataFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const first = readRecords()
  assert.ok(first.length >= 4, 'demo did not persist its lifecycle stages')
  assert.ok(new Set(first.map(record => record.label)).size >= 2, 'configuration update was not persisted')
  execute(args, directory)
  const second = readRecords()
  assert.ok(second.length >= first.length + 4, 'second startup did not append records')
  assert.deepEqual(second.slice(0, first.length), first, 'second startup rewrote existing data')
  assert.deepEqual(second.map(record => record.sequence), second.map((_, index) => index + 1))

  // 执行教程中的完整嵌入脚本，防止示例代码与教程各自演进后失配。
  const tutorial = readFileSync(join(import.meta.dirname, '../docs/tutorials/task-journal.md'), 'utf8')
    .replaceAll('\r\n', '\n')
  const embedded = [...tutorial.matchAll(/```js\n([\s\S]*?)\n```/g)]
    .map(match => match[1])
    .filter(block => block.includes('const application = createApplication(config)'))
  assert.equal(embedded.length, 1, 'tutorial must contain one complete embedded application script')
  writeFileSync(join(directory, 'embedded.mjs'), `${embedded[0]}\n`)
  execute(['embedded.mjs'], directory)
  const embeddedRecords = readFileSync(join(directory, 'data/embedded-tasks.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
  assert.ok(embeddedRecords.length >= 4, 'tutorial embedded script did not complete the lifecycle')

  execute(['dist/main.js', '--help'], directory)
  execute(['dist/main.js', '--config', 'missing-config.json'], directory, 2)
  execute(['dist/main.js', '--unknown'], directory, 2)
  writeFileSync(configurationFile, '{invalid json')
  execute(['dist/main.js', '--config', configurationFile], directory, 2)
  writeFileSync(configurationFile, JSON.stringify({ storage: { file: './records/journal.jsonl' } }))
  writeFileSync(dataFile, 'damaged journal\n')
  execute(['dist/main.js', '--config', configurationFile], directory, 1)

  if (process.platform !== 'win32') runNpm(['run', 'test:signals'], directory)
  console.log('独立示例检查通过：新目录安装、编译、两次演示、嵌入教程、数据延续、配置路径与失败退出状态')
}
