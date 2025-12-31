const { cacheGet, cacheSet, cacheDel, cacheDelPattern } = require('./redisClient');

// Cache service for frequently accessed data
// Optimized for microsecond-level performance in hospitality operations

const CACHE_KEYS = {
    ROOM_TYPES: (propertyId) => `cache:roomtypes:${propertyId}`,
    ROOMS: (propertyId) => `cache:rooms:${propertyId}`,
    ROOMS_BY_TYPE: (propertyId, roomTypeId) => `cache:rooms:${propertyId}:type:${roomTypeId}`,
    AVAILABILITY: (propertyId, roomTypeId, checkIn, checkOut) => 
        `cache:availability:${propertyId}:${roomTypeId}:${checkIn}:${checkOut}`,
    RATES: (propertyId, roomTypeId, date) => `cache:rates:${propertyId}:${roomTypeId}:${date}`,
    PROPERTY_SETTINGS: (propertyId) => `cache:settings:${propertyId}`,
    TAX_RULES: (propertyId) => `cache:taxrules:${propertyId}`,
    SERVICE_FEES: (propertyId) => `cache:servicefees:${propertyId}`,
    GUEST_PROFILE: (propertyId, guestId) => `cache:guest:${propertyId}:${guestId}`,
    RESERVATION: (propertyId, reservationId) => `cache:reservation:${propertyId}:${reservationId}`,
};

const CACHE_TTL = {
    ROOM_TYPES: 1800, // 30 minutes
    ROOMS: 900, // 15 minutes
    AVAILABILITY: 300, // 5 minutes (short TTL as availability changes frequently)
    RATES: 3600, // 1 hour
    PROPERTY_SETTINGS: 3600, // 1 hour
    TAX_RULES: 3600, // 1 hour
    SERVICE_FEES: 3600, // 1 hour
    GUEST_PROFILE: 1800, // 30 minutes
    RESERVATION: 600, // 10 minutes
};

// Generic cache get with fallback
async function getCached(key, fetchFn, ttl) {
    try {
        // Try cache first
        const cached = await cacheGet(key);
        if (cached !== null) {
            return cached;
        }

        // Cache miss - fetch from source
        const data = await fetchFn();
        
        // Store in cache
        if (data !== null && data !== undefined) {
            await cacheSet(key, data, ttl);
        }
        
        return data;
    } catch (error) {
        console.error(`Cache error for key ${key}:`, error.message);
        // On cache error, fallback to direct fetch
        return await fetchFn();
    }
}

// Room Types cache
async function getRoomTypes(propertyId, fetchFn) {
    const key = CACHE_KEYS.ROOM_TYPES(propertyId);
    return getCached(key, fetchFn, CACHE_TTL.ROOM_TYPES);
}

async function invalidateRoomTypes(propertyId) {
    await cacheDel(CACHE_KEYS.ROOM_TYPES(propertyId));
    // Also invalidate related caches
    await cacheDelPattern(`cache:rooms:${propertyId}*`);
    await cacheDelPattern(`cache:availability:${propertyId}*`);
}

// Rooms cache
async function getRooms(propertyId, fetchFn) {
    const key = CACHE_KEYS.ROOMS(propertyId);
    return getCached(key, fetchFn, CACHE_TTL.ROOMS);
}

async function getRoomsByType(propertyId, roomTypeId, fetchFn) {
    const key = CACHE_KEYS.ROOMS_BY_TYPE(propertyId, roomTypeId);
    return getCached(key, fetchFn, CACHE_TTL.ROOMS);
}

async function invalidateRooms(propertyId, roomTypeId = null) {
    if (roomTypeId) {
        await cacheDel(CACHE_KEYS.ROOMS_BY_TYPE(propertyId, roomTypeId));
    }
    await cacheDel(CACHE_KEYS.ROOMS(propertyId));
    await cacheDelPattern(`cache:availability:${propertyId}*`);
}

