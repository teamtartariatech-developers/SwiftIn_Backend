const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');

router.use(express.json());
router.use(authenticate);
router.use(requireModuleAccess('distribution'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

router.get('/monthly', async (req, res) => {
    try {
        const { month, year } = req.query;
        const propertyId = getPropertyId(req);
        const RoomType = getModel(req, 'RoomType');
        const Reservations = getModel(req, 'Reservations');
        const InventoryBlock = getModel(req, 'InventoryBlock');
        
        if (!month || !year) {
            return res.status(400).json({ message: "Month and year are required" });
        }

        const monthNum = parseInt(month);
        const yearNum = parseInt(year);
        
        // Validate month (1-12)
        if (monthNum < 1 || monthNum > 12) {
            return res.status(400).json({ message: "Month must be between 1 and 12" });
        }

        // Get all room types with their total inventory and pricing info
        const roomTypes = await RoomType.find(
            { active: true, property: propertyId },
            'name totalInventory baseRate extraGuestRate adultRate childRate priceModel'
        );
        
        // Create a map of room type inventory
        const roomTypeInventory = {};
        roomTypes.forEach(rt => {
            roomTypeInventory[rt._id.toString()] = {
                name: rt.name,
                totalInventory: rt.totalInventory || 0,
                baseRate: rt.baseRate || 0,
                extraGuestRate: rt.extraGuestRate || 0,
                adultRate: rt.adultRate || 0,
                childRate: rt.childRate || 0,
                priceModel: rt.priceModel || 'perRoom'
            };
        });

        // Get all reservations for the month
        const startDate = new Date(yearNum, monthNum - 1, 1);
        const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59); // Last day of month

        const reservations = await Reservations.find({
            property: propertyId,
            $or: [
                // Reservations that start in this month
                {
                    checkInDate: { $gte: startDate, $lte: endDate }
                },
                // Reservations that end in this month
                {
                    checkOutDate: { $gte: startDate, $lte: endDate }
                },
                // Reservations that span the entire month
                {
                    checkInDate: { $lte: startDate },
                    checkOutDate: { $gte: endDate }
                }
            ],
            status: { $nin: ['cancelled', 'no-show'] } // Exclude cancelled and no-show reservations
        }).populate('roomType', 'name totalInventory baseRate extraGuestRate adultRate childRate priceModel');

        // Get inventory blocks for the month
        const inventoryBlocks = await InventoryBlock.find({
            property: propertyId,
            date: { $gte: startDate, $lte: endDate }
        }).populate('roomType', 'name totalInventory');

        // Calculate days in the month
        const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
        
        // Initialize daily inventory data
        const dailyInventory = {};
        
        // Initialize all days with total inventory
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            dailyInventory[dateStr] = {};
            
            // Initialize each room type with total inventory and pricing
            roomTypes.forEach(rt => {
                dailyInventory[dateStr][rt._id.toString()] = {
                    roomTypeName: rt.name,
                    totalInventory: rt.totalInventory || 0,
                    bookedRooms: 0,
                    availableRooms: rt.totalInventory || 0,
                    baseRate: rt.baseRate || 0,
                    extraGuestRate: rt.extraGuestRate || 0,
                    adultRate: rt.adultRate || 0,
                    childRate: rt.childRate || 0,
                    priceModel: rt.priceModel || 'perRoom'
                };
            });
        }

        // Process each reservation to calculate booked rooms per day
        reservations.forEach(reservation => {
            const checkIn = new Date(reservation.checkInDate);
            const checkOut = new Date(reservation.checkOutDate);
            const roomTypeId = reservation.roomType._id.toString();
            const numberOfRooms = reservation.numberOfRooms || 1;

            // Find the overlap between reservation dates and the requested month
            const reservationStart = new Date(Math.max(checkIn.getTime(), startDate.getTime()));
            const reservationEnd = new Date(Math.min(checkOut.getTime(), endDate.getTime()));

            // For each day the reservation is active in this month
            for (let d = new Date(reservationStart); d < reservationEnd; d.setDate(d.getDate() + 1)) {
                const day = d.getDate();
                const dateStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
                
                if (dailyInventory[dateStr] && dailyInventory[dateStr][roomTypeId]) {
                    dailyInventory[dateStr][roomTypeId].bookedRooms += numberOfRooms;
                }
            }
        });

        // Process inventory blocks
        inventoryBlocks.forEach(block => {
            const blockDate = new Date(block.date);
            const day = blockDate.getDate();
            const dateStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            const roomTypeId = block.roomType._id.toString();
            
            if (dailyInventory[dateStr] && dailyInventory[dateStr][roomTypeId]) {
                dailyInventory[dateStr][roomTypeId].blockedInventory = block.blockedInventory || 0;
            }
        });

        // Calculate final available rooms (total - booked - blocked)
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            
            if (dailyInventory[dateStr]) {
                Object.keys(dailyInventory[dateStr]).forEach(roomTypeId => {
                    const dayData = dailyInventory[dateStr][roomTypeId];
                    const blocked = dayData.blockedInventory || 0;
                    const booked = dayData.bookedRooms || 0;
                    
                    dayData.availableRooms = Math.max(0, dayData.totalInventory - booked - blocked);
                });
            }
        }

        // Format response with updated schema fields
        const response = {
            month: monthNum,
            year: yearNum,
            daysInMonth: daysInMonth,
            roomTypes: roomTypes.map(rt => ({
                id: rt._id.toString(),
                name: rt.name,
                totalInventory: rt.totalInventory || 0,
                baseRate: rt.baseRate || 0,
                extraGuestRate: rt.extraGuestRate || 0,
                adultRate: rt.adultRate || 0,
                childRate: rt.childRate || 0,
                priceModel: rt.priceModel || 'perRoom'
            })),
            dailyInventory: dailyInventory
        };

        res.status(200).json(response);
    } catch (error) {
        console.error('Error fetching monthly inventory:', error);
        res.status(500).json({ message: "Server error fetching monthly inventory." });
    }
});

