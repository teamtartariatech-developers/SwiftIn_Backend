const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../middleware/auth');
const { validateAndSetDefaults, validateDateRange, isValidObjectId } = require('../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

router.post('/check-availability', requireModuleAccess('front-office'), async (req, res) => {
    try {
        // Validate and set defaults
        const availabilitySchema = {
            roomTypeId: { type: 'string', required: true, isObjectId: true },
            checkInDate: { type: 'string', required: true, isDate: true },
            checkOutDate: { type: 'string', required: true, isDate: true }
        };

        const validation = validateAndSetDefaults(req.body, availabilitySchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        // Validate date range
        const dateValidation = validateDateRange(validation.validated.checkInDate, validation.validated.checkOutDate);
        if (!dateValidation.isValid) {
            return res.status(400).json({ message: dateValidation.errors.join(', ') });
        }

        const propertyId = getPropertyId(req);
        const RoomType = getModel(req, 'RoomType');
        const Reservation = getModel(req, 'Reservations');
        
        const roomTypeId = validation.validated.roomTypeId;
        const requestedCheckIn = dateValidation.checkIn;
        const requestedCheckOut = dateValidation.checkOut;

        // --- Get Total Inventory ---
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: "Room type not found." });
        }
        const totalInventory = roomType.totalInventory;

        // --- Find Potentially Conflicting Reservations ---
        const potentialConflicts = await Reservation.find({
            roomType: roomTypeId,
            property: propertyId,
            status: { $in: ['confirmed', 'checked-in'] },
            checkInDate: { $lt: requestedCheckOut },
            checkOutDate: { $gt: requestedCheckIn }
        }).select('checkInDate checkOutDate numberOfRooms').lean();

        // --- Calculate Availability for Each Day ---
        let dailyAvailability = {};
        let isOverallAvailable = true; // Still useful to know if *at least one* room is free the whole time
        let minAvailableOnAnyDay = totalInventory;

        let currentDate = new Date(requestedCheckIn);
        while (currentDate < requestedCheckOut) {
            const dateStr = currentDate.toISOString().split('T')[0];
            let committedRoomsForDay = 0;

            potentialConflicts.forEach(res => {
                const resCheckIn = new Date(res.checkInDate); resCheckIn.setUTCHours(0,0,0,0);
                const resCheckOut = new Date(res.checkOutDate); resCheckOut.setUTCHours(0,0,0,0);
                if (resCheckIn <= currentDate && resCheckOut > currentDate) {
                    committedRoomsForDay += res.numberOfRooms;
                }
            });

            const availableCount = totalInventory - committedRoomsForDay;
            // Ensure count doesn't go below 0
            // const finalAvailableCount = Math.max(0, availableCount);
            const finalAvailableCount =availableCount;
            dailyAvailability[dateStr] = finalAvailableCount;

            // Update overall flag based on whether *at least one* room is available
            if (finalAvailableCount <= 0) {
                isOverallAvailable = false;
            }

            minAvailableOnAnyDay = Math.min(minAvailableOnAnyDay, finalAvailableCount);

            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // --- Respond with Detailed Availability (raw counts) ---
        res.status(200).json({
            // overallAvailable: true ONLY if at least one room is free on ALL requested nights
            overallAvailable: isOverallAvailable,
            // minAvailableCount: The lowest number of rooms free on any single night in the range
            minAvailableCount: minAvailableOnAnyDay,
            // dailyAvailability: Breakdown per night showing absolute available count
            dailyAvailability: dailyAvailability
        });

    } catch (error) {
        console.error("Detailed Availability Check Error:", error);
        res.status(500).json({ message: "Server error checking detailed availability." });
    }
});

router.put('/Rooms/:id', requireModuleAccess('settings'), async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid room ID format' });
        }

        // Validate update fields
        const updateSchema = {
            roomNumber: { type: 'string' },
            roomType: { type: 'string', isObjectId: true },
            status: { type: 'string', enum: ['clean', 'dirty', 'occupied', 'maintenance'] },
            floor: { type: 'number', min: 0 }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const updates = { ...validation.validated };
        delete updates.property;

        const Rooms = getModel(req, 'Rooms');
        const updatedRoom = await Rooms.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updates,
            { new: true, runValidators: true }
        );
        if (!updatedRoom) {
            return res.status(404).json({ message: "Room not found." });
        }
        res.status(200).json(updatedRoom);
    }catch (error) {
        res.status(500).json({ message: "Server error updating room." });
    };
});

