const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, validatePagination, validateDateRange, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('front-office'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all group reservations
router.get('/', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        
        let query = { property: propertyId };
        
        if (search) {
            query.$or = [
                { groupName: { $regex: search, $options: 'i' } },
                { groupCode: { $regex: search, $options: 'i' } },
                { contactPerson: { $regex: search, $options: 'i' } }
            ];
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await GroupReservation.countDocuments(query);
        
        const groups = await GroupReservation.find(query)
            .populate('roomBlocks.roomType')
            .populate('reservations')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        
        // Calculate totals for each group
        groups.forEach(group => group.calculateTotals());
        
        res.status(200).json({
            groups,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                itemsPerPage: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Error fetching group reservations:', error);
        res.status(500).json({ message: 'Failed to fetch group reservations.' });
    }
});

// Create group reservation
router.post('/', async (req, res) => {
    try {
        const groupSchema = {
            groupName: { type: 'string', required: true },
            contactPerson: { type: 'string', required: true },
            contactEmail: { type: 'string', default: '' },
            contactPhone: { type: 'string', default: '' },
            checkInDate: { type: 'string', required: true, isDate: true },
            checkOutDate: { type: 'string', required: true, isDate: true },
            roomBlocks: { isArray: true, required: true },
            totalAmount: { type: 'number', min: 0 },
            discountType: { type: 'string', enum: ['percent', 'amount'], default: 'percent' },
            discountValue: { type: 'number', min: 0, default: 0 },
            discountAmount: { type: 'number', min: 0, default: 0 },
            paymentMode: { type: 'string', default: 'individual-bills', enum: ['entire-bill', 'partial-bill', 'individual-bills'] },
            notes: { type: 'string', default: '' }
        };
        
        const validation = validateAndSetDefaults(req.body, groupSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        // Validate date range
        const dateValidation = validateDateRange(validation.validated.checkInDate, validation.validated.checkOutDate);
        if (!dateValidation.isValid) {
            return res.status(400).json({ message: dateValidation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        const Reservations = getModel(req, 'Reservations');
        const InventoryBlock = getModel(req, 'InventoryBlock');
        
        // Check room availability for each room block
        const availabilityErrors = [];
        for (const block of validation.validated.roomBlocks) {
            const RoomType = getModel(req, 'RoomType');
            const roomType = await RoomType.findOne({ _id: block.roomType, property: propertyId });
            
            if (!roomType) {
                availabilityErrors.push(`Room type ${block.roomType} not found`);
                continue;
            }
            
            const totalInventory = roomType.totalInventory;
            
            // Check existing reservations
            const existingReservations = await Reservations.find({
                roomType: block.roomType,
                property: propertyId,
                status: { $in: ['confirmed', 'checked-in'] },
                checkInDate: { $lt: dateValidation.checkOut },
                checkOutDate: { $gt: dateValidation.checkIn }
            }).select('numberOfRooms').lean();
            
            // Check inventory blocks
            const inventoryBlocks = await InventoryBlock.find({
                roomType: block.roomType,
                property: propertyId,
                date: { $gte: dateValidation.checkIn, $lt: dateValidation.checkOut }
            }).select('blockedInventory').lean();
            
            // Calculate maximum booked/blocked rooms for any day in the range
            let maxBooked = 0;
            let currentDate = new Date(dateValidation.checkIn);
            while (currentDate < dateValidation.checkOut) {
                let bookedForDay = 0;
                existingReservations.forEach(res => {
                    const resCheckIn = new Date(res.checkInDate);
                    const resCheckOut = new Date(res.checkOutDate);
                    if (resCheckIn <= currentDate && resCheckOut > currentDate) {
                        bookedForDay += res.numberOfRooms || 0;
                    }
                });
                
                const blockedForDay = inventoryBlocks.reduce((sum, block) => {
                    const blockDate = new Date(block.date);
                    if (blockDate.toDateString() === currentDate.toDateString()) {
                        return sum + (block.blockedInventory || 0);
                    }
                    return sum;
                }, 0);
                
                const availableForDay = totalInventory - bookedForDay - blockedForDay;
                maxBooked = Math.max(maxBooked, bookedForDay + blockedForDay);
                
                if (availableForDay < block.numberOfRooms) {
                    availabilityErrors.push(
                        `Only ${availableForDay} room(s) available for ${roomType.name} on ${currentDate.toLocaleDateString()}, but ${block.numberOfRooms} requested`
                    );
                }
                
                currentDate.setDate(currentDate.getDate() + 1);
            }
        }
        
        if (availabilityErrors.length > 0) {
            return res.status(400).json({ 
                message: 'Room availability check failed',
                errors: availabilityErrors
            });
        }
        
        const groupCode = await GroupReservation.generateGroupCode(propertyId);
        
        // Calculate discount amount if discount type is percent
        let discountAmount = validation.validated.discountAmount || 0;
        if (validation.validated.discountType === 'percent' && validation.validated.discountValue > 0) {
            const totalBeforeDiscount = validation.validated.totalAmount || 0;
            discountAmount = (totalBeforeDiscount * validation.validated.discountValue) / 100;
        }
        
        const group = new GroupReservation({
            groupName: validation.validated.groupName,
            contactPerson: validation.validated.contactPerson,
            contactEmail: validation.validated.contactEmail,
            contactPhone: validation.validated.contactPhone,
            checkInDate: dateValidation.checkIn,
            checkOutDate: dateValidation.checkOut,
            roomBlocks: validation.validated.roomBlocks,
            totalAmount: validation.validated.totalAmount || 0,
            discountType: validation.validated.discountType || 'percent',
            discountValue: validation.validated.discountValue || 0,
            discountAmount: discountAmount,
            paymentMode: validation.validated.paymentMode,
            notes: validation.validated.notes,
            property: propertyId
        });
        
        group.calculateTotals();
        await group.save();
        
        res.status(201).json(group);
    } catch (error) {
        console.error('Error creating group reservation:', error);
        res.status(500).json({ message: 'Failed to create group reservation.' });
    }
});

// Get single group
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid group ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        
        const group = await GroupReservation.findOne({
            _id: id,
            property: propertyId
        })
        .populate('roomBlocks.roomType')
        .populate('reservations')
        .populate('roomBlocks.assignedRooms');
        
        if (!group) {
            return res.status(404).json({ message: 'Group reservation not found.' });
        }
        
        group.calculateTotals();
        await group.save();
        
        res.status(200).json(group);
    } catch (error) {
        console.error('Error fetching group:', error);
        res.status(500).json({ message: 'Failed to fetch group reservation.' });
    }
});

// Update group
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid group ID format' });
        }
        
        const updateSchema = {
            groupName: { type: 'string' },
            contactPerson: { type: 'string' },
            contactEmail: { type: 'string' },
            contactPhone: { type: 'string' },
            checkInDate: { type: 'string', isDate: true },
            checkOutDate: { type: 'string', isDate: true },
            roomBlocks: { isArray: true },
            paymentMode: { type: 'string', enum: ['entire-bill', 'partial-bill', 'individual-bills'] },
            status: { type: 'string', enum: ['confirmed', 'checked-in', 'checked-out', 'cancelled'] },
            notes: { type: 'string' }
        };
        
        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        
        const group = await GroupReservation.findOneAndUpdate(
            { _id: id, property: propertyId },
            validation.validated,
            { new: true }
        );
        
        if (!group) {
            return res.status(404).json({ message: 'Group reservation not found.' });
        }
        
        group.calculateTotals();
        await group.save();
        
        res.status(200).json(group);
    } catch (error) {
        console.error('Error updating group:', error);
        res.status(500).json({ message: 'Failed to update group reservation.' });
    }
});

