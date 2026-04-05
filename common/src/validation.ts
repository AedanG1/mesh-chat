import { type Envelope, ProtocolMessageType } from "./types/protocol.js";

/** Set of all valid protocol message type strings, for fast lookup. */
const VALID_TYPES = new Set<string>(Object.values(ProtocolMessageType));

/**
 * Type guard that checks whether an unknown value is a valid Envelope.
 *
 * This is used at the system boundary -- when we receive a raw WebSocket
 * message and JSON.parse it, the result is `unknown`. This function
 * validates the shape so TypeScript can safely narrow it to `Envelope`.
 *
 * Checks performed:
 * 1. Value is a non-null object
 * 2. `type` is a string matching one of ProtocolMessageType values
 * 3. `from` is a string (server UUID or user UUID)
 * 4. `to` is a string (server UUID, user UUID, or "*")
 * 5. `ts` is a number (Unix timestamp in milliseconds)
 * 6. `payload` is a non-null object
 * 7. `sig`, if present, is a string (base64url signature)
 *
 * @param value - The unknown value to validate (typically from JSON.parse)
 * @returns true if value conforms to the Envelope interface
 */
export function isValidEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.type !== "string" || !VALID_TYPES.has(obj.type)) {
    return false;
  }

  if (typeof obj.from !== "string") {
    return false;
  }

  if (typeof obj.to !== "string") {
    return false;
  }

  if (typeof obj.ts !== "number") {
    return false;
  }

  if (typeof obj.payload !== "object" || obj.payload === null) {
    return false;
  }

  // sig is optional but must be a string if present
  if (obj.sig !== undefined && typeof obj.sig !== "string") {
    return false;
  }

  return true;
}