// Availability cache
async function getAvailability(propertyId, roomTypeId, checkIn, checkOut, fetchFn) {
    const key = CACHE_KEYS.AVAILABILITY(propertyId, roomTypeId, checkIn, checkOut);
    return getCached(key, fetchFn, CACHE_TTL.AVAILABILITY);
}

async function invalidateAvailability(propertyId, roomTypeId = null) {
    if (roomTypeId) {
        await cacheDelPattern(`cache:availability:${propertyId}:${roomTypeId}:*`);
    } else {
        await cacheDelPattern(`cache:availability:${propertyId}:*`);
    }
}

// Rates cache
async function getRates(propertyId, roomTypeId, date, fetchFn) {
    const key = CACHE_KEYS.RATES(propertyId, roomTypeId, date);
    return getCached(key, fetchFn, CACHE_TTL.RATES);
}

async function invalidateRates(propertyId, roomTypeId = null) {
    if (roomTypeId) {
        await cacheDelPattern(`cache:rates:${propertyId}:${roomTypeId}:*`);
    } else {
        await cacheDelPattern(`cache:rates:${propertyId}:*`);
    }
}

// Property settings cache
async function getPropertySettings(propertyId, fetchFn) {
    const key = CACHE_KEYS.PROPERTY_SETTINGS(propertyId);
    return getCached(key, fetchFn, CACHE_TTL.PROPERTY_SETTINGS);
}

async function invalidatePropertySettings(propertyId) {
    await cacheDel(CACHE_KEYS.PROPERTY_SETTINGS(propertyId));
}

// Tax rules cache
async function getTaxRules(propertyId, fetchFn) {
    const key = CACHE_KEYS.TAX_RULES(propertyId);
    return getCached(key, fetchFn, CACHE_TTL.TAX_RULES);
}

async function invalidateTaxRules(propertyId) {
    await cacheDel(CACHE_KEYS.TAX_RULES(propertyId));
}

// Service fees cache
async function getServiceFees(propertyId, fetchFn) {
    const key = CACHE_KEYS.SERVICE_FEES(propertyId);
    return getCached(key, fetchFn, CACHE_TTL.SERVICE_FEES);
}

async function invalidateServiceFees(propertyId) {
    await cacheDel(CACHE_KEYS.SERVICE_FEES(propertyId));
}

// Guest profile cache
async function getGuestProfile(propertyId, guestId, fetchFn) {
    const key = CACHE_KEYS.GUEST_PROFILE(propertyId, guestId);
    return getCached(key, fetchFn, CACHE_TTL.GUEST_PROFILE);
}

async function invalidateGuestProfile(propertyId, guestId) {
    await cacheDel(CACHE_KEYS.GUEST_PROFILE(propertyId, guestId));
}

// Reservation cache
async function getReservation(propertyId, reservationId, fetchFn) {
    const key = CACHE_KEYS.RESERVATION(propertyId, reservationId);
    return getCached(key, fetchFn, CACHE_TTL.RESERVATION);
}

async function invalidateReservation(propertyId, reservationId = null) {
    if (reservationId) {
        await cacheDel(CACHE_KEYS.RESERVATION(propertyId, reservationId));
    } else {
        await cacheDelPattern(`cache:reservation:${propertyId}:*`);
    }
}

// Invalidate all caches for a property (use with caution)
async function invalidateAllPropertyCache(propertyId) {
    await cacheDelPattern(`cache:*:${propertyId}*`);
}

module.exports = {
    getRoomTypes,
    invalidateRoomTypes,
    getRooms,
    getRoomsByType,
    invalidateRooms,
    getAvailability,
    invalidateAvailability,
    getRates,
    invalidateRates,
    getPropertySettings,
    invalidatePropertySettings,
    getTaxRules,
    invalidateTaxRules,
    getServiceFees,
    invalidateServiceFees,
    getGuestProfile,
    invalidateGuestProfile,
    getReservation,
    invalidateReservation,
    invalidateAllPropertyCache,
    getCached, // Export generic function for custom caching
};

