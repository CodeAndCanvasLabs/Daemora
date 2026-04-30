/**
 * LiveKit token generation using the official livekit-server-sdk.
 *
 * Generates access tokens for:
 *   - Browser clients (join room, publish mic, subscribe to agent audio)
 *   - Voice agent workers (join room, publish audio, subscribe to user)
 */

import { AccessToken } from "livekit-server-sdk";

export interface LiveKitTokenOpts {
  identity: string;
  room: string;
  apiKey: string;
  apiSecret: string;
  ttlSeconds?: number;
}

export async function generateLiveKitToken(opts: LiveKitTokenOpts): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: opts.identity,
    ttl: opts.ttlSeconds ?? 6 * 60 * 60,
  });

  at.addGrant({
    room: opts.room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });

  return await at.toJwt();
}

/**
 * Generate a token for the voice agent worker.
 * Has room admin permissions for managing tracks.
 */
export async function generateAgentToken(opts: {
  apiKey: string;
  apiSecret: string;
  room: string;
}): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, {
    identity: "daemora-agent",
    ttl: 24 * 60 * 60,
  });

  at.addGrant({
    room: opts.room,
    roomJoin: true,
    roomAdmin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });

  return await at.toJwt();
}
