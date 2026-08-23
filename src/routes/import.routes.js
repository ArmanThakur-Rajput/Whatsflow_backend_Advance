const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const upload = require('../middleware/uploadMiddleware');
const { downloadTemplate, importLeads } = require('../controllers/import.controller');

// All routes: must be logged in + admin only
router.use(auth, adminOnly);

// GET  /leads/import/template  — download tenant-specific CSV template
router.get('/template', downloadTemplate);

// POST /leads/import           — upload filled CSV and bulk-import leads
router.post('/', upload.single('file'), importLeads);

module.exports = router;
