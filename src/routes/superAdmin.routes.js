const router = require('express').Router();
const auth = require('../middleware/auth');
const superAdminOnly = require('../middleware/superAdminOnly');
const validate = require('../middleware/validate');
const { addAdminRules, updateAdminRules, idParamRule } = require('../middleware/superAdminValidators');
const ctrl = require('../controllers/superAdmin.controller');

// Every route here requires login AND the superadmin role specifically.
// A tenant admin hitting these gets 403, same as an employee would.
router.use(auth, superAdminOnly);

// Organizations (monitoring view)
router.get('/organizations', ctrl.getOrganizations);
router.get('/organizations/:id/admins', idParamRule, validate, ctrl.getAdminsByOrg);
router.post('/organizations/:id/admins', idParamRule, validate, ctrl.addAdminToOrg);
router.patch('/organizations/:id/toggle', idParamRule, validate, ctrl.toggleOrgStatus);

// Admins (flat cross-org view + management)
router.get('/admins', ctrl.getAllAdmins);
router.post('/admins', addAdminRules, validate, ctrl.addAdmin);
router.patch('/admins/:id', updateAdminRules, validate, ctrl.updateAdmin);
router.patch('/admins/:id/toggle', idParamRule, validate, ctrl.toggleAdminStatus);
router.delete('/admins/:id', idParamRule, validate, ctrl.deleteAdmin);

module.exports = router;
