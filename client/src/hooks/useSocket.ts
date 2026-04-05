import { useEffect, useRef, useState, useCallback } from "react";
import { ProtocolMessageType, type Envelope } from "@mesh-chat/common";
import { SocketService } from "../net/SocketService.js";
import { MessageService } from "../net/MessageService.js";
import { PeerStore } from "../store/PeerStore.js";
import { ChatStore } from "../store/ChatStore.js";
import type { Session } from "../store/AuthStore.js";

/**
 * The return value of useSocket — everything the UI needs from the
 * socket connection: online status, peer list, chat messages, and
 * a function to send messages.
 */
export interface SocketState {
  connected: boolean;
  peers: ReturnType<PeerStore["getAll"]>;
  peerStore: PeerStore;
  chatStore: ChatStore;
  sendMessage: (recipientId: string, recipientEncPub: string, plaintext: string) => Promise<void>;
}

/**
 * Hook that manages the full Socket.io lifecycle for a logged-in user.
 *
 * When a session is provided:
 *   1. Opens a Socket.io connection to the server
 *   2. Sends USER_HELLO to announce our presence
 *   3. Routes inbound envelopes:
 *      - USER_ADVERTISE / USER_REMOVE → PeerStore
 *      - USER_DELIVER → decrypt + verify → ChatStore
 *   4. Exposes sendMessage() for outgoing MSG_DIRECT
 *
 * When session becomes null (logout), disconnects and clears state.
 *
 * @param serverUrl - The server base URL (e.g. "http://127.0.0.1:3000")
 * @param session   - The authenticated session, or null if not logged in
 */
export function useSocket(serverUrl: string, session: Session | null): SocketState {
  const socketRef = useRef(new SocketService());
  const peerStoreRef = useRef(new PeerStore());
  const chatStoreRef = useRef(new ChatStore());

  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<ReturnType<PeerStore["getAll"]>>([]);
  // This counter is used to force re-renders when chat messages change.
  // React won't re-render if we just mutate the ChatStore — we need
  // a state change. Incrementing a counter is the simplest trigger.
  const [, setChatVersion] = useState(0);

  // Wire store change callbacks to trigger React re-renders
  useEffect(() => {
    peerStoreRef.current.onChange = () => {
      setPeers(peerStoreRef.current.getAll());
    };
    chatStoreRef.current.onChange = () => {
      setChatVersion((v) => v + 1);
    };
  }, []);

  // Main effect: connect/disconnect based on session
  useEffect(() => {
    if (!session) {
      socketRef.current.disconnect();
      peerStoreRef.current.clear();
      chatStoreRef.current.clear();
      setConnected(false);
      return;
    }

    const socket = socketRef.current;
    const peerStore = peerStoreRef.current;
    const chatStore = chatStoreRef.current;

    socket.onConnect(() => {
      setConnected(true);

      // Send USER_HELLO to announce ourselves to the server
      const helloEnvelope: Envelope = {
        type: ProtocolMessageType.USER_HELLO,
        from: session.userId,
        to: "", // will be filled by server context
        ts: Date.now(),
        payload: {
          client: "web-v1",
          sig_pubkey: session.sig_pubkey,
          enc_pubkey: session.enc_pubkey,
        },
      };
      socket.send(helloEnvelope);
    });

    socket.onDisconnect(() => {
      setConnected(false);
    });

    // Route inbound envelopes to the right store
    socket.onEnvelope((envelope: Envelope) => {
      // Presence events → PeerStore
      if (peerStore.handleEnvelope(envelope)) return;

      // Message delivery → decrypt + verify → ChatStore
      if (envelope.type === ProtocolMessageType.USER_DELIVER) {
        MessageService.parseDelivery(envelope, session.clientCrypto)
          .then((parsed) => {
            // The "from" field is the server, so we need the sender's userId.
            // We look up the sender by username in the peer list.
            const senderPeer = peerStore.getAll().find((p) => p.username === parsed.sender);
            const senderId = senderPeer?.userId ?? envelope.from;
            chatStore.addReceived(senderId, parsed);
          })
          .catch((err) => {
            console.error("[useSocket] Failed to parse delivery:", err);
          });
      }
    });

    socket.connect(serverUrl);

    return () => {
      socket.disconnect();
      setConnected(false);
    };
    // session identity doesn't change mid-session; serverUrl is stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, serverUrl]);

  const sendMessage = useCallback(async (
    recipientId: string,
    recipientEncPub: string,
    plaintext: string,
  ) => {
    if (!session) throw new Error("Not logged in");

    const envelope = await MessageService.buildDirectMessage(
      session.userId,
      recipientId,
      recipientEncPub,
      session.sig_pubkey,
      plaintext,
      session.clientCrypto,
    );

    socketRef.current.send(envelope);

    // Add to our own chat history so we see it in the conversation
    chatStoreRef.current.addSent(recipientId, plaintext, session.username);
  }, [session]);

  return {
    connected,
    peers,
    peerStore: peerStoreRef.current,
    chatStore: chatStoreRef.current,
    sendMessage,
  };
}
