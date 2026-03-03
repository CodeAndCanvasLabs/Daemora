---
name: weather
description: Get current weather conditions, forecasts, hourly data, and rain predictions for any city, airport, or coordinates. Use when the user asks about weather, temperature, rain, wind, humidity, UV index, or travel forecasts. No API key required.
triggers: weather, temperature, rain, forecast, wind, humidity, hot, cold, snow, sunny, cloudy, storm, UV, climate, degrees
---

## When to Use

✅ Current conditions, today's forecast, multi-day forecast, rain prediction, travel weather, "will it rain?", "is it cold in [city]?"

❌ Historical weather archives, climate trends, aviation METAR/TAF, severe weather emergency alerts - use official sources for those.

## Quick Commands (no API key)

```bash
# One-line summary - best for quick answers
curl -s "wttr.in/London?format=3"
# → London: ⛅️ +18°C

# Full current conditions + 3-day forecast
curl -s "wttr.in/London"

# Specific city with spaces
curl -s "wttr.in/New+York"

# Airport code (IATA)
curl -s "wttr.in/JFK"

# Coordinates
curl -s "wttr.in/48.8566,2.3522"  # Paris lat/lon

# JSON - parse programmatically
curl -s "wttr.in/London?format=j1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
c = d['current_condition'][0]
print(f\"Temp: {c['temp_C']}°C / {c['temp_F']}°F\")
print(f\"Feels like: {c['FeelsLikeC']}°C\")
print(f\"Humidity: {c['humidity']}%\")
print(f\"Wind: {c['windspeedKmph']} km/h {c['winddir16Point']}\")
print(f\"Condition: {c['weatherDesc'][0]['value']}\")
"
```

## Forecast Queries

```bash
# Today only
curl -s "wttr.in/Tokyo?1"

# Tomorrow only
curl -s "wttr.in/Tokyo?2"

# 3-day compact view
curl -s "wttr.in/Tokyo?format=v2"

# Moon phase bonus
curl -s "wttr.in/~moon"
```

## Custom Format Codes

Build exactly the output you want:

| Code | Meaning |
|------|---------|
| `%l` | Location name |
| `%c` | Condition emoji |
| `%t` | Temperature |
| `%f` | Feels like |
| `%h` | Humidity % |
| `%w` | Wind speed + direction |
| `%p` | Precipitation (mm) |
| `%P` | Pressure (hPa) |
| `%u` | UV index |
| `%S` | Sunrise |
| `%s` | Sunset |

```bash
# Rich one-liner
curl -s "wttr.in/London?format=%l:+%c+%t+(feels+%f)+💨%w+💧%h+☔%p"
# → London: ⛅ +17°C (feels +14°C) 💨 18km/h W 💧 72% ☔ 0.0mm

# Travel check - sunrise/sunset
curl -s "wttr.in/Dubai?format=%l:+%c+%t+🌅%S+🌇%s"
```

## "Will it rain?" - Rain Probability

```bash
# Parse hourly rain chance from JSON
curl -s "wttr.in/London?format=j1" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Rain chance by period today:')
for period in d['weather'][0]['hourly']:
    t = period['time'].zfill(4)
    print(f\"  {t[:2]}:00 - {period['chanceofrain']}% rain, {period['tempC']}°C\")
"
```

## Multiple Cities Comparison

```bash
for city in "London" "New+York" "Tokyo" "Sydney"; do
  curl -s "wttr.in/${city}?format=%l:+%c+%t+💧%h" &
done
wait
```

## Error Handling

- If `wttr.in` is slow or down: fall back to `curl -s "wttr.in/${city}?format=j1"` (JSON is more reliable than HTML)
- Unknown city → wttr.in returns nearest match or error; try airport code instead
- Rate limited → wait 10s and retry once; if still failing, report the outage

## Output Format for Users

Always present weather in a clean, scannable format:

```
📍 London, UK
🌤 Partly cloudy · 17°C (feels like 14°C)
💨 Wind: 18 km/h W · 💧 Humidity: 72%
🌧 Rain chance: 10% today, 60% tomorrow
🌅 Sunrise: 06:42 · 🌇 Sunset: 20:15
```
