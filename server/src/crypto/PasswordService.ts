import argon2 from "argon2";

/**
 * Handles server-side password hashing and verification using Argon2id.
 *
 * Auth flow overview:
 *   1. Client computes: clientHash = HMAC-SHA256(username, password)
 *   2. Client sends clientHash to server (plaintext password never leaves client)
 *   3. Server computes: dblHash = Argon2id(clientHash) and stores dblHash in DB
 *   4. On login, server receives clientHash again and verifies it against dblHash
 *
 * Argon2id is a "memory-hard" algorithm -- it requires significant RAM
 * to compute each hash. This makes brute-force attacks expensive even
 * with specialized hardware (GPUs, ASICs). The `argon2` npm package
 * uses native C bindings via Node-API for performance.
 *
 * The hash output includes the salt, parameters, and hash value all
 * encoded in a single string (e.g. "$argon2id$v=19$m=65536,t=3,p=4$salt$hash").
 * This means we don't need to store the salt separately.
 */
export class PasswordService {
  /**
   * Hash a client-provided password hash using Argon2id.
   *
   * @param clientHash - The HMAC-SHA256 hash from the client (base64url string)
   * @returns An Argon2id hash string that includes the salt and parameters.
   *          This is what gets stored in the `dbl_hash_password` DB column.
   */
  async hash(clientHash: string): Promise<string> {
    // argon2.hash() generates a random salt automatically and returns
    // a formatted string containing the algorithm, version, parameters,
    // salt, and hash -- everything needed to verify later.
    //
    // Default parameters (argon2 v0.31+):
    //   memoryCost: 65536 (64 MB) -- how much RAM each hash requires
    //   timeCost: 3               -- number of iterations
    //   parallelism: 4            -- number of threads
    //   type: argon2.argon2id     -- Argon2id variant (hybrid of Argon2i + Argon2d)
    return argon2.hash(clientHash, {
      type: argon2.argon2id,
    });
  }

  /**
   * Verify a client hash against a stored Argon2id hash.
   *
   * This is used during login: the client sends their HMAC-SHA256 hash
   * and we check it against the dbl_hash_password stored in the DB.
   *
   * @param clientHash  - The HMAC-SHA256 hash the client just sent
   * @param storedHash  - The Argon2id hash from the database
   * @returns true if the client hash matches the stored hash
   */
  async verify(clientHash: string, storedHash: string): Promise<boolean> {
    // argon2.verify() extracts the salt and parameters from the stored
    // hash string, re-hashes the input with those same parameters,
    // and compares the results using a constant-time comparison
    // (to prevent timing attacks).
    return argon2.verify(storedHash, clientHash);
  }
}
