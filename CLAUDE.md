# furry-friend-finder

A Firebase project for alerting people when a pet is reported lost (push notifications via Firebase Cloud Messaging, SMS via Twilio). It is an early prototype: the backend logic exists, but `public/index.html` is still the default Firebase Hosting welcome page and there is no real app UI yet.

Firebase project ID: `furry-friend-finder-9afd1` (see `.firebaserc`).

## Working with Tim

Tim is a Business Analyst Manager, not a developer. When working in this repo:
- Explain what you are doing and why in plain language; define jargon the first time you use it.
- Prefer small, reviewable changes. Work on a branch and open a pull request. Never push directly to `main`.
- Ask before anything that touches production, billing, or secrets (deploys, enabling services, Twilio, Secret Manager).
- Say clearly what you tested and what you could not test.

## Layout

- `functions/` — Cloud Functions (Node 24, `firebase-functions` v2). `index.js` has the lost-report notification trigger.
- `firestore.rules`, `storage.rules`, `firestore.indexes.json` — database and file-storage security rules and indexes.
- `public/` — Firebase Hosting site (currently the placeholder page).
- `.github/workflows/` — Firebase Hosting deploy workflows; merging to `main` triggers a live Hosting deploy. `.github/dependabot.yml` keeps `functions/` dependencies updated.
- `.agents/skills/` and `skills-lock.json` — vendored Firebase agent skills (reference material for Firebase work).
- `functions/SECRET_MIGRATION.md` — how Twilio secrets are stored (Secret Manager).

## Commands

Run from the repo root unless noted:
- Install function dependencies: `cd functions && npm ci`
- Run locally: `firebase emulators:start`
- Deploy (only after Tim approves): `firebase deploy --only functions`, `--only firestore:rules`, `--only storage`, `--only hosting`

## Rules for this repo

- Never commit secrets, API keys, service-account files, or real phone numbers/emails. Twilio credentials (`TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`) come from Secret Manager only.
- Every HTTPS function must require authentication unless Tim explicitly approves a public one. Test and sample-data helpers must only run in the emulator (`process.env.FUNCTIONS_EMULATOR === 'true'`).
- Never log personal data (phone numbers, emails, push tokens).
- Any change to `firestore.rules` or `storage.rules` must be tested in the Firebase emulator before it is merged, and must keep these properties: users can read only their own profile; owner fields (`ownerUid`, `reporterUid`, `userUid`) cannot be changed after creation.
- Follow the Firebase skills in `.agents/skills/` when working on Firestore, Auth, Hosting or security rules.

## Known gaps (see open pull requests and issues)

- Lost-report notifications go to every opted-in subscriber (no location filtering yet) and any signed-in user can create a lost report, which triggers them.
- ESLint is disabled (`npm run lint` is a no-op) and there are no automated tests.
