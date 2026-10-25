# drowsyVocals

## DrowsyBot Management Connection

Set `BOT_API_URL` to the bot's private API URL and set `BOT_API_SECRET` to the same long random value configured as `BOT_API_SECRET` in the bot environment. Use an HTTPS bot subdomain when the applications run on separate hosts; use `http://127.0.0.1:8080` only when they share a VPS. These values stay server-side and are never sent to browser code.

The Management > Staff Activity page receives completed voice sessions at `/api/internal/voice-sessions`. Configure the bot's `ACTIVITY_API_URL` to this application's public HTTPS URL. It uses `ACTIVITY_API_SECRET` when set, or the shared `BOT_API_SECRET` by default. The endpoint is authenticated, idempotent, and stores sessions in MongoDB.