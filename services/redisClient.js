const redis = require('redis');

let redisClient = null;
let isConnected = false;
let reconnectAttempts = 0;
let lastReconnectLog = 0;
let hasLoggedMaxAttempts = false;
let isReconnecting = false;

const REDIS_CONFIG = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    connectTimeout: 10000,
    socket: {
        keepAlive: true,
        reconnectStrategy: (times) => {
            reconnectAttempts = times;
            if (times > 10) {
                if (!hasLoggedMaxAttempts) {
                    console.error('Redis: Max reconnection attempts reached. Redis will be disabled.');
                    hasLoggedMaxAttempts = true;
                }
                return new Error('Redis connection failed');
            }
            return Math.min(times * 50, 2000);
        }
    }
};

async function connectRedis() {
    if (redisClient && isConnected) {
        return redisClient;
    }

    // Reset flags for a fresh connection attempt
    if (!redisClient) {
        reconnectAttempts = 0;
        hasLoggedMaxAttempts = false;
        isReconnecting = false;
    }

    try {
        redisClient = redis.createClient(REDIS_CONFIG);
        
        redisClient.on('error', (err) => {
            // Only log errors if we haven't reached max attempts and not currently reconnecting
            if (!hasLoggedMaxAttempts && !isReconnecting) {
                // Suppress common connection errors during startup
                if (!err.message.includes('ECONNREFUSED') && !err.message.includes('ENOTFOUND')) {
                    console.error('Redis Client Error:', err.message);
                }
            }
            isConnected = false;
        });

        redisClient.on('connect', () => {
            if (!isReconnecting) {
                console.log('🔄 Connecting to Redis...');
            }
        });

        redisClient.on('ready', () => {
            console.log('✅ Redis Connected and Ready!');
            isConnected = true;
            reconnectAttempts = 0;
            lastReconnectLog = 0;
            hasLoggedMaxAttempts = false;
            isReconnecting = false;
        });

        redisClient.on('reconnecting', () => {
            isReconnecting = true;
            isConnected = false;
            // Only log reconnection attempts every 5 attempts or after 10 seconds
            const now = Date.now();
            if (reconnectAttempts % 5 === 0 || (now - lastReconnectLog) > 10000) {
                console.log(`🔄 Redis Reconnecting... (attempt ${reconnectAttempts})`);
                lastReconnectLog = now;
            }
        });

        redisClient.on('end', () => {
            console.log('⚠️ Redis Connection Ended');
            isConnected = false;
        });

        await redisClient.connect();
        return redisClient;
    } catch (error) {
        console.error('❌ Redis Connection Failed:', error.message);
        // Don't throw - allow app to continue without Redis (graceful degradation)
        isConnected = false;
        return null;
    }
}

async function getRedisClient() {
    // Don't try to reconnect if we've exceeded max attempts
    if (hasLoggedMaxAttempts) {
        return null;
    }
    if (!redisClient || !isConnected) {
        await connectRedis();
    }
    return redisClient;
}

// Cache operations with fallback
async function cacheGet(key) {
    try {
        const client = await getRedisClient();
        if (!client) return null;
        const value = await client.get(key);
        return value ? JSON.parse(value) : null;
    } catch (error) {
        console.error(`Redis GET error for key ${key}:`, error.message);
        return null;
    }
}

async function cacheSet(key, value, ttlSeconds = 3600) {
    try {
        const client = await getRedisClient();
        if (!client) return false;
        await client.setEx(key, ttlSeconds, JSON.stringify(value));
        return true;
    } catch (error) {
        console.error(`Redis SET error for key ${key}:`, error.message);
        return false;
    }
}

async function cacheDel(key) {
    try {
        const client = await getRedisClient();
        if (!client) return false;
        await client.del(key);
        return true;
    } catch (error) {
        console.error(`Redis DEL error for key ${key}:`, error.message);
        return false;
    }
}

async function cacheDelPattern(pattern) {
    try {
        const client = await getRedisClient();
        if (!client) return false;
        const keys = await client.keys(pattern);
        if (keys.length > 0) {
            await client.del(keys);
        }
        return true;
    } catch (error) {
        console.error(`Redis DEL pattern error for ${pattern}:`, error.message);
        return false;
    }
}

async function cacheIncr(key, ttlSeconds = 3600) {
    try {
        const client = await getRedisClient();
        if (!client) return null;
        const count = await client.incr(key);
        if (count === 1) {
            await client.expire(key, ttlSeconds);
        }
        return count;
    } catch (error) {
        console.error(`Redis INCR error for key ${key}:`, error.message);
        return null;
    }
}

async function cacheExists(key) {
    try {
        const client = await getRedisClient();
        if (!client) return false;
        return await client.exists(key) === 1;
    } catch (error) {
        console.error(`Redis EXISTS error for key ${key}:`, error.message);
        return false;
    }
}

async function disconnectRedis() {
    if (redisClient && isConnected) {
        await redisClient.quit();
        isConnected = false;
        redisClient = null;
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    await disconnectRedis();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await disconnectRedis();
    process.exit(0);
});

module.exports = {
    connectRedis,
    getRedisClient,
    cacheGet,
    cacheSet,
    cacheDel,
    cacheDelPattern,
    cacheIncr,
    cacheExists,
    disconnectRedis,
    isConnected: () => isConnected,
};

