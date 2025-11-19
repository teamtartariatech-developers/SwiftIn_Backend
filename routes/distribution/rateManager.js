const mongoose = require('mongoose');
const express = require('express');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(express.json());
router.use(authenticate);
router.use(requireModuleAccess('distribution'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

router.post ('/setRates', async (req, res) => {
    try {
        // Validate and set defaults
        const rateSchema = {
            roomTypeId: { type: 'string', required: true, isObjectId: true },
            dates: { isArray: true, required: true, custom: (val) => Array.isArray(val) && val.length > 0 || 'Dates array must not be empty' },
            priceModel: { type: 'string', required: true, enum: ['perPerson', 'perRoom', 'hybrid'] },
            adultPrice: { type: 'number', min: 0 },
            childPrice: { type: 'number', default: 0, min: 0 },
            baseRate: { type: 'number', min: 0 },
            extraGuestRate: { type: 'number', default: 0, min: 0 }
        };

        const validation = validateAndSetDefaults(req.body, rateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { roomTypeId, dates, adultPrice, childPrice, baseRate, extraGuestRate, priceModel } = validation.validated;

        // Validate based on price model
        if (priceModel === 'perPerson') {
            if (adultPrice === undefined || adultPrice < 0) {
                return res.status(400).json({ message: "Missing or invalid adultPrice for perPerson model." });
            }
        } else if (priceModel === 'perRoom') {
            if (baseRate === undefined || baseRate < 0) {
                return res.status(400).json({ message: "Missing or invalid baseRate for perRoom model." });
            }
        }

        const dateObjects = [];
        for (const dateStr of dates) {
            // Parse date string and normalize to start of day in UTC
            const [year, month, day] = dateStr.split('-').map(Number);
            if (!year || !month || !day || isNaN(year) || isNaN(month) || isNaN(day)) {
                return res.status(400).json({ message: `Invalid date format found: ${dateStr}. Use YYYY-MM-DD.` });
            }
            const dateObj = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
            if (isNaN(dateObj.getTime())) {
                return res.status(400).json({ message: `Invalid date format found: ${dateStr}. Use YYYY-MM-DD.` });
            }
            dateObjects.push(dateObj);
        }

        const propertyId = getPropertyId(req);
        if (!propertyId) {
            return res.status(500).json({ message: "Property ID not found in request." });
        }

        const DailyRate = getModel(req, 'dailyRates');
        const RoomType = getModel(req, 'RoomType');

        if (!DailyRate) {
            console.error("DailyRate model not found");
            return res.status(500).json({ message: "DailyRate model not available." });
        }

        if (!RoomType) {
            console.error("RoomType model not found");
            return res.status(500).json({ message: "RoomType model not available." });
        }

        const roomTypeExists = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomTypeExists) {
            return res.status(404).json({ message: "Room type not found." });
        }

        // --- Prepare Bulk Operations ---
        const updatePayload = {};
        
        if (priceModel === 'perPerson') {
            if (adultPrice !== undefined && adultPrice !== null) {
                updatePayload.adultRate = Number(adultPrice);
            }
            if (childPrice !== undefined && childPrice !== null) {
                updatePayload.childRate = Number(childPrice);
            } else {
                updatePayload.childRate = 0;
            }
        } else if (priceModel === 'perRoom') {
            if (baseRate !== undefined && baseRate !== null) {
                updatePayload.baseRate = Number(baseRate);
            }
            if (extraGuestRate !== undefined && extraGuestRate !== null) {
                updatePayload.extraGuestRate = Number(extraGuestRate);
            } else {
                updatePayload.extraGuestRate = 0;
            }
        }

        // Ensure we have valid update payload
        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ message: "Invalid price model or missing price data." });
        }

        const bulkOps = dateObjects.map(dateObj => {
            return {
                updateOne: {
                    filter: { 
                        roomType: new mongoose.Types.ObjectId(roomTypeId), 
                        date: dateObj, 
                        property: propertyId 
                    },
                    update: {
                        $set: { 
                            ...updatePayload,
                            updatedAt: new Date()
                        },
                        $setOnInsert: { 
                            roomType: new mongoose.Types.ObjectId(roomTypeId), 
                            date: dateObj, 
                            property: propertyId,
                            createdAt: new Date()
                        },
                    },
                    upsert: true
                }
            };
        });

        let modifiedCount = 0;
        let upsertedCount = 0;
        if (bulkOps.length > 0) {
            const result = await DailyRate.bulkWrite(bulkOps);
            modifiedCount = result.modifiedCount;
            upsertedCount = result.upsertedCount;
        }

        // --- Fetch the Updated Rates ---
        const updatedRates = await DailyRate.find({
            roomType: roomTypeId,
            property: propertyId,
            date: { $in: dateObjects }
        }).select('date adultRate childRate baseRate extraGuestRate -_id');

        // Format response as a map based on price model
        const ratesMap = updatedRates.reduce((acc, rate) => {
            const dateStr = rate.date.toISOString().split('T')[0];
            if (priceModel === 'perPerson') {
                acc[dateStr] = {
                    adultRate: rate.adultRate,
                    childRate: rate.childRate
                };
            } else if (priceModel === 'perRoom') {
                acc[dateStr] = {
                    baseRate: rate.baseRate,
                    extraGuestRate: rate.extraGuestRate
                };
            }
            return acc;
        }, {});

        // Ensure all requested dates are in the response map
        dates.forEach(dateStr => {
            if (!ratesMap[dateStr]) {
                if (priceModel === 'perPerson') {
                    ratesMap[dateStr] = { 
                        adultRate: adultPrice, 
                        childRate: childPrice !== undefined ? childPrice : 0 
                    };
                } else if (priceModel === 'perRoom') {
                    ratesMap[dateStr] = { 
                        baseRate: baseRate, 
                        extraGuestRate: extraGuestRate !== undefined ? extraGuestRate : 0 
                    };
                }
            }
        });

        // --- Respond ---
        res.status(200).json({
            message: `Rates processed for ${dates.length} day(s). Modified: ${modifiedCount}, Created: ${upsertedCount}.`,
            updatedRates: ratesMap
         });

    } catch (error) {
        console.error("Specific Rate Update Error:", error);
        console.error("Error stack:", error.stack);
        console.error("Error details:", {
            message: error.message,
            code: error.code,
            name: error.name
        });
        if (error.code === 11000) {
             return res.status(409).json({ message: "Concurrency error or duplicate rate entry detected." });
        }
        res.status(500).json({ 
            message: "Server error updating rates.",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// --- GET rates function remains the same ---
router.get("/getRates" , async (req, res) => {
     try {
        // Validate query parameters
        const querySchema = {
            roomTypeId: { type: 'string', required: true, isObjectId: true },
            month: { type: 'number', required: true, min: 1, max: 12 },
            year: { type: 'number', required: true, min: 2000, max: 2100 }
        };

        const validation = validateAndSetDefaults(req.query, querySchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { roomTypeId, month, year } = validation.validated;
        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        const RoomType = getModel(req, 'RoomType');

        // Get room type to determine price model
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: "Room type not found." });
        }

        const startDate = new Date(Date.UTC(year, month - 1, 1));
        const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

        const rates = await DailyRate.find({
            roomType: roomTypeId,
            property: propertyId,
            date: { $gte: startDate, $lte: endDate }
        }).select('date adultRate childRate baseRate extraGuestRate -_id');

        // Format for easier frontend use based on price model
        const ratesMap = rates.reduce((acc, rate) => {
            const dateStr = rate.date.toISOString().split('T')[0];
            if (roomType.priceModel === 'perPerson') {
                acc[dateStr] = {
                    adultRate: rate.adultRate,
                    childRate: rate.childRate
                };
            } else if (roomType.priceModel === 'perRoom') {
                acc[dateStr] = {
                    baseRate: rate.baseRate,
                    extraGuestRate: rate.extraGuestRate
                };
            }
            return acc;
        }, {});

        res.status(200).json(ratesMap);

    } catch(error) {
         console.error("Get Rates Error:", error);
         res.status(500).json({ message: "Server error fetching rates." });
    }
});

router.get("/getratesofDate", async (req, res) => {
    try {
        // Validate query parameters
        const querySchema = {
            roomTypeId: { type: 'string', required: true, isObjectId: true },
            date: { type: 'string', required: true, isDate: true }
        };

        const validation = validateAndSetDefaults(req.query, querySchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { roomTypeId, date } = validation.validated;
        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        
        const dateObj = new Date(date + 'T00:00:00.000Z');
        const rate = await DailyRate.findOne({ roomType: roomTypeId, date: dateObj, property: propertyId });
        if (!rate) {
            return res.status(404).json({ message: "Rate not found." });
        }
        res.status(200).json(rate);
    } catch (error) {
        console.error("Get Rates of Date Error:", error);
        res.status(500).json({ message: "Server error fetching rates of date." });
    }
});

module.exports = router;
