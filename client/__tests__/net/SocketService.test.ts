import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";

// ── Socket.io mock ────────────────────────────────────────────────────────────
//
// vi.mock() hoists this factory to the top of the file before any imports,
// replacing the real "socket.io-client" module for this test file only.
// The factory returns an object that mimics the Socket interface we use.
//
// We store the mock socket in a variable that our tests can inspect and
// control (e.g., calling fakeSocket.simulateEvent() to pretend the server
// sent an envelope).

let fakeSocket: {
  connected: boolean;
  on: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  // Test helper: simulate an inbound event from the server
  simulateEvent: (event: string, data: unknown) => void;
  // Captures all registered listeners so simulateEvent can call them
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
};

vi.mock("socket.io-client", () => {
  return {
    io: vi.fn(() => {
      fakeSocket = {
        connected: false,
        listeners: new Map(),
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          const existing = fakeSocket.listeners.get(event) ?? [];
          fakeSocket.listeners.set(event, [...existing, cb]);
        }),
        emit: vi.fn(),
        disconnect: vi.fn(() => { fakeSocket.connected = false; }),
        simulateEvent: (event: string, data: unknown) => {
          fakeSocket.listeners.get(event)?.forEach((cb) => cb(data));
        },
      };
      return fakeSocket;
    }),
  };
});

// ── Import AFTER mock is registered ──────────────────────────────────────────
import { SocketService } from "../../src/net/SocketService.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SocketService", () => {
  let service: SocketService;

  beforeEach(() => {
    service = new SocketService();
    vi.clearAllMocks();
  });

  describe("connect()", () => {
    it("calls io() with the provided URL", async () => {
      const { io } = await import("socket.io-client");
      service.connect("http://localhost:3000");
      expect(io).toHaveBeenCalledWith("http://localhost:3000");
    });

    it("registers listeners for connect, disconnect, and envelope events", () => {
      service.connect("http://localhost:3000");

      // Spread the iterator once — Map.keys() is a one-shot iterator
      const registeredEvents = [...fakeSocket.listeners.keys()];
      expect(registeredEvents).toContain("connect");
      expect(registeredEvents).toContain("disconnect");
      expect(registeredEvents).toContain("envelope");
    });
  });

  describe("send()", () => {
    it("calls socket.emit with 'envelope' and the envelope object", () => {
      service.connect("http://localhost:3000");
      fakeSocket.connected = true;

      const envelope: Envelope = {
        type: ProtocolMessageType.MSG_DIRECT,
        from: "user-a",
        to: "user-b",
        ts: Date.now(),
        payload: { ciphertext: "abc", sender_sig_pub: "pub", content_sig: "sig" },
      };

      service.send(envelope);

      expect(fakeSocket.emit).toHaveBeenCalledWith("envelope", envelope);
    });

    it("throws if not connected", () => {
      // Never called connect(), so not connected
      const envelope: Envelope = {
        type: ProtocolMessageType.MSG_DIRECT,
        from: "a",
        to: "b",
        ts: 0,
        payload: {},
      };

      expect(() => service.send(envelope)).toThrow("not connected");
    });
  });

  describe("onEnvelope()", () => {
    it("calls registered callback when a valid envelope arrives", () => {
      service.connect("http://localhost:3000");

      const received: Envelope[] = [];
      service.onEnvelope((e) => received.push(e));

      const envelope: Envelope = {
        type: ProtocolMessageType.USER_DELIVER,
        from: "server-1",
        to: "user-b",
        ts: Date.now(),
        payload: { ciphertext: "ct", sender: "alice", sender_sig_pub: "pub", content_sig: "sig" },
      };

      fakeSocket.simulateEvent("envelope", envelope);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(envelope);
    });

    it("drops envelopes that fail the isValidEnvelope check", () => {
      service.connect("http://localhost:3000");

      const received: Envelope[] = [];
      service.onEnvelope((e) => received.push(e));

      // Missing required fields — not a valid envelope
      fakeSocket.simulateEvent("envelope", { type: "GARBAGE", from: "x" });

      expect(received).toHaveLength(0);
    });

    it("calls multiple registered callbacks", () => {
      service.connect("http://localhost:3000");

      const calls: number[] = [];
      service.onEnvelope(() => calls.push(1));
      service.onEnvelope(() => calls.push(2));

      const envelope: Envelope = {
        type: ProtocolMessageType.HEARTBEAT,
        from: "server-1",
        to: "*",
        ts: Date.now(),
        payload: {},
      };

      fakeSocket.simulateEvent("envelope", envelope);

      expect(calls).toEqual([1, 2]);
    });
  });

  describe("onConnect / onDisconnect callbacks", () => {
    it("fires onConnect callbacks when connection event fires", () => {
      service.connect("http://localhost:3000");

      const connected: boolean[] = [];
      service.onConnect(() => connected.push(true));

      fakeSocket.simulateEvent("connect", undefined);

      expect(connected).toEqual([true]);
    });

    it("fires onDisconnect callbacks when disconnect event fires", () => {
      service.connect("http://localhost:3000");

      const disconnected: boolean[] = [];
      service.onDisconnect(() => disconnected.push(true));

      fakeSocket.simulateEvent("disconnect", undefined);

      expect(disconnected).toEqual([true]);
    });
  });

  describe("isConnected()", () => {
    it("returns false before connecting", () => {
      expect(service.isConnected()).toBe(false);
    });

    it("returns false after disconnect()", () => {
      service.connect("http://localhost:3000");
      fakeSocket.connected = true;
      service.disconnect();

      expect(service.isConnected()).toBe(false);
    });
  });
});
