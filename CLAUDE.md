# Your role
As an AI coding agent, your role is to guide me through developing this project, discussing alternative approaches to implementations when necessary, and avoiding giving me code without a thorough explanation of what each line is doing. This is a Junior Portfolio Project, meaning I don't want to go too far outside the scope of this specification unless absolutely necessary (eg. pieces can't fit together or a piece was left out and needs to be implemented for the project to work.) I would also like help writing tests and figuring out how to write tests in general. Please suggest testing libraries to make sure the project is well tested and guide me through writing tests. 

# Tech Stack
## Server
- Express.js (server)
- Native Node.js WebSockets (server to server WebSocket Connection)
- Socket.io (client to server WebSocket Connection)
- uuid (UUIDs)
- Argon2id (hashing) 
- Native Node.js crypto library (encrypting, decrypting, signing)

## Client
- React (client, UI)
- Argon2id (KDF)
- WebCrypto (AES-256-GCM, encryption, decryption, signing, CryptoKey importing/caching)
- Socket.io (client to server WebSocket Connection)

## Other
- Docker (simulate n-to-n mesh of servers)

# Project Overview
This project is a basic chat app with a focus on cryptography and an n-to-n mesh server topology. Each server is connected using WebSockets and each Client is connected to it's Local Server using WebSockets. Messages aren't stored in a persistent database (message history can be short lived on the client). Users can only send messages to Users who are connected to the network. Messages between Users are End-to-End Encrypted. The state of the network is stored in in-memory tables on each server. Each server on the network is responsible for keeping the entire network state up-to-date by broadcasting each event to every server on the network using JSON protocol messages.

Because this is a learning project it there's no need to worry about deployment. Docker needs to be used in order to be able to simulate the n-to-n mesh of servers. 

# Object Oriented Approach
The project should be developed with an Object Oriented Approach in mind. I'm not very good at OOP yet so I'd like more help and guidance on developing this project using OOP.

# Specifications

1. Cryptography:
  - Asymmetric (Public/Private Keys): RSA-4096 only
  - Encryption: All payloads MUST be encrypted directly with RSA-OAEP (SHA-256) by the client.
  - Signatures: All payloads MUST be signed using RSASSA-PSS (SHA-256) by the server and sometimes client.
  - Each server creates one RSASSA-PSS key pair for transport signatures.
  - Each client creates one RSASSA-PSS key pair for content signatures and one RSA-OAEP key pair for encryption/decryption.
  - Hash: SHA-256, Argon2id.
  - Encodings: Binary values (keys, ciphertexts, signatures) MUST be base64url (no padding) in
JSON.

2. Identifiers:
  - All unique identifiers MUST use UUID v4.
  - Server IDs: server_uuid, server_uuid, etc.
  - The Server MUST generate a UUID before joining the network.
  - User IDs: case-sensitive strings; MUST be unique Network-wide. MUST use UUIDs.

3. Required In-Memory Tables:
  - Here's an example of the in-memory tables that are required:
    ```javascript
    type Link = any; // Replace with your actual WebSocket wrapper type

    const servers: Map<number, Link> = new Map();

    const serverAddrs: Map<number, [string, number]> = new Map();

    const localUsers: Map<string, Link> = new Map();

    const userLocations: Map<string, string> = new Map();
    ```

4. Transport:
  - WebSocket (RFC 6455) is REQUIRED.
  - Each JSON frame is sent as a WebSocket text message (UTF-8).
  - No custom newline framing. Servers MUST parse one JSON object per WS message.
  - A server MUST listen on a WS port and accept both Server and User connections.
  - A connecting Server/User MUST send an identifying first message.
  - Close: use normal WebSocket closure (code 1000). Optionally send {"type": "CTRL_CLOSE"}
  before closing.

