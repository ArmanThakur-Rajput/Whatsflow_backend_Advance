const router = require('express').Router();
const auth = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const validate = require('../middleware/validate');
const { addEmployeeRules, updateEmployeeRules } = require('../middleware/employeeValidators');
const ctrl = require('../controllers/admin.controller');

// All routes admin only
router.use(auth, adminOnly);

// Stats & Performance Dashboard
router.get('/stats', ctrl.getAdminStats);
router.get('/performance', ctrl.getPerformanceDashboard);
router.get('/monthly-trend', ctrl.getMonthlyTrend);

// Employee routes
router.get('/employees', ctrl.getEmployees);
router.post('/employees', addEmployeeRules, validate, ctrl.addEmployee);
router.get('/employees/:id', ctrl.getEmployeeById);
router.patch('/employees/:id', updateEmployeeRules, validate, ctrl.updateEmployee);
router.patch('/employees/:id/toggle', ctrl.toggleEmployeeStatus);

// Lead archive/history (paginated, filterable)
router.get('/leads', ctrl.getAllLeads);
router.get('/leads/export', ctrl.exportLeadsCSV);
router.patch('/leads/:id/assign', ctrl.assignLead);

// Appointment routes
router.get('/appointments', ctrl.getAppointments);
router.get('/appointments/:id', ctrl.getAppointmentById);
router.patch('/appointments/:id', ctrl.updateAppointment);
router.patch('/appointments/:id/status', ctrl.setAppointmentStatus);

// ✅ Visitor routes
router.get('/visitors', ctrl.getUpcomingVisitors);
router.patch('/visitors/:id/remove', ctrl.removeFromVisitors);

module.exports = router;
