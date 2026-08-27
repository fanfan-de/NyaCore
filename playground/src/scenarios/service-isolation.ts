/** 本文件演示默认与隔离 database 服务在同一 Root 中并存并被各自消费者解析。 */

import { Context, FiberState } from '@nya/core'

interface PlaygroundDatabase {
  readonly label: string
  identify(): string
}

declare module '@nya/core' {
  interface Context {
    database: PlaygroundDatabase
  }
}

function createDatabase(label: string): PlaygroundDatabase {
  return {
    label,
    identify: () => label,
  }
}

function createConsumer(expected: PlaygroundDatabase) {
  return {
    name: `playground-${expected.label}-consumer`,
    inject: ['database'],

    apply(context: Context) {
      if (context.database !== expected) {
        throw new Error(
          `expected ${expected.label}, received ${context.database.label}`,
        )
      }

      console.log(`[service-isolation] resolved ${context.database.identify()}`)
    },
  }
}

export async function runServiceIsolationScenario() {
  console.log('\n--- service isolation scenario ---')

  const app = new Context()
  const testContext = app.isolate('database')
  const defaultDatabase = createDatabase('default database')
  const testDatabase = createDatabase('isolated test database')

  const removeDefault = app.provide('database', defaultDatabase)
  const removeTest = testContext.provide('database', testDatabase)

  const defaultConsumer = app.installComponent(createConsumer(defaultDatabase))
  const testConsumer = testContext.installComponent(createConsumer(testDatabase))

  await Promise.all([defaultConsumer, testConsumer])

  if (
    defaultConsumer.state !== FiberState.ACTIVE
    || testConsumer.state !== FiberState.ACTIVE
  ) {
    throw new Error('default and isolated consumers must both be ACTIVE')
  }

  await Promise.all([defaultConsumer.dispose(), testConsumer.dispose()])
  await Promise.all([removeDefault(), removeTest()])

  console.log('[scenario] service isolation verification passed\n')
}
