import { BaseChannel } from "./BaseChannel.js";
import taskQueue from "../core/TaskQueue.js";

/**
 * Nostr Channel - receives and responds to Nostr direct messages (NIP-04 encrypted DMs).
 * Connects to one or more Nostr relays via WebSocket.
 *
 * Setup:
 * 1. Generate a Nostr keypair: `node -e "const {generateSecretKey,getPublicKey}=require('@noble/secp256k1');const sk=generateSecretKey();console.log('SK:',Buffer.from(sk).toString('hex'));console.log('PK:',getPublicKey(sk))"`
 * 2. Set env: NOSTR_PRIVATE_KEY (hex), NOSTR_RELAYS (comma-separated relay URLs)
 *
 * Config:
 *   privateKey - Bot's Nostr private key (hex string)
 *   relays     - Array of relay URLs (wss://relay.damus.io, etc.)
 *   allowlist  - Optional array of allowed public keys (npub or hex)
 *   model      - Optional model override
 *
 * Implements NIP-04 encrypted DMs (kind 4).
 */
export class NostrChannel extends BaseChannel {
  constructor(config) {
    super("nostr", config);
    this.relayConnections = [];
    this.privateKey = null;
    this.publicKey = null;
  }

  async start() {
    if (!this.config.privateKey) {
      console.log("[Channel:Nostr] Skipped - missing NOSTR_PRIVATE_KEY");
      return;
    }

    const relays = this.config.relays || ["wss://relay.damus.io", "wss://nos.lol"];

    try {
      // Use @noble/curves for crypto (NIP-04 requires secp256k1)
      const { secp256k1, schnorr } = await import("@noble/curves/secp256k1").catch(async () => {
        throw new Error("@noble/curves package not found. Run: npm install @noble/curves");
      });

      const skBytes = Buffer.from(this.config.privateKey, "hex");
      this.privateKey = skBytes;
      this.publicKey = Buffer.from(secp256k1.getPublicKey(skBytes, true)).toString("hex").slice(2); // remove 02/03 prefix

      const { WebSocket } = await import("ws");

      for (const relayUrl of relays) {
        this._connectRelay(relayUrl, WebSocket, secp256k1);
      }

      this.running = true;
      console.log(`[Channel:Nostr] Listening on ${relays.length} relay(s). pubkey: ${this.publicKey.slice(0, 16)}...`);
    } catch (err) {
      console.log(`[Channel:Nostr] Failed to start: ${err.message}`);
    }
  }

  _connectRelay(relayUrl, WebSocket, secp256k1) {
    const ws = new WebSocket(relayUrl);

    ws.on("open", () => {
      // Subscribe to DMs (kind 4) where we are the recipient (#p tag)
      const subId = "dm-sub-" + Date.now();
      ws.send(JSON.stringify([
        "REQ",
        subId,
        { kinds: [4], "#p": [this.publicKey], since: Math.floor(Date.now() / 1000) - 60 },
      ]));
      console.log(`[Channel:Nostr] Subscribed on ${relayUrl}`);
    });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg[0] !== "EVENT") return;

      const event = msg[2];
      if (event.kind !== 4) return;
      if (event.pubkey === this.publicKey) return; // ignore our own

      const senderPubkey = event.pubkey;
      if (!this.isAllowed(senderPubkey)) return;

      // Decrypt NIP-04 DM
      let input;
      try {
        const { nip04Decrypt } = this._nip04(secp256k1);
        input = await nip04Decrypt(this.privateKey, senderPubkey, event.content);
      } catch { return; }

      if (!input?.trim()) return;

      const channelMeta = { senderPubkey, relayUrl, eventId: event.id };

      const task = await taskQueue.enqueue({
        input: input.trim(),
        channel: "nostr",
        sessionId: this.getSessionId(senderPubkey),
        channelMeta,
        model: this.getModel(),
      });

      const result = await taskQueue.waitForResult(task.id);
      if (!this.isTaskMerged(result)) {
        await this.sendReply(channelMeta, result.result || "(no response)");
      }
    });

    ws.on("error", (err) => console.log(`[Channel:Nostr] ${relayUrl} error: ${err.message}`));
    this.relayConnections.push(ws);
  }

  _nip04(secp256k1) {
    const nip04Decrypt = async (privKey, pubKeyHex, encryptedContent) => {
      const [ciphertext, ivB64] = encryptedContent.split("?iv=");
      const sharedPoint = secp256k1.getSharedSecret(privKey, "02" + pubKeyHex);
      const sharedX = sharedPoint.slice(1, 33);
      const { subtle } = globalThis.crypto;
      const key = await subtle.importKey("raw", sharedX, { name: "AES-CBC" }, false, ["decrypt"]);
      const iv = Buffer.from(ivB64, "base64");
      const data = Buffer.from(ciphertext, "base64");
      const decrypted = await subtle.decrypt({ name: "AES-CBC", iv }, key, data);
      return new TextDecoder().decode(decrypted);
    };

    const nip04Encrypt = async (privKey, pubKeyHex, plaintext) => {
      const sharedPoint = secp256k1.getSharedSecret(privKey, "02" + pubKeyHex);
      const sharedX = sharedPoint.slice(1, 33);
      const { subtle } = globalThis.crypto;
      const key = await subtle.importKey("raw", sharedX, { name: "AES-CBC" }, false, ["encrypt"]);
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const data = new TextEncoder().encode(plaintext);
      const encrypted = await subtle.encrypt({ name: "AES-CBC", iv }, key, data);
      return Buffer.from(encrypted).toString("base64") + "?iv=" + Buffer.from(iv).toString("base64");
    };

    return { nip04Decrypt, nip04Encrypt };
  }

  async stop() {
    for (const ws of this.relayConnections) {
      ws.close();
    }
    this.relayConnections = [];
    this.running = false;
    console.log("[Channel:Nostr] Stopped");
  }

  async sendReply(channelMeta, text) {
    if (!channelMeta?.senderPubkey || !this.relayConnections.length) return;

    const { secp256k1 } = await import("@noble/curves/secp256k1").catch(() => null);
    if (!secp256k1) return;

    const { nip04Encrypt } = this._nip04(secp256k1);
    const { schnorr } = await import("@noble/curves/secp256k1");

    const content = await nip04Encrypt(this.privateKey, channelMeta.senderPubkey, text);
    const now = Math.floor(Date.now() / 1000);

    const eventData = [0, this.publicKey, now, 4, [["p", channelMeta.senderPubkey]], content];
    const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(eventData)));
    const id = Buffer.from(hash).toString("hex");
    const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), this.privateKey)).toString("hex");

    const signedEvent = { id, pubkey: this.publicKey, created_at: now, kind: 4, tags: [["p", channelMeta.senderPubkey]], content, sig };

    for (const ws of this.relayConnections) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(["EVENT", signedEvent]));
      }
    }
  }
}
