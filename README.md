# drowsyVocals

## DrowsyBot Management Connection

Set `BOT_API_URL` to the bot's private API URL and set `BOT_API_SECRET` to the same long random value configured as `BOT_API_SECRET` in the bot environment. Use an HTTPS bot subdomain when the applications run on separate hosts; use `http://127.0.0.1:8080` only when they share a VPS. These values stay server-side and are never sent to browser code.

The Management > Staff Activity page receives completed voice sessions at `/api/internal/voice-sessions`. Configure the bot's `ACTIVITY_API_URL` to this application's public HTTPS URL. It uses `ACTIVITY_API_SECRET` when set, or the shared `BOT_API_SECRET` by default. The endpoint is authenticated, idempotent, and stores sessions in MongoDB.

## Role-based page access

Gods and Developers can open **Settings > Page Access** to restrict authenticated pages to selected configured ranks. Pages remain unchanged until **Restrict** is enabled for them; an enabled rule with no selected ranks denies the page to every non-privileged role. Gods and Developers always retain access, including while using the developer preview mode.

## Management history pagination

The Changelog, Audit Log, and LOA History pages show their complete datasets in navigable pages of 10 records, with page numbers and previous/next controls.

## Seasonal themes

Gods and Developers can enable the manual Halloween or Christmas theme from **Settings > System & Security**. Only one seasonal theme is active at a time; enabling one disables the other. Visitors can disable the animated effects locally with the seasonal-effects control.