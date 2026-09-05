import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArguments, readConfig, validateConfig, validateJobConfig } from '../src/config.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('configuration', () => {
  it('fills defaults from an empty object and resolves storage relative to the config directory', () => {
    const directory = resolve('fixture-directory')
    expect(validateConfig({}, directory)).toEqual({
      storage: { file: join(directory, 'data', 'tasks.jsonl') },
      job: { intervalMs: 1000, label: 'heartbeat' },
      logLevel: 'info', startupTimeoutMs: 10_000, shutdownTimeoutMs: 10_000,
    })
  })

  it('reads JSON with paths relative to its file, not the process directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nya-journal-config-'))
    directories.push(directory)
    const filename = join(directory, 'custom.json')
    await writeFile(filename, JSON.stringify({ storage: { file: 'journal.jsonl' }, job: { label: 'custom' } }))
    const config = await readConfig(filename)
    expect(config.storage.file).toBe(join(directory, 'journal.jsonl'))
    expect(config.job).toEqual({ intervalMs: 1000, label: 'custom' })
  })

  it.each([
    null, [], { unexpected: true }, { storage: null }, { storage: { file: '' } },
    { job: { intervalMs: 0 } }, { job: { intervalMs: 1.5 } }, { job: { intervalMs: Infinity } },
    { job: { intervalMs: 2_147_483_648 } }, { job: { intervalMs: '1000' } },
    { job: { label: ' ' } }, { job: { interval: 1 } }, { logLevel: 'trace' },
    { startupTimeoutMs: -1 }, { shutdownTimeoutMs: null },
  ])('rejects invalid configuration %j', value => {
    expect(() => validateConfig(value)).toThrow()
  })

  it('rejects incomplete runtime job updates instead of applying defaults', () => {
    expect(() => validateJobConfig({ intervalMs: 1 })).toThrow('job.label')
    expect(() => validateJobConfig({ label: 'next' })).toThrow('job.intervalMs')
    expect(validateJobConfig({ intervalMs: 20, label: 'next' })).toEqual({ intervalMs: 20, label: 'next' })
  })

  it('reports missing and malformed configuration files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nya-journal-config-'))
    directories.push(directory)
    const filename = join(directory, 'config.json')
    await expect(readConfig(filename)).rejects.toThrow('cannot read JSON configuration')
    await writeFile(filename, '{')
    await expect(readConfig(filename)).rejects.toThrow('cannot read JSON configuration')
  })
})

describe('arguments', () => {
  it('supports the default and explicit configuration, demo and help', () => {
    expect(parseArguments([])).toEqual({ configFile: resolve('config.json'), demo: false, help: false })
    expect(parseArguments(['--config', 'custom.json', '--demo', '--help'])).toEqual({
      configFile: resolve('custom.json'), demo: true, help: true,
    })
  })

  it.each([['--config'], ['--config', '--demo'], ['--unknown'], ['positional'], ['--demo', '--demo']].map(arguments_ => [arguments_]))(
    'rejects ambiguous or unknown arguments %j', arguments_ => {
      expect(() => parseArguments(arguments_)).toThrow()
    },
  )
})
