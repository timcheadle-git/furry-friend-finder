const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

// Initialize Twilio client from environment variables (Secret Manager/params mount into process.env)
// Do NOT rely on firebase functions.config() — that legacy Runtime Config is deprecated and will be removed.
let twilioClient = null;
let TWILIO_SID = process.env.TWILIO_SID || null;
let TWILIO_TOKEN = process.env.TWILIO_TOKEN || null;
let TWILIO_FROM = process.env.TWILIO_FROM || null;

if (!TWILIO_SID || !TWILIO_TOKEN) {
  console.log('Twilio credentials not found in process.env. Ensure secrets are set via Secret Manager and functions are declared with the secret names.');
}
// Lazy ensure Twilio client using env-mounted secrets (Secret Manager / params)
async function ensureTwilioClient() {
  if (twilioClient) return;
  const sid = process.env.TWILIO_SID || TWILIO_SID;
  const token = process.env.TWILIO_TOKEN || TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM || TWILIO_FROM;
  TWILIO_SID = sid || TWILIO_SID;
  TWILIO_TOKEN = token || TWILIO_TOKEN;
  TWILIO_FROM = from || TWILIO_FROM;
  if (TWILIO_SID && TWILIO_TOKEN) {
    try {
      const twilio = require('twilio');
      twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
      console.log('Twilio client initialized at runtime (env)');
    } catch (e) {
      console.warn('Twilio client failed to initialize at runtime', e);
    }
  } else {
    console.log('Twilio secrets not available in process.env');
  }
}
// Log whether Twilio is configured at module load (do not print secrets)
console.log('Twilio configured at module load (client present?):', !!twilioClient);

// Initialize messaging client that supports different admin SDK versions
let messagingClient = null;
try {
  // Prefer the dedicated messaging module
  const adminMessaging = require('firebase-admin/messaging');
  if (adminMessaging && adminMessaging.getMessaging) {
    messagingClient = adminMessaging.getMessaging();
  }
} catch (e) {
  // Fallbacks: admin.messaging may be a function or an object depending on SDK
  try {
    if (typeof admin.messaging === 'function') messagingClient = admin.messaging();
    else if (admin.messaging && typeof admin.messaging.sendMulticast === 'function') messagingClient = admin.messaging;
  } catch (err) {
    console.warn('Messaging client not available', err);
  }
}

// Helper: send FCM in compatible batches (supports sendMulticast, sendAll, or per-token send)
async function sendFcmTokens(tokens, payload) {
  if (!tokens || tokens.length === 0) return;
  if (!messagingClient) {
    console.warn('Messaging client not available');
    return;
  }
  const batchSize = 500; // FCM limit
  for (let i = 0; i < tokens.length; i += batchSize) {
    const slice = tokens.slice(i, i + batchSize);
    if (typeof messagingClient.sendMulticast === 'function') {
      // Modern API: sendMulticast
      await messagingClient.sendMulticast({ tokens: slice, ...payload });
    } else if (typeof messagingClient.sendAll === 'function') {
      // Alternative API: sendAll expects an array of messages
      const messages = slice.map((t) => ({ token: t, notification: payload.notification, data: payload.data }));
      await messagingClient.sendAll(messages);
    } else if (typeof messagingClient.send === 'function') {
      // Fallback: send each message individually (slower)
      await Promise.all(slice.map((t) => messagingClient.send({ token: t, notification: payload.notification, data: payload.data }).catch((err) => {
        console.error('FCM send failed', err);
      })));
    } else {
      console.warn('Messaging client does not support sendMulticast/sendAll/send');
    }
  }
}

// Shared logic to process a report
async function processLostReport(report, reportId) {
  // Support both old and new admin SDK patterns for Firestore
  let db;
  try {
    db = admin.firestore();
  } catch (e) {
    const { getFirestore } = require('firebase-admin/firestore');
    db = getFirestore();
  }

  // Prototype: notify all subscriptions where optIn==true
  const subsSnap = await db.collection('subscriptions').where('optIn', '==', true).get();
  const fcmTokens = [];
  const smsRecipients = [];

  for (const subDoc of subsSnap.docs) {
    const sub = subDoc.data();
    if (!sub.userUid) continue;
    const userDoc = await db.collection('users').doc(sub.userUid).get();
    if (!userDoc.exists) continue;
    const user = userDoc.data();
    if (Array.isArray(user.fcmTokens)) fcmTokens.push(...user.fcmTokens);
    if (user.phone && sub.smsOptIn) smsRecipients.push(user.phone);
  }

  const location = report.lastSeenLocation && (report.lastSeenLocation.address || `${report.lastSeenLocation.latitude},${report.lastSeenLocation.longitude}`) || 'unknown location';
  const messageText = `Lost pet reported: ${report.petId || 'unknown pet'}. Last seen: ${location}.`;

  // Send push notifications
  if (fcmTokens.length) {
    const payload = {
      notification: {
        title: 'Lost pet nearby',
        body: messageText
      },
      data: {
        lostReportId: reportId || ''
      }
    };
    await sendFcmTokens(fcmTokens, payload);
  }

  // Send SMS via Twilio if configured
  if (smsRecipients.length) {
    console.log('SMS recipients:', smsRecipients);
    // Ensure Twilio client is initialized using secrets mounted in process.env
    await ensureTwilioClient();
    const from = TWILIO_FROM || 'Twilio';
    if (!twilioClient) {
      console.warn('Skipping SMS sends: Twilio client not configured');
    } else {
      for (const to of smsRecipients) {
        try {
          const resp = await twilioClient.messages.create({ body: messageText, from, to });
          // Twilio response includes sid and status
          console.log('Twilio send response', { to, sid: resp && resp.sid, status: resp && resp.status });
        } catch (err) {
          // Twilio error objects may contain status, code, message
          console.error('Twilio send failed', {
            to,
            message: err && err.message,
            code: err && err.code,
            more: err && (err.more || err)
          });
        }
      }
    }
  }

  // Record an alert document (server-generated)
  // Determine FieldValue.serverTimestamp() for both admin SDK styles
  let FieldValue;
  try {
    FieldValue = admin.firestore.FieldValue;
  } catch (e) {
    FieldValue = require('firebase-admin/firestore').FieldValue;
  }
  await db.collection('alerts').add({
    lostReportId: reportId || null,
    sentToCount: fcmTokens.length + smsRecipients.length,
    channels: twilioClient ? ['push', 'sms'] : ['push'],
    sentAt: new Date().toISOString(),
    status: 'sent'
  });

  return { sentTo: fcmTokens.length + smsRecipients.length };
}

