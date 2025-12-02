const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, validatePagination, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('front-office'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all travel agents
router.get('/', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        
        let query = { property: propertyId };
        
        if (search) {
            query.$or = [
                { companyName: { $regex: search, $options: 'i' } },
                { agentCode: { $regex: search, $options: 'i' } },
                { contactPerson: { $regex: search, $options: 'i' } }
            ];
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await TravelAgent.countDocuments(query);
        
        const agents = await TravelAgent.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        
        // Calculate commissions for each agent
        agents.forEach(agent => agent.calculateCommission());
        
        res.status(200).json({
            agents,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                itemsPerPage: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Error fetching travel agents:', error);
        res.status(500).json({ message: 'Failed to fetch travel agents.' });
    }
});

// Create travel agent
router.post('/', async (req, res) => {
    try {
        const agentSchema = {
            companyName: { type: 'string', required: true },
            contactPerson: { type: 'string', default: '' },
            email: { type: 'string', default: '' },
            phone: { type: 'string', default: '' },
            address: { type: 'string', default: '' },
            commissionRate: { type: 'number', required: true, min: 0, max: 100 },
            commissionType: { type: 'string', default: 'percentage', enum: ['percentage', 'fixed'] },
            paymentMode: { type: 'string', default: 'post-paid', enum: ['post-paid', 'pre-paid', 'monthly'] },
            paymentTerms: { type: 'string', default: 'Net 30' },
            remarks: { type: 'string', default: '' }
        };
        
        const validation = validateAndSetDefaults(req.body, agentSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        
        const agentCode = await TravelAgent.generateAgentCode(propertyId);
        
        const agent = new TravelAgent({
            ...validation.validated,
            agentCode,
            property: propertyId
        });
        
        await agent.save();
        
        res.status(201).json(agent);
    } catch (error) {
        console.error('Error creating travel agent:', error);
        res.status(500).json({ message: 'Failed to create travel agent.' });
    }
});

// Get single agent
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid agent ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        
        const agent = await TravelAgent.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!agent) {
            return res.status(404).json({ message: 'Travel agent not found.' });
        }
        
        agent.calculateCommission();
        await agent.save();
        
        res.status(200).json(agent);
    } catch (error) {
        console.error('Error fetching agent:', error);
        res.status(500).json({ message: 'Failed to fetch agent.' });
    }
});

// Update agent
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid agent ID format' });
        }
        
        const updateSchema = {
            companyName: { type: 'string' },
            contactPerson: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            address: { type: 'string' },
            commissionRate: { type: 'number', min: 0, max: 100 },
            commissionType: { type: 'string', enum: ['percentage', 'fixed'] },
            paymentMode: { type: 'string', enum: ['post-paid', 'pre-paid', 'monthly'] },
            paymentTerms: { type: 'string' },
            remarks: { type: 'string' },
            isActive: { type: 'boolean' }
        };
        
        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        
        const agent = await TravelAgent.findOneAndUpdate(
            { _id: id, property: propertyId },
            validation.validated,
            { new: true }
        );
        
        if (!agent) {
            return res.status(404).json({ message: 'Travel agent not found.' });
        }
        
        res.status(200).json(agent);
    } catch (error) {
        console.error('Error updating agent:', error);
        res.status(500).json({ message: 'Failed to update agent.' });
    }
});

// Calculate and update commission for a reservation
router.post('/:id/calculate-commission', async (req, res) => {
    try {
        const { id } = req.params;
        const { reservationId, reservationAmount } = req.body;
        
        if (!isValidObjectId(id) || !isValidObjectId(reservationId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        const Reservations = getModel(req, 'Reservations');
        
        const agent = await TravelAgent.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!agent) {
            return res.status(404).json({ message: 'Travel agent not found.' });
        }
        
        const reservation = await Reservations.findOne({
            _id: reservationId,
            property: propertyId
        });
        
        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }
        
        const amount = reservationAmount || reservation.totalAmount || 0;
        let commission = 0;
        
        if (agent.commissionType === 'percentage') {
            commission = (amount * agent.commissionRate) / 100;
        } else {
            commission = agent.commissionRate;
        }
        
        // Update agent totals
        agent.totalBookings += 1;
        agent.totalRevenue += amount;
        agent.totalCommission += commission;
        agent.calculateCommission();
        await agent.save();
        
        // Update reservation
        reservation.travelAgentId = agent._id;
        await reservation.save();
        
        res.status(200).json({
            commission,
            agent
        });
    } catch (error) {
        console.error('Error calculating commission:', error);
        res.status(500).json({ message: 'Failed to calculate commission.' });
    }
});

// Record commission payment
router.post('/:id/payments', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid agent ID format' });
        }
        
        const paymentSchema = {
            amount: { type: 'number', required: true, min: 0 },
            method: { type: 'string', default: 'Bank Transfer' },
            transactionId: { type: 'string', default: '' },
            referenceNumber: { type: 'string', default: '' },
            notes: { type: 'string', default: '' },
            appliedToBookings: { isArray: true, default: [] }
        };
        
        const validation = validateAndSetDefaults(req.body, paymentSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        
        const agent = await TravelAgent.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!agent) {
            return res.status(404).json({ message: 'Travel agent not found.' });
        }
        
        const payment = {
            date: new Date(),
            amount: validation.validated.amount,
            method: validation.validated.method,
            transactionId: validation.validated.transactionId,
            referenceNumber: validation.validated.referenceNumber,
            notes: validation.validated.notes,
            appliedToBookings: validation.validated.appliedToBookings || []
        };
        
        agent.commissionPayments.push(payment);
        agent.calculateCommission();
        await agent.save();
        
        res.status(201).json({ payment, agent });
    } catch (error) {
        console.error('Error recording payment:', error);
        res.status(500).json({ message: 'Failed to record payment.' });
    }
});

// Get agent statement
router.get('/:id/statement', async (req, res) => {
    try {
        const { id } = req.params;
        const { startDate, endDate } = req.query;
        
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid agent ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const TravelAgent = getModel(req, 'TravelAgent');
        const Reservations = getModel(req, 'Reservations');
        
        const agent = await TravelAgent.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!agent) {
            return res.status(404).json({ message: 'Travel agent not found.' });
        }
        
        // Get reservations for this agent
        let reservationQuery = {
            travelAgentId: id,
            property: propertyId
        };
        
        if (startDate && endDate) {
            reservationQuery.checkOutDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }
        
        const reservations = await Reservations.find(reservationQuery)
            .populate('roomType')
            .sort({ checkOutDate: -1 });
        
        // Calculate commission for each reservation
        const statement = reservations.map(res => {
            const amount = res.totalAmount || 0;
            let commission = 0;
            
            if (agent.commissionType === 'percentage') {
                commission = (amount * agent.commissionRate) / 100;
            } else {
                commission = agent.commissionRate;
            }
            
            return {
                reservationId: res._id,
                guestName: res.guestName,
                checkIn: res.checkInDate,
                checkOut: res.checkOutDate,
                amount,
                commission
            };
        });
        
        agent.calculateCommission();
        
        res.status(200).json({
            agent,
            statement,
            summary: {
                totalBookings: statement.length,
                totalRevenue: statement.reduce((sum, s) => sum + s.amount, 0),
                totalCommission: statement.reduce((sum, s) => sum + s.commission, 0),
                outstandingCommission: agent.outstandingCommission
            }
        });
    } catch (error) {
        console.error('Error fetching statement:', error);
        res.status(500).json({ message: 'Failed to fetch statement.' });
    }
});

module.exports = router;

