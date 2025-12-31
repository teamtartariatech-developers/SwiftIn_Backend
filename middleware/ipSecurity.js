const { cacheIncr, cacheSet, cacheGet, cacheExists } = require('../services/redisClient');

// IP whitelist/blacklist storage (in-memory with Redis backup)
const ipWhitelist = new Set();
const ipBlacklist = new Set();

// Load IP lists from Redis on startup
async function loadIPLists() {
    try {
        const whitelist = await cacheGet('security:ip:whitelist') || [];
        const blacklist = await cacheGet('security:ip:blacklist') || [];
        
        whitelist.forEach(ip => ipWhitelist.add(ip));
        blacklist.forEach(ip => ipBlacklist.add(ip));
        
        console.log(`✅ Loaded ${whitelist.length} whitelisted IPs and ${blacklist.length} blacklisted IPs`);
    } catch (error) {
        console.error('Error loading IP lists:', error.message);
    }
}

// Initialize on module load
loadIPLists();

// Get real IP address from request
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           req.ip ||
           'unknown';
}

// Check if IP is whitelisted
function isWhitelisted(ip) {
    return ipWhitelist.has(ip);
}

// Check if IP is blacklisted
function isBlacklisted(ip) {
    return ipBlacklist.has(ip);
}

// Add IP to whitelist
async function addToWhitelist(ip) {
    ipWhitelist.add(ip);
    const list = Array.from(ipWhitelist);
    await cacheSet('security:ip:whitelist', list, 0); // No expiry
}

// Add IP to blacklist
async function addToBlacklist(ip, durationMinutes = 1440) { // Default 24 hours
    ipBlacklist.add(ip);
    const list = Array.from(ipBlacklist);
    await cacheSet('security:ip:blacklist', list, durationMinutes * 60);
    
    // Auto-remove after duration
    setTimeout(() => {
        ipBlacklist.delete(ip);
    }, durationMinutes * 60 * 1000);
}

// Remove IP from whitelist
async function removeFromWhitelist(ip) {
    ipWhitelist.delete(ip);
    const list = Array.from(ipWhitelist);
    await cacheSet('security:ip:whitelist', list, 0);
}

// Remove IP from blacklist
async function removeFromBlacklist(ip) {
    ipBlacklist.delete(ip);
    const list = Array.from(ipBlacklist);
    await cacheSet('security:ip:blacklist', list, 0);
}

// IP-based rate limiting
const rateLimitConfig = {
    windowMs: 60000, // 1 minute
    maxRequests: 100, // Max requests per window
    maxLoginAttempts: 5, // Max login attempts per window
    maxFailedAuth: 10, // Max failed auth attempts per window
    blockDuration: 3600, // Block duration in seconds (1 hour)
};

// Track suspicious activity
const suspiciousPatterns = {
    rapidRequests: 50, // requests per 10 seconds
    invalidPaths: 20, // 404s per minute
    sqlInjectionAttempts: 3, // SQL injection patterns detected
    xssAttempts: 3, // XSS patterns detected
};

