/** 生成式 API 基线的边界回归；只创建并删除本测试拥有的临时 fixture。 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkApi, createApiSnapshot, normalizeDeclaration } from './check-api.mjs'

async function fixture(testContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nya-api-guard-'))
  testContext.after(() => rm(directory, { recursive: true, force: true }))
  const write = async (path, contents) => {
    const filename = join(directory, path)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  }
  return { directory, write }
}

function manifest(name = '@nya/fixture') {
  return {
    name, version: '0.1.0-rc.1', types: './lib/index.d.ts',
    exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' },
  }
}

test('normalizes comments, formatting and private implementation details but retains construction and protected API', () => {
  const first = normalizeDeclaration(`
    /** implementation notes */
    export declare class Example {
      #private;
      private cache;
      private helper();
      private constructor();
      protected current: string;
      run(value: 'one'): void;
    }
  `)
  const second = normalizeDeclaration('export declare class Example {private changed; private constructor(); protected current:string; run(value:"one"):void;}')
  assert.equal(first, second)
  assert.match(first, /private constructor\(\)/)
  assert.match(first, /protected current: string/)
  assert.doesNotMatch(first, /#private|cache|helper|implementation notes/)
  assert.notEqual(first, normalizeDeclaration(first.replace('private constructor();', '')))
  assert.notEqual(first, normalizeDeclaration(first.replace('current: string', 'current: number')))
})

test('collects only reachable declaration files, including import types and reference paths', async t => {
  const f = await fixture(t)
  await f.write('package.json', { ...manifest(), imports: { '#local-types': './lib/local-types.d.ts' } })
  await f.write('lib/index.d.ts', `
    /// <reference path="./ambient.d.ts" />
    export { Public } from './public.js';
    export type Extra = import('./extra.js').Extra;
    import type { External } from 'external-package';
    export type Outside = External;
    export type Local = import('#local-types').Local;
    declare module './augment-target.js' { interface Augmented { enabled: boolean } }
  `)
  await f.write('lib/public.d.ts', `
    import type { Options } from './options.js';
    export declare class Public {
      private secret: import('./private-only.js').Secret;
      run(options: Options): void;
    }
  `)
  await f.write('lib/options.d.ts', 'export interface Options { enabled: boolean }')
  await f.write('lib/extra.d.ts', 'export interface Extra { value: string }')
  await f.write('lib/ambient.d.ts', 'interface AmbientMarker { ready: true }')
  await f.write('lib/local-types.d.ts', 'export type Local = string;')
  await f.write('lib/augment-target.d.ts', 'export interface Augmented {}')
  await f.write('lib/private-only.d.ts', 'export interface Secret { value: string }')
  await f.write('lib/unreachable.d.ts', 'export type NotPublic = number')
  const snapshot = await createApiSnapshot(f.directory)
  for (const name of ['index', 'public', 'options', 'extra', 'ambient', 'local-types', 'augment-target']) assert.match(snapshot, new RegExp(`=== lib/${name}\\.d\\.ts ===`))
  assert.doesNotMatch(snapshot, /=== lib\/(unreachable|private-only)\.d\.ts ===/)
  assert.match(snapshot, /external-package/)
  assert.match(snapshot, /does not publish internal modules/)
})

test('ignores package version changes and records public signatures and export conditions', async t => {
  const f = await fixture(t)
  const packageJson = manifest()
  await f.write('package.json', packageJson)
  await f.write('lib/index.d.ts', 'export declare function run(value: string): void;')
  const first = await createApiSnapshot(f.directory)
  await f.write('package.json', { ...packageJson, version: '0.1.0-rc.2' })
  assert.equal(await createApiSnapshot(f.directory), first)
  await f.write('lib/index.d.ts', 'export declare function run(value: number): void;')
  const changedSignature = await createApiSnapshot(f.directory)
  assert.notEqual(changedSignature, first)
  await f.write('package.json', {
    ...packageJson, exports: { '.': { types: './lib/index.d.ts', import: './lib/index.js', default: './lib/other.js' } },
  })
  assert.notEqual(await createApiSnapshot(f.directory), changedSignature)
})

test('fails clearly when a reachable declaration is missing or leaves published lib', async t => {
  const f = await fixture(t)
  await f.write('package.json', manifest())
  await assert.rejects(createApiSnapshot(f.directory), /run npm run build first/)
  await f.write('lib/index.d.ts', 'export { Missing } from "./missing.js";')
  await assert.rejects(createApiSnapshot(f.directory), /unshipped declaration: .\/missing.js/)
  await f.write('outside.d.ts', 'export type Outside = string;')
  await f.write('lib/index.d.ts', 'export { Outside } from "../outside.js";')
  await assert.rejects(createApiSnapshot(f.directory), /unshipped declaration: ..\/outside.js/)
})

test('checking is read-only, explicit update establishes baselines, and public drift fails the guard', async t => {
  const f = await fixture(t)
  for (const name of ['core', 'loader', 'include', 'hmr', 'logger-console', 'timer']) {
    await f.write(`packages/${name}/package.json`, manifest(`@nya/${name}`))
    await f.write(`packages/${name}/lib/index.d.ts`, 'export declare function run(): void;')
  }
  const messages = []
  const output = { log: message => messages.push(message), error: message => messages.push(message) }
  assert.equal(await checkApi({ root: f.directory, output }), false)
  await assert.rejects(readFile(join(f.directory, 'api/core.api.txt')), { code: 'ENOENT' })
  assert.equal(await checkApi({ root: f.directory, update: true, output }), true)
  assert.equal(await checkApi({ root: f.directory, output }), true)
  const before = await readFile(join(f.directory, 'api/core.api.txt'), 'utf8')
  await f.write('packages/core/lib/index.d.ts', 'export declare function run(required: string): void;')
  assert.equal(await checkApi({ root: f.directory, output }), false)
  assert.equal(await readFile(join(f.directory, 'api/core.api.txt'), 'utf8'), before)
  assert.ok(messages.some(message => message.includes('兼容性和迁移说明')))
})
