/**
 * sonos - Control Sonos speakers via local network API.
 * Uses the Sonos UPNP/SOAP API or the newer Sonos Control API (cloud).
 * Local control (no cloud): sends SOAP requests to speaker IP on port 1400.
 * Requires SONOS_SPEAKER_IP or uses discovery.
 */

const SONOS_PORT = 1400;

async function sonosSoap(speakerIp, service, action, body = "") {
  const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
  const serviceMap = {
    "AVTransport": { path: "/MediaRenderer/AVTransport/Control", xmlns: "urn:schemas-upnp-org:service:AVTransport:1" },
    "RenderingControl": { path: "/MediaRenderer/RenderingControl/Control", xmlns: "urn:schemas-upnp-org:service:RenderingControl:1" },
    "ZoneGroupTopology": { path: "/ZoneGroupTopology/Control", xmlns: "urn:schemas-upnp-org:service:ZoneGroupTopology:1" },
  };

  const svc = serviceMap[service];
  if (!svc) throw new Error(`Unknown service: ${service}`);

  const envelope = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.xmlns}">${body}</u:${action}></s:Body></s:Envelope>`;

  const res = await fetchFn(`http://${speakerIp}:${SONOS_PORT}${svc.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"${svc.xmlns}#${action}"`,
    },
    body: envelope,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SOAP error ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

export async function sonos(_params) {
  const action = _params?.action;
  const paramsJson = _params?.params;
  if (!action) return "Error: action required. Valid: play, pause, stop, next, prev, volume, mute, queue, info";
  const params = paramsJson
    ? (typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson)
    : {};

  const speakerIp = params.speakerIp || process.env.SONOS_SPEAKER_IP;
  if (!speakerIp) return "Error: SONOS_SPEAKER_IP env var or speakerIp param required";

  try {
    if (action === "play") {
      await sonosSoap(speakerIp, "AVTransport", "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
      return "Playback started";
    }

    if (action === "pause") {
      await sonosSoap(speakerIp, "AVTransport", "Pause", "<InstanceID>0</InstanceID>");
      return "Playback paused";
    }

    if (action === "stop") {
      await sonosSoap(speakerIp, "AVTransport", "Stop", "<InstanceID>0</InstanceID>");
      return "Playback stopped";
    }

    if (action === "next") {
      await sonosSoap(speakerIp, "AVTransport", "Next", "<InstanceID>0</InstanceID>");
      return "Skipped to next track";
    }

    if (action === "prev" || action === "previous") {
      await sonosSoap(speakerIp, "AVTransport", "Previous", "<InstanceID>0</InstanceID>");
      return "Went to previous track";
    }

    if (action === "volume") {
      const { level } = params;
      if (level === undefined) {
        // Get current volume
        const xml = await sonosSoap(speakerIp, "RenderingControl", "GetVolume",
          "<InstanceID>0</InstanceID><Channel>Master</Channel>");
        const match = xml.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/);
        return `Current volume: ${match?.[1] || "unknown"}`;
      }
      const vol = Math.max(0, Math.min(100, Math.round(level)));
      await sonosSoap(speakerIp, "RenderingControl", "SetVolume",
        `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${vol}</DesiredVolume>`);
      return `Volume set to ${vol}`;
    }

    if (action === "mute") {
      const muted = params.muted !== false; // default true (mute)
      await sonosSoap(speakerIp, "RenderingControl", "SetMute",
        `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredMute>${muted ? "1" : "0"}</DesiredMute>`);
      return muted ? "Speaker muted" : "Speaker unmuted";
    }

    if (action === "info") {
      const xml = await sonosSoap(speakerIp, "AVTransport", "GetTransportInfo", "<InstanceID>0</InstanceID>");
      const stateMatch = xml.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/);

      const posXml = await sonosSoap(speakerIp, "AVTransport", "GetPositionInfo", "<InstanceID>0</InstanceID>");
      const trackMatch = posXml.match(/<TrackURI>([^<]*)<\/TrackURI>/);
      const metaMatch = posXml.match(/<TrackMetaData>([^<]*)<\/TrackMetaData>/);

      const lines = [
        `State: ${stateMatch?.[1] || "unknown"}`,
        trackMatch?.[1] ? `Track: ${decodeURIComponent(trackMatch[1]).split("/").pop()}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    }

    if (action === "queue") {
      const { uri, title } = params;
      if (!uri) return "Error: uri required to queue a track (e.g. spotify URI or HTTP stream URL)";
      await sonosSoap(speakerIp, "AVTransport", "SetAVTransportURI",
        `<InstanceID>0</InstanceID><CurrentURI>${uri}</CurrentURI><CurrentURIMetaData>${title ? `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1" restricted="true"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">${title}</dc:title></item></DIDL-Lite>` : ""}</CurrentURIMetaData>`);
      return `Queued: ${title || uri}`;
    }

  } catch (err) {
    return `Sonos error: ${err.message}`;
  }

  return `Unknown action: "${action}". Valid: play, pause, stop, next, prev, volume, mute, queue, info`;
}

export const sonosDescription =
  `sonos(action: string, paramsJson?: object) - Control Sonos speakers via local network.
  action: "play" | "pause" | "stop" | "next" | "prev" | "volume" | "mute" | "queue" | "info"
  play/pause/stop/next/prev: { speakerIp? }
  volume: { level?: 0-100, speakerIp? } (omit level to get current volume)
  mute: { muted?: true, speakerIp? }
  queue: { uri: "spotify:track:...|http://...", title?, speakerIp? }
  info: { speakerIp? } → playback state + current track
  Env var: SONOS_SPEAKER_IP
  Examples:
    sonos("play")
    sonos("volume", {"level":40})
    sonos("info")
    sonos("queue", {"uri":"x-sonosapi-stream:s95362?sid=254","title":"Radio"})`;
