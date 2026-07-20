const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

// Initialize Twilio client if configured via functions config
let twilioClient = null;
try {
  const twCfg = functions.config().twilio || {};
  if (twCfg.sid && twCfg.token) {
    const twilio = require('twilio');
    twilioClient = twilio(twCfg.sid, twCfg.token);
  }
} catch (e) {
  console.warn('Twilio not configured or failed to initialize', e);
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

// Trigger: on new lost report, notify subscribers (prototype: no geo-filtering)
exports.onLostReportCreated = functions.firestore.document('lostReports/{reportId}').onCreate(async (snap, ctx) => {
  const report = snap.data();
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
    // Respect a per-subscription flag for SMS fallback (smsOptIn)
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
        lostReportId: snap.id
      }
    };
    await sendFcmTokens(fcmTokens, payload);
  }

  // Send SMS via Twilio if configured
  if (twilioClient && smsRecipients.length) {
    const from = functions.config().twilio.from || 'Twilio';
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
    lostReportId: snap.id,
    sentToCount: fcmTokens.length + smsRecipients.length,
    channels: twilioClient ? ['push', 'sms'] : ['push'],
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    status: 'sent'
  });
});

// A simple HTTPS test endpoint
exports.testNotify = functions.https.onRequest(async (req, res) => {
  res.send('Notification prototype is deployed');
});
