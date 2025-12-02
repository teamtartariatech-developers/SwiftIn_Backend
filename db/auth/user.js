const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLE_OPTIONS = ['Admin', 'Manager', 'Front Desk', 'Housekeeping', 'Channel Manager'];
const MODULE_OPTIONS = [
    'front-office',
    'distribution',
    'guest-management',
    'housekeeping',
    'billing-finance',
    'reports',
    'settings',
];

const ROLE_MODULES = {
    Admin: MODULE_OPTIONS,
    Manager: ['front-office', 'distribution', 'guest-management', 'billing-finance', 'reports', 'settings'],
    'Front Desk': ['front-office', 'guest-management'],
    Housekeeping: ['housekeeping'],
    'Channel Manager': ['distribution', 'reports'],
};

const userSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            required: true,
            minlength: 6,
        },
        property: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Property',
            required: true,
            index: true,
        },
        role: {
            type: String,
            enum: ROLE_OPTIONS,
            default: 'Front Desk',
        },
        modules: {
            type: [String],
            enum: MODULE_OPTIONS,
            default: undefined,
        },
        status: {
            type: String,
            enum: ['Active', 'Inactive'],
            default: 'Active',
        },
        lastLogin: Date,
    },
    { timestamps: true }
);

userSchema.index({ email: 1, property: 1 }, { unique: true });

// Ensure modules align with role defaults if not explicitly provided.
userSchema.pre('validate', function syncModulesWithRole(next) {
    if (!this.modules || this.modules.length === 0) {
        this.modules = ROLE_MODULES[this.role] ?? [];
    }
    next();
});

// Hash password before saving
userSchema.pre('save', async function hashPassword(next) {
    if (!this.isModified('password')) return next();

    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// Compare password method
userSchema.methods.comparePassword = async function comparePassword(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.isModuleAllowed = function isModuleAllowed(moduleId) {
    return this.modules?.includes(moduleId);
};

userSchema.statics.roleModules = function roleModules(role) {
    return ROLE_MODULES[role] ?? [];
};

const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;
module.exports.schema = userSchema;
module.exports.ROLE_MODULES = ROLE_MODULES;
module.exports.MODULE_OPTIONS = MODULE_OPTIONS;
module.exports.ROLE_OPTIONS = ROLE_OPTIONS;
