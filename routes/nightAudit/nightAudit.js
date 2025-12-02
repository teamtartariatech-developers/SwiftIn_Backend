const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validatePagination } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('reports'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get audit summary (pending tasks before running audit)
router.get('/summary', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const Reservations = getModel(req, 'Reservations');
        const GuestFolio = getModel(req, 'GuestFolio');
        const Rooms = getModel(req, 'Rooms');
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // Pending check-ins
        const pendingCheckIns = await Reservations.countDocuments({
            property: propertyId,
            checkInDate: { $gte: today, $lt: tomorrow },
            status: { $ne: 'checked-in' }
        });
        
        // Pending check-outs
        const pendingCheckOuts = await Reservations.countDocuments({
            property: propertyId,
            checkOutDate: { $gte: today, $lt: tomorrow },
            status: 'checked-in'
        });
        
        // Pending folio postings
        const pendingFolios = await GuestFolio.countDocuments({
            property: propertyId,
            status: 'active',
            createdAt: { $lt: today }
        });
        
        // Unposted charges (folios with items added today but not posted)
        const unpostedCharges = await GuestFolio.countDocuments({
            property: propertyId,
            status: 'active',
            'items.date': { $gte: today, $lt: tomorrow }
        });
        
        // Room status summary
        const totalRooms = await Rooms.countDocuments({ property: propertyId });
        const occupiedRooms = await Reservations.countDocuments({
            property: propertyId,
            status: 'checked-in',
            checkOutDate: { $gt: today }
        });
        
        res.status(200).json({
            pendingCheckIns,
            pendingCheckOuts,
            pendingFolios,
            unpostedCharges,
            roomStatus: {
                total: totalRooms,
                occupied: occupiedRooms,
                available: totalRooms - occupiedRooms
            }
        });
    } catch (error) {
        console.error('Error fetching audit summary:', error);
        res.status(500).json({ message: 'Failed to fetch audit summary.' });
    }
});

// Run night audit
router.post('/run', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const NightAudit = getModel(req, 'NightAudit');
        const Reservations = getModel(req, 'Reservations');
        const GuestFolio = getModel(req, 'GuestFolio');
        const Rooms = getModel(req, 'Rooms');
        const ReportSnapshot = getModel(req, 'ReportSnapshot');
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // Check if audit already run for today
        const existingAudit = await NightAudit.findOne({
            property: propertyId,
            auditDate: { $gte: today, $lt: tomorrow }
        });
        
        if (existingAudit && existingAudit.status === 'completed') {
            return res.status(400).json({ 
                message: 'Night audit already completed for today.',
                audit: existingAudit
            });
        }
        
        // Create audit log
        const auditLog = new NightAudit({
            auditDate: new Date(),
            businessDate: today,
            runBy: req.user?.name || req.user?.email || 'System',
            status: 'in-progress',
            property: propertyId
        });
        
        const errors = [];
        const pendingTasks = [];
        
        try {
            // Lock all folios for the day
            const activeFolios = await GuestFolio.find({
                property: propertyId,
                status: 'active',
                checkOut: { $lt: tomorrow }
            });
            
            // Roll over business date (mark reservations as no-show if applicable)
            const noShowReservations = await Reservations.find({
                property: propertyId,
                checkInDate: { $lt: today },
                status: 'confirmed'
            });
            
            let noShows = 0;
            for (const reservation of noShowReservations) {
                reservation.status = 'no-show';
                await reservation.save();
                noShows++;
            }
            
            // Generate revenue summary
            const foliosForRevenue = await GuestFolio.find({
                property: propertyId,
                checkOut: { $gte: today, $lt: tomorrow },
                status: { $in: ['active', 'settled'] }
            });
            
            let totalRevenue = 0;
            let roomRevenue = 0;
            let fBRevenue = 0;
            let otherRevenue = 0;
            
            foliosForRevenue.forEach(folio => {
                folio.items.forEach(item => {
                    totalRevenue += item.amount * (item.quantity || 1);
                    if (item.department === 'Room') {
                        roomRevenue += item.amount * (item.quantity || 1);
                    } else if (item.department === 'F&B') {
                        fBRevenue += item.amount * (item.quantity || 1);
                    } else {
                        otherRevenue += item.amount * (item.quantity || 1);
                    }
                });
            });
            
            // Get room statuses
            const totalRooms = await Rooms.countDocuments({ property: propertyId });
            const occupiedRooms = await Reservations.countDocuments({
                property: propertyId,
                status: 'checked-in',
                checkOutDate: { $gt: today }
            });
            
            // Get check-ins and check-outs
            const totalCheckIns = await Reservations.countDocuments({
                property: propertyId,
                checkInDate: { $gte: today, $lt: tomorrow },
                status: 'checked-in'
            });
            
            const totalCheckOuts = await Reservations.countDocuments({
                property: propertyId,
                checkOutDate: { $gte: today, $lt: tomorrow },
                status: 'checked-out'
            });
            
            const totalReservations = await Reservations.countDocuments({
                property: propertyId,
                checkInDate: { $gte: today, $lt: tomorrow }
            });
            
            // Update audit log
            auditLog.summary = {
                totalRevenue,
                roomRevenue,
                fBRevenue,
                otherRevenue,
                totalCheckIns,
                totalCheckOuts,
                totalReservations,
                occupiedRooms,
                availableRooms: totalRooms - occupiedRooms,
                noShows
            };
            
            auditLog.status = 'completed';
            auditLog.completedAt = new Date();
            
            // Save revenue snapshot
            const snapshot = new ReportSnapshot({
                property: propertyId,
                reportType: 'night-audit',
                date: today,
                data: auditLog.summary
            });
            await snapshot.save();
            
        } catch (error) {
            errors.push({
                type: 'audit-error',
                message: error.message,
                timestamp: new Date()
            });
            auditLog.status = 'failed';
        }
        
        auditLog.errors = errors;
        auditLog.pendingTasks = pendingTasks;
        await auditLog.save();
        
        res.status(200).json({
            message: 'Night audit completed successfully',
            audit: auditLog
        });
    } catch (error) {
        console.error('Error running night audit:', error);
        res.status(500).json({ message: 'Failed to run night audit.' });
    }
});

// Get audit history
router.get('/history', async (req, res) => {
    try {
        const { page, limit } = validatePagination({ ...req.query, limit: req.query.limit || 20 });
        const propertyId = getPropertyId(req);
        const NightAudit = getModel(req, 'NightAudit');
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await NightAudit.countDocuments({ property: propertyId });
        
        const audits = await NightAudit.find({ property: propertyId })
            .sort({ auditDate: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        
        res.status(200).json({
            audits,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                itemsPerPage: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Error fetching audit history:', error);
        res.status(500).json({ message: 'Failed to fetch audit history.' });
    }
});

// Get specific audit by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const propertyId = getPropertyId(req);
        const NightAudit = getModel(req, 'NightAudit');
        
        const audit = await NightAudit.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!audit) {
            return res.status(404).json({ message: 'Audit not found.' });
        }
        
        res.status(200).json(audit);
    } catch (error) {
        console.error('Error fetching audit:', error);
        res.status(500).json({ message: 'Failed to fetch audit.' });
    }
});

module.exports = router;

