const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const upload = require('../middleware/uploadMiddleware');
const imageUpload = require('../middleware/imageUploadMiddleware');
const ctrl = require('../controllers/propertyCRM.controller');
const importCtrl = require('../controllers/propertyImport.controller');

// Public — no auth (shared via WhatsApp)
router.get('/properties/:id/gallery', ctrl.getGalleryPage);

router.use(auth, adminOnly);

// Master data
router.get('/master-data', ctrl.getMasterData);
router.post('/master-data', ctrl.addMasterData);
router.delete('/master-data/:id', ctrl.deleteMasterData);

// Dashboard stats
router.get('/stats', ctrl.getStats);

// Explore
router.get('/locations-summary', ctrl.getLocationsSummary);
router.get('/types-summary', ctrl.getTypesSummary);

// Properties CRUD
router.get('/properties', ctrl.getProperties);
router.get('/properties/:id', ctrl.getPropertyById);
router.post('/properties', ctrl.createProperty);
router.patch('/properties/:id', ctrl.updateProperty);
router.delete('/properties/:id', ctrl.deleteProperty);        // ← Property delete (new)
router.patch('/properties/:id/status', ctrl.setPropertyStatus);

// Photos
router.post('/properties/:id/photos', imageUpload.array('photos', 10), ctrl.uploadPhotos);
router.delete('/properties/:id/photos', ctrl.deletePhoto);

// Import / Export
router.get('/import/template', importCtrl.downloadPropertyTemplate);
router.post('/import', upload.single('file'), importCtrl.importProperties);
router.get('/export', importCtrl.exportProperties);

module.exports = router;
