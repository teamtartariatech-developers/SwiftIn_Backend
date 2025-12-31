const helmet = require('helmet');
const { body, validationResult } = require('express-validator');

// Security headers middleware
const securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding for hospitality integrations
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    xssFilter: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    permittedCrossDomainPolicies: false,
});

// Request size limits
const requestSizeLimit = (req, res, next) => {
    const maxSize = 10 * 1024 * 1024; // 10MB
    const contentLength = parseInt(req.headers['content-length'] || '0');
    
    if (contentLength > maxSize) {
        return res.status(413).json({
            message: 'Request entity too large',
            code: 'PAYLOAD_TOO_LARGE'
        });
    }
    
    next();
};

// Input sanitization
function sanitizeInput(input) {
    if (typeof input === 'string') {
        // Remove null bytes
        input = input.replace(/\0/g, '');
        // Remove control characters except newlines and tabs
        input = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
        // Trim whitespace
        input = input.trim();
    } else if (typeof input === 'object' && input !== null) {
        for (const key in input) {
            input[key] = sanitizeInput(input[key]);
        }
    }
    return input;
}

// Sanitize request body
const sanitizeBody = (req, res, next) => {
    if (req.body) {
        req.body = sanitizeInput(req.body);
    }
    if (req.query) {
        req.query = sanitizeInput(req.query);
    }
    if (req.params) {
        req.params = sanitizeInput(req.params);
    }
    next();
};

// Validation error handler
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({
            message: 'Validation failed',
            errors: errors.array(),
            code: 'VALIDATION_ERROR'
        });
    }
    next();
};

// Common validation rules
const commonValidations = {
    email: body('email')
        .optional()
        .isEmail()
        .normalizeEmail()
        .withMessage('Invalid email format'),
    
    password: body('password')
        .optional()
        .isLength({ min: 8 })
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must be at least 8 characters with uppercase, lowercase, and number'),
    
    objectId: body('id')
        .optional()
        .isMongoId()
        .withMessage('Invalid ID format'),
    
    propertyCode: body('propertyCode')
        .optional()
        .trim()
        .isLength({ min: 2, max: 20 })
        .matches(/^[A-Z0-9_-]+$/)
        .withMessage('Property code must be 2-20 alphanumeric characters'),
};

// Brute force protection for authentication
const bruteForceProtection = async (req, res, next) => {
    // This is handled by IP security middleware, but we can add additional checks here
    next();
};

// Request timeout
const requestTimeout = (timeoutMs = 30000) => {
    return (req, res, next) => {
        req.setTimeout(timeoutMs, () => {
            if (!res.headersSent) {
                res.status(408).json({
                    message: 'Request timeout',
                    code: 'REQUEST_TIMEOUT'
                });
            }
        });
        next();
    };
};

// Performance monitoring
const performanceMonitor = (req, res, next) => {
    const startTime = process.hrtime.bigint();
    
    res.on('finish', () => {
        const duration = Number(process.hrtime.bigint() - startTime) / 1000000; // Convert to milliseconds
        const logData = {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration: `${duration.toFixed(2)}ms`,
            ip: req.clientIP || req.ip,
        };
        
        // Log slow requests (> 1 second)
        if (duration > 1000) {
            console.warn('⚠️ Slow Request:', logData);
        }
        
        // Log very slow requests (> 5 seconds)
        if (duration > 5000) {
            console.error('❌ Very Slow Request:', logData);
        }
    });
    
    next();
};

// API versioning check
const apiVersionCheck = (req, res, next) => {
    // Can add version checking logic here
    next();
};

// Content type validation
const contentTypeValidation = (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const contentType = req.headers['content-type'];
        if (!contentType || !contentType.includes('application/json')) {
            return res.status(415).json({
                message: 'Unsupported Media Type. Content-Type must be application/json',
                code: 'UNSUPPORTED_MEDIA_TYPE'
            });
        }
    }
    next();
};

module.exports = {
    securityHeaders,
    requestSizeLimit,
    sanitizeBody,
    handleValidationErrors,
    commonValidations,
    bruteForceProtection,
    requestTimeout,
    performanceMonitor,
    apiVersionCheck,
    contentTypeValidation,
};

