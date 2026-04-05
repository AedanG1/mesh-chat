import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProtocolMessageType } from "@mesh-chat/common";
import { HeartbeatManager } from "../../src/mesh/HeartbeatManager.js";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from "@mesh-chat/common";

// ── Test doubles ──────────────────────────────────────────────────────────────

const SERVER_ID = "server-a";
const PEER_ID = "server-b";
const PEER_HOST = "127.0.0.1";
const PEER_PORT = 9999;

/**
 * Build a fake MeshManager with the minimal surface HeartbeatManager needs.
 *
 * `getPeerEntries` is the key: it returns [id, link] pairs where each link
 * has a `lastFrameReceived` timestamp and a `close()` spy. We can mutate
 * `lastFrameReceived` in tests to simulate a stale peer.
 */
function makeMeshManager(lastFrameReceived: number) {
  const fakeLink = {
    lastFrameReceived,
    close: vi.fn(),
  };

  return {
    broadcast: vi.fn(),
    getPeerEntries: vi.fn(() => [[PEER_ID, fakeLink]] as [string, typeof fakeLink][]),
    getServerAddr: vi.fn(() => [PEER_HOST, PEER_PORT] as [string, number]),
    connectToPeer: vi.fn(),
    fakeLink, // expose for assertions
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HeartbeatManager", () => {
  beforeEach(() => {
    // Replace the real timer implementations with Vitest's controllable fakes.
    // This means setInterval / setTimeout / Date.now are all under our control.
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Always restore real timers so other test files are unaffected.
    vi.useRealTimers();
  });

  describe("start() / stop()", () => {
    it("does not broadcast before the first interval elapses", () => {
      const mm = makeMeshManager(Date.now());
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();

      // Advance just under one interval — nothing should have fired yet
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);

      expect(mm.broadcast).not.toHaveBeenCalled();
    });

    it("broadcasts a HEARTBEAT after one interval", () => {
      const mm = makeMeshManager(Date.now());
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(mm.broadcast).toHaveBeenCalledOnce();

      // Inspect the envelope that was broadcast
      const [envelope] = mm.broadcast.mock.calls[0];
      expect(envelope.type).toBe(ProtocolMessageType.HEARTBEAT);
      expect(envelope.from).toBe(SERVER_ID);
      expect(envelope.to).toBe("*");
    });

    it("broadcasts 3 times after 3 intervals", () => {
      const mm = makeMeshManager(Date.now());
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

      expect(mm.broadcast).toHaveBeenCalledTimes(3);
    });

    it("stops broadcasting after stop() is called", () => {
      const mm = makeMeshManager(Date.now());
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS); // 1 broadcast
      hb.stop();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5); // should be no more

      expect(mm.broadcast).toHaveBeenCalledOnce();
    });

    it("calling start() twice does not create a second interval", () => {
      const mm = makeMeshManager(Date.now());
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();
      hb.start(); // second call should be a no-op
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      // Only one broadcast per tick, not two
      expect(mm.broadcast).toHaveBeenCalledOnce();
    });
  });

  describe("liveness checks", () => {
    it("does NOT close a peer that received a frame recently", () => {
      // lastFrameReceived = right now → well within the 45s window
      const mm = makeMeshManager(Date.now());
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      expect(mm.fakeLink.close).not.toHaveBeenCalled();
    });

    it("closes and reconnects a peer that has been silent for > 45s", () => {
      // lastFrameReceived = 46 seconds ago → stale
      const staleTime = Date.now() - (HEARTBEAT_TIMEOUT_MS + 1000);
      const mm = makeMeshManager(staleTime);
      const hb = new HeartbeatManager(mm as any, SERVER_ID);

      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

      // The dead link should have been closed immediately
      expect(mm.fakeLink.close).toHaveBeenCalledOnce();

      // connectToPeer is called after a 1s delay — advance past it
      vi.advanceTimersByTime(1500);
      expect(mm.connectToPeer).toHaveBeenCalledOnce();
      expect(mm.connectToPeer).toHaveBeenCalledWith(PEER_ID, PEER_HOST, PEER_PORT);
    });

    it("does NOT reconnect if the dead peer has no stored address", () => {
      const staleTime = Date.now() - (HEARTBEAT_TIMEOUT_MS + 1000);
      const mm = makeMeshManager(staleTime);
      // Override getServerAddr to return undefined (peer address unknown)
      mm.getServerAddr = vi.fn(() => undefined as any);

      const hb = new HeartbeatManager(mm as any, SERVER_ID);
      hb.start();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 1500);

      expect(mm.fakeLink.close).toHaveBeenCalledOnce();
      expect(mm.connectToPeer).not.toHaveBeenCalled();
    });
  });
});
