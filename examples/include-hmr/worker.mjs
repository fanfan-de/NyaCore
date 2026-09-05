import { prefix } from './message.mjs'

export default (ctx, config) => {
  const print = () => ctx.logger.info(prefix + ': ' + config.message)
  print()
  ctx.effect(() => {
    const interval = setInterval(print, 2000)
    return () => {
      clearInterval(interval)
      ctx.logger.info('worker stopped')
    }
  }, 'example worker interval')
}
