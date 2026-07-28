Secrets migration guide (Firebase Functions / Secret Manager)

Goal: Move any runtime secrets and configuration from functions.config()/Runtime Config into Secret Manager (recommended) or Functions params. 2nd‑gen functions (Node 16/18/24) should read secrets from process.env which Firebase mounts from Secret Manager when declared on function exports.

Steps (interactive, Cloud Shell):

1) Export existing functions.config (optional, for inspection):
   firebase functions:config:get --project=YOUR_PROJECT > legacy-config.json

2) Create secrets in Secret Manager (recommended):
   firebase functions:secrets:set TWILIO_SID --project=YOUR_PROJECT
   firebase functions:secrets:set TWILIO_TOKEN --project=YOUR_PROJECT
   firebase functions:secrets:set TWILIO_FROM --project=YOUR_PROJECT
   # You will be prompted to paste each secret value.

3) Declare secrets on the functions that need them (example in code):
   // For HTTP
   exports.simulateLostReport = onRequest({ secrets: ['TWILIO_SID','TWILIO_TOKEN','TWILIO_FROM'] }, async (req, res) => { ... });

   // For Firestore trigger
   exports.onLostReportCreated = onDocumentCreated('lostReports/{reportId}', { secrets: ['TWILIO_SID','TWILIO_TOKEN','TWILIO_FROM'] }, async (event) => { ... });

   When declared, Firebase will mount the secrets into the Cloud Run runtime as environment variables (process.env.TWILIO_SID etc.) and grant the functions' service account accessor permission.

4) Update code to read secrets from process.env (or Secret Manager client if you need rotation):
   const sid = process.env.TWILIO_SID; // already available at runtime

   Avoid using functions.config() — it's deprecated and will be removed in 2027.

5) Redeploy your functions:
   npx -y firebase-tools@latest deploy --only functions --project=YOUR_PROJECT

6) Verify access and runtime:
   - After deploy, Firebase grants the functions service account access to secrets. Check logs for messages like: "ensuring <service-account> access to secret ..."
   - Call your function and check logs for runtime initialization messages.

7) (Optional) Remove legacy Runtime Config entries after migration:
   firebase functions:config:unset twilio --project=YOUR_PROJECT

Notes and best practices:
- Use Secret Manager for production secrets. Use the built-in functions.secrets API (Firebase CLI) to create secrets and declare them on functions.
- For more advanced rotation or access patterns, use the Secret Manager API directly and the Google Cloud client libraries.
- Keep secrets out of source code, logs, and repo history.

Links:
- https://firebase.google.com/docs/functions/config-env#migrate-config
- https://firebase.google.com/docs/functions/secret-manager
- https://cloud.google.com/secret-manager/docs

If you want, I can: 
- Migrate any remaining keys I find in code to secrets and declare them on functions, 
- or produce a one-line script to export existing functions.config entries and set them as secrets automatically.
