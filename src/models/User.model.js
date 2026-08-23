const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['superadmin', 'admin', 'employee'], default: 'employee' },
    phone: { type: String },
    isActive: { type: Boolean, default: true },
    pushTokens: { type: [String], default: [] },

    // Lead card settings — per-user field visibility & order
    leadCardSettings: {
        type: [
            {
                key:      { type: String, required: true },
                label:    { type: String, required: true },
                enabled:  { type: Boolean, default: false },
                order:    { type: Number, default: 0 },
                isCustom: { type: Boolean, default: false },
            }
        ],
        default: [],
    },

    // Every user (admin or employee) belongs to exactly one Account
    // (tenant/business). An admin's tenantId points at the Account they
    // own; an employee's tenantId is copied from the admin who created
    // them (see addEmployee in admin.controller.js), so a single query
    // on tenantId always scopes correctly regardless of role.
    // tenantId is required for admin/employee — every business user belongs
    // to exactly one Account. superadmin is the one exception: they exist
    // ABOVE all tenants (to manage admins across every Account), so they
    // have no tenantId of their own and must never be scoped by one.
    tenantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Account',
        required: function () { return this.role !== 'superadmin'; },
        index: true,
    },
}, { timestamps: true });

// Password save hone se pehle hash karo
userSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 10);
});

// Password compare method
userSchema.methods.comparePassword = async function (password) {
    return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);