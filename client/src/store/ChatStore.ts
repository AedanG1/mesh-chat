import type { ParsedMessage } from "../net/MessageService.js";

/**
 * A single chat message stored in memory.
 * Extends ParsedMessage with direction info (sent vs received).
 */
export interface ChatMessage {
  id: string;          // unique ID for React keys (timestamp + random)
  sender: string;      // display name
  plaintext: string;   // decrypted message text
  verified: boolean;   // true if content_sig was valid
  ts: number;          // Unix timestamp in ms
  direction: "sent" | "received";
}

/**
 * In-memory message history, grouped by conversation partner.
 *
 * Each conversation is keyed by the other user's userId. Messages are
 * stored in chronological order (oldest first).
 *
 * Per the spec, messages aren't stored in a persistent database — they
 * live only in memory and are lost when the tab closes.
 *
 * OOP Pattern: Observable Store — notifies a React hook via onChange
 * whenever the message list changes.
 */
export class ChatStore {
  /** userId → chronological list of messages with that user */
  private conversations: Map<string, ChatMessage[]> = new Map();

  /** Called whenever any conversation changes. Set by the React hook. */
  onChange?: () => void;

  /**
   * Add a received message from another user.
   *
   * @param fromUserId - The sender's userId (conversation key)
   * @param parsed     - The decrypted and verified message from MessageService
   */
  addReceived(fromUserId: string, parsed: ParsedMessage): void {
    const msg: ChatMessage = {
      id: `${parsed.ts}-${Math.random().toString(36).slice(2, 8)}`,
      sender: parsed.sender,
      plaintext: parsed.plaintext,
      verified: parsed.verified,
      ts: parsed.ts,
      direction: "received",
    };
    this.pushMessage(fromUserId, msg);
  }

  /**
   * Add a message that we sent to another user.
   *
   * @param toUserId  - The recipient's userId (conversation key)
   * @param plaintext - The plaintext we sent
   * @param username  - Our own display name
   */
  addSent(toUserId: string, plaintext: string, username: string): void {
    const ts = Date.now();
    const msg: ChatMessage = {
      id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
      sender: username,
      plaintext,
      verified: true,  // our own messages are always "verified"
      ts,
      direction: "sent",
    };
    this.pushMessage(toUserId, msg);
  }

  /** Get the message history for a conversation. */
  getMessages(userId: string): ChatMessage[] {
    return this.conversations.get(userId) ?? [];
  }

  /** Clear all conversations (e.g. on logout). */
  clear(): void {
    this.conversations.clear();
    this.onChange?.();
  }

  private pushMessage(userId: string, msg: ChatMessage): void {
    let list = this.conversations.get(userId);
    if (!list) {
      list = [];
      this.conversations.set(userId, list);
    }
    list.push(msg);
    this.onChange?.();
  }
}