5. JSON Envelope:
  - Every Protocol Message MUST have:
    ```json
    { 
      "type": "STRING", // Payload type, case sensitive
      "from": "UUID", // server_id or user_id
      "to": "UUID", // server_id, user_id, or "*"
      "ts": "INT", // Unix timestamp in miliseconds
      "payload": {}, // JSON object, payload specific
      "sig": "BASE64URL" // Signature over canonical payload
    }
    ```
  - sig is REQUIRED on all Server payloads and all User content payloads.
  - For HELLO/BOOTSTRAP you MAY omit sig if not yet possible to sign; see each type.

# Server to Server Protocol
When a new server joins the network it MUST:
1. Announce itself to an Introducer server. In this project ALL servers will have the responsibility of being an Introducer server once they're on the network. This means that there needs to be a hard-coded list of all server IPs/Ports that can exist as a Docker container. 
  - Example SERVER_HELLO_JOIN:
    ```json
    {
      "type":"SERVER_HELLO_JOIN",
      "from":"server_id", // your server ID
      "to":"A.B.C.D:12345", // select an introducter from static list
      "ts":1700000000000,
      "payload":{
        "host":"A.B.C.D", "port":12345,
        "sig_pubkey":"BASE64URL(RSASSA-PSS-PUB)" // for verifying signatures from this server
      }, 
      "sig":"...",
    }
    ```
  - Notes: 
    - The to field MUST point to a known (and trusted) Introducer IP/port
    - If the first Introducer is unreachable, the Server tries the next entry in its static bootstrap list.
    - The static bootstrap list MUST have at least 3 servers for redundancy.
2. Receive a permanent ID from the Introducer server along with the entire state of the network (servers, serverAddrs, userLocations) as a JSON Envelope.
  ```json
  { 
    "type":"SERVER_WELCOME" ,
    "from":"server_id" ,
    "to":"server_id" ,
    "ts":1700000000500,
    "payload":{
      "assigned_id": "server_id" , // server_id is checked within network to verify its uniqueness. If it is, return same ID, otherwise return new unique ID
      "servers": "<servers on the network>",
      "serverAddrs": "<addresses of servers on the network>",
      "userLocations":"<which user is connected to which server>"
    },
    "sig":"..." 
  }  
  ```
3. Once the new server has the entire state of the network it broadcasts it's presence to all other servers on the network by sending a SERVER_ANNOUNCE message.
  ```json
  {
    "type":"SERVER_ANNOUNCE",
    "from":"server_id",
    "to":"*", // Broadcast to all servers on the network
    "ts":1700000000500,
    "payload":{
      "host": "A.B.C.D", // The Server's IP
      "port": 12345, // The Server's WS port
      "sig_pubkey": "BASE64URL(RSASSA-PSS-PUB)", // for verifying signatures from this server
    },
    "sig":"..."
  }
  ```

# User Presence Gossip
When a User connects to a Server, that Server announces the User’s presence to the entire
Network.

The Payload MUST contain:
- The User’s ID
- The ID of the Server
- Any metadata associated with the User
  ```json
    { 
      "type":"USER_ADVERTISE",
      "from":"server_id",
      "to":"*", // Broadcast to all servers, which relays to all clients
      "ts":1700000100000,
      "payload":{
        "user_id":"the_user_id", "server_id":"server_id",
        "meta":{}
      },
      "sig":"..." 
    }
  ```
The servers receiving the USER_ADVERTISE must:
1. Verify sig using server’s public key.
2. On success, update local mapping: user_locations["user_id"] = "server_id"
3. Forward the message to other servers (gossip).

When a User disconnects, the Server that they are on announces removal:
  ```json
  { 
  "type":"USER_REMOVE" ,
  "from":"server_1" ,
  "to":"*" , // Broadcast to all servers, which relays to all clients
  "ts":1700000200000,
  "payload":{
    "user_id":"user_id",
    "server_id":"server_id"}
  },
  "sig":"..." 
  ```
The servers receiving the USER_REMOVE must:
1. Verify sig using server’s public key.
2. Only remove the User if the local mapping still points to that Server:
  ```
  if user_locations.get("user_id") == "server_id": JSON
  del user_locations["user_id"]
  ```
