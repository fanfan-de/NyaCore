/** 本文件实现 Standard Schema 同步配置校验，并定义可跨包副本识别的校验错误。 */

import type { StandardSchemaV1 } from '@standard-schema/spec'

const validationErrorMarker = Symbol.for('@nya/core/ValidationError')

function formatPath(path: StandardSchemaV1.Issue['path']) {
  return path?.map((segment) => {
    const key = typeof segment === 'object' && segment !== null
      ? segment.key
      : segment
    return String(key)
  }).join('.')
}

/** Standard Schema 返回 issues 时由 Core 暴露的统一错误。 */
export class ValidationError extends TypeError {
  readonly [validationErrorMarker] = true
  readonly issues: readonly StandardSchemaV1.Issue[]

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(`invalid config:\n${issues.map((issue) => {
      const path = formatPath(issue.path)
      return path
        ? `  - ${issue.message} (at ${path})`
        : `  - ${issue.message}`
    }).join('\n')}`)
    this.name = 'ValidationError'
    this.issues = issues
  }

  static is(value: unknown): value is ValidationError {
    return typeof value === 'object'
      && value !== null
      && validationErrorMarker in value
  }
}

/** 校验并转换组件配置；Core 第一版明确拒绝异步 Standard Schema。 */
export function resolveConfig(
  schema: StandardSchemaV1 | undefined,
  config: unknown,
): unknown {
  if (!schema) return config

  const result = schema['~standard'].validate(config)
  if (result instanceof Promise || (
    typeof result === 'object'
    && result !== null
    && 'then' in result
  )) {
    void Promise.resolve(result).catch(() => {})
    throw new TypeError('async config validation is not supported')
  }

  if (result.issues) throw new ValidationError(result.issues)
  return result.value
}