router.get('/getRooms', async (req, res) => {
    try{
        const Rooms = getModel(req, 'Rooms');
        const rooms = await Rooms.find({ property: getPropertyId(req) });
        res.status(200).json(rooms);
    }catch(error){
        res.status(500).json({message: "Server error fetching rooms."})
    }
});

// Get rooms by room type
router.get('/getRoomsByType/:roomTypeId', async (req, res) => {
    try{
        const { roomTypeId } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(roomTypeId)) {
            return res.status(400).json({ message: 'Invalid room type ID format' });
        }
        
        const Rooms = getModel(req, 'Rooms');
        const rooms = await Rooms.find({ roomType: roomTypeId, property: getPropertyId(req) });
        
        res.status(200).json(rooms);
    }catch(error){
        console.error('Error in getRoomsByType:', error);
        res.status(500).json({message: "Server error fetching rooms by type."})
    }
});

// Get single room by ID
router.get('/getRoom/:roomId', async (req, res) => {
    try{
        const { roomId } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(roomId)) {
            return res.status(400).json({ message: 'Invalid room ID format' });
        }
        
        const Rooms = getModel(req, 'Rooms');
        const room = await Rooms.findOne({ _id: roomId, property: getPropertyId(req) });
        if (!room) {
            return res.status(404).json({message: "Room not found."});
        }
        res.status(200).json(room);
    }catch(error){
        console.error('Error in getRoom:', error);
        res.status(500).json({message: "Server error fetching room."})
    }
});

// Update room status
router.put('/updateRoom/:roomId', requireModuleAccess('housekeeping'), async (req, res) => {
    try{
        const { roomId } = req.params;
        const { status } = req.body;
        
        console.log('=== ROOM STATUS UPDATE DEBUG ===');
        console.log('Room ID:', roomId);
        console.log('New Status:', status);
        
        const Rooms = getModel(req, 'Rooms');
        const updatedRoom = await Rooms.findOneAndUpdate(
            { _id: roomId, property: getPropertyId(req) }, 
            { status },
            { new: true, runValidators: true }
        );
        
        if (!updatedRoom) {
            return res.status(404).json({message: "Room not found."});
        }
        
        console.log('Room updated successfully:', updatedRoom);
        console.log('=== END ROOM STATUS UPDATE DEBUG ===');
        
        res.status(200).json({
            message: "Room status updated successfully",
            room: updatedRoom
        });
    }catch(error){
        console.error('Error in updateRoom:', error);
        res.status(500).json({message: "Server error updating room status."})
    }
});

router.post('/addRoomType', requireModuleAccess('settings'), async (req,res) => {
    try{
        const roomTypeData = {
            ...req.body,
            property: getPropertyId(req),
        };
        const RoomType = getModel(req, 'RoomType');
        const newRoomType = new RoomType(roomTypeData);
        await newRoomType.save()
        res.status(200).json({message:"Successfully added new room type", newRoomType})
    }catch(error){
        res.status(500).json({message: "Server error uploading room type."})
    }
})

router.put('/roomType/:id', requireModuleAccess('settings'), async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body };
        delete updateData.property;

        const RoomType = getModel(req, 'RoomType');
        const updatedRoomType = await RoomType.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updateData,
            { new: true, runValidators: true }
        );

        if (!updatedRoomType) {
            return res.status(404).json({ message: "Room type not found." });
        }

        res.status(200).json({
            message: "Room type updated successfully.",
            roomType: updatedRoomType
        });
    } catch (error) {
        console.error('Error updating room type:', error);
        res.status(500).json({ message: "Server error updating room type." });
    }
});

router.delete('/roomType/:id', requireModuleAccess('settings'), async (req, res) => {
    try {
        const { id } = req.params;
        const RoomType = getModel(req, 'RoomType');
        const deletedRoomType = await RoomType.findOneAndDelete({
            _id: id,
            property: getPropertyId(req)
        });

        if (!deletedRoomType) {
            return res.status(404).json({ message: "Room type not found." });
        }

        res.status(200).json({
            message: "Room type deleted successfully.",
            roomType: deletedRoomType
        });
    } catch (error) {
        console.error('Error deleting room type:', error);
        res.status(500).json({ message: "Server error deleting room type." });
    }
});

