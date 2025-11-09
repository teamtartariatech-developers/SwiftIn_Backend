const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('billing-finance'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all active folios
router.get('/', async (req, res) => {
    try {
        const { search } = req.query;
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        let query = { status: 'active', property: propertyId };
        
        if (search) {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { roomNumber: { $regex: search, $options: 'i' } },
                { folioId: { $regex: search, $options: 'i' } }
            ];
        }
        
        const folios = await GuestFolio.find(query)
            .populate('reservationId')
            .sort({ createdAt: -1 });
        
        res.status(200).json(folios);
    } catch (error) {
        console.error('Error fetching folios:', error);
        res.status(500).json({ message: "Server error fetching folios." });
    }
});

// Get a single folio by ID
router.get('/:id', async (req, res) => {
    try {
        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: req.params.id,
            property: getPropertyId(req),
        }).populate('reservationId');
        
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error fetching folio:', error);
        res.status(500).json({ message: "Server error fetching folio." });
    }
});

// Create a new folio (automatically called when reservation is created or checked in)
router.post('/', async (req, res) => {
    try {
        const { reservationId, roomNumber, roomNumbers } = req.body;
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');
        
        if (!reservationId) {
            return res.status(400).json({ message: "Reservation ID is required." });
        }
        
        // Check if folio already exists for this reservation
        const existingFolio = await GuestFolio.findOne({ 
            reservationId: reservationId,
            property: propertyId,
            status: 'active'
        });
        
        if (existingFolio) {
            return res.status(200).json(existingFolio);
        }
        
        // Fetch reservation details
        const reservation = await Reservations.findOne({ _id: reservationId, property: propertyId });
        if (!reservation) {
            return res.status(404).json({ message: "Reservation not found." });
        }
        
        // Generate folio ID
        const folioId = await GuestFolio.generateFolioId(propertyId);
        
        // Get room numbers from reservation or provided roomNumber/roomNumbers
        let finalRoomNumbers = [];
        if (reservation.roomNumbers && reservation.roomNumbers.length > 0) {
            // If reservation has room IDs, fetch room numbers
            const rooms = await Rooms.find({ _id: { $in: reservation.roomNumbers }, property: propertyId });
            finalRoomNumbers = rooms.map(r => r.roomNumber);
        } else if (roomNumbers && roomNumbers.length > 0) {
            finalRoomNumbers = roomNumbers;
        } else if (roomNumber) {
            finalRoomNumbers = [roomNumber];
        }
        
        // Create initial room charge items
        const checkIn = new Date(reservation.checkInDate);
        const checkOut = new Date(reservation.checkOutDate);
        const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
        
        const items = [];
        for (let i = 0; i < nights; i++) {
            const nightDate = new Date(checkIn);
            nightDate.setDate(nightDate.getDate() + i);
            
            finalRoomNumbers.forEach(roomNum => {
                items.push({
                    description: `Room Charge - Night ${i + 1} (Room ${roomNum})`,
                    date: nightDate,
                    amount: reservation.totalAmount / (nights * finalRoomNumbers.length || 1),
                    department: 'Room',
                    quantity: 1
                });
            });
        }
        
        // Create initial payment if advance amount exists
        const payments = [];
        if (reservation.payedAmount && reservation.payedAmount > 0) {
            payments.push({
                date: new Date(),
                method: reservation.paymentMethod || 'Cash',
                amount: reservation.payedAmount,
                transactionId: `ADV-${reservation._id}`
            });
        }
        
        // Create folio
        const newFolio = new GuestFolio({
            folioId,
            reservationId: reservation._id,
            guestName: reservation.guestName,
            guestEmail: reservation.guestEmail,
            guestPhone: reservation.guestNumber,
            roomNumber: finalRoomNumbers[0] || '',
            roomNumbers: finalRoomNumbers,
            checkIn: checkIn,
            checkOut: checkOut,
            items: items,
            payments: payments,
            status: 'active',
            property: propertyId
        });
        
        newFolio.calculateBalance();
        await newFolio.save();
        
        res.status(201).json(newFolio);
    } catch (error) {
        console.error('Error creating folio:', error);
        res.status(500).json({ message: "Server error creating folio." });
    }
});

