import { useMemo } from "react";
import type { ChatStore, ChatMessage } from "../store/ChatStore.js";

/**
 * Hook that provides messages for a specific conversation.
 *
 * Simply reads from ChatStore for the given userId. The parent
 * component (via useSocket) already triggers re-renders when
 * ChatStore changes, so this hook just provides a convenient
 * accessor.
 *
 * @param chatStore       - The ChatStore instance from useSocket
 * @param selectedUserId  - The userId of the conversation partner, or null
 * @param chatVersion     - A change counter to trigger re-computation
 */
export function useChat(
  chatStore: ChatStore,
  selectedUserId: string | null,
  chatVersion: number,
): ChatMessage[] {
  return useMemo(() => {
    if (!selectedUserId) return [];
    return chatStore.getMessages(selectedUserId);
    // chatVersion is included to re-compute when new messages arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatStore, selectedUserId, chatVersion]);
}
