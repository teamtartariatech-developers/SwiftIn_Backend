const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, validatePagination, normalizePaymentMethod, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('billing-finance'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all active folios
router.get('/', async (req, res) => {
    try {
        const { search } = validatePagination(req.query);
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        let query = { status: 'active', property: propertyId };
        
        if (search) {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { roomNumber: { $regex: search, $options: 'i' } },
                { folioId: { $regex: search, $options: 'i' } },
                { 'roomNumbers': { $regex: search, $options: 'i' } }
            ];
        }
        
        const folios = await GuestFolio.find(query)
            .populate('reservationId', 'guestName guestEmail checkInDate checkOutDate status')
            .populate('paymasterId', 'name email')
            .populate('groupId', 'groupName')
            .sort({ createdAt: -1 })
            .lean(); // Use lean() for better performance
        
        res.status(200).json(folios);
    } catch (error) {
        console.error('Error fetching folios:', error);
        res.status(500).json({ message: "Server error fetching folios." });
    }
});

// Get a single folio by ID
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        })
        .populate('reservationId', 'guestName guestEmail checkInDate checkOutDate status')
        .populate('paymasterId', 'name email')
        .populate('groupId', 'groupName')
        .lean(); // Use lean() for better performance
        
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
        // Validate and set defaults
        const folioSchema = {
            reservationId: { type: 'string', required: true, isObjectId: true },
            roomNumber: { type: 'string', default: '' },
            roomNumbers: { isArray: true, default: [] },
            payedAmount: { type: 'number', default: 0, min: 0 },
            paymentMethod: { type: 'string', default: 'Cash' }
        };

        const validation = validateAndSetDefaults(req.body, folioSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { reservationId, roomNumber, roomNumbers, payedAmount: overridePayedAmount, paymentMethod: overridePaymentMethod } = validation.validated;
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');
        
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
        
        const payedAmount = typeof overridePayedAmount === 'number'
            ? overridePayedAmount
            : reservation.payedAmount || 0;
        const paymentMethod = normalizePaymentMethod(overridePaymentMethod || reservation.paymentMethod);
        
        // Fetch RoomType, TaxRule, and ServiceFee models
        const RoomType = getModel(req, 'RoomType');
        const TaxRule = getModel(req, 'TaxRule');
        const ServiceFee = getModel(req, 'ServiceFee');
        
        // Fetch RoomType to get priceModel and room name
        let roomTypeData = null;
        if (reservation.roomType) {
            roomTypeData = await RoomType.findOne({
                _id: reservation.roomType,
                property: propertyId,
            });
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
        
        // Create accommodation charge items based on priceModel
        const checkIn = new Date(reservation.checkInDate);
        const checkOut = new Date(reservation.checkOutDate);
        const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
        const roomTypeName = roomTypeData?.name || 'Room';
        
        const items = [];
        const priceModel = roomTypeData?.priceModel || 'perRoom';
        
        if (priceModel === 'perPerson') {
            // For perPerson: Single accommodation charge with total guests and room name
            const adultCount = reservation.adultCount || reservation.numberOfAdults || reservation.adults || 0;
            const childCount = reservation.childCount || reservation.numberOfChildren || reservation.children || 0;
            const totalGuests = adultCount + childCount || reservation.totalGuest || 1;
            
            items.push({
                description: `Accommodation - ${roomTypeName} (${totalGuests} Guest${totalGuests > 1 ? 's' : ''})`,
                date: checkIn,
                amount: reservation.totalAmount || 0,
                department: 'Room',
                quantity: 1,
                unitPrice: reservation.totalAmount || 0
            });
        } else {
            // For perRoom: Separate charges for each room
            const numberOfRooms = finalRoomNumbers.length || reservation.numberOfRooms || 1;
            const roomChargePerRoom = (reservation.totalAmount || 0) / numberOfRooms;
            
            if (finalRoomNumbers.length > 0) {
                // If we have room numbers, create a charge for each room
                finalRoomNumbers.forEach((roomNum, index) => {
                    items.push({
                        description: `Accommodation - ${roomTypeName} (Room ${roomNum})`,
                        date: checkIn,
                        amount: roomChargePerRoom,
                        department: 'Room',
                        quantity: 1,
                        unitPrice: roomChargePerRoom
                    });
                });
            } else {
                // If no room numbers yet, create charges based on numberOfRooms
                for (let i = 0; i < numberOfRooms; i++) {
                    items.push({
                        description: `Accommodation - ${roomTypeName} (Room ${i + 1})`,
                        date: checkIn,
                        amount: roomChargePerRoom,
                        department: 'Room',
                        quantity: 1,
                        unitPrice: roomChargePerRoom
                    });
                }
            }
        }
        
        // Fetch active tax rules
        const activeTaxRules = await TaxRule.find({
            property: propertyId,
            isActive: true
        });
        
        // Calculate and add tax items
        const accommodationTotal = reservation.totalAmount || 0;
        activeTaxRules.forEach(taxRule => {
            // Check if tax applies to room_rate or total_amount
            if (taxRule.applicableOn === 'room_rate' || taxRule.applicableOn === 'total_amount' || taxRule.applicableOn === 'all') {
                let taxAmount = 0;
                if (taxRule.isPercentage) {
                    taxAmount = (accommodationTotal * taxRule.rate) / 100;
                } else {
                    taxAmount = taxRule.rate;
                }
                
                if (taxAmount > 0) {
                    items.push({
                        description: `${taxRule.name}${taxRule.isPercentage ? ` (${taxRule.rate}%)` : ''}`,
                        date: checkIn,
                        amount: taxAmount,
                        department: 'Room',
                        quantity: 1,
                        unitPrice: taxAmount,
                        tax: 0 // Tax is already included in amount
                    });
                }
            }
        });
        
        // Fetch active service fees
        const activeServiceFees = await ServiceFee.find({
            property: propertyId,
            isActive: true
        });
        
        // Calculate guest count for per-person calculations
        const adultCount = reservation.adultCount || reservation.numberOfAdults || reservation.adults || 0;
        const childCount = reservation.childCount || reservation.numberOfChildren || reservation.children || 0;
        const totalGuests = adultCount + childCount || reservation.totalGuest || 1;
        const numberOfRooms = finalRoomNumbers.length || reservation.numberOfRooms || 1;
        
        // Calculate and add service fee items
        activeServiceFees.forEach(serviceFee => {
            let feeAmount = 0;
            
            if (serviceFee.applicableOn === 'per_night') {
                // Per night: multiply by number of nights
                if (serviceFee.isPercentage) {
                    // Percentage of accommodation per night
                    const accommodationPerNight = accommodationTotal / nights;
                    feeAmount = (accommodationPerNight * serviceFee.amount) / 100 * nights;
                } else {
                    // Fixed amount per night
                    feeAmount = serviceFee.amount * nights;
                }
            } else if (serviceFee.applicableOn === 'per_booking') {
                // Per booking: one-time fee
                if (serviceFee.isPercentage) {
                    feeAmount = (accommodationTotal * serviceFee.amount) / 100;
                } else {
                    feeAmount = serviceFee.amount;
                }
            } else if (serviceFee.applicableOn === 'per_person') {
                // Per person: multiply by total number of guests
                if (serviceFee.isPercentage) {
                    // Percentage of accommodation per person
                    feeAmount = (accommodationTotal * serviceFee.amount) / 100;
                } else {
                    // Fixed amount per person
                    feeAmount = serviceFee.amount * totalGuests;
                }
            } else if (serviceFee.applicableOn === 'per_person_per_night') {
                // Per person per night: multiply by guests and nights
                if (serviceFee.isPercentage) {
                    // Percentage of accommodation per person per night
                    const accommodationPerNight = accommodationTotal / nights;
                    feeAmount = (accommodationPerNight * serviceFee.amount) / 100 * totalGuests * nights;
                } else {
                    // Fixed amount per person per night
                    feeAmount = serviceFee.amount * totalGuests * nights;
                }
            } else if (serviceFee.applicableOn === 'room_rate' || serviceFee.applicableOn === 'total_amount') {
                // Based on room rate or total amount
                if (serviceFee.isPercentage) {
                    feeAmount = (accommodationTotal * serviceFee.amount) / 100;
                } else {
                    feeAmount = serviceFee.amount;
                }
            }
            
            if (feeAmount > 0) {
                let description = serviceFee.name;
                if (serviceFee.isPercentage) {
                    description += ` (${serviceFee.amount}%)`;
                }
                if (serviceFee.applicableOn === 'per_night') {
                    description += ` - ${nights} night${nights > 1 ? 's' : ''}`;
                } else if (serviceFee.applicableOn === 'per_person') {
                    description += ` - ${totalGuests} guest${totalGuests > 1 ? 's' : ''}`;
                } else if (serviceFee.applicableOn === 'per_person_per_night') {
                    description += ` - ${totalGuests} guest${totalGuests > 1 ? 's' : ''} × ${nights} night${nights > 1 ? 's' : ''}`;
                }
                
                items.push({
                    description: description,
                    date: checkIn,
                    amount: feeAmount,
                    department: 'Room',
                    quantity: 1,
                    unitPrice: feeAmount,
                    tax: 0
                });
            }
        });
        
        // Create initial payment if advance amount exists
        const payments = [];
        if (payedAmount && payedAmount > 0) {
            payments.push({
                date: new Date(),
                method: paymentMethod,
                amount: payedAmount,
                transactionId: `ADV-${reservation._id}`,
                notes: 'Advance payment'
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
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        // Validate charge fields
        const chargeSchema = {
            description: { type: 'string', required: true },
            date: { type: 'string', isDate: true, default: () => new Date() },
            amount: { type: 'number', required: true, min: 0 },
            department: { type: 'string', default: 'Other' },
            quantity: { type: 'number', default: 1, min: 1 },
            unitPrice: { type: 'number', min: 0 },
            tax: { type: 'number', default: 0, min: 0 },
            discount: { type: 'number', default: 0, min: 0 },
            notes: { type: 'string', default: '' }
        };

        const validation = validateAndSetDefaults(req.body, chargeSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        // Set unitPrice to amount if not provided
        if (!validation.validated.unitPrice) {
            validation.validated.unitPrice = validation.validated.amount;
        }

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        const { description, date, amount, department, quantity, unitPrice, tax, discount, notes } = validation.validated;
        
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
        
        // Update paymaster totals if this is a paymaster folio
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    // Sync charges from folio to paymaster
                    paymaster.charges = folio.items.map(item => ({
                        description: item.description,
                        date: item.date,
                        amount: item.amount,
                        department: item.department,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        tax: item.tax,
                        discount: item.discount,
                        notes: item.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
                // Don't fail the charge addition if paymaster update fails
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error adding charge:', error);
        res.status(500).json({ message: "Server error adding charge." });
    }
});

// Add a payment to folio
router.post('/:id/payments', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        // Validate payment fields
        const paymentSchema = {
            date: { type: 'string', isDate: true, default: () => new Date() },
            method: { type: 'string', default: 'Cash' },
            amount: { type: 'number', required: true, min: 0 },
            transactionId: { type: 'string', default: '' },
            notes: { type: 'string', default: '' }
        };

        const validation = validateAndSetDefaults(req.body, paymentSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        // Normalize payment method
        validation.validated.method = normalizePaymentMethod(validation.validated.method);

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        const { date, method, amount, transactionId, notes } = validation.validated;
        
        folio.payments.push({
            date: date ? new Date(date) : new Date(),
            method: normalizePaymentMethod(method),
            amount: amount || 0,
            transactionId,
            notes
        });
        
        folio.calculateBalance();
        await folio.save();
        
        // Update paymaster totals if this is a paymaster folio
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    // Sync payments from folio to paymaster
                    paymaster.payments = folio.payments.map(payment => ({
                        date: payment.date,
                        method: payment.method,
                        amount: payment.amount,
                        transactionId: payment.transactionId,
                        notes: payment.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
                // Don't fail the payment addition if paymaster update fails
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error adding payment:', error);
        res.status(500).json({ message: "Server error adding payment." });
    }
});

// Update folio
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }

        // Validate update fields (all optional)
        const updateSchema = {
            status: { type: 'string', enum: ['active', 'archived'] },
            guestName: { type: 'string' },
            guestEmail: { type: 'string' },
            guestPhone: { type: 'string' },
            roomNumber: { type: 'string' },
            roomNumbers: { isArray: true }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const updates = { ...validation.validated };
        delete updates.property;

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
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
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        const Bill = getModel(req, 'Bill');
        const Reservations = getModel(req, 'Reservations');

        const folio = await GuestFolio.findOne({
            _id: id,
            property: propertyId,
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        // Calculate final balance
        folio.calculateBalance();
        
        // Check if balance is settled (allow small rounding differences)
        const balanceThreshold = 0.01; // Allow 1 paisa difference for rounding
        if (folio.balance > balanceThreshold) {
            return res.status(400).json({ 
                message: `Cannot checkout with outstanding balance of ₹${folio.balance.toFixed(2)}. Please settle the balance first.` 
            });
        }
        
        // Handle early checkout - adjust charges if checkout is before scheduled check-out date
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const scheduledCheckOut = new Date(folio.checkOut);
        scheduledCheckOut.setHours(0, 0, 0, 0);
        
        if (today < scheduledCheckOut) {
            // Early checkout - calculate refund for unused nights
            const nightsUsed = Math.ceil((today.getTime() - new Date(folio.checkIn).getTime()) / (1000 * 60 * 60 * 24));
            const scheduledNights = Math.ceil((scheduledCheckOut.getTime() - new Date(folio.checkIn).getTime()) / (1000 * 60 * 60 * 24));
            const unusedNights = scheduledNights - nightsUsed;
            
            if (unusedNights > 0) {
                // Calculate refund amount (proportional to accommodation charges)
                const accommodationCharges = folio.items
                    .filter(item => item.description.toLowerCase().includes('accommodation'))
                    .reduce((sum, item) => sum + (item.amount * (item.quantity || 1)), 0);
                
                const refundAmount = (accommodationCharges / scheduledNights) * unusedNights;
                
                // Add refund as a negative charge or payment adjustment
                if (refundAmount > 0) {
                    folio.items.push({
                        description: `Early Checkout Refund (${unusedNights} unused night${unusedNights > 1 ? 's' : ''})`,
                        date: today,
                        amount: -refundAmount, // Negative amount for refund
                        department: 'Room',
                        quantity: 1,
                        unitPrice: -refundAmount
                    });
                    
                    // Recalculate balance after refund
                    folio.calculateBalance();
                    console.log(`Early checkout detected: Refund of ₹${refundAmount.toFixed(2)} for ${unusedNights} unused night(s)`);
                }
            }
        }
        
        // Handle late checkout - add late checkout fee if applicable
        const checkOutTime = new Date();
        const scheduledCheckOutTime = new Date(folio.checkOut);
        // Default checkout time is 11:00 AM
        scheduledCheckOutTime.setHours(11, 0, 0, 0);
        
        // Check if checkout is after scheduled checkout time (e.g., after 11 AM)
        if (checkOutTime > scheduledCheckOutTime) {
            const PropertyDetails = getModel(req, 'PropertyDetails');
            const propertyDetails = await PropertyDetails.findOne({
                property: propertyId,
            });
            
            const lateCheckoutFee = propertyDetails?.lateCheckoutFee || 0;
            const lateCheckoutFeePerHour = propertyDetails?.lateCheckoutFeePerHour || 0;
            
            if (lateCheckoutFee > 0 || lateCheckoutFeePerHour > 0) {
                let feeAmount = 0;
                if (lateCheckoutFeePerHour > 0) {
                    const hoursLate = Math.ceil((checkOutTime.getTime() - scheduledCheckOutTime.getTime()) / (1000 * 60 * 60));
                    feeAmount = lateCheckoutFeePerHour * hoursLate;
                } else {
                    feeAmount = lateCheckoutFee;
                }
                
                if (feeAmount > 0) {
                    folio.items.push({
                        description: `Late Checkout Fee`,
                        date: checkOutTime,
                        amount: feeAmount,
                        department: 'Room',
                        quantity: 1,
                        unitPrice: feeAmount
                    });
                    
                    folio.calculateBalance();
                    console.log(`Late checkout fee added: ₹${feeAmount.toFixed(2)}`);
                }
            }
        }
        
        // Final balance check after adjustments
        if (folio.balance > balanceThreshold) {
            return res.status(400).json({ 
                message: `Cannot checkout with outstanding balance of ₹${folio.balance.toFixed(2)} after adjustments. Please settle the balance first.` 
            });
        }
        
        // Generate bill ID
        const billId = await Bill.generateBillId(propertyId);
        
        // Create permanent bill from folio
        const billData = {
            billId,
            folioId: folio.folioId,
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
        };
        
        // Handle paymaster vs guest folio
        if (folio.paymasterId) {
            billData.paymasterId = folio.paymasterId;
            // For paymaster invoices, use paymaster name
            const PaymasterRoom = getModel(req, 'PaymasterRoom');
            const paymaster = await PaymasterRoom.findOne({
                _id: folio.paymasterId,
                property: propertyId
            });
            if (paymaster) {
                billData.guestName = paymaster.name; // Use paymaster name
                // Update paymaster status to closed
                paymaster.status = 'closed';
                await paymaster.save();
            }
        } else {
            billData.reservationId = folio.reservationId;
            // Update reservation status to checked-out
            if (folio.reservationId) {
                await Reservations.findOneAndUpdate(
                    { _id: folio.reservationId, property: propertyId },
                    { status: 'checked-out' }
                );
            }
        }
        
        // CRITICAL: Update room statuses to 'dirty' when guest checks out
        // This is essential for housekeeping workflow
        const Rooms = getModel(req, 'Rooms');
        if (folio.roomNumbers && folio.roomNumbers.length > 0) {
            try {
                // Find rooms by room numbers
                const rooms = await Rooms.find({
                    roomNumber: { $in: folio.roomNumbers },
                    property: propertyId
                });
                
                // Update each room status to 'dirty' (needs cleaning)
                for (const room of rooms) {
                    room.status = 'dirty';
                    await room.save();
                }
                console.log(`Updated ${rooms.length} room(s) status to 'dirty' after checkout`);
            } catch (roomError) {
                console.error('Error updating room statuses during checkout:', roomError);
                // Don't fail checkout if room status update fails, but log it
            }
        }
        
        const bill = new Bill(billData);
        await bill.save();
        
        // Update folio status to archived
        folio.status = 'archived';
        await folio.save();
        
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

// Get all permanent bills (for historical records) - MUST be before /bills/:id route
router.get('/bills/all', async (req, res) => {
    try {
        const { search, page, limit } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
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

// Get a single bill by ID - MUST be after /bills/all route
router.get('/bills/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId format
        const mongoose = require('mongoose');
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid bill ID format." });
        }
        
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

// Generate HTML invoice template
const generateInvoiceHTML = (folio, propertyDetails, isPaymaster = false) => {
    const formatDate = (date) => {
        if (!date) return '';
        return new Date(date).toLocaleDateString('en-GB', { 
            day: '2-digit', 
            month: '2-digit', 
            year: 'numeric' 
        });
    };

    const formatCurrency = (amount) => {
        return `₹${(amount || 0).toLocaleString('en-IN', { 
            minimumFractionDigits: 2, 
            maximumFractionDigits: 2 
        })}`;
    };

    const propertyName = propertyDetails?.name || 'Hotel';
    const propertyAddress = propertyDetails?.address || '';
    const propertyPhone = propertyDetails?.phone || '';
    const propertyEmail = propertyDetails?.email || '';
    const gstin = propertyDetails?.gstin || '';

    // Build charges table
    let chargesTableRows = '';
    if (folio.items && folio.items.length > 0) {
        folio.items.forEach(item => {
            const itemAmount = ((item.amount || 0) + (item.tax || 0) - (item.discount || 0)) * (item.quantity || 1);
            chargesTableRows += `
                <tr>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #374151;">${formatDate(item.date)}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #111827;">${(item.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #6b7280;">${item.department || 'Other'}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #111827; font-weight: 500;">${formatCurrency(itemAmount)}</td>
                </tr>
            `;
        });
    } else {
        chargesTableRows = `
            <tr>
                <td colspan="4" style="padding: 20px; text-align: center; color: #6b7280; font-style: italic;">No charges available</td>
            </tr>
        `;
    }

    // Build payments table
    let paymentsTableRows = '';
    if (folio.payments && folio.payments.length > 0) {
        folio.payments.forEach(payment => {
            paymentsTableRows += `
                <tr>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #374151;">${formatDate(payment.date)}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; color: #111827;">${payment.method || 'N/A'}</td>
                    <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; color: #059669; font-weight: 500;">${formatCurrency(payment.amount)}</td>
                </tr>
            `;
        });
    } else {
        paymentsTableRows = `
            <tr>
                <td colspan="3" style="padding: 20px; text-align: center; color: #6b7280; font-style: italic;">No payments available</td>
            </tr>
        `;
    }

    const roomNumberDisplay = folio.roomNumbers && folio.roomNumbers.length > 0 
        ? folio.roomNumbers.join(', ') 
        : (folio.roomNumber || 'N/A');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Invoice - ${folio.folioId}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
    <div style="max-width: 800px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff;">
        <!-- Header -->
        <div style="border-bottom: 2px solid #e5e7eb; padding-bottom: 30px; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 28px; font-weight: bold; color: #111827;">${propertyName.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
            ${propertyAddress ? `<p style="margin: 8px 0 0 0; color: #6b7280; font-size: 14px;">${propertyAddress.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : ''}
            <div style="margin-top: 12px; font-size: 14px; color: #6b7280;">
                ${propertyPhone ? `<span>Phone: ${propertyPhone.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>` : ''}
                ${propertyEmail ? `<span style="margin-left: 16px;">Email: ${propertyEmail.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>` : ''}
            </div>
            ${gstin ? `<p style="margin: 8px 0 0 0; color: #6b7280; font-size: 14px;">GSTIN: ${gstin.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>` : ''}
        </div>

        <!-- Invoice Title -->
        <div style="margin-bottom: 30px;">
            <h2 style="margin: 0 0 10px 0; font-size: 24px; font-weight: bold; color: #111827;">Invoice</h2>
            <p style="margin: 0; color: #6b7280; font-size: 14px;">Folio #${folio.folioId}</p>
            <p style="margin: 4px 0 0 0; color: #6b7280; font-size: 14px;">Date: ${formatDate(new Date())}</p>
        </div>

        <!-- Guest Information -->
        <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
            <h3 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #111827;">${isPaymaster && folio.paymasterId ? 'Account Information' : 'Guest Information'}</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; font-size: 14px;">
                <div>
                    <p style="margin: 0 0 4px 0; color: #6b7280;">${isPaymaster && folio.paymasterId ? 'Account Name' : 'Guest Name'}</p>
                    <p style="margin: 0; color: #111827; font-weight: 500;">${folio.guestName.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                </div>
                ${!isPaymaster ? `
                <div>
                    <p style="margin: 0 0 4px 0; color: #6b7280;">Room Number</p>
                    <p style="margin: 0; color: #111827; font-weight: 500;">${roomNumberDisplay}</p>
                </div>
                ` : ''}
                <div>
                    <p style="margin: 0 0 4px 0; color: #6b7280;">Check In</p>
                    <p style="margin: 0; color: #111827; font-weight: 500;">${formatDate(folio.checkIn)}</p>
                </div>
                <div>
                    <p style="margin: 0 0 4px 0; color: #6b7280;">Check Out</p>
                    <p style="margin: 0; color: #111827; font-weight: 500;">${formatDate(folio.checkOut)}</p>
                </div>
            </div>
        </div>

        <!-- Charges Table -->
        <div style="margin-bottom: 30px;">
            <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #111827;">Charges</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                <thead>
                    <tr style="background-color: #f9fafb;">
                        <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Date</th>
                        <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Description</th>
                        <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Department</th>
                        <th style="padding: 12px; text-align: right; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${chargesTableRows}
                </tbody>
            </table>
        </div>

        <!-- Payments Table -->
        <div style="margin-bottom: 30px;">
            <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #111827;">Payments</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                <thead>
                    <tr style="background-color: #f9fafb;">
                        <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Date</th>
                        <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Method</th>
                        <th style="padding: 12px; text-align: right; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; border-bottom: 1px solid #e5e7eb;">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    ${paymentsTableRows}
                </tbody>
            </table>
        </div>

        <!-- Summary -->
        <div style="background-color: #f9fafb; padding: 24px; border-radius: 8px; border: 1px solid #e5e7eb;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b7280;">Total Charges:</span>
                <span style="color: #111827; font-weight: 600;">${formatCurrency(folio.totalCharges || 0)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px; font-size: 14px;">
                <span style="color: #6b7280;">Total Payments:</span>
                <span style="color: #059669; font-weight: 600;">${formatCurrency(folio.totalPayments || 0)}</span>
            </div>
            <div style="border-top: 2px solid #e5e7eb; padding-top: 16px; margin-top: 16px; display: flex; justify-content: space-between; font-size: 18px;">
                <span style="color: #111827; font-weight: bold;">Balance Due:</span>
                <span style="color: ${(folio.balance || 0) > 0 ? '#dc2626' : '#059669'}; font-weight: bold;">${formatCurrency(folio.balance || 0)}</span>
            </div>
        </div>

        <!-- Footer -->
        <div style="margin-top: 40px; padding-top: 30px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px;">
            <p style="margin: 0;">Thank you for your stay!</p>
            <p style="margin: 8px 0 0 0;">This is an automated invoice. Please contact us if you have any questions.</p>
        </div>
    </div>
</body>
</html>
    `;

    return html;
};

// Send folio email
router.post('/:id/send-email', async (req, res) => {
    try {
        const { id } = req.params;
        const propertyId = getPropertyId(req);
        const tenant = req.tenant;
        
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        const GuestFolio = getModel(req, 'GuestFolio');
        const PropertyDetails = getModel(req, 'PropertyDetails');
        const emailService = require('../../services/emailService');
        
        // Get folio
        const folio = await GuestFolio.findOne({
            _id: id,
            property: propertyId
        }).populate('reservationId').populate('paymasterId').lean();
        
        if (!folio) {
            return res.status(404).json({ message: 'Folio not found' });
        }
        
        // Get recipient email
        const recipientEmail = folio.guestEmail || '';
        
        if (!recipientEmail) {
            return res.status(400).json({ 
                message: 'No email address found for this folio. Please add an email address.' 
            });
        }
        
        // Get property details
        const propertyDetails = await PropertyDetails.findOne({ property: propertyId }).lean();
        
        // Determine if this is a paymaster folio
        const isPaymaster = !!folio.paymasterId;
        
        // Generate HTML invoice
        const htmlContent = generateInvoiceHTML(folio, propertyDetails, isPaymaster);
        const emailSubject = `Invoice - ${folio.folioId} - ${propertyDetails?.name || 'Hotel'}`;
        
        // Send email
        const emailResult = await emailService.sendEmail(
            tenant,
            recipientEmail,
            emailSubject,
            htmlContent
        );
        
        if (!emailResult.success) {
            return res.status(500).json({ 
                message: 'Failed to send email', 
                error: emailResult.error 
            });
        }
        
        res.status(200).json({ 
            message: 'Email sent successfully',
            email: recipientEmail
        });
    } catch (error) {
        console.error('Error sending folio email:', error);
        res.status(500).json({ message: 'Server error sending email', error: error.message });
    }
});

// Generate PDF for bill and send via email
router.post('/bills/:id/generate-pdf', async (req, res) => {
    try {
        const { id } = req.params;
        const { sendViaEmail, sendViaWhatsApp } = req.body;
        const propertyId = getPropertyId(req);
        const tenant = req.tenant;
        
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid bill ID format' });
        }
        
        const Bill = getModel(req, 'Bill');
        const PropertyDetails = getModel(req, 'PropertyDetails');
        const emailService = require('../../services/emailService');
        const PDFDocument = require('pdfkit');
        const fs = require('fs');
        const path = require('path');
        
        // Get bill
        const bill = await Bill.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!bill) {
            return res.status(404).json({ message: 'Bill not found' });
        }
        
        // Get property details
        const propertyDetails = await PropertyDetails.findOne({ property: propertyId });
        
        // Generate PDF
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const pdfPath = path.join(__dirname, '../../temp', `invoice_${bill.billId}_${Date.now()}.pdf`);
        
        // Ensure temp directory exists
        const tempDir = path.dirname(pdfPath);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const stream = fs.createWriteStream(pdfPath);
        doc.pipe(stream);
        
        // Colors
        const primaryColor = '#0f5f9c';
        const textColor = '#1f2a37';
        const grayColor = '#6b7280';
        
        // Header
        doc.rect(0, 0, doc.page.width, 80).fill(primaryColor);
        doc.fillColor('white')
           .fontSize(24)
           .font('Helvetica-Bold')
           .text(propertyDetails?.propertyName || 'Hotel', 50, 30);
        
        doc.fontSize(10)
           .font('Helvetica')
           .text('Invoice Statement', 50, 60);
        
        let yPos = 100;
        
        // Invoice Info
        doc.fillColor(textColor)
           .fontSize(10)
           .font('Helvetica-Bold')
           .text('Invoice Information', 50, yPos);
        
        yPos += 20;
        doc.font('Helvetica')
           .fontSize(9)
           .fillColor(grayColor)
           .text('Bill ID:', 50, yPos)
           .text('Folio ID:', 50, yPos + 15)
           .text('Checkout Date:', 50, yPos + 30)
           .text('Archived Date:', 50, yPos + 45);
        
        doc.fillColor(textColor)
           .text(bill.billId, 120, yPos)
           .text(bill.folioId, 120, yPos + 15)
           .text(new Date(bill.checkoutDate).toLocaleDateString('en-GB'), 120, yPos + 30)
           .text(new Date(bill.archivedAt).toLocaleDateString('en-GB'), 120, yPos + 45);
        
        doc.text('Guest Name:', 300, yPos)
           .text('Reservation ID:', 300, yPos + 15)
           .text('Room Number:', 300, yPos + 30)
           .text('Stay Period:', 300, yPos + 45);
        
        doc.text(bill.guestName, 400, yPos)
           .text(String(bill.reservationId || '-'), 400, yPos + 15)
           .text(bill.roomNumber || '-', 400, yPos + 30)
           .text(
               `${new Date(bill.checkIn).toLocaleDateString('en-GB')} - ${new Date(bill.checkOut).toLocaleDateString('en-GB')}`,
               400,
               yPos + 45
           );
        
        yPos += 70;
        
        // Charges Table
        doc.font('Helvetica-Bold')
           .fontSize(10)
           .fillColor(textColor)
           .text('Charges', 50, yPos);
        
        yPos += 20;
        doc.font('Helvetica-Bold')
           .fontSize(8)
           .fillColor('white')
           .rect(50, yPos, 500, 20)
           .fill(primaryColor)
           .text('Date', 55, yPos + 6)
           .text('Description', 120, yPos + 6)
           .text('Department', 350, yPos + 6)
           .text('Amount', 450, yPos + 6, { align: 'right' });
        
        yPos += 25;
        doc.fillColor(textColor)
           .font('Helvetica')
           .fontSize(8);
        
        if (bill.items && bill.items.length > 0) {
            bill.items.forEach(item => {
                const itemAmount = ((item.amount || 0) + (item.tax || 0) - (item.discount || 0)) * (item.quantity || 1);
                doc.text(new Date(item.date).toLocaleDateString('en-GB'), 55, yPos)
                   .text(item.description || '-', 120, yPos, { width: 220 })
                   .text(item.department || 'Other', 350, yPos)
                   .text(`₹${itemAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 450, yPos, { align: 'right' });
                yPos += 15;
            });
        } else {
            doc.text('No charges', 55, yPos);
            yPos += 15;
        }
        
        yPos += 10;
        
        // Payments Table
        doc.font('Helvetica-Bold')
           .fontSize(10)
           .fillColor(textColor)
           .text('Payments', 50, yPos);
        
        yPos += 20;
        doc.font('Helvetica-Bold')
           .fontSize(8)
           .fillColor('white')
           .rect(50, yPos, 500, 20)
           .fill(primaryColor)
           .text('Date', 55, yPos + 6)
           .text('Method', 120, yPos + 6)
           .text('Transaction ID', 250, yPos + 6)
           .text('Amount', 450, yPos + 6, { align: 'right' });
        
        yPos += 25;
        doc.fillColor(textColor)
           .font('Helvetica')
           .fontSize(8);
        
        if (bill.payments && bill.payments.length > 0) {
            bill.payments.forEach(payment => {
                doc.text(new Date(payment.date).toLocaleDateString('en-GB'), 55, yPos)
                   .text(payment.method, 120, yPos)
                   .text(payment.transactionId || '-', 250, yPos, { width: 180 })
                   .text(`₹${payment.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 450, yPos, { align: 'right' });
                yPos += 15;
            });
        } else {
            doc.text('No payments', 55, yPos);
            yPos += 15;
        }
        
        yPos += 20;
        
        // Summary
        doc.rect(50, yPos, 500, 60)
           .stroke(primaryColor)
           .lineWidth(1);
        
        doc.font('Helvetica')
           .fontSize(9)
           .fillColor(grayColor)
           .text('Total Charges:', 55, yPos + 10)
           .text('Total Payments:', 55, yPos + 25)
           .text('Final Balance:', 55, yPos + 45);
        
        doc.font('Helvetica-Bold')
           .fillColor(textColor)
           .text(`₹${bill.totalCharges.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 500, yPos + 10, { align: 'right' })
           .text(`₹${bill.totalPayments.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 500, yPos + 25, { align: 'right' });
        
        const balanceColor = bill.finalBalance === 0 ? '#22c55e' : '#ef4444';
        doc.fillColor(balanceColor)
           .fontSize(12)
           .text(`₹${bill.finalBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, 500, yPos + 45, { align: 'right' });
        
        // Footer
        const footerY = doc.page.height - 50;
        doc.font('Helvetica')
           .fontSize(8)
           .fillColor(grayColor)
           .text(propertyDetails?.address || '', 50, footerY)
           .text(`Phone: ${propertyDetails?.phone || ''} | Email: ${propertyDetails?.email || ''}`, 50, footerY + 10);
        
        if (propertyDetails?.gstin) {
            doc.text(`GSTIN: ${propertyDetails.gstin}`, 50, footerY + 20);
        }
        
        doc.end();
        
        // Wait for PDF to be written
        await new Promise((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
        });
        
        const results = {
            pdfPath,
            emailSent: false,
            whatsappMessage: null
        };
        
        // Send via email if requested
        if (sendViaEmail && bill.guestEmail) {
            const emailSubject = `Invoice ${bill.billId} - ${propertyDetails?.propertyName || 'Hotel'}`;
            const emailHtml = `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2 style="color: #0f5f9c;">Invoice ${bill.billId}</h2>
                    <p>Dear ${bill.guestName},</p>
                    <p>Please find attached your invoice statement.</p>
                    <p><strong>Total Amount:</strong> ₹${bill.totalCharges.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    <p><strong>Final Balance:</strong> ₹${bill.finalBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
                    <p>Thank you for your business!</p>
                    <p>Best regards,<br>${propertyDetails?.propertyName || 'Hotel'} Team</p>
                </div>
            `;
            
            const emailResult = await emailService.sendEmail(
                tenant,
                bill.guestEmail,
                emailSubject,
                emailHtml,
                {
                    attachments: [{
                        filename: `Invoice_${bill.billId}.pdf`,
                        path: pdfPath
                    }]
                }
            );
            
            results.emailSent = emailResult.success;
        }
        
        // Prepare WhatsApp message
        if (sendViaWhatsApp && bill.guestPhone) {
            const message = `Hello ${bill.guestName},\n\nYour invoice ${bill.billId} has been sent to your email${bill.guestEmail ? ` (${bill.guestEmail})` : ''}.\n\nTotal Amount: ₹${bill.totalCharges.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\nFinal Balance: ₹${bill.finalBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\nPlease check your email for the PDF invoice.\n\nThank you!`;
            results.whatsappMessage = message;
        }
        
        // Clean up PDF file after a delay (or keep it for download)
        setTimeout(() => {
            if (fs.existsSync(pdfPath)) {
                fs.unlinkSync(pdfPath);
            }
        }, 60000); // Delete after 1 minute
        
        res.status(200).json({
            message: 'PDF generated successfully',
            ...results
        });
    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({ message: 'Server error generating PDF', error: error.message });
    }
});

// Update a charge in folio
router.put('/:id/charges/:chargeId', async (req, res) => {
    try {
        const { id, chargeId } = req.params;
        
        // Validate ObjectIds
        if (!isValidObjectId(id) || !isValidObjectId(chargeId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }
        
        // Validate charge fields
        const chargeSchema = {
            description: { type: 'string' },
            date: { type: 'string', isDate: true },
            amount: { type: 'number', min: 0 },
            department: { type: 'string' },
            quantity: { type: 'number', min: 1 },
            unitPrice: { type: 'number', min: 0 },
            tax: { type: 'number', min: 0 },
            discount: { type: 'number', min: 0 },
            notes: { type: 'string' }
        };

        const validation = validateAndSetDefaults(req.body, chargeSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        // Find the charge item
        const chargeIndex = folio.items.findIndex(item => item._id.toString() === chargeId);
        if (chargeIndex === -1) {
            return res.status(404).json({ message: "Charge not found." });
        }
        
        // Check if it's a room charge (don't allow editing)
        const charge = folio.items[chargeIndex];
        if (charge.department === 'Room' && charge.description.toLowerCase().includes('accommodation')) {
            return res.status(400).json({ message: "Room accommodation charges cannot be edited." });
        }
        
        // Update the charge
        const updates = validation.validated;
        if (updates.date) {
            folio.items[chargeIndex].date = new Date(updates.date);
        }
        if (updates.description !== undefined) folio.items[chargeIndex].description = updates.description;
        if (updates.amount !== undefined) folio.items[chargeIndex].amount = updates.amount;
        if (updates.department !== undefined) folio.items[chargeIndex].department = updates.department;
        if (updates.quantity !== undefined) folio.items[chargeIndex].quantity = updates.quantity;
        if (updates.unitPrice !== undefined) folio.items[chargeIndex].unitPrice = updates.unitPrice;
        if (updates.tax !== undefined) folio.items[chargeIndex].tax = updates.tax;
        if (updates.discount !== undefined) folio.items[chargeIndex].discount = updates.discount;
        if (updates.notes !== undefined) folio.items[chargeIndex].notes = updates.notes;
        
        // Set unitPrice to amount if not provided
        if (!folio.items[chargeIndex].unitPrice) {
            folio.items[chargeIndex].unitPrice = folio.items[chargeIndex].amount;
        }
        
        folio.calculateBalance();
        await folio.save();
        
        // Update paymaster if applicable
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    paymaster.charges = folio.items.map(item => ({
                        description: item.description,
                        date: item.date,
                        amount: item.amount,
                        department: item.department,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        tax: item.tax,
                        discount: item.discount,
                        notes: item.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error updating charge:', error);
        res.status(500).json({ message: "Server error updating charge." });
    }
});

// Delete a charge from folio
router.delete('/:id/charges/:chargeId', async (req, res) => {
    try {
        const { id, chargeId } = req.params;
        
        // Validate ObjectIds
        if (!isValidObjectId(id) || !isValidObjectId(chargeId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        // Find the charge item
        const chargeIndex = folio.items.findIndex(item => item._id.toString() === chargeId);
        if (chargeIndex === -1) {
            return res.status(404).json({ message: "Charge not found." });
        }
        
        // Check if it's a room charge (don't allow deletion)
        const charge = folio.items[chargeIndex];
        if (charge.department === 'Room' && charge.description.toLowerCase().includes('accommodation')) {
            return res.status(400).json({ message: "Room accommodation charges cannot be deleted." });
        }
        
        // Remove the charge
        folio.items.splice(chargeIndex, 1);
        
        folio.calculateBalance();
        await folio.save();
        
        // Update paymaster if applicable
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    paymaster.charges = folio.items.map(item => ({
                        description: item.description,
                        date: item.date,
                        amount: item.amount,
                        department: item.department,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        tax: item.tax,
                        discount: item.discount,
                        notes: item.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error deleting charge:', error);
        res.status(500).json({ message: "Server error deleting charge." });
    }
});

// Update a payment in folio
router.put('/:id/payments/:paymentId', async (req, res) => {
    try {
        const { id, paymentId } = req.params;
        
        // Validate ObjectIds
        if (!isValidObjectId(id) || !isValidObjectId(paymentId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }
        
        // Validate payment fields
        const paymentSchema = {
            date: { type: 'string', isDate: true },
            method: { type: 'string' },
            amount: { type: 'number', min: 0 },
            transactionId: { type: 'string' },
            notes: { type: 'string' }
        };

        const validation = validateAndSetDefaults(req.body, paymentSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        // Find the payment item
        const paymentIndex = folio.payments.findIndex(payment => payment._id.toString() === paymentId);
        if (paymentIndex === -1) {
            return res.status(404).json({ message: "Payment not found." });
        }
        
        // Update the payment
        const updates = validation.validated;
        if (updates.date) {
            folio.payments[paymentIndex].date = new Date(updates.date);
        }
        if (updates.method !== undefined) {
            folio.payments[paymentIndex].method = normalizePaymentMethod(updates.method);
        }
        if (updates.amount !== undefined) folio.payments[paymentIndex].amount = updates.amount;
        if (updates.transactionId !== undefined) folio.payments[paymentIndex].transactionId = updates.transactionId;
        if (updates.notes !== undefined) folio.payments[paymentIndex].notes = updates.notes;
        
        folio.calculateBalance();
        await folio.save();
        
        // Update paymaster if applicable
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    paymaster.payments = folio.payments.map(payment => ({
                        date: payment.date,
                        method: payment.method,
                        amount: payment.amount,
                        transactionId: payment.transactionId,
                        notes: payment.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error updating payment:', error);
        res.status(500).json({ message: "Server error updating payment." });
    }
});

// Delete a payment from folio
router.delete('/:id/payments/:paymentId', async (req, res) => {
    try {
        const { id, paymentId } = req.params;
        
        // Validate ObjectIds
        if (!isValidObjectId(id) || !isValidObjectId(paymentId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        // Find the payment item
        const paymentIndex = folio.payments.findIndex(payment => payment._id.toString() === paymentId);
        if (paymentIndex === -1) {
            return res.status(404).json({ message: "Payment not found." });
        }
        
        // Remove the payment
        folio.payments.splice(paymentIndex, 1);
        
        folio.calculateBalance();
        await folio.save();
        
        // Update paymaster if applicable
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    paymaster.payments = folio.payments.map(payment => ({
                        date: payment.date,
                        method: payment.method,
                        amount: payment.amount,
                        transactionId: payment.transactionId,
                        notes: payment.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error deleting payment:', error);
        res.status(500).json({ message: "Server error deleting payment." });
    }
});

// Apply discount to all charges in folio
router.put('/:id/discount', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        // Validate discount field
        const discountSchema = {
            discountPercent: { type: 'number', required: true, min: 0, max: 100 }
        };

        const validation = validateAndSetDefaults(req.body, discountSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        });
        if (!folio) {
            return res.status(404).json({ message: "Folio not found." });
        }
        
        const { discountPercent } = validation.validated;
        
        // Apply discount to all non-room charges (or all charges if needed)
        folio.items.forEach(item => {
            // Skip room accommodation charges
            if (item.department === 'Room' && item.description.toLowerCase().includes('accommodation')) {
                return;
            }
            
            // Calculate discount amount
            const discountAmount = (item.amount * discountPercent) / 100;
            item.discount = (item.discount || 0) + discountAmount;
            item.amount = item.amount - discountAmount;
            
            // Update unitPrice proportionally
            if (item.unitPrice && item.quantity) {
                item.unitPrice = item.amount / item.quantity;
            }
        });
        
        folio.calculateBalance();
        await folio.save();
        
        // Update paymaster if applicable
        if (folio.paymasterId) {
            try {
                const PaymasterRoom = getModel(req, 'PaymasterRoom');
                const paymaster = await PaymasterRoom.findOne({
                    _id: folio.paymasterId,
                    property: getPropertyId(req)
                });
                if (paymaster) {
                    paymaster.charges = folio.items.map(item => ({
                        description: item.description,
                        date: item.date,
                        amount: item.amount,
                        department: item.department,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        tax: item.tax,
                        discount: item.discount,
                        notes: item.notes
                    }));
                    paymaster.calculateBalance();
                    await paymaster.save();
                }
            } catch (paymasterError) {
                console.error('Error updating paymaster:', paymasterError);
            }
        }
        
        res.status(200).json(folio);
    } catch (error) {
        console.error('Error applying discount:', error);
        res.status(500).json({ message: "Server error applying discount." });
    }
});

module.exports = router;