// Add a charge item to folio
router.post('/:id/charges', async (req, res) => {
    try {
        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: req.params.id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        const { description, date, amount, department, quantity, unitPrice, tax, discount, notes } = req.body;
        
        folio.items.push({
            description,
            date: date ? new Date(date) : new Date(),
            amount: amount || 0,
            department: department || 'Other',
            quantity: quantity || 1,
            unitPrice: unitPrice || amount || 0,
            tax: tax || 0,
            discount: discount || 0,
            notes
        });
        
        folio.calculateBalance();
        await folio.save();
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error adding charge:', error);
        res.status(500).json({ message: "Server error adding charge." });
    }
});

// Add a payment to folio
router.post('/:id/payments', async (req, res) => {
    try {
        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: req.params.id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        const { date, method, amount, transactionId, notes } = req.body;
        
        folio.payments.push({
            date: date ? new Date(date) : new Date(),
            method: method || 'Cash',
            amount: amount || 0,
            transactionId,
            notes
        });
        
        folio.calculateBalance();
        await folio.save();
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error adding payment:', error);
        res.status(500).json({ message: "Server error adding payment." });
    }
});

// Update folio
router.put('/:id', async (req, res) => {
    try {
        const updates = { ...req.body };
        delete updates.property;

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOneAndUpdate(
            { _id: req.params.id, property: getPropertyId(req) },
            updates,
            { new: true }
        );
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        folio.calculateBalance();
        await folio.save();
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error updating folio:', error);
        res.status(500).json({ message: "Server error updating folio." });
    }
});

// Settle and checkout - Archive folio to permanent bills
router.post('/:id/checkout', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        const Bill = getModel(req, 'Bill');
        const Reservations = getModel(req, 'Reservations');

        const folio = await GuestFolio.findOne({
            _id: req.params.id,
            property: propertyId,
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        // Calculate final balance
        folio.calculateBalance();
        
        // Check if balance is settled
        if (folio.balance > 0) {
            return res.status(400).json({ 
                message: `Cannot checkout with outstanding balance of ₹${folio.balance.toFixed(2)}` 
            });
        }
        
        // Generate bill ID
        const billId = await Bill.generateBillId(propertyId);
        
        // Create permanent bill from folio
        const bill = new Bill({
            billId,
            folioId: folio.folioId,
            reservationId: folio.reservationId,
            guestName: folio.guestName,
            guestEmail: folio.guestEmail,
            guestPhone: folio.guestPhone,
            roomNumber: folio.roomNumber,
            roomNumbers: folio.roomNumbers,
            checkIn: folio.checkIn,
            checkOut: folio.checkOut,
            items: folio.items,
            payments: folio.payments,
            totalCharges: folio.totalCharges,
            totalPayments: folio.totalPayments,
            finalBalance: folio.balance,
            checkoutDate: new Date(),
            archivedAt: new Date(),
            property: propertyId
        });
        
        await bill.save();
        
        // Update folio status to archived
        folio.status = 'archived';
        await folio.save();
        
        // Update reservation status to checked-out
        await Reservations.findOneAndUpdate(
            { _id: folio.reservationId, property: propertyId },
            { status: 'checked-out' }
        );
        
        res.status(200).json({
            message: "Folio settled and archived successfully",
            bill: bill,
            folio: folio
        });
    } catch (error) {
        console.error('Error during checkout:', error);
        res.status(500).json({ message: "Server error during checkout." });
    }
});

// Get a single bill by ID
router.get('/bills/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const Bill = getModel(req, 'Bill');
        const bill = await Bill.findOne({ _id: id, property: getPropertyId(req) }).populate('reservationId');
        
        if (!bill) {
            return res.status(404).json({ message: "Bill not found." });
        }
        
        res.status(200).json(bill);
    } catch (error) {
        console.error('Error fetching bill:', error);
        res.status(500).json({ message: "Server error fetching bill." });
    }
});

// Get all permanent bills (for historical records)
router.get('/bills/all', async (req, res) => {
    try {
        const { search, page = 1, limit = 50 } = req.query;
        const propertyId = getPropertyId(req);
        const Bill = getModel(req, 'Bill');
        let query = { property: propertyId };
        
        if (search) {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { roomNumber: { $regex: search, $options: 'i' } },
                { billId: { $regex: search, $options: 'i' } },
                { folioId: { $regex: search, $options: 'i' } },
                { reservationId: { $regex: search, $options: 'i' } }
            ];
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await Bill.countDocuments(query);
        
        const bills = await Bill.find(query)
            .populate('reservationId')
            .sort({ archivedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        
        res.status(200).json({
            bills,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                itemsPerPage: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Error fetching bills:', error);
        res.status(500).json({ message: "Server error fetching bills." });
    }
});

module.exports = router;

