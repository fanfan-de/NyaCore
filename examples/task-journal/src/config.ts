/** CLI 配置边界：严格校验 JSON，并以配置文件目录解析存储路径。 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { LogLevel } from '@nya/core'
import type { ApplicationConfig, JobConfig } from './types.js'

export interface CliArguments {
  readonly configFile: string
  readonly demo: boolean
  readonly help: boolean
}

export const helpText = `Usage: task-journal [--config <file>] [--demo] [--help]

  --config <file>  Read JSON configuration (default: ./config.json)
  --demo           Run the finite lifecycle demonstration, then close
  --help           Show this help
`

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], name: string) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`unknown ${name} field: ${key}`)
  }
}

function positiveDuration(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be an integer from 1 to 2147483647`)
  }
  return value
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value
}

/** 运行期间的更新必须提供完整任务配置，不能悄悄补回启动默认值。 */
export function validateJobConfig(value: unknown): JobConfig {
  const job = record(value, 'job')
  knownKeys(job, ['intervalMs', 'label'], 'job')
  return Object.freeze({
    intervalMs: positiveDuration(job.intervalMs, 'job.intervalMs'),
    label: nonEmptyString(job.label, 'job.label'),
  })
}

export function validateConfig(value: unknown, directory = process.cwd()): ApplicationConfig {
  const input = record(value, 'configuration')
  knownKeys(input, ['storage', 'job', 'logLevel', 'startupTimeoutMs', 'shutdownTimeoutMs'], 'configuration')
  const storage = input.storage === undefined ? {} : record(input.storage, 'storage')
  const job = input.job === undefined ? {} : record(input.job, 'job')
  knownKeys(storage, ['file'], 'storage')
  const logLevel = input.logLevel === undefined ? 'info' : input.logLevel
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel as string)) {
    throw new TypeError('logLevel must be debug, info, warn, or error')
  }
  return Object.freeze({
    storage: Object.freeze({
      file: resolve(directory, nonEmptyString(storage.file === undefined ? './data/tasks.jsonl' : storage.file, 'storage.file')),
    }),
    job: validateJobConfig({ intervalMs: 1000, label: 'heartbeat', ...job }),
    logLevel: logLevel as LogLevel,
    startupTimeoutMs: positiveDuration(input.startupTimeoutMs === undefined ? 10_000 : input.startupTimeoutMs, 'startupTimeoutMs'),
    shutdownTimeoutMs: positiveDuration(input.shutdownTimeoutMs === undefined ? 10_000 : input.shutdownTimeoutMs, 'shutdownTimeoutMs'),
  })
}

export async function readConfig(filename: string, signal?: AbortSignal): Promise<ApplicationConfig> {
  const absolute = resolve(filename)
  let value: unknown
  try {
    value = JSON.parse(await readFile(absolute, { encoding: 'utf8', signal }))
  } catch (cause) {
    throw new Error(`cannot read JSON configuration: ${absolute}`, { cause })
  }
  return validateConfig(value, dirname(absolute))
}

export function parseArguments(argv: readonly string[], cwd = process.cwd()): CliArguments {
  let configFile = resolve(cwd, 'config.json')
  let demo = false
  let help = false
  const seen = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (!['--config', '--demo', '--help'].includes(argument)) throw new Error(`unknown argument: ${argument}`)
    if (seen.has(argument)) throw new Error(`duplicate argument: ${argument}`)
    seen.add(argument)
    if (argument === '--help') help = true
    if (argument === '--demo') demo = true
    if (argument === '--config') {
      const filename = argv[++index]
      if (!filename || filename.startsWith('--')) throw new Error('--config requires a file path')
      configFile = resolve(cwd, filename)
    }
  }
  return { configFile, demo, help }
}
