const express = require('express');
const http = require('http');
const compression = require('compression');
const app = express();
const dotenv = require('dotenv');
const connectDB = require('./db/dbcon');
const { connectRedis } = require('./services/redisClient');
const test = require('./routes/test');
const reservations = require('./routes/frontOffice/reservations');
const foundation = require('./routes/foundation');
const rateManager = require('./routes/distribution/rateManager');
const promotion = require('./routes/distribution/promotion');
const inventoryManager = require('./routes/distribution/inventoryManager');
const guestManagement = require('./routes/guestManagement/guests');
const reputation = require('./routes/guestManagement/reputation');
const communication = require('./routes/guestManagement/communication');
const settings = require('./routes/settings/settings');
const folios = require('./routes/billingFinance/folios');
const auth = require('./routes/auth/auth');
const reports = require('./routes/reports/reports');
const mailer = require('./routes/mailer');
const independentMailer = require('./independent/mailer');
const housekeeping = require('./routes/housekeeping');
const nightAudit = require('./routes/nightAudit/nightAudit');
const cityLedger = require('./routes/cityLedger/cityLedger');
const travelAgent = require('./routes/travelAgent/travelAgent');
const paymaster = require('./routes/paymaster/paymaster');
const groupReservation = require('./routes/groupReservation/groupReservation');
const { initWebsockets } = require('./services/websocketManager');

// Security and Performance Middleware
const {
    securityHeaders,
    requestSizeLimit,
    sanitizeBody,
    performanceMonitor,
    requestTimeout,
    contentTypeValidation,
} = require('./middleware/security');
const { ipSecurity } = require('./middleware/ipSecurity');

dotenv.config();

// Initialize Redis connection
connectRedis().catch(err => {
    console.warn('⚠️ Redis connection failed, continuing without cache:', err.message);
});

// Apply security headers first
app.use(securityHeaders);

// Compression for faster responses
app.use(compression({
    level: 6, // Balance between compression and CPU
    threshold: 1024, // Only compress responses > 1KB
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            return false;
        }
        return compression.filter(req, res);
    }
}));

// Request timeout (30 seconds)
app.use(requestTimeout(30000));

// Request size limit
app.use(requestSizeLimit);

// Content type validation
app.use(contentTypeValidation);

// Performance monitoring
app.use(performanceMonitor);

// IP-based security (must be early in the chain)
app.use(ipSecurity);

// Body parsing with size limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Input sanitization
app.use(sanitizeBody);

// Enable CORS for specific origins only
const allowedOrigins = [
    'https://app.swif10.com',
    'https://www.app.swif10.com',
    'https://bookings.swif10.com'
];

// Function to check if origin is allowed
const isOriginAllowed = (origin) => {
    if (!origin) return false;
    
    // Check exact match in allowed origins
    if (allowedOrigins.includes(origin)) {
        return true;
    }
    
    // Allow localhost with any port
    const localhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    if (localhostRegex.test(origin)) {
        return true;
    }
    
    // Allow LAN IP addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    const lanIpRegex = /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+)(:\d+)?$/;
    if (lanIpRegex.test(origin)) {
        return true;
    }
    
    return false;
};

app.use((req, res, next) => {
    const origin = req.headers.origin;
    
    // Debug logging (remove in production)
    if (origin) {
        console.log(`[CORS] Request from origin: ${origin}, Method: ${req.method}, Path: ${req.path}`);
        console.log(`[CORS] Origin allowed: ${isOriginAllowed(origin)}`);
    }
    
    // Always set CORS headers for preflight requests
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        // Only set Access-Control-Allow-Origin if origin is allowed
        if (origin && isOriginAllowed(origin)) {
            res.header('Access-Control-Allow-Origin', origin);
            console.log(`[CORS] Preflight allowed for: ${origin}`);
        } else {
            console.log(`[CORS] Preflight rejected for: ${origin || 'no origin'}`);
        }
        return res.sendStatus(200);
    }
    
    // For actual requests, only set Access-Control-Allow-Origin if origin is allowed
    if (origin && isOriginAllowed(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    
    next();
});

dotenv.config();

app.get('/', (req, res) => {
    res.send('This is intelligent Hospitality Management System');
});

app.use('/test', test);
app.use('/api/foundation', foundation);
app.use('/api/frontoffice/reservations', reservations);
app.use('/api/distribution/ratemanager', rateManager );
app.use('/api/distribution/promotion', promotion);
app.use('/api/distribution/inventorymanager', inventoryManager);
app.use('/api/guestmanagement', guestManagement);
app.use('/api/guestmanagement/reputation', reputation);
app.use('/api/guestmanagement/communication', communication);
app.use('/api/settings', settings);
app.use('/api/billingfinance/folios', folios);
app.use('/api/auth', auth);
app.use('/api/reports', reports);
app.use('/api/mailer', mailer); // Original mailer (tenant-managed)
app.use('/api/mailer-independent', independentMailer); // Independent mailer (no tenant management)
app.use('/api/housekeeping', housekeeping);
app.use('/api/reports/night-audit', nightAudit);
app.use('/api/city-ledger', cityLedger);
app.use('/api/travel-agent', travelAgent);
app.use('/api/paymaster', paymaster);
app.use('/api/group-reservation', groupReservation);
// app.use('/frontoffice', frontRouter);
// app.use('/distribution', distRouter);


const server = http.createServer(app);

// Connect to MongoDB and Redis, then initialize WebSockets
async function startServer() {
    try {
        // Connect to MongoDB
        await connectDB();
        console.log('✅ MongoDB connected');
        
        // Connect to Redis (non-blocking - app continues if Redis fails)
        await connectRedis();
        
        // Initialize WebSockets
        console.log('🔄 Initializing WebSockets...');
        initWebsockets(server);
        
        const port = process.env.Port || 3000;
        const os = require('os');
        
        // Get LAN IP address
        const getLocalIP = () => {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name]) {
                    // Skip internal (loopback) and non-IPv4 addresses
                    if (iface.family === 'IPv4' && !iface.internal) {
                        return iface.address;
                    }
                }
            }
            return 'localhost';
        };
        
        const lanIP = getLocalIP();
        
        // Listen on all network interfaces (0.0.0.0) to allow LAN access
        server.listen(port, '0.0.0.0', () => { 
            console.log(`🚀 Server is listening on port ${port}`);
            console.log(`🌐 Local:    http://localhost:${port}`);
            console.log(`🌐 Network:  http://${lanIP}:${port}`);
            console.log(`⚡ Performance optimizations: ENABLED`);
            console.log(`🔒 Security enhancements: ENABLED`);
            console.log(`💾 Redis caching: ${require('./services/redisClient').isConnected() ? 'ENABLED' : 'DISABLED'}`);
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

startServer();