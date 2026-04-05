import { useState } from "react";
import { useAuth } from "../hooks/useAuth.js";
import { useSocket } from "../hooks/useSocket.js";
import { useChat } from "../hooks/useChat.js";
import { UserList } from "./UserList.js";
import { ChatWindow } from "./ChatWindow.js";
import { MessageInput } from "./MessageInput.js";

/**
 * Main layout for the authenticated chat view.
 *
 * Structure:
 *   Header  — app title, connection status, username, logout
 *   Body    — sidebar (user list) + main (chat window + message input)
 */
interface LayoutProps {
  serverUrl: string;
}

export function Layout({ serverUrl }: LayoutProps) {
  const { session, logout } = useAuth();
  const { connected, peers, peerStore, chatStore, sendMessage } = useSocket(serverUrl, session);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [chatVersion, setChatVersion] = useState(0);

  // Wire chatStore onChange to bump the version for useChat
  chatStore.onChange = () => setChatVersion((v) => v + 1);

  const messages = useChat(chatStore, selectedUserId, chatVersion);

  const selectedPeer = selectedUserId ? peerStore.get(selectedUserId) : undefined;

  async function handleSend(plaintext: string) {
    if (!selectedPeer) return;
    try {
      await sendMessage(selectedPeer.userId, selectedPeer.enc_pubkey, plaintext);
    } catch (err) {
      console.error("[Layout] Send failed:", err);
    }
  }

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-200">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-700">
        <h1 className="text-base font-semibold text-gray-100">Mesh Chat</h1>
        <div className="flex items-center gap-4 text-sm">
          <span className={`flex items-center gap-1.5 text-xs`}>
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
            {connected ? "Connected" : "Disconnected"}
          </span>
          <span className="text-gray-500">{session?.username}</span>
          <button
            onClick={logout}
            className="px-3 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 hover:bg-gray-700 cursor-pointer"
          >
            Logout
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-56 bg-gray-900 border-r border-gray-700 overflow-y-auto">
          <UserList
            peers={peers}
            selectedUserId={selectedUserId}
            onSelectUser={setSelectedUserId}
            currentUserId={session?.userId ?? ""}
          />
        </aside>

        {/* Main chat area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <ChatWindow
            messages={messages}
            peerUsername={selectedPeer?.username ?? null}
          />
          <MessageInput
            onSend={handleSend}
            disabled={!connected || !selectedPeer}
          />
        </main>
      </div>
    </div>
  );
}
