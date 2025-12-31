const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getTenantContext } = require('../services/tenantManager');
const { cacheGet, cacheSet, cacheDel } = require('../services/redisClient');
const { trackFailedAuth, getClientIP } = require('./ipSecurity');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Cache TTLs (in seconds)
const CACHE_TTL = {
    SESSION: 3600, // 1 hour
    TENANT_CONTEXT: 1800, // 30 minutes
    USER_DATA: 900, // 15 minutes
};

// Serialize user for caching (remove sensitive data)
function serializeUserForCache(user, property) {
    return {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        modules: user.modules ?? [],
        status: user.status,
        property: {
            _id: property._id.toString(),
            name: property.name,
            code: property.code,
        }
    };
}

// Deserialize cached user
function deserializeUserFromCache(cached) {
    return cached; // Already in correct format
}

async function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authorization header missing or malformed.' });
    }

    const token = authHeader.substring(7);
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sessionKey = `session:${tokenHash}`;

    try {
        // Check Redis cache for session first (fastest path)
        const cachedSession = await cacheGet(sessionKey);
        if (cachedSession) {
            // Session found in cache - verify user is still active
            if (cachedSession.user.status !== 'Active') {
                await cacheDel(sessionKey);
                const ip = getClientIP(req);
                await trackFailedAuth(ip, req.path);
                return res.status(401).json({ message: 'User account is inactive.' });
            }

            // Get tenant context (connection/models can't be cached, but property code lookup is fast)
            const tenant = await getTenantContext(cachedSession.tenant.code);
            
            req.tenant = {
                code: tenant.code,
                dbName: tenant.dbName,
                connection: tenant.connection,
                models: tenant.models,
                property: tenant.property,
                user: cachedSession.user,
            };

            req.user = {
                id: cachedSession.user.id,
                name: cachedSession.user.name,
                email: cachedSession.user.email,
                role: cachedSession.user.role,
                modules: cachedSession.user.modules,
                property: cachedSession.user.property,
            };

            return next();
        }

        // Token not in cache - verify and load from database
        const decoded = jwt.verify(token, JWT_SECRET);

        if (!decoded.propertyCode) {
            return res.status(401).json({ message: 'Invalid token payload.' });
        }

        // Check cache for tenant context
        const tenantContextKey = `tenant:context:${decoded.propertyCode}`;
        let tenantContext = await cacheGet(tenantContextKey);
        
        if (!tenantContext) {
            // Load tenant context
            const tenant = await getTenantContext(decoded.propertyCode);
            tenantContext = {
                code: tenant.code,
                dbName: tenant.dbName,
                property: {
                    _id: tenant.property._id.toString(),
                    name: tenant.property.name,
                    code: tenant.property.code,
                }
            };
            // Cache tenant context (without connection/models as they can't be serialized)
            await cacheSet(tenantContextKey, tenantContext, CACHE_TTL.TENANT_CONTEXT);
        }

        // Get actual tenant for connection/models
        const tenant = await getTenantContext(decoded.propertyCode);
        const UserModel = tenant.models.User;

        // Check cache for user data
        const userCacheKey = `user:${decoded.userId}:${decoded.propertyCode}`;
        let userData = await cacheGet(userCacheKey);

        if (!userData) {
            // Load user from database with lean() for performance
            const user = await UserModel.findById(decoded.userId).lean();

            if (!user || user.status !== 'Active') {
                const ip = getClientIP(req);
                await trackFailedAuth(ip, req.path);
                return res.status(401).json({ message: 'Invalid or inactive user.' });
            }

            // Serialize and cache user
            userData = serializeUserForCache(user, tenant.property);
            await cacheSet(userCacheKey, userData, CACHE_TTL.USER_DATA);
        } else {
            // Verify user is still active (quick check)
            if (userData.status !== 'Active') {
                await cacheDel(userCacheKey);
                await cacheDel(sessionKey);
                const ip = getClientIP(req);
                await trackFailedAuth(ip, req.path);
                return res.status(401).json({ message: 'User account is inactive.' });
            }
        }

        // Build tenant object
        req.tenant = {
            code: tenant.code,
            dbName: tenant.dbName,
            connection: tenant.connection,
            models: tenant.models,
            property: tenant.property,
            user: userData, // Use cached user data
        };

        req.user = {
            id: userData.id,
            name: userData.name,
            email: userData.email,
            role: userData.role,
            modules: userData.modules,
            property: userData.property,
        };

        // Cache the session for future requests (without connection/models)
        await cacheSet(sessionKey, {
            tenant: tenantContext,
            user: userData,
        }, CACHE_TTL.SESSION);

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
        
        const ip = getClientIP(req);
        await trackFailedAuth(ip, req.path);
        
        res.status(401).json({ message: 'Invalid token.' });
    }
}

// Helper to invalidate user cache (call when user data changes)
async function invalidateUserCache(userId, propertyCode) {
    const userCacheKey = `user:${userId}:${propertyCode}`;
    await cacheDel(userCacheKey);
    // Also invalidate all sessions for this user
    // Note: This requires scanning, which is expensive. In production, maintain a set of active tokens per user.
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
    invalidateUserCache,
};

