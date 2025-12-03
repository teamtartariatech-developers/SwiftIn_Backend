const jwt = require('jsonwebtoken');
const { getTenantContext } = require('../services/tenantManager');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authorization header missing or malformed.' });
    }

    const token = authHeader.substring(7);

    try {
        const decoded = jwt.verify(token, JWT_SECRET);

        if (!decoded.propertyCode) {
            return res.status(401).json({ message: 'Invalid token payload.' });
        }

        const tenant = await getTenantContext(decoded.propertyCode);
        const UserModel = tenant.models.User;
        const user = await UserModel.findById(decoded.userId);

        if (!user || user.status !== 'Active') {
            return res.status(401).json({ message: 'Invalid or inactive user.' });
        }

        req.tenant = {
            code: tenant.code,
            dbName: tenant.dbName,
            connection: tenant.connection,
            models: tenant.models,
            property: tenant.property,
            user,
        };

        req.user = {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            modules: user.modules ?? [],
            property: tenant.property,
        };

        next();
    } catch (error) {
        // Only log non-network errors (network errors are usually transient DNS issues)
        // Don't spam console with MongoDB connection retry errors
        const isNetworkError = error?.message?.includes('ENOTFOUND') || 
                              error?.message?.includes('getaddrinfo') ||
                              error?.message?.includes('MongoServerSelectionError') ||
                              error?.code === 'ENOTFOUND' ||
                              error?.name === 'MongoServerSelectionError';
        
        if (!isNetworkError) {
            console.error('Authentication error:', error.message || error);
        }
        res.status(401).json({ message: 'Invalid token.' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.tenant || !req.tenant.user || !roles.includes(req.tenant.user.role)) {
            return res.status(403).json({ message: 'You do not have permission to perform this action.' });
        }
        next();
    };
}

function requireModuleAccess(...modules) {
    return (req, res, next) => {
        if (!req.tenant || !req.tenant.user) {
            return res.status(401).json({ message: 'Authentication required.' });
        }

        const allowedModules = req.tenant.user.modules ?? [];
        const hasAccess = modules.every((module) => allowedModules.includes(module));

        if (!hasAccess) {
            return res.status(403).json({ message: 'You do not have access to this module.' });
        }

        next();
    };
}

module.exports = {
    authenticate,
    requireRole,
    requireModuleAccess,
};

