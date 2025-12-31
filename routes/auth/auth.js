const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { ROLE_MODULES, MODULE_OPTIONS, ROLE_OPTIONS } = require('../../db/auth/user');
const { getTenantContext, sanitizeCode } = require('../../services/tenantManager');
const { authenticate, requireRole, requireModuleAccess } = require('../../middleware/auth');
const { loginRateLimit, trackFailedAuth, getClientIP } = require('../../middleware/ipSecurity');
const { cacheSet, cacheDel } = require('../../services/redisClient');

const router = express.Router();
router.use(bodyParser.json());

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const serializeUser = (user, property) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    modules: user.modules ?? [],
    property: property?._id,
    propertyName: property?.name,
    propertyCode: property?.code,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
});

const signToken = (user, property) =>
    jwt.sign(
        {
            userId: user._id,
            email: user.email,
            role: user.role,
            propertyCode: property.code,
            propertyId: property._id,
        },
        JWT_SECRET,
        { expiresIn: '7d' }
    );

router.post('/properties', (_req, res) => {
    res.status(501).json({
        message: 'Use the admin CLI (npm run admin:create-property) to provision new properties.',
    });
});

// Public endpoint to get mobile app version info (no auth required)
router.get('/mobile-app-version', async (req, res) => {
    try {
        const Property = require('../../db/auth/properties');
        // Get the first active property (assuming all properties share the same app version)
        // Or you can modify this to get a specific property by code if needed
        const property = await Property.findOne({ status: 'Active' })
            .select('mobileApp_version mobileApp_link')
            .lean();
        
        if (!property) {
            return res.status(200).json({
                mobileApp_version: '1.0.0',
                mobileApp_link: '',
            });
        }
        
        res.status(200).json({
            mobileApp_version: property.mobileApp_version || '1.0.0',
            mobileApp_link: property.mobileApp_link || '',
        });
    } catch (error) {
        console.error('Error fetching mobile app version:', error);
        res.status(500).json({
            message: 'Server error fetching mobile app version.',
            mobileApp_version: '1.0.0',
            mobileApp_link: '',
        });
    }
});

// Create a new user for the current property (Admin/Manager only)
router.post('/register', authenticate, requireRole('Admin', 'Manager'), async (req, res) => {
    try {
        const { name, email, password, role = 'Front Desk', modules } = req.body;
        const { property, user: requester, models } = req.tenant;

        if (!name || !email || !password) {
            return res.status(400).json({ message: 'Name, email, and password are required.' });
        }

        if (requester.role === 'Manager' && role === 'Admin') {
            return res.status(403).json({ message: 'Managers cannot create Admin users.' });
        }

        const UserModel = models.User;
        const existingUser = await UserModel.findOne({ email: email.toLowerCase(), property: property._id });
        if (existingUser) {
            return res.status(409).json({ message: 'User with this email already exists for the property.' });
        }

        const normalizedModules =
            Array.isArray(modules) && modules.length > 0
                ? modules.filter((module) => MODULE_OPTIONS.includes(module))
                : ROLE_MODULES[role] ?? [];

        if (requester.role === 'Manager') {
            const invalidModule = normalizedModules.find((module) => !requester.modules.includes(module));
            if (invalidModule) {
                return res.status(403).json({
                    message: `Managers cannot grant access to the ${invalidModule} module.`,
                });
            }
        }

        const user = new UserModel({
            name: name.trim(),
            email: email.toLowerCase(),
            password,
            property: property._id,
            role,
            modules: normalizedModules,
        });

        await user.save();

        res.status(201).json({
            message: 'User created successfully.',
            user: serializeUser(user, property),
        });
    } catch (error) {
        console.error('Error in register:', error);
        res.status(500).json({ message: 'Server error creating user.' });
    }
});

// List users for the current property with their roles and module access
router.get(
    '/users',
    authenticate,
    requireRole('Admin', 'Manager'),
    requireModuleAccess('settings'),
    async (req, res) => {
        try {
            const { property, models } = req.tenant;
            const UserModel = models.User;

            const users = await UserModel.find({ property: property._id }).sort({ createdAt: -1 });

            res.status(200).json({
                users: users.map((user) => serializeUser(user, property)),
            });
        } catch (error) {
            console.error('Error listing users:', error);
            res.status(500).json({ message: 'Server error fetching users.' });
        }
    }
);

// Metadata endpoint: available roles, modules, and default role → modules mapping
router.get('/roles-modules', authenticate, requireRole('Admin', 'Manager'), async (_req, res) => {
    try {
        res.status(200).json({
            roles: ROLE_OPTIONS,
            modules: MODULE_OPTIONS,
            roleModules: ROLE_MODULES,
        });
    } catch (error) {
        console.error('Error fetching role/module metadata:', error);
        res.status(500).json({ message: 'Server error fetching role/module metadata.' });
    }
});

