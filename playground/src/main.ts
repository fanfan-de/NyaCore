/** 本文件是 Nya 开发期试玩入口，只负责选择并运行当前需要人工观察的验证场景。 */

import { runLifecycleScenario } from './scenarios/lifecycle.ts'
import { runDiagnosticsScenario } from './scenarios/diagnostics.ts'
import { runGreetingScenario } from './scenarios/greeting.ts'
import { runServiceCallerContextScenario } from './scenarios/service-caller-context.ts'
import { runServiceIsolationScenario } from './scenarios/service-isolation.ts'

await runLifecycleScenario()
await runGreetingScenario()
await runServiceIsolationScenario()
await runServiceCallerContextScenario()
await runDiagnosticsScenario()
