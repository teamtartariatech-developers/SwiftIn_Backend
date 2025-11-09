const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const { ROLE_MODULES, MODULE_OPTIONS } = require('../../db/auth/user');
const { getTenantContext, sanitizeCode } = require('../../services/tenantManager');
const { authenticate, requireRole } = require('../../middleware/auth');

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

router.post('/login', async (req, res) => {
    try {
        const { email, password, propertyCode } = req.body;

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
                return res.status(404).json({ message: 'Property not found or inactive.' });
            }
            console.error('Error resolving tenant:', error);
            return res.status(500).json({ message: 'Server error resolving property.' });
        }

        const UserModel = tenant.models.User;
        const user = await UserModel.findOne({ email: email.toLowerCase(), property: tenant.property._id });

        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        if (user.status !== 'Active') {
            return res.status(403).json({ message: 'User account is inactive.' });
        }

        user.lastLogin = new Date();
        await user.save();

        const token = signToken(user, tenant.property);

        res.status(200).json({
            message: 'Login successful',
            token,
            user: serializeUser(user, tenant.property),
        });
    } catch (error) {
        console.error('Error in login:', error);
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
