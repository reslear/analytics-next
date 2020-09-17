import { Context } from '../context'
import { Extension } from '../extension'
import pWhile from 'p-whilst'
import { attempt, ensure } from './delivery'

interface EventQueueConfig {
  extensions: Extension[]
}

export class EventQueue {
  queue: Context[]
  archive: Context[]
  private flushing = false

  config: EventQueueConfig

  private constructor(config: EventQueueConfig) {
    this.queue = []
    this.archive = []
    this.config = config
  }

  public static async init(config: EventQueueConfig): Promise<EventQueue> {
    const queue = new EventQueue(config)

    const ctx = Context.system()
    const extensions = queue.config.extensions

    const loaders = extensions.map((xt) => xt.load(ctx, {}))
    await Promise.all(loaders)

    return queue
  }

  async register(extension: Extension): Promise<void> {
    this.config.extensions.push(extension)
    const ctx = Context.system()
    await extension.load(ctx, {})
  }

  async dispatch(ctx: Context): Promise<Context | undefined> {
    ctx.log('debug', 'Dispatching')
    ctx.stats.increment('message_dispatched')

    this.queue.push(ctx)
    this.scheduleFlush()

    return Promise.resolve(ctx)
  }

  private scheduleFlush(): void {
    if (this.flushing) {
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    setTimeout(async () => {
      this.flushing = true

      await this.flush()
      this.flushing = false

      this.scheduleFlush()
    }, 3000)
  }

  async flush(): Promise<Context[]> {
    const flushed: Context[] = []
    // prevent multiple calls to `flush()`
    await pWhile(
      () => this.queue.length > 0,
      async () => {
        const start = new Date().getTime()
        const ctx = this.queue.shift()
        if (!ctx) {
          return
        }

        try {
          await this.flushOne(ctx)
          const done = new Date().getTime() - start
          ctx.stats.gauge('delivered', done)
          ctx.log('debug', 'Delivered')
          flushed.push(ctx)
        } catch (err) {
          ctx.log('error', 'Failed to deliver')
          ctx.stats.increment('delivery_failed')

          // Retrying...
          // How many times until discard?
          this.queue.push(ctx)

          // TODO: sleep?
        }
      }
    )

    return flushed
  }

  private isReady(): boolean {
    return this.config.extensions.every((p) => p.isLoaded())
  }

  private async flushOne(ctx: Context): Promise<Context | undefined> {
    // TODO: check connection
    if (!this.isReady()) {
      return
    }

    const before = this.config.extensions.filter((p) => p.type === 'before')
    const enrichment = this.config.extensions.filter((p) => p.type === 'enrichment')
    const destinations = this.config.extensions.filter((p) => p.type === 'destination')

    for (const beforeWare of before) {
      const temp: Context | undefined = await ensure(ctx, beforeWare)
      if (temp !== undefined) {
        ctx = temp
      }
    }

    // TODO: should enrichment halt the pipeline?
    // TODO: should enrichment be run in parallel?
    for (const enrichmentWare of enrichment) {
      const temp: Context | Error = await attempt(ctx, enrichmentWare)
      if (temp instanceof Context) {
        ctx = temp
      }
    }

    // No more changes to ctx from now on
    ctx.seal()

    // TODO: send to Segment

    // TODO: concurrency control
    // TODO: timeouts
    const deliveryAttempts = destinations.map((destination) => attempt(ctx, destination))
    await Promise.all(deliveryAttempts)

    ctx.stats.increment('message_delivered')
    return ctx
  }
}
