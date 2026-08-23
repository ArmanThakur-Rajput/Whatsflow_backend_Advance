const router = require('express').Router();
const User = require('../models/User.model');
const { login, changePassword } = require('../controllers/auth.controller');
const validate = require('../middleware/validate');
const { loginRules } = require('../middleware/leadValidators');
const { updateProfileRules } = require('../middleware/employeeValidators');
const asyncHandler = require('../utils/asyncHandler');

router.post('/login', loginRules, validate, login);
const auth = require('../middleware/auth');

// Change password (logged-in user)
router.patch('/change-password', auth, changePassword);

router.patch('/profile', auth, updateProfileRules, validate, asyncHandler(async (req, res) => {
    const { name, phone } = req.body;
    const user = await User.findByIdAndUpdate(
        req.user._id,
        { name, phone },
        { new: true }
    );
    res.json({
        message: 'Profile updated',
        user: {
            _id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            isActive: user.isActive,
            phone: user.phone,
        },
    });
}));

// Push token save karo
router.post('/push-token', auth, asyncHandler(async (req, res) => {
    console.log('📲 /push-token hit — user:', req.user?._id, '| body:', req.body);

    const { pushToken } = req.body;

    if (!pushToken || typeof pushToken !== 'string' || !pushToken.trim()) {
        console.warn('⚠️ Invalid pushToken received:', pushToken);
        return res.status(400).json({ message: 'Valid pushToken required' });
    }

    const updated = await User.findByIdAndUpdate(
        req.user._id,
        { $addToSet: { pushTokens: pushToken.trim() } },
        { new: true }
    ).select('pushTokens email');

    console.log('✅ Push token saved — email:', updated?.email, '| tokens:', updated?.pushTokens?.length);

    res.json({ message: 'Push token saved', pushTokens: updated?.pushTokens });
}));

// Lead Card Settings — GET
router.get('/lead-card-settings', auth, asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select('leadCardSettings');
    res.json({ fields: user.leadCardSettings || [] });
}));

// Lead Card Settings — PUT (save)
router.put('/lead-card-settings', auth, asyncHandler(async (req, res) => {
    const { fields } = req.body;
    if (!Array.isArray(fields)) {
        return res.status(400).json({ message: 'fields must be an array' });
    }
    await User.findByIdAndUpdate(req.user._id, { leadCardSettings: fields });
    res.json({ message: 'Lead card settings saved', fields });
}));

module.exports = router;
