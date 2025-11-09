const express = require('express');
const bodyParser = require('body-parser');
const router = express.Router();
const { authenticate, requireModuleAccess } = require('../../middleware/auth');

router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('guest-management'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;


// Get all guest profiles with pagination and search
router.get('/guests', async (req, res) => {
    try {
        const { page = 1, limit = 15, search = '' } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const propertyId = getPropertyId(req);
        const guestProfiles = getModel(req, 'GuestProfiles');
        
        // Build search query
        let searchQuery = { property: propertyId };
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

router.post('/', async (req, res) => {
    try {
        const guestProfiles = getModel(req, 'GuestProfiles');
        const newGuest = new guestProfiles({
            ...req.body,
            property: getPropertyId(req),
        });
        await newGuest.save();
        res.status(201).json({ message: "Guest created successfully", guest: newGuest });
    }catch(error){
        res.status(500).json({ message: "Server error creating guest." });
    }
});

// Create or update guest profile (for check-in process)
router.post('/create-or-update', async (req, res) => {
    try {
        const { guestName, guestEmail, guestNumber, totalSpend, guestType, checkInDate, checkOutDate } = req.body;
        const propertyId = getPropertyId(req);
        const guestProfiles = getModel(req, 'GuestProfiles');
        
        console.log('=== GUEST PROFILE CREATE/UPDATE DEBUG ===');
        console.log('Request body:', req.body);
        
        // Check if guest already exists by email or phone
        let existingGuest = await guestProfiles.findOne({
            property: propertyId,
            $or: [
                { guestEmail: guestEmail },
                { guestNumber: guestNumber }
            ]
        });

        if (existingGuest) {
            console.log('Existing guest found:', existingGuest._id);
            
            // Create new stay record
            const newStayRecord = {
                checkInDate: checkInDate ? new Date(checkInDate) : new Date(),
                checkOutDate: checkOutDate ? new Date(checkOutDate) : new Date(),
                amount: totalSpend || 0
            };
            
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
                        ...(guestType && { guestType }),
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
            
            // Create new stay record
            const newStayRecord = {
                checkInDate: checkInDate ? new Date(checkInDate) : new Date(),
                checkOutDate: checkOutDate ? new Date(checkOutDate) : new Date(),
                amount: totalSpend || 0
            };
            
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