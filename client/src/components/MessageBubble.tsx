import type { ChatMessage } from "../store/ChatStore.js";

/**
 * A single message bubble in the chat window.
 *
 * Sent messages are right-aligned (blue), received messages left-aligned
 * (dark gray). Shows a warning if signature verification failed.
 */
interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const time = new Date(message.ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const isSent = message.direction === "sent";

  return (
    <div className={`max-w-[70%] px-3 py-2 rounded-lg text-sm leading-relaxed ${
      isSent
        ? "self-end bg-blue-600 text-white"
        : "self-start bg-gray-800 text-gray-200"
    }`}>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="font-semibold text-xs">{message.sender}</span>
        <span className="text-[0.7rem] opacity-70">{time}</span>
      </div>
      <div className="whitespace-pre-wrap wrap-break-word">{message.plaintext}</div>
      {!message.verified && (
        <div className="mt-1 text-[0.7rem] text-red-400 italic">Unverified signature</div>
      )}
    </div>
  );
}
