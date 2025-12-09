const express = require('express');
const http = require('http');
const app = express();
const dotenv = require('dotenv');
const connectDB = require('./db/dbcon');
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

app.use(express.json());

// Enable CORS for specific origins only
const allowedOrigins = [
    'https://app.swif10.com',
    'https://www.app.swif10.com'
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

// Connect to MongoDB first, then initialize WebSockets
connectDB().then(() => {
    console.log('MongoDB connected, initializing WebSockets...');
    initWebsockets(server);
    
    const port = process.env.Port || 3000;
    server.listen(port, () => { 
        console.log(`Server is listening on port ${port}`);
    });
}).catch((error) => {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
});