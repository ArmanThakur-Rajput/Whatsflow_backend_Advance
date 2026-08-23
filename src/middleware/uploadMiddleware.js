const multer = require('multer');

// Store in memory (buffer) — we parse the CSV in the controller
// and never write it to disk, so no temp file cleanup needed.
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['text/csv', 'application/vnd.ms-excel', 'text/plain'];
  // Also accept by extension since some OS/browsers send wrong mimetype for .csv
  const isCSV =
    allowed.includes(file.mimetype) ||
    file.originalname.toLowerCase().endsWith('.csv');

  if (isCSV) {
    cb(null, true);
  } else {
    cb(new Error('Only CSV files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max — ~10,000 rows is well within this
});

module.exports = upload;
