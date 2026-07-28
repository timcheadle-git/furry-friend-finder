const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

// Initialize Twilio client from environment variables (safer for v7+), with fallback to firebase functions config
let twilioClient = null;
const functionsV1 = (() => { try { return require('firebase-functions'); } catch (e) { return null; } })();
let TWILIO_SID = process.env.TWILIO_SID || null;
let TWILIO_TOKEN = process.env.TWILIO_TOKEN || null;
let TWILIO_FROM = process.env.TWILIO_FROM || null;
// Fallback to functions config if not provided via env
if ((!TWILIO_SID || !TWILIO_TOKEN) && functionsV1) {
  try {
    const cfg = functionsV1.config();
    if (cfg && cfg.twilio) {
      TWILIO_SID = TWILIO_SID || cfg.twilio.sid || null;
      TWILIO_TOKEN = TWILIO_TOKEN || cfg.twilio.token || null;
      TWILIO_FROM = TWILIO_FROM || cfg.twilio.from || null;
    }
  } catch (e) {
    // ignore
  }
}
if (TWILIO_SID && TWILIO_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  } catch (e) {
    console.warn('Twilio client failed to initialize', e);
  }
}

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

// Helper: send FCM multicast in batches
async function sendFcmTokens(tokens, payload) {
  if (!tokens || tokens.length === 0) return;
  if (!messagingClient || !messagingClient.sendMulticast) {
    console.warn('Messaging client not available or does not support sendMulticast');
    return;
  }
  const batchSize = 500; // FCM limit
  for (let i = 0; i < tokens.length; i += batchSize) {
    const slice = tokens.slice(i, i + batchSize);
    await messagingClient.sendMulticast({ tokens: slice, ...payload });
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
  if (twilioClient && smsRecipients.length) {
    const from = TWILIO_FROM || 'Twilio';
    for (const to of smsRecipients) {
      try {
        await twilioClient.messages.create({ body: messageText, from, to });
      } catch (err) {
        console.error('Twilio send failed', err);
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
exports.onLostReportCreated = onDocumentCreated('lostReports/{reportId}', async (event) => {
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
exports.simulateLostReport = onRequest(async (req, res) => {
  const sample = {
    petId: 'pet-test-1',
    reporterUid: 'user-test-1',
    status: 'lost',
    lastSeenLocation: { latitude: 40.12345, longitude: -74.12345, address: 'Test Park' },
    reportedAt: new Date().toISOString()
  };
  const report = req.body && Object.keys(req.body).length ? req.body : sample;
  try {
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
    await db.collection('users').doc('user-alice').set({ name: 'Alice Tester', email: 'alice@example.com', phone: '+15550001111', fcmTokens: ['fcm-token-abc'], createdAt: now });
    await db.collection('users').doc('user-bob').set({ name: 'Bob SMS', email: 'bob@example.com', phone: '+15550002222', createdAt: now });
    await db.collection('subscriptions').doc('sub-alice-1').set({ userUid: 'user-alice', optIn: true, smsOptIn: false, radiusKm: 5, location: { latitude: 40.12, longitude: -74.12 }, createdAt: now });
    await db.collection('subscriptions').doc('sub-bob-1').set({ userUid: 'user-bob', optIn: true, smsOptIn: true, radiusKm: 10, location: { latitude: 40.13, longitude: -74.13 }, createdAt: now });
    res.json({ ok: true });
  } catch (err) {
    console.error('createSampleData error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
