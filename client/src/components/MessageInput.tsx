import { useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_PLAINTEXT_BYTES } from "@mesh-chat/common";

/**
 * Text input for composing and sending messages.
 *
 * Enforces the RSA-OAEP plaintext size limit (446 bytes) and shows
 * a byte counter. Submit with Enter or the Send button.
 * Shift+Enter inserts a newline.
 */
interface MessageInputProps {
  onSend: (plaintext: string) => void;
  disabled: boolean;
}

export function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [text, setText] = useState("");

  const byteLength = new TextEncoder().encode(text).length;
  const overLimit = byteLength > MAX_PLAINTEXT_BYTES;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim() || overLimit || disabled) return;
    onSend(text);
    setText("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <form className="px-4 py-3 border-t border-gray-700 bg-gray-900" onSubmit={handleSubmit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "Select a user to chat" : "Type a message..."}
        disabled={disabled}
        rows={2}
        className="w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded text-gray-200 text-sm font-[inherit] resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50"
      />
      <div className="flex justify-between items-center mt-1">
        <span className={`text-xs ${overLimit ? "text-red-400 font-semibold" : "text-gray-600"}`}>
          {byteLength}/{MAX_PLAINTEXT_BYTES}
        </span>
        <button
          type="submit"
          disabled={disabled || overLimit || !text.trim()}
          className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed rounded text-white text-sm font-semibold cursor-pointer"
        >
          Send
        </button>
      </div>
    </form>
  );
}
