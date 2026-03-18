# Voice & Meetings

Daemora can make voice calls and join meetings via phone dial-in.

## Voice Calls

Make outbound calls via Twilio:

```
Call +1234567890 and say hello
```

### Requirements
- **TWILIO_ACCOUNT_SID** — Twilio account ID
- **TWILIO_AUTH_TOKEN** — Twilio auth token
- **TWILIO_PHONE_FROM** — your Twilio phone number (E.164 format)

Configure in **Settings** → **Global Channels** → **WhatsApp** section (Twilio credentials are shared).

### How It Works
1. Twilio dials the number
2. Call connects → WebSocket media stream opens
3. OpenAI Realtime API handles speech-to-text (native mu-law, server-side VAD)
4. LLM generates response
5. ElevenLabs or OpenAI TTS → mu-law 8kHz → back to Twilio
6. Full conversation is two-way

## Meeting Attendance

Join any Google Meet, Zoom, or Teams meeting via phone dial-in:

```
Join this meeting: dial-in +12405603685, PIN 717937610
```

### Requirements
- Same Twilio credentials as voice calls
- Upgraded Twilio account (trial can't call unverified numbers)
- Public URL for webhooks (auto-tunneled via cloudflared)

### How It Works
1. Agent calls `meetingAction("join", {dialIn, pin})`
2. Twilio dials the meeting's phone number
3. DTMF plays the PIN to join
4. WebSocket media stream opens
5. OpenAI Realtime STT transcribes all speech
6. Agent can speak via TTS
7. When meeting ends, full transcript returned
8. Agent writes meeting summary

### Meeting Attendant Profile
Use the `meeting-attendant` profile for full meeting lifecycle:
- Joins via phone
- Greets participants
- Listens and transcribes
- Waits for meeting to end
- Writes structured summary to file

## Voice Cloning

Clone voices via ElevenLabs:

```
meetingAction("cloneVoice", {name: "My Voice", samplePaths: ["/path/to/audio.mp3"]})
```

## Tunneling

Twilio needs a public URL for webhooks. Daemora auto-detects and starts a tunnel:

1. **DAEMORA_PUBLIC_URL** set → uses it (production)
2. **NGROK_AUTHTOKEN** set → starts ngrok tunnel
3. **cloudflared** installed → free tunnel, no signup
4. Nothing → logs instructions

The `cloudflared` npm package is bundled — auto-installs the binary on first use.
