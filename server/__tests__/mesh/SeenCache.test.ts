import { describe, it, expect } from "vitest";
import { SeenCache } from "../../src/mesh/SeenCache.js";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    type: ProtocolMessageType.SERVER_ANNOUNCE,
    from: "server-a",
    to: "*",
    ts: 1700000000000,
    payload: { host: "10.0.0.1", port: 9000, sig_pubkey: "abc" },
    ...overrides,
  };
}

describe("SeenCache", () => {
  it("returns false for an unseen envelope", () => {
    const cache = new SeenCache();
    expect(cache.hasSeen(makeEnvelope())).toBe(false);
  });

  it("returns true after markSeen", () => {
    const cache = new SeenCache();
    const env = makeEnvelope();
    cache.markSeen(env);
    expect(cache.hasSeen(env)).toBe(true);
  });

  it("treats envelopes with different `from` as distinct", () => {
    const cache = new SeenCache();
    const envA = makeEnvelope({ from: "server-a" });
    const envB = makeEnvelope({ from: "server-b" });

    cache.markSeen(envA);
    // envB has the same ts, to, payload -- only `from` differs
    expect(cache.hasSeen(envB)).toBe(false);
  });

  it("treats envelopes with different `ts` as distinct", () => {
    const cache = new SeenCache();
    const env1 = makeEnvelope({ ts: 1000 });
    const env2 = makeEnvelope({ ts: 2000 });

    cache.markSeen(env1);
    expect(cache.hasSeen(env2)).toBe(false);
  });

  it("treats envelopes with different payload as distinct", () => {
    const cache = new SeenCache();
    const envA = makeEnvelope({ payload: { host: "10.0.0.1", port: 9000, sig_pubkey: "abc" } });
    const envB = makeEnvelope({ payload: { host: "10.0.0.2", port: 9001, sig_pubkey: "xyz" } });

    cache.markSeen(envA);
    expect(cache.hasSeen(envB)).toBe(false);
  });

  it("tracks the correct size after multiple markSeen calls", () => {
    const cache = new SeenCache();
    cache.markSeen(makeEnvelope({ ts: 1 }));
    cache.markSeen(makeEnvelope({ ts: 2 }));
    cache.markSeen(makeEnvelope({ ts: 3 }));
    expect(cache.size()).toBe(3);
  });

  it("does not double-count the same envelope", () => {
    const cache = new SeenCache();
    const env = makeEnvelope();
    cache.markSeen(env);
    cache.markSeen(env); // calling again should not increase size
    expect(cache.size()).toBe(1);
  });
});
