/** 本文件提供一个仅供 playground 使用的心跳组件，用于观察 Component 配置、Effect 和资源清理行为。 */

import type { Component } from '@nya/core'

export interface HeartbeatConfig {
  interval: number
  label: string
}

export const heartbeatComponent: Component<HeartbeatConfig> = {
  name: 'playground-heartbeat',

  apply(context, config) {
    if (!config) {
      throw new TypeError('playground-heartbeat requires config')
    }

    let count = 0

    console.log(`[${config.label}] component started`)

    context.effect(() => {
      const timer = setInterval(() => {
        count += 1
        console.log(`[${config.label}] beat ${count}`)
      }, config.interval)

      return () => {
        clearInterval(timer)
        console.log(`[${config.label}] timer disposed`)
      }
    }, 'playground.heartbeat.timer')

    return () => {
      console.log(`[${config.label}] component disposed after ${count} beats`)
    }
  },
}
