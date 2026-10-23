const router = require('express').Router();
const auth = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Auth middleware verifies the JWT, active user, and active organization.
// Rate-limit by authenticated user so a shared office IP doesn't throttle everyone.
const rivaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => String(req.user?._id || req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Riva is receiving too many messages. Please try again shortly.' },
});

router.post('/chat', auth, (req, res, next) => {
  // Riva is for logged-in business team members, not public users or superadmins.
  if (!req.user || !['admin', 'employee'].includes(req.user.role) || !req.user.tenantId) {
    return res.status(403).json({ message: 'Riva AI is available to authorized team members only.' });
  }
  return next();
}, rivaLimiter, async (req, res) => {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 1000) {
    return res.status(400).json({ message: 'Message must contain 1–1000 characters.' });
  }

  const webhookUrl = process.env.N8N_RIVA_WEBHOOK_URL;
  const apiKey = process.env.N8N_RIVA_API_KEY;
  if (!webhookUrl || !apiKey) {
    console.error('Riva AI is not configured: N8N_RIVA_WEBHOOK_URL or N8N_RIVA_API_KEY is missing.');
    return res.status(503).json({ message: 'Riva AI is temporarily unavailable.' });
  }

  // Only allow HTTPS endpoints; URL is server configuration, never client-controlled.
  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    return res.status(503).json({ message: 'Riva AI is temporarily unavailable.' });
  }
  if (parsedUrl.protocol !== 'https:') {
    console.error('Riva webhook URL must use HTTPS.');
    return res.status(503).json({ message: 'Riva AI is temporarily unavailable.' });
  }

  // Namespace memory/session by tenant + verified user so one team member cannot
  // choose another member's n8n chat-memory session ID.
  const suppliedSessionId = typeof req.body?.sessionId === 'string'
    ? req.body.sessionId.slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '_')
    : `session_${Date.now()}`;
  const sessionId = `tenant_${String(req.user.tenantId)}_user_${String(req.user._id)}_${suppliedSessionId}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const upstream = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        type: 'text',
        sessionId,
        message: message.trim(),
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      // Do not pass upstream details or credentials to the client.
      console.error(`Riva n8n request failed with HTTP ${upstream.status}.`);
      return res.status(502).json({ message: 'Riva AI is temporarily unavailable.' });
    }

    const data = await upstream.json();
    return res.json({
      reply: data?.reply || data?.output || data?.message || data?.text || 'No response received.',
      property: data?.property ?? undefined,
    });
  } catch (error) {
    console.error('Riva n8n request failed:', error?.name === 'AbortError' ? 'upstream timeout' : 'network/response error');
    return res.status(502).json({ message: 'Riva AI is temporarily unavailable. Please try again.' });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
