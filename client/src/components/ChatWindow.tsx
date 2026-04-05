import { useEffect, useRef } from "react";
import type { ChatMessage } from "../store/ChatStore.js";
import { MessageBubble } from "./MessageBubble.js";

/**
 * The main chat area showing messages for the current conversation.
 *
 * Auto-scrolls to the bottom when new messages arrive. Shows a
 * placeholder when no conversation is selected.
 */
interface ChatWindowProps {
  messages: ChatMessage[];
  peerUsername: string | null;
}

export function ChatWindow({ messages, peerUsername }: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  if (!peerUsername) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <p>Select a user to start chatting</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-700 bg-gray-900">
        <h3 className="text-sm font-semibold text-gray-100">{peerUsername}</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
        {messages.length === 0 && (
          <p className="text-center text-gray-600 mt-8 text-sm">No messages yet. Say hello!</p>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
