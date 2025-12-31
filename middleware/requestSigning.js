const crypto = require('crypto');
const { cacheGet, cacheSet, cacheIncr } = require('../services/redisClient');

// Request signing for API integrity verification
// This prevents request tampering and replay attacks

const REQUEST_SIGNING_ENABLED = process.env.REQUEST_SIGNING_ENABLED === 'true';
const SIGNING_SECRET = process.env.REQUEST_SIGNING_SECRET || process.env.JWT_SECRET || 'default-secret-change-in-production';
const NONCE_TTL = 300; // 5 minutes

// Generate request signature
function generateSignature(method, path, body, timestamp, nonce) {
    const payload = `${method}:${path}:${JSON.stringify(body)}:${timestamp}:${nonce}`;
    return crypto
        .createHmac('sha256', SIGNING_SECRET)
        .update(payload)
        .digest('hex');
}

// Verify request signature
async function verifySignature(req) {
    if (!REQUEST_SIGNING_ENABLED) {
        return true; // Skip if not enabled
    }

    const signature = req.headers['x-request-signature'];
    const timestamp = req.headers['x-request-timestamp'];
    const nonce = req.headers['x-request-nonce'];

    if (!signature || !timestamp || !nonce) {
        return false;
    }

    // Check timestamp (prevent replay attacks)
    const requestTime = parseInt(timestamp);
    const currentTime = Date.now();
    const timeDiff = Math.abs(currentTime - requestTime);

    // Allow 5 minute window for clock skew
    if (timeDiff > 300000) {
        return false;
    }

    // Check nonce (prevent replay attacks)
    const nonceKey = `nonce:${nonce}`;
    const nonceExists = await cacheGet(nonceKey);
    if (nonceExists) {
        return false; // Nonce already used
    }

    // Store nonce for 5 minutes
    await cacheSet(nonceKey, true, NONCE_TTL);

    // Generate expected signature
    const body = req.body || {};
    const expectedSignature = generateSignature(
        req.method,
        req.path,
        body,
        timestamp,
        nonce
    );

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

// Request signing middleware (optional, for enhanced security)
const requestSigning = async (req, res, next) => {
    // Skip signing for public endpoints
    const publicPaths = ['/api/auth/login', '/api/auth/register', '/test'];
    if (publicPaths.some(path => req.path.startsWith(path))) {
        return next();
    }

    // Skip if signing is disabled
    if (!REQUEST_SIGNING_ENABLED) {
        return next();
    }

    try {
        const isValid = await verifySignature(req);
        if (!isValid) {
            return res.status(401).json({
                message: 'Invalid request signature',
                code: 'INVALID_SIGNATURE'
            });
        }
        next();
    } catch (error) {
        console.error('Request signing error:', error);
        return res.status(500).json({
            message: 'Request verification failed',
            code: 'SIGNATURE_ERROR'
        });
    }
};

module.exports = {
    requestSigning,
    generateSignature,
    verifySignature,
};

