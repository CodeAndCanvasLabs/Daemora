/**
 * Mailbox — in-memory inter-agent messaging for team coordination.
 *
 * Each Mailbox instance is scoped to a single team.
 * Messages are stored in order with read/unread tracking.
 */

export default class Mailbox {
  constructor() {
    /** @type {Array<{id: number, from: string, to: string, content: string, timestamp: number, read: boolean}>} */
    this._messages = [];
    this._nextId = 1;
  }

  /**
   * Send a message from one agent to another.
   * @param {string} from - Sender agent ID
   * @param {string} to - Recipient agent ID (or "*" for broadcast)
   * @param {string} content - Message content
   * @returns {{id: number, from: string, to: string, timestamp: number}}
   */
  send(from, to, content) {
    const msg = {
      id: this._nextId++,
      from,
      to,
      content,
      timestamp: Date.now(),
      read: false,
    };
    this._messages.push(msg);
    return { id: msg.id, from: msg.from, to: msg.to, timestamp: msg.timestamp };
  }

  /**
   * Read all unread messages for a recipient, marking them as read.
   * Includes broadcasts (to === "*") and direct messages (to === recipientId).
   * @param {string} recipientId
   * @returns {Array<{id: number, from: string, to: string, content: string, timestamp: number}>}
   */
  readFor(recipientId) {
    const unread = this._messages.filter(
      (m) => !m.read && (m.to === recipientId || m.to === "*") && m.from !== recipientId
    );
    for (const m of unread) m.read = true;
    return unread.map(({ read, ...rest }) => rest);
  }

  /**
   * Get message history with optional filters.
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {string} [opts.from] - Filter by sender
   * @param {string} [opts.to] - Filter by recipient
   * @returns {Array}
   */
  history({ limit = 50, from, to } = {}) {
    let msgs = this._messages;
    if (from) msgs = msgs.filter((m) => m.from === from);
    if (to) msgs = msgs.filter((m) => m.to === to || m.to === "*");
    return msgs.slice(-limit).map(({ read, ...rest }) => rest);
  }

  /** Total message count. */
  count() {
    return this._messages.length;
  }

  /**
   * Unread message count for a recipient.
   * @param {string} recipientId
   */
  unreadCount(recipientId) {
    return this._messages.filter(
      (m) => !m.read && (m.to === recipientId || m.to === "*") && m.from !== recipientId
    ).length;
  }
}
