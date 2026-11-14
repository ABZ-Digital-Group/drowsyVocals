# drowsyVocals

## DrowsyBot Management Connection

Set `BOT_API_URL` to the bot's private API URL and set `BOT_API_SECRET` to the same long random value configured as `BOT_API_SECRET` in the bot environment. Use an HTTPS bot subdomain when the applications run on separate hosts; use `http://127.0.0.1:8080` only when they share a VPS. These values stay server-side and are never sent to browser code.

The Management > Staff Activity page receives completed voice sessions at `/api/internal/voice-sessions`. Configure the bot's `ACTIVITY_API_URL` to this application's public HTTPS URL. It uses `ACTIVITY_API_SECRET` when set, or the shared `BOT_API_SECRET` by default. The endpoint is authenticated, idempotent, and stores sessions in MongoDB.

## Discord forgot-password recovery

The login screen now supports **Forgot your password?** and sends reset links through DrowsyBot DMs. Configure these variables in the portal environment:

- `BOT_PASSWORD_RESET_DM_PATH` (default: `/actions/direct-message`) – bot API endpoint used to deliver DMs
- `PASSWORD_RESET_TOKEN_TTL_MINUTES` (default: `20`) – validity period for reset tokens (clamped to 5–120)
- `PASSWORD_RESET_URL_BASE` (optional) – public base URL for reset links when reverse proxy host detection is not reliable

Reset tokens are single-use, short-lived, and existing sessions for the account are revoked after a successful reset.
Gods and Developers can run a one-click DM delivery probe from **Bot > Bot Core Configuration** to verify the reset DM endpoint wiring.
The same bot DM path is also used for LOA lifecycle reminders (start/end) and promotion/demotion notifications sent to affected staff accounts.
Staff DMs now also cover account security updates (password changed, suspension/unsuspension, and new login IP), strike added/removed events, strike appeal decisions, and event assignment updates/cancellations plus configurable pre-event reminders.
Use `LOA_PENDING_REMINDER_DAYS` (default `3`) to control when pending LOA requests trigger a reminder DM, and `EVENT_ASSIGNMENT_REMINDER_HOURS` (default `24`) for pre-event assignment reminders.

## Role-based page access

Gods and Developers can open **Settings > Page Access** to restrict authenticated pages to selected configured ranks. Pages remain unchanged until **Restrict** is enabled for them; an enabled rule with no selected ranks denies the page to every non-privileged role. Gods and Developers always retain access, including while using the developer preview mode.

## Management history pagination

The Changelog, Audit Log, and LOA History pages show their complete datasets in navigable pages of 10 records, with page numbers and previous/next controls.

Deleted staff accounts retain their strike history in the deleted-user record. If the same Discord account is added back to the roster, its previous strikes are restored automatically.

## Seasonal themes

Gods and Developers can enable the manual Halloween or Christmas theme from **Settings > System & Security**. Only one seasonal theme is active at a time; enabling one disables the other. Visitors can disable the animated effects locally with the seasonal-effects control.