router.get('/getRoomTypes', async (req, res) => {
    try{
        const RoomType = getModel(req, 'RoomType');
        const roomTypes = await RoomType.find({ property: getPropertyId(req) });
        res.status(200).json(roomTypes);
    }catch(error){
        res.status(500).json({message: "Server error fetching room types."})
    }
});

router.post('/addRoom', requireModuleAccess('settings'), async (req, res) => {
    try{
        const roomData = {
            ...req.body,
            property: getPropertyId(req),
        };
        const Rooms = getModel(req, 'Rooms');
        const newRoom = new Rooms(roomData);
        await newRoom.save()
        res.status(200).json({message:"Successfully added new room", newRoom})
    }catch(error){
        res.status(500).json({message: "Server error uploading room."})
    }
});

router.delete('/Rooms/:id', requireModuleAccess('settings'), async (req, res) => {
    try {
        const { id } = req.params;
        const Rooms = getModel(req, 'Rooms');
        const deletedRoom = await Rooms.findOneAndDelete({
            _id: id,
            property: getPropertyId(req)
        });

        if (!deletedRoom) {
            return res.status(404).json({ message: "Room not found." });
        }

        res.status(200).json({
            message: "Room deleted successfully.",
            room: deletedRoom
        });
    } catch (error) {
        console.error('Error deleting room:', error);
        res.status(500).json({ message: "Server error deleting room." });
    }
});

router.get('/getRoomType/:id', async (req, res) => {
    try{
        const RoomType = getModel(req, 'RoomType');
        const roomType = await RoomType.findOne({ _id: req.params.id, property: getPropertyId(req) });
        res.status(200).json(roomType);
    }catch(error){
        res.status(500).json({message: "Server error fetching room type."})
    }
});

// Update room status
router.put('/updateRoomStatus', requireModuleAccess('housekeeping'), async (req, res) => {
    try {
        const { roomNumber, status } = req.body;
        
        if (!roomNumber || !status) {
            return res.status(400).json({ message: "Room number and status are required." });
        }

        const Rooms = getModel(req, 'Rooms');
        const updatedRoom = await Rooms.findOneAndUpdate(
            { roomNumber, property: getPropertyId(req) },
            { status },
            { new: true, runValidators: true }
        );

        if (!updatedRoom) {
            return res.status(404).json({ message: "Room not found." });
        }

        res.status(200).json({ 
            message: "Room status updated successfully", 
            room: updatedRoom 
        });
    } catch (error) {
        console.error('Error updating room status:', error);
        res.status(500).json({ message: "Server error updating room status." });
    }
});

// Add test rooms data
router.post('/addTestRooms', requireModuleAccess('settings'), async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const RoomType = getModel(req, 'RoomType');
        const Rooms = getModel(req, 'Rooms');
        // First, get existing room types to use their IDs
        const roomTypes = await RoomType.find({ property: propertyId });
        if (roomTypes.length === 0) {
            return res.status(400).json({ message: "No room types found. Please add room types first." });
        }

        const testRooms = [];
        
        // Create rooms for each room type
        roomTypes.forEach((roomType, index) => {
            // Create 5 rooms for each room type
            for (let i = 1; i <= 5; i++) {
                testRooms.push({
                    roomNumber: `${roomType.name.substring(0, 3).toUpperCase()}${String(index * 5 + i).padStart(2, '0')}`,
                    roomType: roomType._id.toString(),
                    status: i <= 3 ? 'cleaned' : 'maintenance' // First 3 rooms are available, last 2 are in maintenance
                });
            }
        });

        // Clear existing rooms and add test data
        await Rooms.deleteMany({ property: propertyId });
        const createdRooms = await Rooms.insertMany(
            testRooms.map((room) => ({ ...room, property: propertyId }))
        );

        res.status(200).json({ 
            message: "Test rooms added successfully", 
            rooms: createdRooms,
            count: createdRooms.length 
        });
    } catch (error) {
        console.error('Error adding test rooms:', error);
        res.status(500).json({ message: "Server error adding test rooms." });
    }
});

module.exports = router;