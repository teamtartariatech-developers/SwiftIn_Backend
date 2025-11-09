const mongoose = require('mongoose');
const express = require('express');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');

const router = express.Router();
router.use(express.json());
router.use(authenticate);
router.use(requireModuleAccess('distribution'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

router.post ('/setRates', async (req, res) => {
    try {
        const { roomTypeId, dates, adultPrice, childPrice, baseRate, extraGuestRate, priceModel } = req.body;

        if (!roomTypeId || !Array.isArray(dates) || dates.length === 0) {
            return res.status(400).json({ message: "Missing or invalid required fields (roomTypeId, dates array)." });
        }

        // Validate based on price model
        if (priceModel === 'perPerson') {
            if (adultPrice === undefined || adultPrice < 0) {
                return res.status(400).json({ message: "Missing or invalid adultPrice for perPerson model." });
            }
            if (childPrice !== undefined && childPrice < 0) {
                return res.status(400).json({ message: "Child price cannot be negative." });
            }
        } else if (priceModel === 'perRoom') {
            if (baseRate === undefined || baseRate < 0) {
                return res.status(400).json({ message: "Missing or invalid baseRate for perRoom model." });
            }
            if (extraGuestRate !== undefined && extraGuestRate < 0) {
                return res.status(400).json({ message: "Extra guest rate cannot be negative." });
            }
        }
        if (!mongoose.Types.ObjectId.isValid(roomTypeId)) {
             return res.status(400).json({ message: "Invalid Room Type ID format." });
        }

        const dateObjects = [];
        for (const dateStr of dates) {
            const dateObj = new Date(dateStr + 'T00:00:00.000Z');
            if (isNaN(dateObj.getTime())) {
                return res.status(400).json({ message: `Invalid date format found: ${dateStr}. Use YYYY-MM-DD.` });
            }
            dateObjects.push(dateObj);
        }

        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        const RoomType = getModel(req, 'RoomType');

        const roomTypeExists = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomTypeExists) {
            return res.status(404).json({ message: "Room type not found." });
        }

        // --- Prepare Bulk Operations ---
        const updatePayload = {};
        
        if (priceModel === 'perPerson') {
            updatePayload.adultRate = adultPrice;
            updatePayload.childRate = childPrice !== undefined ? childPrice : 0;
        } else if (priceModel === 'perRoom') {
            updatePayload.baseRate = baseRate;
            updatePayload.extraGuestRate = extraGuestRate !== undefined ? extraGuestRate : 0;
        }


        const bulkOps = dateObjects.map(dateObj => ({
            updateOne: {
                filter: { roomType: roomTypeId, date: dateObj, property: propertyId },
                update: {
                    $set: { ...updatePayload, property: propertyId },
                    $setOnInsert: { roomType: roomTypeId, date: dateObj, property: propertyId },
                },
                upsert: true
            }
        }));

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
         if (error.code === 11000) {
             return res.status(409).json({ message: "Concurrency error or duplicate rate entry detected." });
        }
        res.status(500).json({ message: "Server error updating rates." });
    }
});

// --- GET rates function remains the same ---
router.get("/getRates" , async (req, res) => {
     try {
        const { roomTypeId, month, year } = req.query;
        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        const RoomType = getModel(req, 'RoomType');

        if (!roomTypeId || !month || !year) {
            return res.status(400).json({ message: "Missing required query parameters (roomTypeId, month, year)." });
        }

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
        const { roomTypeId, date } = req.query;
        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        if (!roomTypeId || !date) {
            return res.status(400).json({ message: "Missing required query parameters (roomTypeId, date)." });
        }
        if (!mongoose.Types.ObjectId.isValid(roomTypeId)) {
            return res.status(400).json({ message: "Invalid Room Type ID format." });
        }
        const dateObj = new Date(date + 'T00:00:00.000Z');
        if (isNaN(dateObj.getTime())) {
            return res.status(400).json({ message: "Invalid date format. Use YYYY-MM-DD." });
        }
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
