// Central error handler. Logs full details server-side,
// returns safe, generic messages to clients (especially in production).
function errorHandler(err, req, res, next) {
  // Always log the real error for debugging / monitoring.
  console.error(`[error] ${req.method} ${req.originalUrl} -`, err);

  // CORS rejection from the cors() origin callback (Step 6)
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed' });
  }

  // Mongoose validation error -> 400 with field messages
  if (err.name === 'ValidationError') {
    const msg = Object.values(err.errors)[0]?.message || 'Validation failed';
    return res.status(400).json({ message: msg });
  }

  // Invalid ObjectId / cast error -> 404 (resource doesn't exist)
  if (err.name === 'CastError') {
    return res.status(404).json({ message: 'Resource not found' });
  }

  // Duplicate key (e.g. unique email/phone) -> 409
  if (err.code === 11000) {
    return res.status(409).json({ message: 'Duplicate value' });
  }

  // Malformed JSON body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Invalid JSON body' });
  }

  // Payload too large (express.json limit from Step 6)
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Payload too large' });
  }

  const status = err.status || err.statusCode || 500;

  // In production, never expose internal messages for 5xx errors.
  const isProd = process.env.NODE_ENV === 'production';
  const message =
    status >= 500 && isProd ? 'Something went wrong' : err.message || 'Error';

  res.status(status).json({ message });
}

// 404 handler for unmatched routes
function notFound(req, res) {
  res.status(404).json({ message: 'Route not found' });
}

module.exports = { errorHandler, notFound };