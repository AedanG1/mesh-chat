/**
 * Information about a server on the mesh network.
 * Exchanged during SERVER_HELLO_JOIN / SERVER_WELCOME / SERVER_ANNOUNCE.
 */
export interface ServerInfo {
  host: string;
  port: number;
  sig_pubkey: string; // base64url RSASSA-PSS public key (for verifying transport signatures)
}

/**
 * A server's network address as a [host, port] tuple.
 * Stored in the serverAddrs in-memory table.
 */
export type ServerAddr = [host: string, port: number];
