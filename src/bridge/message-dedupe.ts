/**
 * Atomic inbound message claiming keyed by QQ message identity.
 * Synchronous Map ops — safe against concurrent handler entry on one event loop.
 */

export type DedupeResult = "claimed" | "duplicate";

export interface MessageIdentity {
  messageId?: string;
  msgIdx?: string;
  conversationId: string;
  /** Platform timestamp string from the event (not wall clock). */
  timestamp?: string;
  rawEventType?: string;
}

export class MessageDeduper {
  private readonly claimed = new Map<string, number>();
  private readonly windowMs: number;
  private readonly maxSize: number;

  constructor(options: { windowMs?: number; maxSize?: number } = {}) {
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.maxSize = options.maxSize ?? 5000;
  }

  /** Build stable identity keys for a QQ inbound message (no content). */
  static keysFor(identity: MessageIdentity): string[] {
    const keys: string[] = [];
    if (identity.messageId) keys.push(`mid:${identity.messageId}`);
    if (identity.msgIdx) {
      keys.push(`idx:${identity.conversationId}:${identity.msgIdx}`);
    }
    // Platform retries often reuse the same event timestamp with a new id.
    if (identity.timestamp) {
      keys.push(`ts:${identity.conversationId}:${identity.timestamp}`);
    }
    return keys;
  }

  /**
   * Atomically claim all identity keys. Returns duplicate if any key was
   * already claimed within the window.
   */
  tryClaim(identity: MessageIdentity): { result: DedupeResult; keys: string[]; hitKey?: string } {
    const keys = MessageDeduper.keysFor(identity);
    if (keys.length === 0) {
      // No identity — cannot dedupe; allow but caller should log.
      return { result: "claimed", keys: [] };
    }

    const now = Date.now();
    this.evict(now);

    for (const key of keys) {
      const prev = this.claimed.get(key);
      if (prev !== undefined && now - prev <= this.windowMs) {
        return { result: "duplicate", keys, hitKey: key };
      }
    }

    for (const key of keys) {
      this.claimed.set(key, now);
    }
    return { result: "claimed", keys };
  }

  /** Test helper */
  size(): number {
    return this.claimed.size;
  }

  clear(): void {
    this.claimed.clear();
  }

  private evict(now: number): void {
    if (this.claimed.size <= this.maxSize) {
      for (const [key, ts] of this.claimed) {
        if (now - ts > this.windowMs) this.claimed.delete(key);
      }
      return;
    }
    for (const [key, ts] of this.claimed) {
      if (now - ts > this.windowMs || this.claimed.size > this.maxSize) {
        this.claimed.delete(key);
      }
    }
  }
}
