const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const router = express.Router();
const { authenticate, requireModuleAccess } = require('../../middleware/auth');

router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('guest-management'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

const createGuestProfileWithReservation = async (req, res, reservationIdOverride = null) => {
    try {
        const {
            guestName,
            guestEmail,
            guestNumber,
            reservationId,
            guestType,
            aadhaarNumber,
            adultCount,
            childCount,
            totalSpend,
            records = [],
            checkInDate,
            checkOutDate
        } = req.body;

        const effectiveReservationId = reservationIdOverride || reservationId;

        if (!guestName || !guestNumber || !effectiveReservationId) {
            return res.status(400).json({ message: "guestName, guestNumber and reservationId are required." });
        }

        if (!mongoose.Types.ObjectId.isValid(effectiveReservationId)) {
            return res.status(400).json({ message: "Invalid reservationId provided." });
        }

        const propertyId = getPropertyId(req);
        const guestProfiles = getModel(req, 'GuestProfiles');
        const reservationsModel = getModel(req, 'Reservations');

        const reservation = await reservationsModel.findOne({
            _id: effectiveReservationId,
            property: propertyId
        });

        if (!reservation) {
            return res.status(404).json({ message: "Reservation not found for the provided reservationId." });
        }

        const stayRecord = (() => {
            const inDate = checkInDate || reservation.checkInDate;
            const outDate = checkOutDate || reservation.checkOutDate;

            if (!inDate || !outDate) {
                return null;
            }

            const start = new Date(inDate);
            const end = new Date(outDate);

            if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
                return null;
            }

            return {
                checkInDate: start,
                checkOutDate: end,
                amount: typeof totalSpend === 'number' ? totalSpend : (reservation.totalAmount || 0)
            };
        })();

        const initialRecords = Array.isArray(records) && records.length > 0
            ? records
            : stayRecord
                ? [stayRecord]
                : [];

        const averageStay = initialRecords.length
            ? Math.round(initialRecords.reduce((sum, record) => {
                const checkIn = new Date(record.checkInDate);
                const checkOut = new Date(record.checkOutDate);
                const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
                return sum + (Number.isNaN(nights) ? 0 : nights);
            }, 0) / initialRecords.length * 100) / 100
            : 0;

        const newGuest = new guestProfiles({
            guestName,
            guestEmail,
            guestNumber,
            reservationId: effectiveReservationId,
            guestType: guestType || 'regular',
            aadhaarNumber,
            adultCount: typeof adultCount === 'number' ? adultCount : 1,
            childCount: typeof childCount === 'number' ? childCount : 0,
            totalSpend: typeof totalSpend === 'number' ? totalSpend : 0,
            totalVisits: 1,
            records: initialRecords,
            AverageStay: averageStay,
            property: propertyId
        });
        await newGuest.save();
        return res.status(201).json({ message: "Guest created successfully", guest: newGuest });
    } catch (error) {
        console.error('Error creating guest:', error);
        return res.status(500).json({ message: "Server error creating guest." });
    }
};


// Get all guest profiles with pagination and search
router.get('/guests', async (req, res) => {
    try {
        const { page = 1, limit = 15, search = '', reservationId = '' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const propertyId = getPropertyId(req);
        const guestProfiles = getModel(req, 'GuestProfiles');
        
        // Build search query
        let searchQuery = { property: propertyId };
        if (reservationId) {
            if (!mongoose.Types.ObjectId.isValid(reservationId)) {
                return res.status(400).json({ message: "Invalid reservationId provided." });
            }
            searchQuery.reservationId = reservationId;
        }
        if (search && search.trim() !== '') {
            searchQuery.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { guestEmail: { $regex: search, $options: 'i' } },
                { guestNumber: { $regex: search, $options: 'i' } }
            ];
        }
        
        // Get total count with search filter
        const total = await guestProfiles.countDocuments(searchQuery);
        
        // Get paginated results
        const guests = await guestProfiles.find(searchQuery)
            .skip(skip)
            .limit(parseInt(limit))
            .sort({ createdAt: -1 });
        
        // Calculate pagination info
        const totalPages = Math.ceil(total / parseInt(limit));
        const hasNextPage = parseInt(page) < totalPages;
        const hasPrevPage = parseInt(page) > 1;
        
        res.status(200).json({
            guests,
            pagination: {
                currentPage: parseInt(page),
                totalPages,
                totalItems: total,
                itemsPerPage: parseInt(limit),
                hasNextPage,
                hasPrevPage
            }
        });

    } catch(error) {
        console.error('Error fetching guests:', error);
        res.status(500).json({ message: "Server error fetching guests." });
    }
});

router.post('/', (req, res) => createGuestProfileWithReservation(req, res));
router.post('/reservation/:reservationId', (req, res) =>
    createGuestProfileWithReservation(req, res, req.params.reservationId)
);

