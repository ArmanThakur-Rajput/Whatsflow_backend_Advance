const multer = require('multer');

// Memory storage — buffers go straight to R2, never touch disk
const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpg, png, webp, heic) are allowed'), false);
  }
};

// Keep uploads reliable on mobile networks and avoid unbounded memory usage.
const imageUpload = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

module.exports = imageUpload;
