---
name: spotify
description: Control Spotify playback, search tracks/albums/playlists, manage queue, get now-playing info, and switch devices via the terminal. Use when the user asks to play music, pause, skip, search for a song, add to queue, or control Spotify. Requires Spotify Premium and spogo or spotify_player CLI.
triggers: spotify, play music, pause music, skip song, next track, previous track, now playing, add to queue, spotify search, play album, play playlist, music control
---

## When to Use

✅ Play/pause/skip tracks, search and play specific songs/albums/artists/playlists, get current playing status, manage queue, switch output device

❌ Download music, access Spotify on behalf of other users, anything requiring Spotify free tier (Premium required for playback control)

## Setup (one-time)

```bash
# Install spogo (preferred - simpler auth)
brew tap steipete/tap && brew install spogo
spogo auth import --browser chrome   # import from Chrome cookies
spogo status   # verify it works

# OR: install spotify_player (alternative)
brew install spotify_player
# First run opens Spotify auth in browser
```

## Playback Control

```bash
# Play / Pause
spogo play
spogo pause

# Skip
spogo next
spogo prev

# Current track info
spogo status
# → 🎵 Now Playing: Daft Punk - Get Lucky (Random Access Memories)
#   ⏱ 2:34 / 4:08  🔊 65%  🔀 Shuffle: off

# Volume
spogo volume 80        # set to 80%
spogo volume +10       # relative up
spogo volume -10       # relative down
```

## Search & Play

```bash
# Play a specific track
spogo search track "Get Lucky Daft Punk"
# Shows results; then play by index:
spogo play --track "spotify:track:2TpxZ7JUBn3uw46aR7qd6V"

# Play an artist's top tracks
spogo search artist "Arctic Monkeys"

# Play a playlist
spogo search playlist "lofi hip hop"

# Play an album
spogo search album "Random Access Memories"
```

## Queue Management

```bash
# Add current search result to queue
spogo queue add "spotify:track:<id>"

# View queue (spotify_player)
spotify_player playback queue
```

## Device Management

```bash
# List available devices (speakers, phones, computers)
spogo device list
# → 1. MacBook Pro (active)
#   2. Kitchen Speaker
#   3. iPhone

# Transfer playback to a device
spogo device set "Kitchen Speaker"
spogo device set 2   # by index
```

## Spotify Player (fallback commands)

```bash
# Status
spotify_player playback status

# Play/Pause/Skip
spotify_player playback play
spotify_player playback pause
spotify_player playback next
spotify_player playback previous

# Like current track
spotify_player like

# Search
spotify_player search "query"

# Connect to device
spotify_player connect
```

## Error Handling

| Error | Fix |
|-------|-----|
| `auth failed` | Re-run `spogo auth import --browser chrome` (cookies expired) |
| `no active device` | Open Spotify app first, play something manually, then control via CLI |
| `premium required` | Spotify playback control requires Premium |
| `command not found` | Install with `brew install spogo` |
| `rate limited` | Wait 30s; Spotify API has rate limits on rapid commands |

## Response Format

When reporting now-playing status, format it clearly:

```
🎵 Now Playing
Track:   Get Lucky
Artist:  Daft Punk
Album:   Random Access Memories
Progress: 2:34 / 4:08
Volume:  65% 🔊
Device:  MacBook Pro
```