// Get real-time room availability by room type
router.get('/availability', async (req, res) => {
    try {
        const { roomTypeId, date } = req.query;
        const propertyId = getPropertyId(req);
        const RoomType = getModel(req, 'RoomType');
        const Rooms = getModel(req, 'Rooms');
        const Reservations = getModel(req, 'Reservations');
        
        if (!roomTypeId) {
            return res.status(400).json({ message: "Room type ID is required" });
        }

        // Get room type details
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: "Room type not found" });
        }

        // Get all rooms of this type
        const rooms = await Rooms.find({ roomType: roomTypeId, property: propertyId });
        
        // Count rooms by status
        const roomStatusCounts = {
            clean: 0,
            dirty: 0,
            occupied: 0,
            maintenance: 0,
            total: rooms.length
        };

        rooms.forEach(room => {
            if (roomStatusCounts.hasOwnProperty(room.status)) {
                roomStatusCounts[room.status]++;
            }
        });

        // Calculate available rooms (clean + dirty)
        const availableRooms = roomStatusCounts.clean + roomStatusCounts.dirty;
        const unavailableRooms = roomStatusCounts.occupied + roomStatusCounts.maintenance;

        // Get reservations for the specific date if provided
        let bookedRooms = 0;
        if (date) {
            const targetDate = new Date(date);
            const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
            const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

            const reservations = await Reservations.find({
                property: propertyId,
                roomType: roomTypeId,
                checkInDate: { $lte: endOfDay },
                checkOutDate: { $gt: startOfDay },
                status: { $nin: ['cancelled', 'no-show'] }
            });

            bookedRooms = reservations.reduce((total, reservation) => {
                return total + (reservation.numberOfRooms || 1);
            }, 0);
        }

        const response = {
            roomType: {
                id: roomType._id.toString(),
                name: roomType.name,
                totalInventory: roomType.totalInventory,
                baseRate: roomType.baseRate,
                extraGuestRate: roomType.extraGuestRate,
                adultRate: roomType.adultRate,
                childRate: roomType.childRate,
                priceModel: roomType.priceModel
            },
            roomStatus: roomStatusCounts,
            availability: {
                totalRooms: roomStatusCounts.total,
                availableRooms: availableRooms,
                unavailableRooms: unavailableRooms,
                bookedRooms: bookedRooms,
                actuallyAvailable: Math.max(0, availableRooms - bookedRooms)
            },
            date: date || new Date().toISOString().split('T')[0]
        };

        res.status(200).json(response);
    } catch (error) {
        console.error('Error fetching room availability:', error);
        res.status(500).json({ message: "Server error fetching room availability." });
    }
});

