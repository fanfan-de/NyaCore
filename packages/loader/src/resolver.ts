/** 本文件实现默认动态 import 解析器，并把解析结果归一化为 Component 定义。 */

import type { Component } from '@nya/core'
import type {
  LoaderResolution,
  LoaderResolver,
} from './types.js'

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
  if (!baseUrl || (!name.startsWith('.') && !name.startsWith('/'))) {
    return name
  }
  return new URL(name, baseUrl).href
}

/** 使用宿主原生动态 import；裸包名保持原样，相对名按显式 baseUrl 解析。 */
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

  throw new TypeError(
    'invalid loader resolution: expected a Component or a default Component export',
  )
}
