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
const housekeeping = require('./routes/housekeeping');
const { initHousekeepingWebsocket } = require('./services/housekeepingWebsocket');

app.use(express.json());

// Enable CORS for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

dotenv.config();
connectDB();

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
app.use('/api/mailer', mailer);
app.use('/api/housekeeping', housekeeping);
// app.use('/frontoffice', frontRouter);
// app.use('/distribution', distRouter);


const server = http.createServer(app);
initHousekeepingWebsocket(server);

const port = process.env.Port || 3000;
server.listen(port, () => { 
    console.log(`Server is listening on port ${port}`);
} );