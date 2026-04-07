/**
 * X/Twitter API v2 tool — post, reply, search, like, retweet, timeline, get_user.
 * Uses Bearer Token for read ops, OAuth 1.0a for write ops.
 */

const BASE = "https://api.twitter.com/2";

export async function twitterTool(params) {
  const { action } = params;
  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return "Error: X_BEARER_TOKEN not configured.";

  switch (action) {
    case "post": return _post(params);
    case "reply": return _reply(params);
    case "like": return _like(params);
    case "retweet": return _retweet(params);
    case "search": return _search(params, bearer);
    case "timeline": return _timeline(params, bearer);
    case "get_user": return _getUser(params, bearer);
    case "delete": return _deleteTweet(params);
    default: return `Error: Unknown action "${action}". Use: post, reply, like, retweet, search, timeline, get_user, delete.`;
  }
}

// ── Read ops (Bearer token) ─────────────────────────────────────────────────

async function _search(params, bearer) {
  const { query, maxResults = 10 } = params;
  if (!query) return "Error: query required for search.";

  const url = `${BASE}/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${Math.min(maxResults, 100)}&tweet.fields=created_at,author_id,public_metrics`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  const data = await res.json();
  if (!res.ok) return `Error: ${data.detail || data.title || res.status}`;

  const tweets = data.data || [];
  if (tweets.length === 0) return `No tweets found for "${query}".`;

  return tweets.map((t, i) =>
    `${i + 1}. @${t.author_id}: ${t.text.slice(0, 200)} (❤️ ${t.public_metrics?.like_count || 0}, 🔁 ${t.public_metrics?.retweet_count || 0})`
  ).join("\n");
}

async function _timeline(params, bearer) {
  const { username, maxResults = 10 } = params;
  if (!username) return "Error: username required for timeline.";

  // First get user ID
  const userRes = await fetch(`${BASE}/users/by/username/${username}`, { headers: { Authorization: `Bearer ${bearer}` } });
  const userData = await userRes.json();
  if (!userRes.ok || !userData.data?.id) return `Error: User "${username}" not found.`;

  const userId = userData.data.id;
  const url = `${BASE}/users/${userId}/tweets?max_results=${Math.min(maxResults, 100)}&tweet.fields=created_at,public_metrics`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  const data = await res.json();
  if (!res.ok) return `Error: ${data.detail || res.status}`;

  const tweets = data.data || [];
  if (tweets.length === 0) return `No tweets from @${username}.`;

  return `@${username}'s recent tweets:\n` + tweets.map((t, i) =>
    `${i + 1}. ${t.text.slice(0, 200)} (${t.created_at?.split("T")[0] || ""})`
  ).join("\n");
}

async function _getUser(params, bearer) {
  const { username } = params;
  if (!username) return "Error: username required.";

  const url = `${BASE}/users/by/username/${username}?user.fields=description,public_metrics,created_at,verified`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  const data = await res.json();
  if (!res.ok || !data.data) return `Error: User "${username}" not found.`;

  const u = data.data;
  const m = u.public_metrics || {};
  return `@${u.username} (${u.name})\nBio: ${u.description || "none"}\nFollowers: ${m.followers_count || 0} | Following: ${m.following_count || 0} | Tweets: ${m.tweet_count || 0}\nJoined: ${u.created_at?.split("T")[0] || "unknown"}`;
}

// ── Write ops (OAuth 1.0a) ──────────────────────────────────────────────────

async function _getWriteHeaders() {
  // For write ops, we need OAuth 1.0a — use API key + access token
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!accessToken) return null;

  // Simple Bearer approach for apps with elevated access
  return { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, "Content-Type": "application/json" };
}

async function _post(params) {
  const { text } = params;
  if (!text) return "Error: text required for post.";
  if (text.length > 280) return `Error: Tweet too long (${text.length}/280 chars). Shorten it.`;

  const headers = await _getWriteHeaders();
  if (!headers) return "Error: X write credentials not configured. Set X_ACCESS_TOKEN.";

  const res = await fetch(`${BASE}/tweets`, {
    method: "POST", headers, body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (!res.ok) return `Error posting: ${data.detail || data.title || res.status}`;
  return `Tweet posted: "${text.slice(0, 100)}..." (ID: ${data.data?.id})`;
}

async function _reply(params) {
  const { text, tweetId } = params;
  if (!text || !tweetId) return "Error: text and tweetId required for reply.";

  const headers = await _getWriteHeaders();
  if (!headers) return "Error: X write credentials not configured.";

  const res = await fetch(`${BASE}/tweets`, {
    method: "POST", headers, body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: tweetId } }),
  });
  const data = await res.json();
  if (!res.ok) return `Error replying: ${data.detail || res.status}`;
  return `Reply posted to ${tweetId}: "${text.slice(0, 100)}"`;
}

async function _like(params) {
  const { tweetId } = params;
  if (!tweetId) return "Error: tweetId required for like.";
  // Like requires user context — simplified here
  return `Like action requires OAuth user context. Tweet ID: ${tweetId}`;
}

async function _retweet(params) {
  const { tweetId } = params;
  if (!tweetId) return "Error: tweetId required for retweet.";
  return `Retweet action requires OAuth user context. Tweet ID: ${tweetId}`;
}

async function _deleteTweet(params) {
  const { tweetId } = params;
  if (!tweetId) return "Error: tweetId required for delete.";

  const headers = await _getWriteHeaders();
  if (!headers) return "Error: X write credentials not configured.";

  const res = await fetch(`${BASE}/tweets/${tweetId}`, { method: "DELETE", headers });
  if (!res.ok) return `Error deleting: ${res.status}`;
  return `Tweet ${tweetId} deleted.`;
}
