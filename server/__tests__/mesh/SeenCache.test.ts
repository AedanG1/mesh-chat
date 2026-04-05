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
  it("returns false for an unseen envelope", async () => {
    const cache = new SeenCache();
    expect(await cache.hasSeen(makeEnvelope())).toBe(false);
  });

  it("returns true after markSeen", async () => {
    const cache = new SeenCache();
    const env = makeEnvelope();
    await cache.markSeen(env);
    expect(await cache.hasSeen(env)).toBe(true);
  });

  it("treats envelopes with different `from` as distinct", async () => {
    const cache = new SeenCache();
    const envA = makeEnvelope({ from: "server-a" });
    const envB = makeEnvelope({ from: "server-b" });

    await cache.markSeen(envA);
    // envB has the same ts, to, payload -- only `from` differs
    expect(await cache.hasSeen(envB)).toBe(false);
  });

  it("treats envelopes with different `ts` as distinct", async () => {
    const cache = new SeenCache();
    const env1 = makeEnvelope({ ts: 1000 });
    const env2 = makeEnvelope({ ts: 2000 });

    await cache.markSeen(env1);
    expect(await cache.hasSeen(env2)).toBe(false);
  });

  it("treats envelopes with different payload as distinct", async () => {
    const cache = new SeenCache();
    const envA = makeEnvelope({ payload: { host: "10.0.0.1", port: 9000, sig_pubkey: "abc" } });
    const envB = makeEnvelope({ payload: { host: "10.0.0.2", port: 9001, sig_pubkey: "xyz" } });

    await cache.markSeen(envA);
    expect(await cache.hasSeen(envB)).toBe(false);
  });

  it("tracks the correct size after multiple markSeen calls", async () => {
    const cache = new SeenCache();
    await cache.markSeen(makeEnvelope({ ts: 1 }));
    await cache.markSeen(makeEnvelope({ ts: 2 }));
    await cache.markSeen(makeEnvelope({ ts: 3 }));
    expect(cache.size()).toBe(3);
  });

  it("does not double-count the same envelope", async () => {
    const cache = new SeenCache();
    const env = makeEnvelope();
    await cache.markSeen(env);
    await cache.markSeen(env); // calling again should not increase size
    expect(cache.size()).toBe(1);
  });
});