// SQL injection patterns
const sqlInjectionPatterns = [
    /(\%27)|(\')|(\-\-)|(\%23)|(#)/i,
    /((\%3D)|(=))[^\n]*((\%27)|(\')|(\-\-)|(\%3B)|(;))/i,
    /\w*((\%27)|(\'))((\%6F)|o|(\%4F))((\%72)|r|(\%52))/i,
    /((\%27)|(\'))union/i,
    /exec(\s|\+)+(s|x)p\w+/i,
];

// XSS patterns
const xssPatterns = [
    /<script[^>]*>.*?<\/script>/gi,
    /<iframe[^>]*>.*?<\/iframe>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /<img[^>]+src[^>]*=.*javascript:/gi,
];

// Check for SQL injection
function detectSQLInjection(input) {
    if (typeof input !== 'string') return false;
    return sqlInjectionPatterns.some(pattern => pattern.test(input));
}

// Check for XSS
function detectXSS(input) {
    if (typeof input !== 'string') return false;
    return xssPatterns.some(pattern => pattern.test(input));
}

// Main IP security middleware
async function ipSecurity(req, res, next) {
    const ip = getClientIP(req);
    
    // Skip security for whitelisted IPs
    if (isWhitelisted(ip)) {
        return next();
    }
    
    // Block blacklisted IPs immediately
    if (isBlacklisted(ip)) {
        return res.status(403).json({
            message: 'Access denied. Your IP address has been blocked.',
            code: 'IP_BLOCKED'
        });
    }
    
    // Check for SQL injection in query params and body
    const checkInput = (obj) => {
        for (const key in obj) {
            if (typeof obj[key] === 'string') {
                if (detectSQLInjection(obj[key])) {
                    return { type: 'sql_injection', value: obj[key] };
                }
                if (detectXSS(obj[key])) {
                    return { type: 'xss', value: obj[key] };
                }
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                const result = checkInput(obj[key]);
                if (result) return result;
            }
        }
        return null;
    };
    
    const sqlInjection = checkInput(req.query) || checkInput(req.body) || checkInput(req.params);
    if (sqlInjection) {
        await recordSuspiciousActivity(ip, sqlInjection.type, req.path);
        const count = await cacheIncr(`security:suspicious:${ip}:${sqlInjection.type}`, 3600);
        
        if (count >= suspiciousPatterns[sqlInjection.type === 'sql_injection' ? 'sqlInjectionAttempts' : 'xssAttempts']) {
            await addToBlacklist(ip, 1440); // Block for 24 hours
            return res.status(403).json({
                message: 'Suspicious activity detected. Access denied.',
                code: 'SUSPICIOUS_ACTIVITY'
            });
        }
        
        return res.status(400).json({
            message: 'Invalid input detected.',
            code: 'INVALID_INPUT'
        });
    }
    
    // Rate limiting per IP
    const rateLimitKey = `ratelimit:ip:${ip}`;
    const requestCount = await cacheIncr(rateLimitKey, Math.ceil(rateLimitConfig.windowMs / 1000));
    
    if (requestCount > rateLimitConfig.maxRequests) {
        await recordSuspiciousActivity(ip, 'rate_limit_exceeded', req.path);
        return res.status(429).json({
            message: 'Too many requests. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: Math.ceil(rateLimitConfig.windowMs / 1000)
        });
    }
    
    // Track rapid requests (potential DDoS)
    const rapidKey = `security:rapid:${ip}`;
    const rapidCount = await cacheIncr(rapidKey, 10); // 10 second window
    
    if (rapidCount > suspiciousPatterns.rapidRequests) {
        await recordSuspiciousActivity(ip, 'rapid_requests', req.path);
        await addToBlacklist(ip, 60); // Block for 1 hour
        return res.status(429).json({
            message: 'Too many rapid requests. Your IP has been temporarily blocked.',
            code: 'RAPID_REQUESTS'
        });
    }
    
    // Add IP to request for logging
    req.clientIP = ip;
    
    next();
}

// Enhanced rate limiting for specific endpoints
function createRateLimiter(maxRequests, windowMs, endpoint) {
    return async (req, res, next) => {
        const ip = getClientIP(req);
        const key = `ratelimit:${endpoint}:${ip}`;
        const count = await cacheIncr(key, Math.ceil(windowMs / 1000));
        
        if (count > maxRequests) {
            return res.status(429).json({
                message: `Too many requests to ${endpoint}. Please try again later.`,
                code: 'RATE_LIMIT_EXCEEDED',
                retryAfter: Math.ceil(windowMs / 1000)
            });
        }
        
        next();
    };
}

// Login attempt rate limiting
async function loginRateLimit(req, res, next) {
    const ip = getClientIP(req);
    const key = `ratelimit:login:${ip}`;
    const count = await cacheIncr(key, Math.ceil(rateLimitConfig.windowMs / 1000));
    
    if (count > rateLimitConfig.maxLoginAttempts) {
        await recordSuspiciousActivity(ip, 'excessive_login_attempts', '/api/auth/login');
        return res.status(429).json({
            message: 'Too many login attempts. Please try again later.',
            code: 'LOGIN_RATE_LIMIT',
            retryAfter: Math.ceil(rateLimitConfig.windowMs / 1000)
        });
    }
    
    next();
}

// Failed authentication tracking
async function trackFailedAuth(ip, endpoint) {
    const key = `security:failed_auth:${ip}`;
    const count = await cacheIncr(key, 3600); // 1 hour window
    
    if (count >= rateLimitConfig.maxFailedAuth) {
        await recordSuspiciousActivity(ip, 'excessive_failed_auth', endpoint);
        await addToBlacklist(ip, 1440); // Block for 24 hours
    }
}

// Record suspicious activity
async function recordSuspiciousActivity(ip, type, endpoint) {
    const key = `security:activity:${ip}:${Date.now()}`;
    await cacheSet(key, {
        ip,
        type,
        endpoint,
        timestamp: new Date().toISOString(),
        userAgent: 'N/A' // Can be enhanced
    }, 86400); // Keep for 24 hours
}

// Get suspicious activity for an IP
async function getSuspiciousActivity(ip, hours = 24) {
    // This would require scanning keys, which is expensive
    // In production, use a sorted set or separate logging system
    return [];
}

module.exports = {
    ipSecurity,
    loginRateLimit,
    trackFailedAuth,
    createRateLimiter,
    getClientIP,
    isWhitelisted,
    isBlacklisted,
    addToWhitelist,
    addToBlacklist,
    removeFromWhitelist,
    removeFromBlacklist,
    getSuspiciousActivity,
};

