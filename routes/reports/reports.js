const express = require('express');
const bodyParser = require('body-parser');
const {
    getDashboardReport,
    getOccupancyReport,
    getRevenueReport,
    getChannelPerformanceReport
} = require('../../services/reportService');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('reports'));

router.get('/dashboard', async (req, res) => {
    try {
        const report = await getDashboardReport(req.tenant.models, req.query, req.tenant.property._id);
        res.status(200).json(report);
    } catch (error) {
        console.error('Error generating dashboard report:', error);
        res.status(500).json({ message: 'Failed to generate dashboard report.' });
    }
});

router.get('/occupancy', async (req, res) => {
    try {
        const report = await getOccupancyReport(req.tenant.models, req.query, req.tenant.property._id);
        res.status(200).json(report);
    } catch (error) {
        console.error('Error generating occupancy report:', error);
        res.status(500).json({ message: 'Failed to generate occupancy report.' });
    }
});

router.get('/revenue', async (req, res) => {
    try {
        const report = await getRevenueReport(req.tenant.models, req.query, req.tenant.property._id);
        res.status(200).json(report);
    } catch (error) {
        console.error('Error generating revenue report:', error);
        res.status(500).json({ message: 'Failed to generate revenue report.' });
    }
});

router.get('/channel-performance', async (req, res) => {
    try {
        const report = await getChannelPerformanceReport(req.tenant.models, req.query, req.tenant.property._id);
        res.status(200).json(report);
    } catch (error) {
        console.error('Error generating channel performance report:', error);
        res.status(500).json({ message: 'Failed to generate channel performance report.' });
    }
});

module.exports = router;

