const { cacheSet } = require('../services/redisClient');
const { getClientIP } = require('./ipSecurity');

// Audit logging middleware for security and compliance
// Logs all critical operations for security monitoring

const AUDIT_LOG_TTL = 2592000; // 30 days

// Audit log entry structure
function createAuditLog(req, action, details = {}) {
    return {
        timestamp: new Date().toISOString(),
        userId: req.user?.id || 'anonymous',
        userEmail: req.user?.email || 'unknown',
        propertyId: req.tenant?.property?._id?.toString() || 'unknown',
        propertyCode: req.tenant?.code || 'unknown',
        action,
        method: req.method,
        path: req.path,
        ip: getClientIP(req),
        userAgent: req.headers['user-agent'] || 'unknown',
        details,
    };
}

// Log audit entry to Redis (can be extended to write to database)
async function logAuditEntry(entry) {
    try {
        const key = `audit:${entry.propertyId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
        await cacheSet(key, entry, AUDIT_LOG_TTL);
    } catch (error) {
        console.error('Failed to log audit entry:', error);
        // Don't throw - audit logging should not break the application
    }
}

// Audit middleware for sensitive operations
const auditLog = (action, getDetails = null) => {
    return async (req, res, next) => {
        // Log before the operation
        const details = getDetails ? getDetails(req) : {};
        const auditEntry = createAuditLog(req, action, details);
        
        // Store original json method
        const originalJson = res.json.bind(res);
        
        // Override json to log after response
        res.json = function(data) {
            auditEntry.responseStatus = res.statusCode;
            auditEntry.success = res.statusCode < 400;
            
            if (res.statusCode >= 400) {
                auditEntry.error = data.message || data.error || 'Unknown error';
            }
            
            logAuditEntry(auditEntry);
            return originalJson(data);
        };
        
        next();
    };
};

// Critical operations that should be audited
const CRITICAL_ACTIONS = {
    USER_CREATE: 'user.create',
    USER_UPDATE: 'user.update',
    USER_DELETE: 'user.delete',
    RESERVATION_CREATE: 'reservation.create',
    RESERVATION_UPDATE: 'reservation.update',
    RESERVATION_DELETE: 'reservation.delete',
    RESERVATION_CANCEL: 'reservation.cancel',
    PAYMENT_PROCESS: 'payment.process',
    SETTINGS_UPDATE: 'settings.update',
    PROPERTY_UPDATE: 'property.update',
    GUEST_CREATE: 'guest.create',
    GUEST_UPDATE: 'guest.update',
    FOLIO_CREATE: 'folio.create',
    FOLIO_UPDATE: 'folio.update',
};

module.exports = {
    auditLog,
    createAuditLog,
    logAuditEntry,
    CRITICAL_ACTIONS,
};

