/** 在原生 POSIX Node 子进程中验证真正的 SIGINT/SIGTERM；Windows 不模拟该验收。 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const applicationDirectory = resolve(import.meta.dirname, '..')

async function verifySignal(signal, expectedCode) {
  const directory = await mkdtemp(join(tmpdir(), 'nya-signal-'))
  const configuration = join(directory, 'config.json')
  await writeFile(configuration, JSON.stringify({
    storage: { file: './journal.jsonl' },
    job: { intervalMs: 10, label: signal },
    startupTimeoutMs: 5000,
    shutdownTimeoutMs: 5000,
  }))
  const child = spawn(process.execPath, ['dist/main.js', '--config', configuration], {
    cwd: applicationDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let timer
  const exited = new Promise((fulfill, reject) => {
    child.once('error', reject)
    child.once('close', (code, receivedSignal) => fulfill({ code, receivedSignal }))
  })
  // 同时登记首条成功写入和进程结束，避免快速退出漏掉事件。
  const written = new Promise((fulfill, reject) => {
    const capture = chunk => {
      output += chunk.toString()
      if (output.includes('journal record written')) fulfill()
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`application exited before writing:\n${output}`)))
  })
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`signal test timed out:\n${output}`)), 15000)
  })
  try {
    await Promise.race([written, deadline])
    assert.equal(child.kill(signal), true)
    const result = await Promise.race([exited, deadline])
    assert.deepEqual(result, { code: expectedCode, receivedSignal: null }, output)
    assert.ok(output.includes('shutdown completed'), output)
    const records = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(records.length > 0)
    assert.deepEqual(records.map(record => record.sequence), records.map((_, index) => index + 1))
    console.log(`${signal}: cleanup completed, exit ${expectedCode}, persisted ${records.length} record(s)`)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited.catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.platform === 'win32') {
  console.log('真实信号检查需要 Linux/macOS 或 WSL 内的原生 Node；Windows 不以 kill 模拟优雅退出。')
} else {
  await verifySignal('SIGINT', 130)
  await verifySignal('SIGTERM', 143)
}