// Add guest to group
router.post('/:id/guests', async (req, res) => {
    try {
        const { id } = req.params;
        const { reservationId } = req.body;
        
        if (!isValidObjectId(id) || !isValidObjectId(reservationId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        const Reservations = getModel(req, 'Reservations');
        
        const group = await GroupReservation.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!group) {
            return res.status(404).json({ message: 'Group reservation not found.' });
        }
        
        const reservation = await Reservations.findOne({
            _id: reservationId,
            property: propertyId
        });
        
        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }
        
        // Add reservation to group
        if (!group.reservations.includes(reservationId)) {
            group.reservations.push(reservationId);
        }
        
        // Update reservation
        reservation.groupId = group._id;
        await reservation.save();
        
        group.calculateTotals();
        await group.save();
        
        res.status(200).json({ group, reservation });
    } catch (error) {
        console.error('Error adding guest to group:', error);
        res.status(500).json({ message: 'Failed to add guest to group.' });
    }
});

// Assign rooms to group blocks and create folio
router.post('/:id/assign-rooms', async (req, res) => {
    try {
        const { id } = req.params;
        const { roomAssignments } = req.body; // Array of { roomBlockIndex, roomIds: [] }
        
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid group ID format' });
        }
        
        if (!Array.isArray(roomAssignments)) {
            return res.status(400).json({ message: 'roomAssignments must be an array' });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        const Rooms = getModel(req, 'Rooms');
        const GuestFolio = getModel(req, 'GuestFolio');
        const RoomType = getModel(req, 'RoomType');
        
        const group = await GroupReservation.findOne({
            _id: id,
            property: propertyId
        }).populate('roomBlocks.roomType');
        
        if (!group) {
            return res.status(404).json({ message: 'Group reservation not found.' });
        }
        
        // Assign rooms to blocks
        for (const assignment of roomAssignments) {
            const { roomBlockIndex, roomIds } = assignment;
            
            if (roomBlockIndex < 0 || roomBlockIndex >= group.roomBlocks.length) {
                continue; // Skip invalid block index
            }
            
            const block = group.roomBlocks[roomBlockIndex];
            
            if (!Array.isArray(roomIds)) {
                continue;
            }
            
            // Validate and assign rooms
            for (const roomId of roomIds) {
                if (!isValidObjectId(roomId)) {
                    continue;
                }
                
                const room = await Rooms.findOne({
                    _id: roomId,
                    roomType: block.roomType._id || block.roomType,
                    property: propertyId
                });
                
                if (!room) {
                    continue; // Skip invalid room
                }
                
                if (!block.assignedRooms.includes(roomId)) {
                    if (block.assignedRooms.length < block.numberOfRooms) {
                        block.assignedRooms.push(roomId);
                    }
                }
            }
        }
        
        group.calculateTotals();
        
        // Update status to checked-in if not already
        if (group.status === 'confirmed') {
            group.status = 'checked-in';
        }
        
        await group.save();
        
        // Update room statuses to "occupied"
        const allRoomIds = [];
        for (const assignment of roomAssignments) {
            if (Array.isArray(assignment.roomIds)) {
                allRoomIds.push(...assignment.roomIds);
            }
        }
        
        if (allRoomIds.length > 0) {
            try {
                const Rooms = getModel(req, 'Rooms');
                await Rooms.updateMany(
                    { _id: { $in: allRoomIds }, property: propertyId },
                    { $set: { status: 'occupied' } }
                );
            } catch (roomError) {
                console.error('Error updating room statuses:', roomError);
                // Don't fail the assignment if room status update fails
            }
        }
        
        // Check if folio already exists
        const existingFolio = await GuestFolio.findOne({
            groupId: group._id,
            property: propertyId,
            status: 'active'
        });
        
        if (!existingFolio) {
            // Create folio for group
            const folioId = await GuestFolio.generateFolioId(propertyId);
            
            // Collect all assigned rooms and their details
            const allAssignedRooms = [];
            const roomDetails = [];
            
            for (const block of group.roomBlocks) {
                const roomType = await RoomType.findOne({ _id: block.roomType._id || block.roomType, property: propertyId });
                const rooms = await Rooms.find({ _id: { $in: block.assignedRooms }, property: propertyId });
                
                rooms.forEach(room => {
                    allAssignedRooms.push(room.roomNumber);
                    roomDetails.push({
                        roomNumber: room.roomNumber,
                        roomType: roomType?.name || 'Unknown',
                        roomTypeId: block.roomType._id || block.roomType
                    });
                });
            }
            
            // Calculate nights
            const checkIn = new Date(group.checkInDate);
            const checkOut = new Date(group.checkOutDate);
            const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
            
            // Create folio items with room descriptions and prices
            const items = [];
            
            // Calculate price per room type block
            const totalAmount = group.totalAmount || 0;
            const discountAmount = group.discountAmount || 0;
            const amountAfterDiscount = totalAmount - discountAmount;
            
            // Distribute amount across room blocks proportionally
            const totalRooms = group.totalRooms || 1;
            
            for (const block of group.roomBlocks) {
                const roomType = await RoomType.findOne({ _id: block.roomType._id || block.roomType, property: propertyId });
                const rooms = await Rooms.find({ _id: { $in: block.assignedRooms }, property: propertyId });
                
                if (rooms.length > 0) {
                    const blockProportion = block.numberOfRooms / totalRooms;
                    const blockAmount = (amountAfterDiscount * blockProportion) / rooms.length;
                    
                    rooms.forEach(room => {
                        items.push({
                            description: `Accommodation - ${roomType?.name || 'Room'} (Room ${room.roomNumber}) - ${nights} night${nights > 1 ? 's' : ''}`,
                            date: checkIn,
                            amount: blockAmount,
                            department: 'Room',
                            quantity: nights,
                            unitPrice: blockAmount / nights
                        });
                    });
                }
            }
            
            // Add discount as a negative item if applicable
            if (discountAmount > 0) {
                items.push({
                    description: `Discount (${group.discountType === 'percent' ? `${group.discountValue}%` : 'Fixed'})`,
                    date: checkIn,
                    amount: -discountAmount,
                    department: 'Other',
                    quantity: 1,
                    unitPrice: -discountAmount
                });
            }
            
            const folio = new GuestFolio({
                folioId,
                groupId: group._id,
                guestName: group.groupName,
                guestEmail: group.contactEmail,
                guestPhone: group.contactPhone,
                roomNumbers: allAssignedRooms,
                checkIn: checkIn,
                checkOut: checkOut,
                items: items,
                payments: [],
                status: 'active',
                property: propertyId
            });
            
            folio.calculateBalance();
            await folio.save();
        }
        
        // Refresh group data
        await group.populate('roomBlocks.roomType');
        await group.populate('roomBlocks.assignedRooms');
        
        res.status(200).json({ group, message: 'Rooms assigned and folio created successfully' });
    } catch (error) {
        console.error('Error assigning rooms:', error);
        res.status(500).json({ message: 'Failed to assign rooms.' });
    }
});