// Update an existing user (name, email, role, status, modules)
router.patch(
    '/users/:id',
    authenticate,
    requireRole('Admin', 'Manager'),
    requireModuleAccess('settings'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, email, role, status, modules } = req.body;
            const { property, user: requester, models } = req.tenant;

            const UserModel = models.User;
            const user = await UserModel.findOne({ _id: id, property: property._id });

            if (!user) {
                return res.status(404).json({ message: 'User not found for this property.' });
            }

            if (requester.role === 'Manager') {
                if (user.role === 'Admin') {
                    return res.status(403).json({ message: 'Managers cannot modify Admin users.' });
                }
                if (role === 'Admin') {
                    return res.status(403).json({ message: 'Managers cannot promote users to Admin.' });
                }
            }

            if (typeof name === 'string' && name.trim()) {
                user.name = name.trim();
            }

            if (typeof email === 'string' && email.trim()) {
                user.email = email.toLowerCase().trim();
            }

            if (typeof role === 'string' && ROLE_OPTIONS.includes(role)) {
                user.role = role;
            }

            if (typeof status === 'string' && ['Active', 'Inactive'].includes(status)) {
                user.status = status;
            }

            if (Array.isArray(modules)) {
                const normalizedModules = modules.filter((module) => MODULE_OPTIONS.includes(module));

                if (requester.role === 'Manager') {
                    const invalidModule = normalizedModules.find((module) => !requester.modules.includes(module));
                    if (invalidModule) {
                        return res.status(403).json({
                            message: `Managers cannot grant access to the ${invalidModule} module.`,
                        });
                    }
                }

                user.modules = normalizedModules;
            }

            await user.save();

            res.status(200).json({
                message: 'User updated successfully.',
                user: serializeUser(user, property),
            });
        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).json({ message: 'Server error updating user.' });
        }
    }
);

// Delete a user from the current property
router.delete(
    '/users/:id',
    authenticate,
    requireRole('Admin', 'Manager'),
    requireModuleAccess('settings'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { property, user: requester, models } = req.tenant;

            const UserModel = models.User;
            const user = await UserModel.findOne({ _id: id, property: property._id });

            if (!user) {
                return res.status(404).json({ message: 'User not found for this property.' });
            }

            if (requester.role === 'Manager' && user.role === 'Admin') {
                return res.status(403).json({ message: 'Managers cannot delete Admin users.' });
            }

            await user.deleteOne();

            res.status(200).json({ message: 'User deleted successfully.' });
        } catch (error) {
            console.error('Error deleting user:', error);
            res.status(500).json({ message: 'Server error deleting user.' });
        }
    }
);

router.post('/login', loginRateLimit, async (req, res) => {
    try {
        const { email, password, propertyCode } = req.body;
        const ip = getClientIP(req);

        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        if (!propertyCode) {
            return res.status(400).json({ message: 'Property code is required.' });
        }

        const normalizedCode = sanitizeCode(propertyCode);
        let tenant;
        try {
            tenant = await getTenantContext(normalizedCode);
        } catch (error) {
            if (error.message === 'TENANT_PROPERTY_NOT_FOUND') {
                await trackFailedAuth(ip, '/api/auth/login');
                return res.status(404).json({ message: 'Property not found or inactive.' });
            }
            console.error('Error resolving tenant:', error);
            return res.status(500).json({ message: 'Server error resolving property.' });
        }

        const UserModel = tenant.models.User;
        // Use lean() for faster query - we only need to check password
        const user = await UserModel.findOne({ 
            email: email.toLowerCase(), 
            property: tenant.property._id 
        }).lean();

        if (!user) {
            await trackFailedAuth(ip, '/api/auth/login');
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        // Need to get full user document to use comparePassword method
        const fullUser = await UserModel.findById(user._id);
        const isMatch = await fullUser.comparePassword(password);
        
        if (!isMatch) {
            await trackFailedAuth(ip, '/api/auth/login');
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        if (fullUser.status !== 'Active') {
            await trackFailedAuth(ip, '/api/auth/login');
            return res.status(403).json({ message: 'User account is inactive.' });
        }

        // Update last login
        fullUser.lastLogin = new Date();
        await fullUser.save();

        // Invalidate any existing user cache
        await cacheDel(`user:${fullUser._id}:${normalizedCode}`);

        const token = signToken(fullUser, tenant.property);

        res.status(200).json({
            message: 'Login successful',
            token,
            user: serializeUser(fullUser, tenant.property),
        });
    } catch (error) {
        console.error('Error in login:', error);
        const ip = getClientIP(req);
        await trackFailedAuth(ip, '/api/auth/login');
        res.status(500).json({ message: 'Server error during login.' });
    }
});

router.get('/verify', authenticate, async (req, res) => {
    try {
        const { user, property } = req.tenant;
        res.status(200).json({
            valid: true,
            user: serializeUser(user, property),
        });
    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(500).json({ message: 'Server error verifying token.' });
    }
});

module.exports = router;
