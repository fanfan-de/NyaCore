/** 本文件实现默认动态 import 解析器，并把解析结果归一化为 Component 定义。 */

import type { Component } from '@nya/core'
import { resolve as resolveEsm } from 'import-meta-resolve'
import type { LoaderResolution, LoaderResolver } from './types.js'

function isComponent(value: unknown): value is Component<any> {
  if (typeof value === 'function') return true
  if (!value || typeof value !== 'object') return false

  try {
    return typeof Reflect.get(value, 'apply') === 'function'
  } catch {
    return false
  }
}

function resolveSpecifier(name: string, baseUrl?: string) {
  try { return new URL(name).href } catch {}

  if (baseUrl === undefined) {
    if (name === '.' || name === '..' || name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
      throw new TypeError('default loader resolver requires an explicit baseUrl for relative module names')
    }
    // 没有宿主基址的裸包名保留原生模块相对解析；宿主插件应显式提供 baseUrl。
    return name
  }

  let parent: URL
  try {
    parent = new URL(baseUrl)
  } catch (cause) {
    throw new TypeError('default loader resolver baseUrl must be an absolute file: URL', { cause })
  }
  if (parent.protocol !== 'file:') {
    throw new TypeError('default loader resolver baseUrl must be an absolute file: URL')
  }
  // package imports 与 self resolution 需要模块 URL；目录基址使用虚拟模块。
  if (parent.pathname.endsWith('/')) parent = new URL('__nya_loader_resolver__.mjs', parent)
  return resolveEsm(name, parent.href)
}

/** 按宿主基址解析 ESM 后导入；模块缓存由 Node 管理。 */
export const defaultLoaderResolver: LoaderResolver = async request => {
  return import(resolveSpecifier(request.name, request.baseUrl))
}

/** 接受直接 Component 或 ESM default 导出，拒绝含糊的命名导出猜测。 */
export function normalizeLoaderResolution(
  resolution: LoaderResolution,
): Component<any> {
  if (isComponent(resolution)) return resolution

  let candidate: unknown
  try {
    candidate = Reflect.get(resolution, 'default')
  } catch {}
  if (isComponent(candidate)) return candidate

  throw new TypeError('invalid loader resolution: expected a Component or a default Component export')
}
