import type { Envelope } from "@mesh-chat/common";
import { SEEN_CACHE_TTL_MS } from "@mesh-chat/common";
import { ServerCrypto } from "../crypto/ServerCrypto.js";

/**
 * Deduplication cache for broadcast protocol messages.
 *
 * The Problem:
 *   In an n-to-n mesh, every server forwards broadcast messages
 *   (SERVER_ANNOUNCE, USER_ADVERTISE, USER_REMOVE) to all its peers.
 *   Without deduplication, a message from server A reaches B,
 *   B forwards it to C, C forwards it back to A, and the loop
 *   continues forever.
 *
 * The Solution:
 *   Before processing any broadcast message, check if we've seen it
 *   before using a composite key: (ts, from, to, hash(payload)).
 *   If seen, drop the message. If new, record it and process it.
 *
 * Implementation:
 *   - `seen`: Set<string> for O(1) key lookups
 *   - `insertedAt`: Map<key, timestamp> for TTL-based cleanup
 *   - Pruning happens lazily on every `markSeen` call
 *
 * The payload hash uses SHA-256 over the canonical JSON payload,
 * making the key unique to the actual message content.
 */
export class SeenCache {
  private seen: Set<string> = new Set();
  private insertedAt: Map<string, number> = new Map();

  /**
   * Check whether this envelope has already been processed.
   *
   * Now async because the SHA-256 payload hash uses crypto.subtle.digest.
   *
   * @returns true if we've seen this exact message before
   */
  async hasSeen(envelope: Envelope): Promise<boolean> {
    const key = await this.makeKey(envelope);
    return this.seen.has(key);
  }

  /**
   * Record that we've processed this envelope.
   * Also triggers lazy pruning of expired entries.
   */
  async markSeen(envelope: Envelope): Promise<void> {
    // Prune old entries first to keep memory bounded
    this.prune();

    const key = await this.makeKey(envelope);
    this.seen.add(key);
    this.insertedAt.set(key, Date.now());
  }

  /**
   * Builds the composite deduplication key for an envelope.
   *
   * Format: "${ts}:${from}:${to}:${sha256(canonicalPayload)}"
   *
   * Using all four components ensures:
   *   - Different senders with same payload are distinct (from)
   *   - Same message forwarded to different targets are distinct (to)
   *   - Timestamps prevent collisions across time (ts)
   *   - Payload hash captures the exact message content
   *
   * Uses WebCrypto's crypto.subtle.digest for the SHA-256 hash.
   */
  private async makeKey(envelope: Envelope): Promise<string> {
    const canonicalPayload = ServerCrypto.canonicalizePayload(envelope.payload);

    // crypto.subtle.digest returns an ArrayBuffer of the raw hash.
    // We convert to hex for a readable, compact string representation.
    const hashBuffer = await crypto.subtle.digest("SHA-256", canonicalPayload);
    const hashArray = new Uint8Array(hashBuffer);
    const payloadHash = Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return `${envelope.ts}:${envelope.from}:${envelope.to}:${payloadHash}`;
  }

  /**
   * Remove entries that have exceeded the TTL.
   *
   * This is called lazily (on every markSeen) rather than on a
   * fixed interval, which avoids needing a setInterval/timer.
   * For our message volume this is sufficient.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, insertedAt] of this.insertedAt) {
      if (now - insertedAt > SEEN_CACHE_TTL_MS) {
        this.seen.delete(key);
        this.insertedAt.delete(key);
      }
    }
  }

  /** Returns the current number of cached entries (useful for tests). */
  size(): number {
    return this.seen.size;
  }
}
