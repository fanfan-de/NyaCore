/** 在内存中生成发布声明并编译外部消费者，防止内部协调成员重新进入支持面。 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonical = (filename: string) => {
  const path = resolve(filename).replaceAll('\\', '/')
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase()
}

it('keeps supported protocols while stripping internal members from emitted declarations', () => {
  const configFile = ts.readConfigFile(resolve(packageRoot, 'tsconfig.json'), ts.sys.readFile)
  expect(configFile.error).toBeUndefined()
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, packageRoot)
  expect(config.errors).toEqual([])
  const files = new Map<string, string>()
  const build = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, declaration: true, emitDeclarationOnly: true, declarationMap: false, types: [] },
  })
  const emitted = build.emit(undefined, (filename, contents) => { files.set(canonical(filename), contents) })
  expect(emitted.emitSkipped).toBe(false)
  expect(emitted.diagnostics).toEqual([])

  const filename = resolve(packageRoot, 'public-api-consumer.mts')
  files.set(canonical(filename), `
import {
  Context, Fiber, Service, Registry, ServiceRegistry, EventRegistry,
  DisposableStack, EffectScope, ValidationError, contextMarker,
} from '@nya/core'
import type { DependencyDiagnosticSnapshot } from '@nya/core'
// @ts-expect-error Raw dependency snapshots belong to Core internals.
import type { DependencySnapshot } from '@nya/core'
// @ts-expect-error Raw implementations belong to Core internals.
import type { ServiceImplementation } from '@nya/core'
// @ts-expect-error Event Hook records are not a user-facing protocol.
import type { EventHook } from '@nya/core'
// @ts-expect-error Package exports do not expose implementation subpaths.
import type { ServiceAddress } from '@nya/core/lib/service.js'

const context = new Context()
const fiber: Fiber = context.installComponent(() => undefined)
fiber.refreshDependencies()
await fiber.awaitStable()
const dependencies: readonly DependencyDiagnosticSnapshot[] = fiber.inspect().dependencies
await fiber.update({})
await fiber.restart()
await fiber.dispose()
const services: ServiceRegistry = context.services
services.has(context, 'example')
services.get(context, 'example')
services.provide(context, 'example', {}, () => true)
const events: EventRegistry = context.events
events.on(context, 'example', () => {})
const registry: Registry = context.registry
registry.subscribe(() => {})
new EventRegistry(context)
new ServiceRegistry()
new DisposableStack()
new EffectScope()

class ExampleService extends Service {
  static provide = 'example-service';
  [Service.check]() { return true }
  [Service.init]() { return this.ctx.effect(() => undefined) }
}
context.installComponent(ExampleService)
// @ts-expect-error Context owns root Fiber construction.
Fiber.root(context)
// @ts-expect-error Registry owns component Fiber construction.
Fiber.component({} as never)
// @ts-expect-error Registry controls the initial start.
fiber.start()
// @ts-expect-error Lifecycle assertions are internal coordination.
fiber.assertActive()
// @ts-expect-error Service state notifications are internal coordination.
services.onFiberStateChange(fiber, fiber.state, fiber.state)

type Never<Value extends never> = Value
type NoFiberSymbols = Never<Extract<keyof Fiber, symbol>>
type NoRegistrySymbols = Never<Extract<keyof Registry, symbol>>
type NoServiceRegistrySymbols = Never<Extract<keyof ServiceRegistry, symbol>>
type OnlyPublicContextMarker = Never<Exclude<Extract<keyof Context, symbol>, typeof contextMarker>>
type NoErrorMarker = Never<Extract<keyof ValidationError, symbol>>
`)
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: false,
    noEmit: true,
    types: [],
    paths: { '@nya/core': [resolve(packageRoot, 'lib/index.d.ts')] },
  }
  const host = ts.createCompilerHost(options)
  host.readFile = path => files.get(canonical(path)) ?? ts.sys.readFile(path)
  host.fileExists = path => files.has(canonical(path)) || ts.sys.fileExists(path)
  host.getSourceFile = (path, languageVersion) => {
    const source = host.readFile(path)
    return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true)
  }
  const consumer = ts.createProgram([filename], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(consumer).map(diagnostic => {
    return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  })
  expect(diagnostics).toEqual([])
}, 15_000)