// Trigger: on new lost report, notify subscribers (prototype: no geo-filtering)
exports.onLostReportCreated = onDocumentCreated('lostReports/{reportId}', { secrets: ['TWILIO_SID','TWILIO_TOKEN','TWILIO_FROM'] }, async (event) => {
  const snap = event.data; // DocumentSnapshot
  const report = snap.data();
  const reportId = snap.id;
  await processLostReport(report, reportId);
});

// A simple HTTPS test endpoint
exports.testNotify = onRequest((req, res) => {
  res.send('Notification prototype is deployed');
});

// HTTP endpoint to simulate a lost report (for emulator testing)
exports.simulateLostReport = onRequest({ secrets: ['TWILIO_SID','TWILIO_TOKEN','TWILIO_FROM'] }, async (req, res) => {
  const sample = {
    petId: 'pet-test-1',
    reporterUid: 'user-test-1',
    status: 'lost',
    lastSeenLocation: { latitude: 40.12345, longitude: -74.12345, address: 'Test Park' },
    reportedAt: new Date().toISOString()
  };
  const report = req.body && Object.keys(req.body).length ? req.body : sample;
  try {
    // Build recipients similarly to processLostReport so we can debug who's targeted
    const db = (() => { try { return admin.firestore(); } catch (e) { return require('firebase-admin/firestore').getFirestore(); }})();
    const subsSnap = await db.collection('subscriptions').where('optIn', '==', true).get();
    const fcmTokens = [];
    const smsRecipients = [];
    for (const subDoc of subsSnap.docs) {
      const sub = subDoc.data();
      if (!sub.userUid) continue;
      const userDoc = await db.collection('users').doc(sub.userUid).get();
      if (!userDoc.exists) continue;
      const user = userDoc.data();
      if (Array.isArray(user.fcmTokens)) fcmTokens.push(...user.fcmTokens);
      if (user.phone && sub.smsOptIn) smsRecipients.push(user.phone);
    }

    // If debug query param present, return recipients without sending
    const debug = (req.query && req.query.debug) || (req.body && req.body.debug);
    if (debug) {
      console.log('simulateLostReport debug recipients', { fcmTokens, smsRecipients });
      return res.json({ ok: true, recipients: { fcmTokens, smsRecipients } });
    }

    const result = await processLostReport(report, 'simulated-' + Date.now());
    res.json({ ok: true, result });
  } catch (err) {
    console.error('simulateLostReport error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin-only helper to create sample users/subscriptions using Admin SDK (emulator testing)
exports.createSampleData = onRequest(async (req, res) => {
  try {
    const db = (() => { try { return admin.firestore(); } catch (e) { return require('firebase-admin/firestore').getFirestore(); }})();
    const now = new Date().toISOString();
    // Do not insert placeholder FCM tokens in sample data to avoid invalid-token errors during testing.
    await db.collection('users').doc('user-alice').set({ name: 'Alice Tester', email: 'alice@example.com', phone: '+15550001111', fcmTokens: [], createdAt: now });
    await db.collection('users').doc('user-bob').set({ name: 'Bob SMS', email: 'bob@example.com', phone: '+15550002222', createdAt: now });
    await db.collection('subscriptions').doc('sub-alice-1').set({ userUid: 'user-alice', optIn: true, smsOptIn: false, radiusKm: 5, location: { latitude: 40.12, longitude: -74.12 }, createdAt: now });
    await db.collection('subscriptions').doc('sub-bob-1').set({ userUid: 'user-bob', optIn: true, smsOptIn: true, radiusKm: 10, location: { latitude: 40.13, longitude: -74.13 }, createdAt: now });
    res.json({ ok: true });
  } catch (err) {
    console.error('createSampleData error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
