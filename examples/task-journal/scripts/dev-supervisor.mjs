/** 串行拥有一个构建任务和一个应用进程；依赖注入只用于观察真实调度边界。 */

export function createDevelopmentSupervisor({
  build, launch, report = console.error, debounceMs = 75,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let revision = 0
  let handled = 0
  let timer
  let worker
  let application
  let stopping = false
  let failure
  const controller = new AbortController()
  let finish
  const finished = new Promise(resolve => { finish = resolve })

  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }
  const fail = error => {
    failure ??= { error }
    stopping = true
    cancelTimer()
    controller.abort()
    report('[dev] stopped after an unsuccessful shutdown or process failure; restart dev explicitly', error)
    pump()
  }
  const closeApplication = async () => {
    const current = application
    if (!current) return
    application = undefined
    const result = await current.stop()
    if (result.forced || ![0, 130, 143].includes(result.code)) {
      throw new Error(`application did not close cleanly (code ${result.code}, signal ${result.signal ?? 'none'})`)
    }
  }
  const drain = async () => {
    while (stopping || handled !== revision) {
      await closeApplication()
      if (stopping) return
      const target = revision
      handled = target
      const success = await build(controller.signal)
      if (stopping) return
      // 构建期间保存过源码就重新构建；不运行已知过期或混合时刻的输出。
      if (revision !== target) continue
      if (!success) continue
      const current = launch()
      application = current
      void current.exited.then(result => {
        if (application !== current) return
        application = undefined
        if (stopping) return
        if (result.code === 0 || result.code === 2) {
          report(`[dev] application exited (${result.code}); waiting for a file change`)
        } else {
          fail(new Error(`application exited unexpectedly (code ${result.code}, signal ${result.signal ?? 'none'})`))
        }
      }, fail)
    }
  }
  function pump() {
    if (worker) return worker
    worker = Promise.resolve().then(drain).catch(error => {
      fail(error)
    }).finally(() => {
      worker = undefined
      if (stopping) {
        if (application) pump()
        else finish(failure ? { failed: true, error: failure.error } : { failed: false })
      } else if (handled !== revision) {
        pump()
      }
    })
    return worker
  }

  return {
    finished,
    settled() { return worker ?? Promise.resolve() },
    change() {
      if (stopping) return
      revision++
      cancelTimer()
      if (worker) return
      timer = setTimer(() => {
        timer = undefined
        pump()
      }, debounceMs)
    },
    stop() {
      if (!stopping) {
        stopping = true
        cancelTimer()
        controller.abort()
        pump()
      }
      return finished
    },
    fail,
  }
}