// Assign room to group block (legacy endpoint, kept for compatibility)
router.post('/:id/assign-room', async (req, res) => {
    try {
        const { id } = req.params;
        const { roomBlockIndex, roomId } = req.body;
        
        if (!isValidObjectId(id) || !isValidObjectId(roomId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        const Rooms = getModel(req, 'Rooms');
        
        const group = await GroupReservation.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!group) {
            return res.status(404).json({ message: 'Group reservation not found.' });
        }
        
        const room = await Rooms.findOne({
            _id: roomId,
            property: propertyId
        });
        
        if (!room) {
            return res.status(404).json({ message: 'Room not found.' });
        }
        
        if (roomBlockIndex < 0 || roomBlockIndex >= group.roomBlocks.length) {
            return res.status(400).json({ message: 'Invalid room block index' });
        }
        
        const block = group.roomBlocks[roomBlockIndex];
        
        if (block.assignedRooms.includes(roomId)) {
            return res.status(400).json({ message: 'Room already assigned to this block' });
        }
        
        if (block.assignedRooms.length >= block.numberOfRooms) {
            return res.status(400).json({ message: 'Room block is full' });
        }
        
        block.assignedRooms.push(roomId);
        group.calculateTotals();
        await group.save();
        
        res.status(200).json(group);
    } catch (error) {
        console.error('Error assigning room:', error);
        res.status(500).json({ message: 'Failed to assign room.' });
    }
});

// Move charge between individual guest and group folio
router.post('/:id/move-charge', async (req, res) => {
    try {
        const { id } = req.params;
        const { fromReservationId, toGroupFolio, chargeDescription, amount } = req.body;
        
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid group ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        const GuestFolio = getModel(req, 'GuestFolio');
        
        const group = await GroupReservation.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!group) {
            return res.status(404).json({ message: 'Group reservation not found.' });
        }
        
        if (toGroupFolio) {
            // Move charge to group folio
            group.groupFolio.items.push({
                description: chargeDescription,
                date: new Date(),
                amount: amount,
                department: 'Other',
                reservationId: fromReservationId
            });
            
            group.groupFolio.totalCharges += amount;
            group.groupFolio.balance = group.groupFolio.totalCharges - group.groupFolio.totalPayments;
        } else {
            // Move charge from group folio to individual reservation
            if (fromReservationId && isValidObjectId(fromReservationId)) {
                const folio = await GuestFolio.findOne({
                    reservationId: fromReservationId,
                    property: propertyId,
                    status: 'active'
                });
                
                if (folio) {
                    folio.items.push({
                        description: chargeDescription,
                        date: new Date(),
                        amount: amount,
                        department: 'Other'
                    });
                    
                    folio.calculateBalance();
                    await folio.save();
                }
            }
        }
        
        await group.save();
        
        res.status(200).json(group);
    } catch (error) {
        console.error('Error moving charge:', error);
        res.status(500).json({ message: 'Failed to move charge.' });
    }
});

