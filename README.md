# drowsyVocals

## DrowsyBot Management Connection

Set `BOT_API_URL` to the bot's private API URL and set `BOT_API_SECRET` to the same long random value configured as `BOT_API_SECRET` in the bot environment. Use an HTTPS bot subdomain when the applications run on separate hosts; use `http://127.0.0.1:8080` only when they share a VPS. These values stay server-side and are never sent to browser code.

The Management > Staff Activity page receives completed voice sessions at `/api/internal/voice-sessions`. Configure the bot's `ACTIVITY_API_URL` to this application's public HTTPS URL. It uses `ACTIVITY_API_SECRET` when set, or the shared `BOT_API_SECRET` by default. The endpoint is authenticated, idempotent, and stores sessions in MongoDB.

Staff Activity reports completed sessions over 7-, 14-, 30-, or 90-day windows using Eastern calendar days. Live presence is shown separately from completed-session totals. The page shows the timestamp and batch size of the latest session report received; missing reports cannot be reconstructed by the portal, so verify the bot's `ACTIVITY_API_URL` and shared API secret if history is absent.

## Discord forgot-password recovery

The login screen now supports **Forgot your password?** and sends reset links through DrowsyBot DMs. Configure these variables in the portal environment:

- `BOT_PASSWORD_RESET_DM_PATH` (default: `/actions/direct-message`) – bot API endpoint used to deliver DMs
- `PASSWORD_RESET_TOKEN_TTL_MINUTES` (default: `20`) – validity period for reset tokens (clamped to 5–120)
- `PASSWORD_RESET_URL_BASE` (optional) – public base URL for reset links when reverse proxy host detection is not reliable

Reset tokens are single-use, short-lived, and existing sessions for the account are revoked after a successful reset.
Gods and Developers can run a one-click DM delivery probe from **Bot > Bot Core Configuration** to verify the reset DM endpoint wiring.
When the configured DM endpoint returns `404`/`405`, the probe automatically retries common fallback routes (`/actions/direct-message`, `/actions/dm`, `/admin/api/direct-message`, `/admin/api/dm`) and reports the final route/status in the portal flash message and server logs.
The same bot DM path is also used for LOA lifecycle reminders (start/end) and promotion/demotion notifications sent to affected staff accounts.
Staff DMs now also cover account security updates (password changed, suspension/unsuspension, and new login IP), strike added/removed events, strike appeal decisions, and event assignment updates/cancellations plus configurable pre-event reminders.
Use `LOA_PENDING_REMINDER_DAYS` (default `3`) to control when pending LOA requests trigger a reminder DM, and `EVENT_ASSIGNMENT_REMINDER_HOURS` (default `24`) for pre-event assignment reminders.

## Role-based page access

Gods and Developers can open **Settings > Page Access** to restrict authenticated pages to selected configured ranks or archive pages that are temporarily out of use. Archived pages are hidden from navigation and direct requests for regular users; Gods and Developers retain access so they can restore a page later. Archiving does not delete page data.

## Management history pagination

The Changelog, Audit Log, and LOA History pages show their complete datasets in navigable pages of 10 records, with page numbers and previous/next controls.

Deleted staff accounts retain their strike history in the deleted-user record. If the same Discord account is added back to the roster, its previous strikes are restored automatically.

## Event planning toolkit

Managers can open **Event Toolkit** from a scheduled event to add preparation tasks, assign them to staff, set due dates, and save or reuse checklist templates. Assigned staff can open the event toolkit from the event listing and update only their own task completion; managers can edit all tasks and record close-out notes. Templates copy task titles only, so assignees, due dates, and completion state are set separately for each event.

## Seasonal themes

Gods and Developers can enable the manual Halloween or Christmas theme from **Settings > System & Security**. Only one seasonal theme is active at a time; enabling one disables the other. Visitors can disable the animated effects locally with the seasonal-effects control.

## Privacy baseline

The public privacy notice is available at `/privacy`. Signed-in users can submit access, correction, erasure, restriction, portability, objection, or other privacy requests at `/privacy-requests`; Gods and Developers can review requests and record a response there. Requests are reviewed manually and are not automatically fulfilled by submission.

For access requests, Gods and Developers can use **Complete with data copy** after verifying the requester and reviewing whether the records are appropriate to share. This creates a JSON snapshot of the account and directly linked records, excludes password hashes and credentials, and makes it available only to the requester through the authenticated portal for 12 months. Requesters can download both the original JSON and a paginated, formatted PDF. Uploaded profile images and check-in attachments are provided through separate authenticated download links in the export. An in-app notification tells the requester the copy is ready; sensitive data is not sent through Discord DMs.

The automatic export does not associate legacy/external applications that lack the account's exact Discord ID, omits application manager notes, and includes only action and date (not detail text) for audit activity. Requests that need a broader review still need staff handling.

Application intake enforces a minimum age of 13, including submissions received through the external application webhook. Scheduled database cleanup runs at connection and daily for the record categories and periods described in the privacy notice. Completed check-in attachments are removed from both MongoDB and the local upload directory when their check-in records expire.

Before relying on this as a compliance program, have qualified privacy counsel review applicable legal bases, children’s privacy requirements, international data transfers, and retention. In particular:

- Configure and verify the Hostinger backup rotation; application cleanup does not erase backup copies. The current operational target is 90 days.
- Confirm transfer safeguards and provider terms for Discord and Google integrations.
- Review retention for accepted applications and other record types not covered by the automated cleanup.

This technical baseline is not a legal compliance certification.

## Terms of Service

The public Terms of Service is available at `/terms`. Users must explicitly accept the current version after signing in before using the portal. The native API login response indicates whether acceptance is needed, and authenticated API clients can record acceptance through `/api/v1/auth/accept-terms` with `{ "accepted": true }`. Acceptance is recorded on the user's account with the terms version and timestamp; update `TERMS_VERSION` in `server.js` whenever revised terms require users to accept again.

The terms text is an operational draft, not legal advice or a guarantee of enforceability. Have qualified counsel review it for the operator's legal identity, applicable jurisdictions, consumer rights, moderation procedures, and any liability or dispute provisions before relying on it.