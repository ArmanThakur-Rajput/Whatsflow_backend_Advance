const { getMessaging } = require('../config/firebase');

const sendPushNotification = async (pushToken, title, body, data = {}) => {
  if (!pushToken) return;

  const messaging = getMessaging();
  if (!messaging) {
    console.warn('⚠️ Firebase not initialized — push notification skip');
    return;
  }

  // Purana Expo token aaya to skip karo
  if (pushToken.startsWith('ExponentPushToken')) {
    console.warn('⚠️ Expo token mila FCM token chahiye — skip:', pushToken);
    return;
  }

  try {
    const message = {
      token: pushToken,
      notification: {
        title,
        body,
      },
      // data sirf strings honi chahiye FCM mein
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: 'high',
        notification: {
          sound: 'sound',      // assets/sounds/sound.wav — EAS build mein bundle hota hai
          channelId: 'default',
        },
      },
      apns: {
        payload: {
          aps: { sound: 'sound.wav' },
        },
      },
    };

    const result = await messaging.send(message);
    console.log('✅ FCM push sent:', result);
  } catch (err) {
    console.error('❌ FCM push failed:', err.message);
  }
};

module.exports = sendPushNotification;