// Create or update guest profile (for check-in process)
router.post('/create-or-update', async (req, res) => {
    try {
        const {
            guestName,
            guestEmail,
            guestNumber,
            totalSpend,
            guestType,
            checkInDate,
            checkOutDate,
            reservationId,
            aadhaarNumber,
            adultCount,
            childCount
        } = req.body;
        const propertyId = getPropertyId(req);
        const guestProfiles = getModel(req, 'GuestProfiles');
        const reservationsModel = getModel(req, 'Reservations');
        
        console.log('=== GUEST PROFILE CREATE/UPDATE DEBUG ===');
        console.log('Request body:', req.body);

        let reservation = null;
        if (reservationId) {
            if (!mongoose.Types.ObjectId.isValid(reservationId)) {
                return res.status(400).json({ message: "Invalid reservationId provided." });
            }
            reservation = await reservationsModel.findOne({
                _id: reservationId,
                property: propertyId
            });

            if (!reservation) {
                return res.status(404).json({ message: "Reservation not found for the provided reservationId." });
            }
        }
        
        // Check if guest already exists by email or phone
        const identifierQuery = [];
        if (guestEmail) identifierQuery.push({ guestEmail });
        if (guestNumber) identifierQuery.push({ guestNumber });

        let existingGuest = null;
        if (identifierQuery.length > 0) {
            existingGuest = await guestProfiles.findOne({
                property: propertyId,
                $or: identifierQuery
            });
        }

        const resolvedCheckIn = checkInDate || reservation?.checkInDate || null;
        const resolvedCheckOut = checkOutDate || reservation?.checkOutDate || null;

        const buildStayRecord = () => {
            const fallbackDate = new Date();
            const inDate = resolvedCheckIn ? new Date(resolvedCheckIn) : fallbackDate;
            const outDate = resolvedCheckOut ? new Date(resolvedCheckOut) : fallbackDate;

            return {
                checkInDate: Number.isNaN(inDate.getTime()) ? fallbackDate : inDate,
                checkOutDate: Number.isNaN(outDate.getTime()) ? fallbackDate : outDate,
                amount: totalSpend || 0
            };
        };

        if (existingGuest) {
            console.log('Existing guest found:', existingGuest._id);
            
            // Create new stay record
            const newStayRecord = buildStayRecord();
            
            // Calculate average stay duration
            const allRecords = [...existingGuest.records, newStayRecord];
            const totalNights = allRecords.reduce((sum, record) => {
                const checkIn = new Date(record.checkInDate);
                const checkOut = new Date(record.checkOutDate);
                const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
                return sum + nights;
            }, 0);
            const averageStay = totalNights / allRecords.length;

            // Update existing guest
            const updatedGuest = await guestProfiles.findOneAndUpdate(
                { _id: existingGuest._id, property: propertyId },
                {
                    $set: {
                        totalVisits: existingGuest.totalVisits + 1,
                        totalSpend: existingGuest.totalSpend + (totalSpend || 0),
                        AverageStay: Math.round(averageStay * 100) / 100,
                        ...(reservation ? { reservationId: reservation._id } : {}),
                        ...(guestType && { guestType }),
                        ...(aadhaarNumber && { aadhaarNumber }),
                        ...(typeof adultCount === 'number' ? { adultCount } : {}),
                        ...(typeof childCount === 'number' ? { childCount } : {})
                    },
                    $push: { records: newStayRecord }
                },
                { new: true, runValidators: true }
            );
            
            console.log('Guest profile updated successfully');
            console.log('=== END GUEST PROFILE DEBUG ===');
            
            res.status(200).json({ 
                message: "Guest profile updated successfully", 
                guest: updatedGuest,
                isNewGuest: false 
            });
        } else {
            console.log('Creating new guest profile');
            
            if (!reservation) {
                return res.status(400).json({ message: "reservationId is required to create a new guest profile." });
            }
            
            // Create new stay record
            const newStayRecord = buildStayRecord();
            
            // Calculate average stay duration for new guest
            const checkIn = new Date(newStayRecord.checkInDate);
            const checkOut = new Date(newStayRecord.checkOutDate);
            const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
            const averageStay = nights; // For first stay, average is just the current stay duration
            
            // Create new guest
            const newGuest = new guestProfiles({
                guestName,
                guestEmail,
                guestNumber,
                guestType: guestType || 'regular',
                reservationId: reservation._id,
                aadhaarNumber,
                adultCount: typeof adultCount === 'number' ? adultCount : 1,
                childCount: typeof childCount === 'number' ? childCount : 0,
                totalVisits: 1,
                totalSpend: totalSpend || 0,
                AverageStay: averageStay,
                records: [newStayRecord],
                property: propertyId
            });
            await newGuest.save();
            
            console.log('Guest profile created successfully');
            console.log('=== END GUEST PROFILE DEBUG ===');
            
            res.status(201).json({ 
                message: "Guest profile created successfully", 
                guest: newGuest,
                isNewGuest: true 
            });
        }
    } catch (error) {
        console.error('Error creating/updating guest profile:', error);
        res.status(500).json({ message: "Server error creating/updating guest profile." });
    }
});

// Update existing guest profile
router.put('/guest/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body };
        delete updateData.property;
        const guestProfiles = getModel(req, 'GuestProfiles');
        
        const updatedGuest = await guestProfiles.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updateData,
            { new: true, runValidators: true }
        );
        
        if (!updatedGuest) {
            return res.status(404).json({ message: "Guest not found" });
        }
        
        res.status(200).json({ 
            message: "Guest profile updated successfully", 
            guest: updatedGuest 
        });
    } catch (error) {
        console.error('Error updating guest profile:', error);
        res.status(500).json({ message: "Server error updating guest profile." });
    }
});


module.exports = router;