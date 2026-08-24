require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const validateEnv = require('./config/validateEnv');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const { startScheduler } = require('./utils/scheduler');
const { startVisitorDateNotifier, scheduleDayOfNotifications } = require('./utils/visitorDateNotifier');

validateEnv(); // fail fast before anything else boots

const app = express();
// Trust the first proxy hop so req.ip reflects the real client IP
// (needed for correct rate limiting behind Nginx/Render/Railway/etc.)
app.set('trust proxy', 1);
connectDB();
// FIX #6: Wire up the midnight IST cron that promotes New→Pending leads.
// Must be called after validateEnv() so DB is ready, and after Fix #1
// (tenantId filter added to scheduler.js) so it's safe to run.
startScheduler();
startVisitorDateNotifier();

// --- Security headers ---
app.use(helmet());

// --- CORS: allow only known origins ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // React Native / Expo Go / Postman
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("Blocked Origin:", origin);
      return callback(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --- Body parsing with size caps ---
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// ── TEMP TEST ROUTE — testing ke baad hata dena ──────────────────────────────
app.get('/test-visitor', async (req, res) => {
  try {
    await scheduleDayOfNotifications();
    res.json({ ok: true, message: 'scheduleDayOfNotifications ran — check Easy Panel logs' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/leads', require('./routes/lead.routes'));
app.use('/api/leads/import', require('./routes/import.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/notifications', require('./routes/notification.routes'));
app.use('/api/schedule', require('./routes/schedule.routes'));
app.use('/api/custom-fields', require('./routes/customField.routes'));
app.use('/api/super-admin', require('./routes/superAdmin.routes'));
app.use('/api/property-crm', require('./routes/propertyCRM.routes'));


app.get('/', (req, res) => {
  res.json({ status: '🚀 Lead Backend Running!' });
});

app.use(notFound);      // unmatched routes -> 404
app.use(errorHandler);  // central error handler -> safe responses

app.listen(process.env.PORT || 5000, () => {
  console.log(`🚀 Server on port ${process.env.PORT || 5000}`);
});
