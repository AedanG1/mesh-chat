import type { Peer } from "../store/PeerStore.js";

/**
 * Sidebar list of online users.
 *
 * Displays all peers on the network. Clicking a user selects them
 * as the current conversation partner. The currently selected user
 * is visually highlighted.
 */
interface UserListProps {
  peers: Peer[];
  selectedUserId: string | null;
  onSelectUser: (userId: string) => void;
  currentUserId: string;
}

export function UserList({ peers, selectedUserId, onSelectUser, currentUserId }: UserListProps) {
  const otherPeers = peers.filter((p) => p.userId !== currentUserId);

  return (
    <div className="p-3">
      <h3 className="text-xs text-gray-500 uppercase tracking-wide mb-2">
        Online ({otherPeers.length})
      </h3>
      {otherPeers.length === 0 && (
        <p className="text-sm text-gray-600 py-2">No other users online</p>
      )}
      <ul className="list-none">
        {otherPeers.map((peer) => (
          <li
            key={peer.userId}
            className={`flex items-center gap-2 px-2.5 py-2 rounded cursor-pointer text-sm
              ${peer.userId === selectedUserId
                ? "bg-blue-500/20 text-blue-400"
                : "hover:bg-gray-800"
              }`}
            onClick={() => onSelectUser(peer.userId)}
          >
            <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{peer.username}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
