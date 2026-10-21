/**
 * In-process fan-out for live board updates.
 *
 * The product is a single Node process, so a plain map of subscribers is enough:
 * every write bumps the project revision in SQLite and the hub forwards that
 * revision to whoever has the board open over Server-Sent Events. No external
 * broker, no polling of the database.
 */
import type { BoardPresenceMember } from '../core/protocol.ts'

export interface Subscriber {
  /** Unique per connection (a user may keep several tabs open). */
  id: string
  projectId: string
  member: BoardPresenceMember
  send: (event: string, data: unknown) => void
}

export interface PublishResult {
  /** Distinct people currently subscribed to the project. */
  presence: BoardPresenceMember[]
}

/** Event hub: connection bookkeeping + presence de-duplicated by user id. */
export class EventHub {
  private readonly byProject = new Map<string, Map<string, Subscriber>>()

  subscribe(input: { id: string; projectId: string; member: BoardPresenceMember; send: (event: string, data: unknown) => void }): () => void {
    const bucket = this.byProject.get(input.projectId) ?? new Map<string, Subscriber>()
    this.byProject.set(input.projectId, bucket)
    const subscriber: Subscriber = { id: input.id, projectId: input.projectId, member: input.member, send: input.send }
    bucket.set(input.id, subscriber)
    this.broadcastPresence(input.projectId)
    return () => {
      const current = this.byProject.get(input.projectId)
      if (!current) return
      current.delete(input.id)
      if (current.size === 0) this.byProject.delete(input.projectId)
      this.broadcastPresence(input.projectId)
    }
  }

  /** People (one entry per account) with this project currently open. */
  presence(projectId: string): BoardPresenceMember[] {
    const seen = new Map<string, BoardPresenceMember>()
    for (const subscriber of this.byProject.get(projectId)?.values() ?? []) {
      if (!seen.has(subscriber.member.userId)) seen.set(subscriber.member.userId, subscriber.member)
    }
    return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
  }

  /** Tell every subscriber of a project that its revision moved. */
  publish(projectId: string, revision: number): PublishResult {
    for (const subscriber of this.byProject.get(projectId)?.values() ?? []) {
      try {
        subscriber.send('revision', { projectId, revision })
      } catch {
        /* a broken pipe is cleaned up by the connection's own close handler */
      }
    }
    return { presence: this.presence(projectId) }
  }

  /** Push the current presence list to every subscriber of a project. */
  private broadcastPresence(projectId: string): void {
    const presence = this.presence(projectId)
    for (const subscriber of this.byProject.get(projectId)?.values() ?? []) {
      try {
        subscriber.send('presence', { projectId, presence })
      } catch {
        /* ignore */
      }
    }
  }

  /** Count of open subscriptions, used by `health()`. */
  size(): number {
    let total = 0
    for (const bucket of this.byProject.values()) total += bucket.size
    return total
  }

  /** Close every stream (shutdown, tests). */
  closeAll(): void {
    for (const bucket of this.byProject.values()) {
      for (const subscriber of bucket.values()) {
        try {
          subscriber.send('bye', { projectId: subscriber.projectId, presence: [] })
        } catch {
          /* ignore */
        }
      }
    }
    this.byProject.clear()
  }
}