// Get all room types with their current availability
router.get('/room-types-availability', async (req, res) => {
    try {
        const { date } = req.query;
        const propertyId = getPropertyId(req);
        const RoomType = getModel(req, 'RoomType');
        const Rooms = getModel(req, 'Rooms');
        const Reservations = getModel(req, 'Reservations');
        
        // Get all active room types
        const roomTypes = await RoomType.find({ active: true, property: propertyId });
        
        const availabilityData = await Promise.all(
            roomTypes.map(async (roomType) => {
                // Get all rooms of this type
                const rooms = await Rooms.find({ roomType: roomType._id, property: propertyId });
                
                // Count rooms by status
                const roomStatusCounts = {
                    clean: 0,
                    dirty: 0,
                    occupied: 0,
                    maintenance: 0,
                    total: rooms.length
                };

                rooms.forEach(room => {
                    if (roomStatusCounts.hasOwnProperty(room.status)) {
                        roomStatusCounts[room.status]++;
                    }
                });

                // Calculate available rooms
                const availableRooms = roomStatusCounts.clean + roomStatusCounts.dirty;
                
                // Get booked rooms for the date if provided
                let bookedRooms = 0;
                if (date) {
                    const targetDate = new Date(date);
                    const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
                    const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

                    const reservations = await Reservations.find({
                        property: propertyId,
                        roomType: roomType._id,
                        checkInDate: { $lte: endOfDay },
                        checkOutDate: { $gt: startOfDay },
                        status: { $nin: ['cancelled', 'no-show'] }
                    });

                    bookedRooms = reservations.reduce((total, reservation) => {
                        return total + (reservation.numberOfRooms || 1);
                    }, 0);
                }

                return {
                    id: roomType._id.toString(),
                    name: roomType.name,
                    totalInventory: roomType.totalInventory,
                    baseRate: roomType.baseRate,
                    extraGuestRate: roomType.extraGuestRate,
                    adultRate: roomType.adultRate,
                    childRate: roomType.childRate,
                    priceModel: roomType.priceModel,
                    roomStatus: roomStatusCounts,
                    availability: {
                        totalRooms: roomStatusCounts.total,
                        availableRooms: availableRooms,
                        bookedRooms: bookedRooms,
                        actuallyAvailable: Math.max(0, availableRooms - bookedRooms)
                    }
                };
            })
        );

        res.status(200).json({
            date: date || new Date().toISOString().split('T')[0],
            roomTypes: availabilityData
        });
    } catch (error) {
        console.error('Error fetching room types availability:', error);
        res.status(500).json({ message: "Server error fetching room types availability." });
    }
});

