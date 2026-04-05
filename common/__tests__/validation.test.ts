import { describe, it, expect } from "vitest";
import { isValidEnvelope } from "../src/validation.js";
import { ProtocolMessageType } from "../src/types/protocol.js";

/** A minimal valid envelope we can use as a base for tests. */
function makeValidEnvelope() {
  return {
    type: ProtocolMessageType.HEARTBEAT,
    from: "abc-123",
    to: "*",
    ts: Date.now(),
    payload: {},
  };
}

describe("isValidEnvelope", () => {
  it("accepts a valid envelope without sig", () => {
    expect(isValidEnvelope(makeValidEnvelope())).toBe(true);
  });

  it("accepts a valid envelope with sig", () => {
    const env = { ...makeValidEnvelope(), sig: "somesignature" };
    expect(isValidEnvelope(env)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidEnvelope(null)).toBe(false);
  });

  it("rejects non-object types", () => {
    expect(isValidEnvelope("string")).toBe(false);
    expect(isValidEnvelope(42)).toBe(false);
    expect(isValidEnvelope(undefined)).toBe(false);
  });

  it("rejects when type is missing", () => {
    const { type, ...rest } = makeValidEnvelope();
    expect(isValidEnvelope(rest)).toBe(false);
  });

  it("rejects when type is not a valid ProtocolMessageType", () => {
    const env = { ...makeValidEnvelope(), type: "INVALID_TYPE" };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it("rejects when from is not a string", () => {
    const env = { ...makeValidEnvelope(), from: 123 };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it("rejects when to is not a string", () => {
    const env = { ...makeValidEnvelope(), to: null };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it("rejects when ts is not a number", () => {
    const env = { ...makeValidEnvelope(), ts: "not-a-number" };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it("rejects when payload is null", () => {
    const env = { ...makeValidEnvelope(), payload: null };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it("rejects when payload is not an object", () => {
    const env = { ...makeValidEnvelope(), payload: "string" };
    expect(isValidEnvelope(env)).toBe(false);
  });

  it("rejects when sig is present but not a string", () => {
    const env = { ...makeValidEnvelope(), sig: 12345 };
    expect(isValidEnvelope(env)).toBe(false);
  });
});
