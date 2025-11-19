const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
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

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

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

// Get dashboard summary using AI
router.post('/dashboard/summarize', async (req, res) => {
    try {
        const { metrics } = req.body;
        
        if (!metrics) {
            return res.status(400).json({ message: 'Metrics data is required.' });
        }
        
        // Get language from AI settings
        const propertyId = getPropertyId(req);
        const AISettings = getModel(req, 'AISettings');
        let aiSettings = await AISettings.findOne({ property: propertyId });
        
        // Default to english if no settings found
        const language = aiSettings?.language || 'english';
        
        // Get AI API base URL
        const aiApiBaseUrl = process.env.AI_API_BASEURL;
        if (!aiApiBaseUrl) {
            return res.status(500).json({ 
                message: "AI_API_BASEURL environment variable is not configured." 
            });
        }
        
        try {
            const aiResponse = await axios.post(
                `${aiApiBaseUrl}/inAppAI/dashboardSummarizer`,
                { 
                    metrics: metrics,
                    language: language
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000 // 60 second timeout
                }
            );
            
            // Extract summary from response
            const summary = aiResponse.data.summary;
            
            if (!summary) {
                return res.status(502).json({ 
                    message: "AI API did not return a summary." 
                });
            }
            
            return res.status(200).json({ summary });
        } catch (aiError) {
            console.error('Error calling AI API for dashboard summarizer:', aiError.message);
            if (aiError.response) {
                console.error('AI API Response:', aiError.response.data);
            }
            return res.status(502).json({ 
                message: "Failed to generate summary. AI service unavailable.",
                detail: aiError.message
            });
        }
    } catch (error) {
        console.error('Error in dashboard summarizer:', error);
        res.status(500).json({ message: "Server error generating summary." });
    }
});

module.exports = router;

