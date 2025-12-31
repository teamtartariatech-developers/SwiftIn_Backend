# Backend Optimization & Security Enhancements

This document outlines the comprehensive performance optimizations and security enhancements implemented for the Phoenix Hospitality Management System backend.

## 🚀 Performance Optimizations

### Redis Caching
- **Purpose**: Microsecond-level response times for critical hospitality operations
- **Implementation**: 
  - Session caching for authenticated users
  - Tenant context caching
  - User data caching
  - Frequently accessed data caching (room types, rooms, availability, rates, settings)

### Database Query Optimizations
- **Lean Queries**: Using `.lean()` for read-only operations to return plain JavaScript objects (faster than Mongoose documents)
- **Selective Fields**: Using `.select()` to fetch only required fields
- **Indexed Queries**: All queries use indexed fields (property, _id) for optimal performance

### Response Compression
- **Gzip Compression**: Enabled for responses > 1KB
- **CPU Balance**: Level 6 compression (balance between size and CPU usage)

### Performance Monitoring
- Automatic logging of slow requests (> 1 second)
- Error logging for very slow requests (> 5 seconds)
- Request duration tracking

## 🔒 Security Enhancements

### IP-Based Security
- **Rate Limiting**: 
  - General: 100 requests per minute per IP
  - Login: 5 attempts per minute per IP
  - Failed Auth: 10 attempts per hour (auto-block after threshold)
- **IP Whitelist/Blacklist**: 
  - Whitelist: Trusted IPs bypass security checks
  - Blacklist: Blocked IPs automatically rejected
  - Auto-blocking for suspicious activity
- **Suspicious Activity Detection**:
  - Rapid requests (> 50 requests per 10 seconds)
  - SQL injection attempts
  - XSS attempts
  - Excessive failed authentication

### Input Validation & Sanitization
- **SQL Injection Prevention**: Pattern detection and blocking
- **XSS Prevention**: Script tag and event handler detection
- **Input Sanitization**: Removal of null bytes and control characters
- **Request Size Limits**: 10MB maximum payload size

### Security Headers (Helmet)
- **Content Security Policy**: Restricts resource loading
- **HSTS**: HTTP Strict Transport Security (1 year, includeSubDomains)
- **XSS Filter**: Browser XSS protection
- **No Sniff**: Prevents MIME type sniffing
- **Frame Guard**: Prevents clickjacking
- **Referrer Policy**: Controls referrer information

### Authentication Enhancements
- **JWT Token Caching**: Session tokens cached in Redis for fast validation
- **User Session Caching**: User data cached to avoid database lookups
- **Failed Auth Tracking**: Automatic IP blocking after excessive failures
- **Token Validation**: Enhanced token verification with caching

### Request Validation
- **Content-Type Validation**: Only accepts `application/json` for POST/PUT/PATCH
- **Request Timeout**: 30-second timeout for all requests
- **Body Parser Limits**: 10MB maximum request body

## 📦 New Dependencies

```json
{
  "compression": "^1.7.4",      // Response compression
  "express-validator": "^7.2.0", // Input validation
  "helmet": "^8.0.0",           // Security headers
  "redis": "^4.7.0"             // Redis client
}
```

## 🔧 Configuration

### Environment Variables
Add to `.env`:
```env
# Redis Configuration
REDIS_HOST=localhost          # Redis server host
REDIS_PORT=6379              # Redis server port
REDIS_PASSWORD=             # Redis password (if required)

# Existing variables
MONGO_URI=                  # MongoDB connection string
JWT_SECRET=                 # JWT secret key
PORT=3000                   # Server port
```

### Redis Setup
1. **Local Development**: Install Redis locally or use Docker
   ```bash
   docker run -d -p 6379:6379 redis:latest
   ```

2. **Production**: Use managed Redis service (AWS ElastiCache, Redis Cloud, etc.)

3. **Graceful Degradation**: Application continues to work without Redis (caching disabled)

## 📊 Cache TTLs (Time To Live)

| Cache Type | TTL | Reason |
|------------|-----|--------|
| User Sessions | 1 hour | Balance between security and performance |
| Tenant Context | 30 minutes | Property data changes infrequently |
| User Data | 15 minutes | User data may change |
| Room Types | 30 minutes | Room types change infrequently |
| Rooms | 15 minutes | Room status changes more frequently |
| Availability | 5 minutes | Availability changes frequently |
| Rates | 1 hour | Rates change infrequently |
| Property Settings | 1 hour | Settings change infrequently |
| Tax Rules | 1 hour | Tax rules change infrequently |
| Guest Profiles | 30 minutes | Guest data may update |

## 🛡️ Security Features

### IP Security Management
```javascript
// Add IP to whitelist
await addToWhitelist('192.168.1.100');

// Add IP to blacklist (24 hours)
await addToBlacklist('192.168.1.200', 1440);

// Remove from lists
await removeFromWhitelist('192.168.1.100');
await removeFromBlacklist('192.168.1.200');
```

### Rate Limiting
- Automatic rate limiting per IP
- Endpoint-specific rate limiting available
- Configurable limits in `middleware/ipSecurity.js`

### Suspicious Activity Patterns
- **Rapid Requests**: > 50 requests per 10 seconds → 1 hour block
- **SQL Injection**: 3 attempts → 24 hour block
- **XSS Attempts**: 3 attempts → 24 hour block
- **Failed Auth**: 10 attempts → 24 hour block

## 🎯 Performance Targets

- **Authentication**: < 10ms (with Redis cache)
- **Room Type Queries**: < 5ms (cached)
- **Availability Checks**: < 50ms (cached, < 200ms uncached)
- **General API Responses**: < 100ms (cached endpoints)

## 🔄 Cache Invalidation

Cache is automatically invalidated when:
- Room types are created/updated/deleted
- Rooms are created/updated/deleted
- Reservations are created/updated (availability cache)
- User data changes (user cache)
- Settings are updated (settings cache)

## 📝 Best Practices

1. **Always use `.lean()`** for read-only queries
2. **Use `.select()`** to fetch only required fields
3. **Cache frequently accessed data** using cacheService
4. **Invalidate cache** when data is modified
5. **Monitor slow requests** via performance logs
6. **Review security logs** for suspicious activity

## 🚨 Monitoring

### Performance Monitoring
- Slow requests logged automatically
- Request duration tracked per endpoint
- Cache hit/miss rates (can be added to monitoring)

### Security Monitoring
- Failed authentication attempts tracked
- Suspicious activity logged
- IP blocking events logged
- Rate limit violations logged

## 🔍 Troubleshooting

### Redis Connection Issues
- Application continues without Redis (graceful degradation)
- Check Redis server status
- Verify connection credentials
- Check network connectivity

### Performance Issues
- Check Redis cache hit rates
- Review slow request logs
- Verify database indexes exist
- Check query patterns (use `.explain()`)

### Security Issues
- Review IP blacklist/whitelist
- Check rate limit configurations
- Review suspicious activity logs
- Verify security headers are set

## 📚 Additional Resources

- [Redis Documentation](https://redis.io/docs/)
- [Helmet Documentation](https://helmetjs.github.io/)
- [Express Best Practices](https://expressjs.com/en/advanced/best-practice-performance.html)
- [MongoDB Performance](https://www.mongodb.com/docs/manual/administration/analyzing-mongodb-performance/)

---

**Last Updated**: 2024
**Version**: 1.0.0

