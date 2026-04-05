import {
  ProtocolMessageType,
  MAX_PLAINTEXT_BYTES,
  type Envelope,
  type MsgDirectPayload,
  type UserDeliverPayload,
} from "@mesh-chat/common";
import { ClientCrypto } from "../crypto/ClientCrypto.js";

/**
 * Describes a message that has been decrypted and verified from a
 * USER_DELIVER envelope.
 */
export interface ParsedMessage {
  sender: string;        // display name of the sender
  plaintext: string;     // decrypted message content
  verified: boolean;     // true if content_sig was valid
  ts: number;            // original timestamp from the envelope
}

/**
 * Builds and parses the client-side message envelopes.
 *
 * Two responsibilities:
 *
 *   BUILD (outgoing): Given a plaintext message and the recipient's
 *   public key, produces a complete MSG_DIRECT envelope ready to send.
 *   This includes encrypting the content and signing the ciphertext.
 *
 *   PARSE (incoming): Given a USER_DELIVER envelope from the server,
 *   decrypts the ciphertext and verifies the sender's content signature.
 *
 * The server NEVER decrypts. It moves ciphertext between envelopes.
 * MessageService on the sender side encrypts; MessageService on the
 * recipient side decrypts. Only the two clients can read the content.
 *
 * OOP Pattern: Static utility class — no instance state needed because
 * all inputs are passed as arguments. The caller (Phase 9 hooks) holds
 * the session state and passes what's needed.
 */
export class MessageService {
  // ── Build MSG_DIRECT ──────────────────────────────────────────────────────

  /**
   * Build a MSG_DIRECT envelope to send to a recipient.
   *
   * Steps:
   *   1. Validate plaintext length (≤ 446 bytes — RSA-OAEP limit)
   *   2. Encrypt plaintext with recipient's RSA-OAEP public key
   *   3. Sign the timestamp string with sender's RSASSA-PSS private key
   *      (produces content_sig — recipient verifies this to prove authenticity)
   *   4. Wrap everything into an Envelope
   *
   * @param senderId         - Our userId (UUID)
   * @param recipientId      - Recipient's userId (UUID)
   * @param recipientEncPub  - Recipient's RSA-OAEP public key (base64url SPKI)
   * @param senderSigPub     - Our RSASSA-PSS public key (base64url SPKI), included
   *                           so the recipient can verify our signature
   * @param plaintext        - The message text to encrypt (max 446 bytes as UTF-8)
   * @param clientCrypto     - Our ClientCrypto instance (holds private signing key)
   * @returns A complete MSG_DIRECT Envelope ready to emit via SocketService
   * @throws If plaintext exceeds 446 bytes or encryption fails
   */
  static async buildDirectMessage(
    senderId: string,
    recipientId: string,
    recipientEncPub: string,
    senderSigPub: string,
    plaintext: string,
    clientCrypto: ClientCrypto,
  ): Promise<Envelope> {
    // 1. Enforce the RSA-OAEP plaintext size limit.
    //    TextEncoder.encode() gives us the UTF-8 byte count which is what
    //    matters — some Unicode characters take more than 1 byte.
    const plaintextBytes = new TextEncoder().encode(plaintext);
    if (plaintextBytes.length > MAX_PLAINTEXT_BYTES) {
      throw new Error(
        `Message too long: ${plaintextBytes.length} bytes (max ${MAX_PLAINTEXT_BYTES})`,
      );
    }

    const ts = Date.now();

    // 2. Encrypt with the recipient's RSA-OAEP public key.
    //    Only the recipient (with their private key) can decrypt this.
    const ciphertext = await ClientCrypto.encrypt(plaintext, recipientEncPub);

    // 3. Sign the ciphertext.
    //    Per spec: content_sig covers the ciphertext field (base64url string).
    //    RSA-PSS applies SHA-256 internally, so we sign the ciphertext string
    //    and the effective coverage is PSS-Sign(SHA256(ciphertext_utf8_bytes)).
    //    The recipient verifies with: ClientCrypto.verify(ciphertext, sig, senderSigPub).
    //
    //    Why ciphertext instead of timestamp?
    //    The ciphertext is present in every envelope along the routing chain
    //    (MSG_DIRECT → SERVER_DELIVER → USER_DELIVER). The timestamp can get
    //    replaced when the server creates a new envelope for forwarding.
    //    Signing the ciphertext guarantees the encrypted content wasn't
    //    tampered with, regardless of how many hops it takes.
    const content_sig = await clientCrypto.sign(ciphertext);

    const payload: MsgDirectPayload = {
      ciphertext,
      sender_sig_pub: senderSigPub,
      content_sig,
    };

    return {
      type: ProtocolMessageType.MSG_DIRECT,
      from: senderId,
      to: recipientId,
      ts,
      payload,
    };
  }

  // ── Parse USER_DELIVER ────────────────────────────────────────────────────

  /**
   * Decrypt and verify an inbound USER_DELIVER envelope.
   *
   * Steps:
   *   1. Decrypt ciphertext using our RSA-OAEP private key
   *   2. Verify content_sig: ClientCrypto.verify(String(ts), content_sig, sender_sig_pub)
   *      — if false, the message was tampered with or the signature is invalid
   *
   * Note on `verified`: a false value means the signature check failed.
   * The decrypted plaintext is still returned so the caller can decide
   * how to display an unverified message (e.g. show a warning in the UI).
   *
   * @param envelope     - The USER_DELIVER envelope from the server
   * @param clientCrypto - Our ClientCrypto instance (holds private decryption key)
   * @returns ParsedMessage with plaintext, sender info, and verification status
   * @throws If decryption fails (wrong key, corrupted ciphertext)
   */
  static async parseDelivery(
    envelope: Envelope,
    clientCrypto: ClientCrypto,
  ): Promise<ParsedMessage> {
    const payload = envelope.payload as UserDeliverPayload;

    // 1. Decrypt the ciphertext with our private RSA-OAEP key.
    const plaintext = await clientCrypto.decrypt(payload.ciphertext);

    // 2. Verify the content signature.
    //    The sender signed the ciphertext string with their RSASSA-PSS private key.
    //    We verify with the sender's public key included in the payload.
    //    This proves the encrypted content wasn't tampered with in transit.
    const verified = await ClientCrypto.verify(
      payload.ciphertext,
      payload.content_sig,
      payload.sender_sig_pub,
    );

    return {
      sender: payload.sender,
      plaintext,
      verified,
      ts: envelope.ts,
    };
  }
}
