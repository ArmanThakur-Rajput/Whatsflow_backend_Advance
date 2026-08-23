const crypto = require('crypto');

// Verifies the shared secret that n8n must send in the x-webhook-secret header.
module.exports = function webhookAuth(req, res, next) {
  const provided = req.headers['x-webhook-secret'] || '';
  const expected = process.env.WEBHOOK_SECRET || '';

  if (!expected) {
    return res.status(500).json({ message: 'Webhook not configured' });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  // timingSafeEqual throws if lengths differ, so guard that first.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  next();
};