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
            .populate('reservationId')
            .populate('paymasterId')
            .populate('groupId')
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
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid folio ID format' });
        }
        
        const GuestFolio = getModel(req, 'GuestFolio');
        const folio = await GuestFolio.findOne({
            _id: id,
            property: getPropertyId(req),
        }).populate('reservationId').populate('paymasterId').populate('groupId');
        
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

module.exports = router;

