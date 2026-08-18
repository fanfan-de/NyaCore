/** 本文件定义一个用于演示配置传入、Effect 登记和资源清理的问候组件。 */

import type { Component } from '@nya/core'

export interface GreetingConfig {
  interval: number
  message: string
}

export const greetingComponent: Component<GreetingConfig> = {
  name: 'playground-greeting',

  apply(context, config) {
    if (!config) {
      throw new TypeError('playground-greeting requires config')
    }

    if (!Number.isFinite(config.interval) || config.interval <= 0) {
      throw new RangeError('playground-greeting interval must be greater than 0')
    }

    console.log('[greeting] component started')

    context.effect(() => {
      const timer = setInterval(() => {
        console.log(`[greeting] ${config.message}`)
      }, config.interval)

      return () => {
        clearInterval(timer)
        console.log('[greeting] timer disposed')
      }
    }, 'playground.greeting.timer')

    return () => {
      console.log('[greeting] component disposed')
    }
  },
}
