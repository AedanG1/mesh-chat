/** How often each server sends HEARTBEAT to all peers (milliseconds). */
export const HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds

/** If no frame received from a server within this window, mark it dead (milliseconds). */
export const HEARTBEAT_TIMEOUT_MS = 45_000; // 45 seconds

/**
 * Maximum plaintext size for RSA-OAEP with RSA-4096 and SHA-256.
 * Formula: (keySize / 8) - 2 * (hashSize / 8) - 2 = 512 - 64 - 2 = 446 bytes.
 */
export const MAX_PLAINTEXT_BYTES = 446;

/** How long a login nonce challenge remains valid (milliseconds). */
export const NONCE_TTL_MS = 60_000; // 60 seconds

/** Time-to-live for entries in the seen_ids dedup cache (milliseconds). */
export const SEEN_CACHE_TTL_MS = 300_000; // 5 minutes