// Check room availability for group reservation
router.post('/check-availability', async (req, res) => {
    try {
        const availabilitySchema = {
            checkInDate: { type: 'string', required: true, isDate: true },
            checkOutDate: { type: 'string', required: true, isDate: true },
            roomBlocks: { isArray: true, required: true }
        };

        const validation = validateAndSetDefaults(req.body, availabilitySchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const dateValidation = validateDateRange(validation.validated.checkInDate, validation.validated.checkOutDate);
        if (!dateValidation.isValid) {
            return res.status(400).json({ message: dateValidation.errors.join(', ') });
        }

        const propertyId = getPropertyId(req);
        const Reservations = getModel(req, 'Reservations');
        const InventoryBlock = getModel(req, 'InventoryBlock');
        const RoomType = getModel(req, 'RoomType');

        const availabilityErrors = [];
        const availabilityDetails = [];

        for (const block of validation.validated.roomBlocks) {
            if (!block.roomType || !block.numberOfRooms) {
                availabilityErrors.push('Invalid room block data');
                continue;
            }

            const roomType = await RoomType.findOne({ _id: block.roomType, property: propertyId });
            if (!roomType) {
                availabilityErrors.push(`Room type ${block.roomType} not found`);
                continue;
            }

            const totalInventory = roomType.totalInventory;

            // Check existing reservations
            const existingReservations = await Reservations.find({
                roomType: block.roomType,
                property: propertyId,
                status: { $in: ['confirmed', 'checked-in'] },
                checkInDate: { $lt: dateValidation.checkOut },
                checkOutDate: { $gt: dateValidation.checkIn }
            }).select('numberOfRooms checkInDate checkOutDate').lean();

            // Check inventory blocks
            const inventoryBlocks = await InventoryBlock.find({
                roomType: block.roomType,
                property: propertyId,
                date: { $gte: dateValidation.checkIn, $lt: dateValidation.checkOut }
            }).select('blockedInventory date').lean();

            // Calculate availability for each day
            let minAvailable = totalInventory;
            let currentDate = new Date(dateValidation.checkIn);
            while (currentDate < dateValidation.checkOut) {
                let bookedForDay = 0;
                existingReservations.forEach(res => {
                    const resCheckIn = new Date(res.checkInDate);
                    const resCheckOut = new Date(res.checkOutDate);
                    if (resCheckIn <= currentDate && resCheckOut > currentDate) {
                        bookedForDay += res.numberOfRooms || 0;
                    }
                });

                const blockedForDay = inventoryBlocks.reduce((sum, invBlock) => {
                    const blockDate = new Date(invBlock.date);
                    if (blockDate.toDateString() === currentDate.toDateString()) {
                        return sum + (invBlock.blockedInventory || 0);
                    }
                    return sum;
                }, 0);

                const availableForDay = totalInventory - bookedForDay - blockedForDay;
                minAvailable = Math.min(minAvailable, availableForDay);

                if (availableForDay < block.numberOfRooms) {
                    availabilityErrors.push(
                        `Only ${availableForDay} room(s) available for ${roomType.name} on ${currentDate.toLocaleDateString()}, but ${block.numberOfRooms} requested`
                    );
                }

                currentDate.setDate(currentDate.getDate() + 1);
            }

            availabilityDetails.push({
                roomTypeId: block.roomType,
                roomTypeName: roomType.name,
                requested: block.numberOfRooms,
                available: minAvailable,
                totalInventory
            });
        }

        if (availabilityErrors.length > 0) {
            return res.status(400).json({
                available: false,
                message: 'Room availability check failed',
                errors: availabilityErrors,
                details: availabilityDetails
            });
        }

        res.status(200).json({
            available: true,
            message: 'All rooms available',
            details: availabilityDetails
        });
    } catch (error) {
        console.error('Error checking availability:', error);
        res.status(500).json({ message: 'Failed to check availability.' });
    }
});

// Get group arrivals for today
router.get('/arrivals/today', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const GroupReservation = getModel(req, 'GroupReservation');
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const groups = await GroupReservation.find({
            property: propertyId,
            checkInDate: { $gte: today, $lt: tomorrow },
            status: { $ne: 'checked-out' }
        })
        .populate('roomBlocks.roomType')
        .sort({ checkInDate: 1 });
        
        groups.forEach(group => group.calculateTotals());
        
        res.status(200).json({ groups });
    } catch (error) {
        console.error('Error fetching group arrivals:', error);
        res.status(500).json({ message: 'Failed to fetch group arrivals.' });
    }
});

module.exports = router;

