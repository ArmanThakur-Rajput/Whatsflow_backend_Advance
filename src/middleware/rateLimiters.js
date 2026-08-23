const rateLimit = require('express-rate-limit');

// Caps webhook ingestion to prevent flooding / DoS.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // max 30 webhook calls per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, slow down.' },
});

// Throttles login attempts to slow down brute-force / credential stuffing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // max 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  message: { message: 'Too many login attempts. Try again in 15 minutes.' },
});

module.exports = { webhookLimiter, loginLimiter };