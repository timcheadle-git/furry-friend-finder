const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

admin.initializeApp();

// Initialize Twilio client from environment variables (safer for v7+)
let twilioClient = null;
const TWILIO_SID = process.env.TWILIO_SID || null;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || null;
const TWILIO_FROM = process.env.TWILIO_FROM || null;
if (TWILIO_SID && TWILIO_TOKEN) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
  } catch (e) {
    console.warn('Twilio client failed to initialize', e);
  }
}

// Helper: send FCM multicast in batches
async function sendFcmTokens(tokens, payload) {
  if (!tokens || tokens.length === 0) return;
  const batchSize = 500; // FCM limit
  for (let i = 0; i < tokens.length; i += batchSize) {
    const slice = tokens.slice(i, i + batchSize);
    await admin.messaging().sendMulticast({ tokens: slice, ...payload });
  }
}

// Shared logic to process a report
async function processLostReport(report, reportId) {
  const db = admin.firestore();

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
  await db.collection('alerts').add({
    lostReportId: reportId || null,
    sentToCount: fcmTokens.length + smsRecipients.length,
    channels: twilioClient ? ['push', 'sms'] : ['push'],
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
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