// Block inventory for specific dates
router.post('/block-inventory', async (req, res) => {
    try {
        const { roomTypeId, dates, blockedInventory, reason } = req.body;
        const propertyId = getPropertyId(req);
        const RoomType = getModel(req, 'RoomType');
        const InventoryBlock = getModel(req, 'InventoryBlock');

        if (!roomTypeId || !Array.isArray(dates) || dates.length === 0 || blockedInventory === undefined) {
            return res.status(400).json({ message: "Missing or invalid required fields (roomTypeId, dates array, blockedInventory)." });
        }

        if (blockedInventory < 0) {
            return res.status(400).json({ message: "Blocked inventory cannot be negative." });
        }

        if (!mongoose.Types.ObjectId.isValid(roomTypeId)) {
            return res.status(400).json({ message: "Invalid Room Type ID format." });
        }

        // Verify room type exists
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: "Room type not found." });
        }

        // Validate dates and convert to Date objects
        const dateObjects = [];
        for (const dateStr of dates) {
            const dateObj = new Date(dateStr + 'T00:00:00.000Z');
            if (isNaN(dateObj.getTime())) {
                return res.status(400).json({ message: `Invalid date format found: ${dateStr}. Use YYYY-MM-DD.` });
            }
            dateObjects.push(dateObj);
        }

        // Prepare bulk operations for upsert
        const bulkOps = dateObjects.map(dateObj => ({
            updateOne: {
                filter: { roomType: roomTypeId, date: dateObj, property: propertyId },
                update: { 
                    $set: { 
                        blockedInventory: blockedInventory,
                        reason: reason || 'Manual block',
                        createdBy: req.tenant.user?._id?.toString() || 'admin',
                        property: propertyId
                    }
                },
                upsert: true
            }
        }));

        let modifiedCount = 0;
        let upsertedCount = 0;
        if (bulkOps.length > 0) {
            const result = await InventoryBlock.bulkWrite(bulkOps);
            modifiedCount = result.modifiedCount;
            upsertedCount = result.upsertedCount;
        }

        res.status(200).json({
            message: `Inventory blocked for ${dates.length} day(s). Modified: ${modifiedCount}, Created: ${upsertedCount}.`,
            blockedInventory: blockedInventory,
            dates: dates
        });

    } catch (error) {
        console.error("Error blocking inventory:", error);
        if (error.code === 11000) {
            return res.status(409).json({ message: "Concurrency error or duplicate inventory block detected." });
        }
        res.status(500).json({ message: "Server error blocking inventory." });
    }
});

// Get inventory blocks for a specific date range
router.get('/inventory-blocks', async (req, res) => {
    try {
        const { roomTypeId, startDate, endDate } = req.query;
        const propertyId = getPropertyId(req);
        const InventoryBlock = getModel(req, 'InventoryBlock');

        if (!roomTypeId) {
            return res.status(400).json({ message: "Room type ID is required." });
        }

        if (!mongoose.Types.ObjectId.isValid(roomTypeId)) {
            return res.status(400).json({ message: "Invalid Room Type ID format." });
        }

        // Build query
        const query = { roomType: roomTypeId, property: propertyId };
        
        if (startDate && endDate) {
            const start = new Date(startDate + 'T00:00:00.000Z');
            const end = new Date(endDate + 'T23:59:59.999Z');
            
            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res.status(400).json({ message: "Invalid date format. Use YYYY-MM-DD." });
            }
            
            query.date = { $gte: start, $lte: end };
        }

        const blocks = await InventoryBlock.find(query)
            .populate('roomType', 'name totalInventory')
            .sort({ date: 1 });

        res.status(200).json(blocks);

    } catch (error) {
        console.error("Error fetching inventory blocks:", error);
        res.status(500).json({ message: "Server error fetching inventory blocks." });
    }
});

// Remove inventory blocks
router.delete('/unblock-inventory', async (req, res) => {
    try {
        const { roomTypeId, dates } = req.body;
        const propertyId = getPropertyId(req);
        const InventoryBlock = getModel(req, 'InventoryBlock');

        if (!roomTypeId || !Array.isArray(dates) || dates.length === 0) {
            return res.status(400).json({ message: "Missing or invalid required fields (roomTypeId, dates array)." });
        }

        if (!mongoose.Types.ObjectId.isValid(roomTypeId)) {
            return res.status(400).json({ message: "Invalid Room Type ID format." });
        }

        // Convert dates to Date objects
        const dateObjects = [];
        for (const dateStr of dates) {
            const dateObj = new Date(dateStr + 'T00:00:00.000Z');
            if (isNaN(dateObj.getTime())) {
                return res.status(400).json({ message: `Invalid date format found: ${dateStr}. Use YYYY-MM-DD.` });
            }
            dateObjects.push(dateObj);
        }

        // Delete inventory blocks
        const result = await InventoryBlock.deleteMany({
            roomType: roomTypeId,
            property: propertyId,
            date: { $in: dateObjects }
        });

        res.status(200).json({
            message: `Removed ${result.deletedCount} inventory block(s).`,
            deletedCount: result.deletedCount,
            dates: dates
        });

    } catch (error) {
        console.error("Error removing inventory blocks:", error);
        res.status(500).json({ message: "Server error removing inventory blocks." });
    }
});

module.exports = router;