3. Forward the removal to other Servers.

# User to Server Protocol
Once the user has logged in, the user announces it's presence to it's local server.
  ```json
  { 
    "type":"USER_HELLO" ,
    "from":"user_id", // User's ID
    "to":"server_id", // Local Server ID
    "ts":1700000003000,
    "payload":{
      "client":"cli-v1",
      "sig_pubkey":"<b64url RSASSA-PSS pub>", // for signature verification by recipient clients
      "enc_pubkey":"<b64url RSA-OAEP pub" // for encrypting messages to this user
    },
    "sig":"" // optional on first frame
  }
  ```
On accept: 
1. local_users[user_id]=link; user_locations[user_id]="local" & emit USER_ADVERTISE to
servers.
2. the client gets the usernames, UUIDs, and public keys of all users on the network.

When a user sends a Direct Message to another user on the network the server must NOT decrypt.
  ```json
    { 
    "type":"MSG_DIRECT",
    "from":"sender_user_id", // UUID of sender
    "to":"recipent_user_id", // UUID of recipient
    "ts":1700000400000,
    "payload":{
      "ciphertext":"<b64url RSA-OAEP(SHA-256) ciphertext over plaintext>", // character limit of 446
      "sender_sig_pub":"<b64url RSASSA-PSS pub of sender>",
      "content_sig":"<b64url RSASSA-PSS(SHA-256) over ts>"
    },
    "sig":"<optional client->server link sig; not required if TLS/Noise used>"
    }
  ```
Sender Client behavior:
1. Alice wants to send a message to Bob. Alice's client is responsible for encrypting the plaintext, creating a hash of the ts field and encrypting that hash with Alice's own private key to create a content_sig for Bob to verify with Alice's public key before it gets sent to Alice's local server for delivery. 

Server behavior:
1. If user_locations[sender_user_id] == "local" –> send USER_DELIVER directly to the
recipient.
  ```json
  { 
    "type":"USER_DELIVER" ,
    "from":"server_1" ,
    "to":"recipient_user_id" ,
    "ts":1700000400100,
    "payload":{
      "ciphertext":"<b64url RSA-OAEP(SHA-256)>",
      "sender":"<sender_username>",
      "sender_sig_pub":"<b64url RSASSA-PSS pub>",
      "content_sig":"<b64url RSASSA-PSS(SHA-256)>"
    },
    "sig":"<server_1 signature over payload>" // transport integrity
    }
  ```
2. Otherwise, the local server needs to find the server that the recipient is on and forward the message to the correct server using SERVER_DELIVER after signing the message with it's own private key.
  ```json
  {
    "type":"SERVER_DELIVER" ,
    "from":"sender_server_id" ,
    "to":"recipient_server_id" ,
    "ts":1700000300000,
    "payload":{
      "user_id":"recipient_user_id",
      "ciphertext":"<b64url RSA-OAEP(SHA-256)>",
      "sender":"<sender_username>",
      "sender_pub":"<b64url RSA-4096 pub>",
      "content_sig":"<b64url RSASSA-PSS(SHA-256)>"
    },
    "sig":"<server_2 signature over payload>"
  }
  ```
  - Once the recipient's local server receives this SERVER_DELIVER message, the recipient's local server has to verify the transport signature, "sig", using the sender server's public key. Once the recipient server decrypts the transport signature, it hashes the payload and compares it to the decrypted transport signature hash. Only once that's been verified does the recipient server create a USER_DELIVER message out of the payload in SERVER_DELIVER message to send to the recipient's client.

Recipient Client behavior:
Once the recipient client gets the USER_DELIVER message, it has to verify the content_sig by using the sender_user's public key to decrypt the content_sig. Once the content_sig hash is decrypted, the recipient client can hash the ts field and compare to verify the contents weren't changed. It can then decrypt the ciphertext with the recipient user's private key.

Error Handling:
If no recipient user is found, emit ERROR(USER_NOT_FOUND) upstream.

