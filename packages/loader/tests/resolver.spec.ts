/** 真实文件及宿主 node_modules 验证默认 Resolver 的 Node ESM 解析边界。 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultLoaderResolver, normalizeLoaderResolution } from '../src/resolver.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'nya-loader-resolver-'))
  directories.push(temporary)
  const host = join(temporary, '宿主 空格 # %')
  await mkdir(host)
  const write = async (relative: string, contents: string) => {
    const filename = join(host, relative)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, contents, 'utf8')
    return pathToFileURL(filename).href
  }
  const component = (name: string) => `export default { name: ${JSON.stringify(name)}, apply() {} }\n`
  const hostModule = await write('main.mjs', 'export {}\n')
  const hostDirectory = pathToFileURL(host).href + '/'
  return { host, write, component, hostModule, hostDirectory }
}

async function resolve(name: string, baseUrl?: string) {
  const resolution = await defaultLoaderResolver({ id: 'probe', name, baseUrl, parentId: null })
  return normalizeLoaderResolution(resolution)
}

describe('default Node ESM resolver', () => {
  it.each(['./component.mjs', '../component.mjs', '/component.mjs', '.', '..'])('requires explicit baseUrl for %s', async name => {
    await expect(resolve(name)).rejects.toThrow('baseUrl')
  })

  it('loads an absolute file URL with space, Unicode, # and % independently of baseUrl', async () => {
    const f = await fixture()
    const url = await f.write('组件 # %.mjs', f.component('encoded-file'))
    expect(url).toContain('%23')
    expect(url).toContain('%25')
    await expect(resolve(url)).resolves.toMatchObject({ name: 'encoded-file' })
    await expect(resolve(url, 'unused invalid base')).resolves.toMatchObject({ name: 'encoded-file' })
  })

  it.each(['module', 'directory'] as const)('resolves relative ESM imports from a host %s URL', async kind => {
    const f = await fixture()
    await f.write('插件/组件 # %.mjs', f.component('host-relative'))
    const baseUrl = kind === 'module' ? f.hostModule : f.hostDirectory
    await expect(resolve('./插件/组件%20%23%20%25.mjs', baseUrl)).resolves.toMatchObject({ name: 'host-relative' })
  })

  it.each(['module', 'directory'] as const)('uses host node_modules and import export conditions from a %s URL', async kind => {
    const f = await fixture()
    await f.write('node_modules/nya-probe-plugin/package.json', JSON.stringify({
      name: 'nya-probe-plugin', type: 'module', exports: {
        '.': { require: './require.cjs', import: './import.mjs', default: './fallback.mjs' },
        './feature': { require: './require.cjs', import: './feature.mjs' },
      },
    }))
    await f.write('node_modules/nya-probe-plugin/import.mjs', f.component('host-import'))
    await f.write('node_modules/nya-probe-plugin/feature.mjs', f.component('host-feature'))
    await f.write('node_modules/nya-probe-plugin/require.cjs', 'throw new Error("require condition must not be used")\n')
    await f.write('node_modules/nya-probe-plugin/fallback.mjs', 'throw new Error("fallback condition must not be used")\n')
    const baseUrl = kind === 'module' ? f.hostModule : f.hostDirectory
    await expect(resolve('nya-probe-plugin', baseUrl)).resolves.toMatchObject({ name: 'host-import' })
    await expect(resolve('nya-probe-plugin/feature', baseUrl)).resolves.toMatchObject({ name: 'host-feature' })
    await expect(resolve('nya-probe-plugin/import.mjs', baseUrl)).rejects.toMatchObject({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  })

  it.each(['module', 'directory'] as const)('resolves package imports and self exports in the host %s scope', async kind => {
    const f = await fixture()
    await f.write('package.json', JSON.stringify({
      name: 'nya-resolver-host', type: 'module',
      exports: { '.': './self.mjs' },
      imports: { '#component': { require: './require.cjs', import: './import.mjs' } },
    }))
    await f.write('self.mjs', f.component('self-export'))
    await f.write('import.mjs', f.component('host-imports'))
    await f.write('require.cjs', 'throw new Error("require condition must not be used")\n')
    const baseUrl = kind === 'module' ? f.hostModule : f.hostDirectory
    await expect(resolve('#component', baseUrl)).resolves.toMatchObject({ name: 'host-imports' })
    await expect(resolve('nya-resolver-host', baseUrl)).resolves.toMatchObject({ name: 'self-export' })
  })

  it('uses the nearest host node_modules in a nested project', async () => {
    const f = await fixture()
    for (const [directory, label] of [['.', 'outer'], ['nested', 'inner']] as const) {
      await f.write(`${directory}/node_modules/nya-nested-plugin/package.json`, JSON.stringify({
        name: 'nya-nested-plugin', type: 'module', exports: './index.mjs',
      }))
      await f.write(`${directory}/node_modules/nya-nested-plugin/index.mjs`, f.component(label))
    }
    const inner = await f.write('nested/main.mjs', 'export {}\n')
    await expect(resolve('nya-nested-plugin', inner)).resolves.toMatchObject({ name: 'inner' })
    await expect(resolve('nya-nested-plugin', f.hostModule)).resolves.toMatchObject({ name: 'outer' })
  })

  it('honors explicit package export default targets when no import branch exists', async () => {
    const f = await fixture()
    await f.write('node_modules/nya-default-plugin/package.json', JSON.stringify({
      name: 'nya-default-plugin', exports: { require: './require.cjs', default: './default.mjs' },
    }))
    await f.write('node_modules/nya-default-plugin/default.mjs', f.component('default-condition'))
    await f.write('node_modules/nya-default-plugin/require.cjs', 'throw new Error("wrong condition")\n')
    await expect(resolve('nya-default-plugin', f.hostModule)).resolves.toMatchObject({ name: 'default-condition' })
  })

  it.each(['./host.mjs', 'https://example.com/main.mjs', 'C:\\host\\main.mjs'])('rejects a non-file baseUrl %s clearly', async baseUrl => {
    await expect(resolve('nya-plugin', baseUrl)).rejects.toThrow('baseUrl')
  })

  it('keeps absolute data modules and normalized definition identity without cache busting', async () => {
    const name = 'data:text/javascript,export default function plugin() {}'
    const first = await resolve(name)
    expect(await resolve(name)).toBe(first)
  })
})
