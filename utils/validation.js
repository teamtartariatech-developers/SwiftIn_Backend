const mongoose = require('mongoose');

/**
 * Validation utility for Backend routes
 * Provides parameter validation and default value setting
 */

/**
 * Validates and sets default values for request parameters
 * @param {Object} params - Request body/query/params object
 * @param {Object} schema - Validation schema with rules
 * @returns {Object} - Validated and normalized parameters
 */
function validateAndSetDefaults(params, schema) {
    const validated = {};
    const errors = [];

    for (const [key, rules] of Object.entries(schema)) {
        const value = params[key];
        const isRequired = rules.required === true;
        const hasValue = value !== undefined && value !== null && value !== '';

        // Check required fields
        if (isRequired && !hasValue) {
            errors.push(`${key} is required`);
            continue;
        }

        // Set default if value is missing and default is provided
        if (!hasValue && rules.default !== undefined) {
            validated[key] = typeof rules.default === 'function' ? rules.default() : rules.default;
            continue;
        }

        // Skip validation if value is not provided and not required
        if (!hasValue) {
            continue;
        }

        // Type validation
        if (rules.type) {
            const typeCheck = validateType(value, rules.type, key);
            if (!typeCheck.valid) {
                errors.push(typeCheck.error);
                continue;
            }
            // Convert type if needed
            validated[key] = typeCheck.value;
        } else {
            validated[key] = value;
        }

        // Additional validations
        if (rules.min !== undefined && typeof validated[key] === 'number' && validated[key] < rules.min) {
            errors.push(`${key} must be at least ${rules.min}`);
        }

        if (rules.max !== undefined && typeof validated[key] === 'number' && validated[key] > rules.max) {
            errors.push(`${key} must be at most ${rules.max}`);
        }

        if (rules.enum && !rules.enum.includes(validated[key])) {
            errors.push(`${key} must be one of: ${rules.enum.join(', ')}`);
        }

        if (rules.pattern && typeof validated[key] === 'string' && !rules.pattern.test(validated[key])) {
            errors.push(`${key} format is invalid`);
        }

        if (rules.custom && typeof rules.custom === 'function') {
            const customResult = rules.custom(validated[key], validated);
            if (customResult !== true) {
                errors.push(customResult || `${key} validation failed`);
            }
        }

        // ObjectId validation
        if (rules.isObjectId && !mongoose.Types.ObjectId.isValid(validated[key])) {
            errors.push(`${key} must be a valid ObjectId`);
        }

        // Array validation
        if (rules.isArray && !Array.isArray(validated[key])) {
            errors.push(`${key} must be an array`);
        }

        // Date validation
        if (rules.isDate) {
            const date = new Date(validated[key]);
            if (isNaN(date.getTime())) {
                errors.push(`${key} must be a valid date`);
            } else {
                validated[key] = date;
            }
        }
    }

    return {
        validated,
        errors,
        isValid: errors.length === 0
    };
}

/**
 * Validates type and converts if needed
 */
function validateType(value, type, key) {
    switch (type) {
        case 'string':
            return { valid: typeof value === 'string', value: String(value), error: null };
        case 'number':
            const num = Number(value);
            return { 
                valid: !isNaN(num) && isFinite(num), 
                value: num, 
                error: isNaN(num) ? `${key} must be a number` : null 
            };
        case 'boolean':
            if (typeof value === 'boolean') return { valid: true, value, error: null };
            if (value === 'true' || value === 'false' || value === 1 || value === 0) {
                return { valid: true, value: value === 'true' || value === 1, error: null };
            }
            return { valid: false, value: null, error: `${key} must be a boolean` };
        case 'array':
            return { valid: Array.isArray(value), value, error: Array.isArray(value) ? null : `${key} must be an array` };
        case 'object':
            return { valid: typeof value === 'object' && !Array.isArray(value) && value !== null, value, error: null };
        default:
            return { valid: true, value, error: null };
    }
}

/**
 * Validates pagination parameters
 */
function validatePagination(query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 15));
    const search = query.search || '';
    const status = query.status || '';

    return { page, limit, search, status };
}

/**
 * Validates date range
 */
function validateDateRange(checkInDate, checkOutDate) {
    const errors = [];
    
    if (!checkInDate || !checkOutDate) {
        errors.push('Both checkInDate and checkOutDate are required');
        return { isValid: false, errors, checkIn: null, checkOut: null };
    }

    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);

    if (isNaN(checkIn.getTime())) {
        errors.push('checkInDate must be a valid date');
    }

    if (isNaN(checkOut.getTime())) {
        errors.push('checkOutDate must be a valid date');
    }

    if (errors.length === 0 && checkIn >= checkOut) {
        errors.push('checkOutDate must be after checkInDate');
    }

    return {
        isValid: errors.length === 0,
        errors,
        checkIn: errors.length === 0 ? checkIn : null,
        checkOut: errors.length === 0 ? checkOut : null
    };
}

/**
 * Normalizes payment method
 */
function normalizePaymentMethod(method) {
    if (!method) return 'Cash';
    
    const methodLower = String(method).toLowerCase().trim();
    const validMethods = {
        'cash': 'Cash',
        'credit card': 'Credit Card',
        'creditcard': 'Credit Card',
        'debit card': 'Debit Card',
        'debitcard': 'Debit Card',
        'upi': 'UPI',
        'bank transfer': 'Bank Transfer',
        'banktransfer': 'Bank Transfer',
        'wallet': 'Wallet',
        'cheque': 'Cheque',
        'check': 'Cheque',
        'card': 'Credit Card'
    };
    
    return validMethods[methodLower] || 'Cash';
}

/**
 * Validates ObjectId
 */
function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Validates email format
 */
function isValidEmail(email) {
    if (!email) return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Validates phone number (basic validation)
 */
function isValidPhone(phone) {
    if (!phone) return false;
    const phoneRegex = /^[\d\s\-\+\(\)]+$/;
    return phoneRegex.test(String(phone)) && String(phone).replace(/\D/g, '').length >= 10;
}

module.exports = {
    validateAndSetDefaults,
    validatePagination,
    validateDateRange,
    normalizePaymentMethod,
    isValidObjectId,
    isValidEmail,
    isValidPhone
};