# Avoiding Loops
Servers must keep a "seen_ids" cache for server delivered frames by (ts,from,to,hash(payload)) and drop duplicates.

# Heartbeat
Servers need to keep track of the last time they received a message from all individual servers on the network.
- Send HEARTBEAT every 15s to all Servers.
- If 45s without any frame from a Server –> mark connection as dead, close, and try
reconnecting (using server_addrs ).
- On connection loss, User presence may become stale. Implementations SHOULD lazily correct
presence when deliveries fail or when new gossip is received.

# Signing and Verification
- Content signature (content_sig) covers only end-to-end fields:
  - For DM: SHA256(ts field)
- Transport signature (sig in envelope) covers payload object only (canonicalised with JSON
key sort; no whitespace variation).
- Key sources:
  - User pubkeys fetched from Server Database (or supplied in USER_HELLO , subject to directory
verification).
  - Server pubkeys exchanged at bootstrap and pinned to server_id.
  - User private key (for client decryption) is given on login and stored in session storage.

# Server's individual persistent database
Each server must have it's own persistent database to store user information required for authentication
- Model:
  ```sql
  users( 
    user_id TEXT PRIMARY KEY, -- UUID, use UUID type if supported (e.g., in PostgreSQL)
    enc_pubkey TEXT NOT NULL, -- RSA-OAEP (base64url)
    sig_pubkey TEXT NOT NULL, -- RSASSA-PSS (base64url)
    enc_privkey_store TEXT NOT NULL, -- Encrypted private encryption key blob
    sig_privkey_store TEXT NOT NULL, -- Encrypted private signature key blob
    dbl_hash_password -- Password hashed by client then by server
    username TEXT,
    version INT NOT NULL -- bumps on deco/security changes
    )
  ```

# User Registration and Login

## Registration
To create an account, a user must enter a display name and password. The client is then responsible for hashing the password with the username (HMAC-SHA256) and creating a pair of public/private keys. One pair used for encrypting/decrypting (RSA-OAEP), and one pair used for signatures (RSASSA-PSS). The plain-text password is used to create a password derived key to encrypt the private keys, using an Argon2id KDF (Key Derived Function). The Argon2id KDF uses the plaintext password, a salt, and a work factor to create a unique fixed-length key. WebCrypto then encrypts the private keys with AES-256-GCM. The client hashed password, the public keys, the private key blobs, and username is then sent to the server. The server checks if the username is in use and if not, creates a unique UUID v4, runs the client hash through an Argon2id hash, and writes the Argon2id hash, the public keys, the private key blobs, username, and UUID v4 to its persistent database. The user is now registered.

## Login
In order for a user to login, the user enters their details and clicks login. The client then sends a login request to the server which contains the username and a hash of the username and password (HMAC-SHA256) that was entered. The server looks up the username in its persistent database, if it finds a corresponding username, it compares the client hash to the Argon2id hash in the database by using Argon2id to hash the client hash with the same salt as the database hash and making sure they’re the same. If they match the server sends a nonce challenge message that includes a nonce and the AES-256-GCM encrypted private key blobs associated with the user. The client then needs to use the password that was entered to create the Argon2id password derived key to decrypt the private key blobs with AES-256-GCM (WebCrypto). The AES-256-GCM encrypted private key blobs have the Argon2id salt that needs to be extracted in order to create the same password derived key to decrypt the private key blobs. The blob is structured as a concatenation of fixed-length sections: the first 16 bytes are the Argon2id salt, the next 12 bytes are the AES-256-GCM IV, and the remaining bytes are the encrypted private key. The client extracts each section by slicing the blob at known byte offsets. Once the client has the decrypted private keys, it can sign the nonce with the private key used for signing and return it to the server. The server then verifies the signature on the nonce with the public key that’s used for signing associated with the user and if it's verified, the user is logged in. The final step is to cache both private keys as non-extractable CryptoKeys. The private encryption key for decrypting incoming messages and the private signing key for signing outgoing messages.