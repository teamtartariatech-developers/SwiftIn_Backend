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

// --- GET rates function with dynamic pricing support ---
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
        const DynamicPricingRule = getModel(req, 'dynamicPricingRules');
        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');

        // Get room type to determine price model
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: "Room type not found." });
        }

        // Get dynamic pricing rules
        const pricingRule = await DynamicPricingRule.findOne({ 
            roomType: roomTypeId, 
            property: propertyId 
        });

        const startDate = new Date(Date.UTC(year, month - 1, 1));
        const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

        // Get manual rates (if any)
        const manualRates = await DailyRate.find({
            roomType: roomTypeId,
            property: propertyId,
            date: { $gte: startDate, $lte: endDate }
        }).select('date adultRate childRate baseRate extraGuestRate -_id');

        const manualRatesMap = {};
        manualRates.forEach(rate => {
            const dateStr = rate.date.toISOString().split('T')[0];
            manualRatesMap[dateStr] = rate;
        });

        // Generate rates for all days in the month
        const ratesMap = {};
        let currentDate = new Date(startDate);
        
        while (currentDate <= endDate) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const manualRate = manualRatesMap[dateStr];
            
            // If manual rate exists, use it (manual prices take priority)
            if (manualRate) {
                if (roomType.priceModel === 'perPerson') {
                    ratesMap[dateStr] = {
                        adultRate: manualRate.adultRate,
                        childRate: manualRate.childRate
                    };
                } else if (roomType.priceModel === 'perRoom') {
                    ratesMap[dateStr] = {
                        baseRate: manualRate.baseRate,
                        extraGuestRate: manualRate.extraGuestRate
                    };
                }
            } else {
                // No manual rate - check if dynamic pricing is enabled
                if (pricingRule && pricingRule.enabled) {
                    // Calculate occupancy for this date
                    const occupancyPercent = await calculateOccupancyForDate(
                        propertyId, 
                        roomTypeId, 
                        currentDate, 
                        Reservations, 
                        Rooms
                    );
                    
                    // Get base rates from room type
                    let baseAdultRate = roomType.adultRate || 0;
                    let baseChildRate = roomType.childRate || 0;
                    let baseRoomRate = roomType.baseRate || 0;
                    let baseExtraGuestRate = roomType.extraGuestRate || 0;
                    
                    // Apply dynamic pricing rules
                    if (roomType.priceModel === 'perPerson') {
                        ratesMap[dateStr] = {
                            adultRate: applyDynamicPricingRules(
                                baseAdultRate, 
                                occupancyPercent, 
                                pricingRule, 
                                pricingRule.rateRoundOff
                            ),
                            childRate: applyDynamicPricingRules(
                                baseChildRate, 
                                occupancyPercent, 
                                pricingRule, 
                                pricingRule.rateRoundOff
                            )
                        };
                    } else if (roomType.priceModel === 'perRoom') {
                        ratesMap[dateStr] = {
                            baseRate: applyDynamicPricingRules(
                                baseRoomRate, 
                                occupancyPercent, 
                                pricingRule, 
                                pricingRule.rateRoundOff
                            ),
                            extraGuestRate: applyDynamicPricingRules(
                                baseExtraGuestRate, 
                                occupancyPercent, 
                                pricingRule, 
                                pricingRule.rateRoundOff
                            )
                        };
                    }
                } else {
                    // No dynamic pricing - use base rates from room type
                    if (roomType.priceModel === 'perPerson') {
                        ratesMap[dateStr] = {
                            adultRate: roomType.adultRate || 0,
                            childRate: roomType.childRate || 0
                        };
                    } else if (roomType.priceModel === 'perRoom') {
                        ratesMap[dateStr] = {
                            baseRate: roomType.baseRate || 0,
                            extraGuestRate: roomType.extraGuestRate || 0
                        };
                    }
                }
            }
            
            // Move to next day
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

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

// Get rates for a date range (uses unified pricing logic)
// This endpoint is kept for backward compatibility but now uses the unified pricing function
router.get("/getRatesForDateRange", async (req, res) => {
    try {
        // Validate query parameters
        const querySchema = {
            roomTypeId: { type: 'string', required: true, isObjectId: true },
            startDate: { type: 'string', required: true, isDate: true },
            endDate: { type: 'string', required: true, isDate: true }
        };

        const validation = validateAndSetDefaults(req.query, querySchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { roomTypeId, startDate, endDate } = validation.validated;
        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        const RoomType = getModel(req, 'RoomType');
        const DynamicPricingRule = getModel(req, 'dynamicPricingRules');
        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');

        // Get room type to determine price model
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: "Room type not found." });
        }

        // Parse dates properly
        let start, end;
        try {
            if (typeof startDate === 'string') {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
                    return res.status(400).json({ message: "startDate must be in YYYY-MM-DD format." });
                }
                start = new Date(startDate + 'T00:00:00.000Z');
            } else {
                const year = startDate.getUTCFullYear();
                const month = startDate.getUTCMonth();
                const day = startDate.getUTCDate();
                start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
            }
            
            if (typeof endDate === 'string') {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
                    return res.status(400).json({ message: "endDate must be in YYYY-MM-DD format." });
                }
                end = new Date(endDate + 'T00:00:00.000Z');
            } else {
                const year = endDate.getUTCFullYear();
                const month = endDate.getUTCMonth();
                const day = endDate.getUTCDate();
                end = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
            }

            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res.status(400).json({ message: "Invalid date values provided." });
            }

            if (end <= start) {
                return res.status(400).json({ message: "endDate must be after startDate." });
            }
        } catch (dateError) {
            console.error("Date parsing error:", dateError);
            return res.status(400).json({ message: "Error parsing dates: " + dateError.message });
        }

        // Use unified pricing function for each date
        const ratesMap = {};
        let currentDate = new Date(start);
        
        while (currentDate < end) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const price = await getPriceForDate(
                propertyId,
                roomTypeId,
                currentDate,
                DailyRate,
                RoomType,
                DynamicPricingRule,
                Reservations,
                Rooms
            );
            
            // Format response (remove source and occupancyPercent for backward compatibility)
            if (roomType.priceModel === 'perPerson') {
                ratesMap[dateStr] = {
                    adultRate: price.adultRate,
                    childRate: price.childRate
                };
            } else {
                ratesMap[dateStr] = {
                    baseRate: price.baseRate,
                    extraGuestRate: price.extraGuestRate
                };
            }
            
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        res.status(200).json({
            roomTypeId,
            priceModel: roomType.priceModel,
            rates: ratesMap
        });
    } catch (error) {
        console.error("Get Rates for Date Range Error:", error);
        console.error("Error stack:", error.stack);
        console.error("Request query:", req.query);
        res.status(500).json({ 
            message: "Server error fetching rates for date range.",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Get dynamic pricing rules for a room type
router.get('/dynamic-pricing/:roomTypeId', async (req, res) => {
    try {
        const { roomTypeId } = req.params;
        if (!isValidObjectId(roomTypeId)) {
            return res.status(400).json({ message: 'Invalid room type ID format' });
        }

        const propertyId = getPropertyId(req);
        const DynamicPricingRule = getModel(req, 'dynamicPricingRules');
        const RoomType = getModel(req, 'RoomType');

        // Verify room type exists
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: 'Room type not found' });
        }

        // Get or create default dynamic pricing rule
        let rule = await DynamicPricingRule.findOne({ roomType: roomTypeId, property: propertyId });
        
        if (!rule) {
            // Create default rule
            rule = new DynamicPricingRule({
                roomType: roomTypeId,
                property: propertyId,
                enabled: false,
                demandScale: 1.0,
                occupancyRules: [],
                rateRoundOff: 1
            });
            await rule.save();
        }

        res.status(200).json(rule);
    } catch (error) {
        console.error('Error fetching dynamic pricing rules:', error);
        res.status(500).json({ message: 'Server error fetching dynamic pricing rules.' });
    }
});

// Save dynamic pricing rules for a room type
router.post('/dynamic-pricing/:roomTypeId', async (req, res) => {
    try {
        const { roomTypeId } = req.params;
        if (!isValidObjectId(roomTypeId)) {
            return res.status(400).json({ message: 'Invalid room type ID format' });
        }

        const propertyId = getPropertyId(req);
        const DynamicPricingRule = getModel(req, 'dynamicPricingRules');
        const RoomType = getModel(req, 'RoomType');

        // Verify room type exists
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: 'Room type not found' });
        }

        // Validate request body
        const ruleSchema = {
            enabled: { type: 'boolean', default: false },
            demandScale: { type: 'number', min: 0, default: 1.0 },
            occupancyRules: { isArray: true, default: [] },
            rateRoundOff: { type: 'number', min: 1, default: 1 }
        };

        const validation = validateAndSetDefaults(req.body, ruleSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        // Validate occupancy rules
        if (Array.isArray(validation.validated.occupancyRules)) {
            for (const rule of validation.validated.occupancyRules) {
                if (typeof rule.startPercent !== 'number' || rule.startPercent < 0 || rule.startPercent > 100) {
                    return res.status(400).json({ message: 'Invalid startPercent in occupancy rule' });
                }
                if (typeof rule.endPercent !== 'number' || rule.endPercent < 0 || rule.endPercent > 100) {
                    return res.status(400).json({ message: 'Invalid endPercent in occupancy rule' });
                }
                if (rule.startPercent >= rule.endPercent) {
                    return res.status(400).json({ message: 'startPercent must be less than endPercent' });
                }
                if (rule.multiplier !== undefined && rule.multiplier < 0) {
                    return res.status(400).json({ message: 'multiplier must be >= 0' });
                }
            }
        }

        // Update or create rule
        const rule = await DynamicPricingRule.findOneAndUpdate(
            { roomType: roomTypeId, property: propertyId },
            {
                enabled: validation.validated.enabled,
                demandScale: validation.validated.demandScale,
                occupancyRules: validation.validated.occupancyRules,
                rateRoundOff: validation.validated.rateRoundOff
            },
            { new: true, upsert: true }
        );

        res.status(200).json(rule);
    } catch (error) {
        console.error('Error saving dynamic pricing rules:', error);
        res.status(500).json({ message: 'Server error saving dynamic pricing rules.' });
    }
});

// Helper function to calculate occupancy for a date
async function calculateOccupancyForDate(propertyId, roomTypeId, date, Reservations, Rooms) {
    const dateStart = new Date(date);
    dateStart.setHours(0, 0, 0, 0);
    const dateEnd = new Date(date);
    dateEnd.setHours(23, 59, 59, 999);

    // Get all rooms of this type
    const totalRooms = await Rooms.countDocuments({
        roomType: roomTypeId,
        property: propertyId,
        status: { $nin: ['maintenance'] }
    });

    if (totalRooms === 0) return 0;

    // Get occupied rooms (checked-in or confirmed reservations that overlap with this date)
    const occupiedReservations = await Reservations.find({
        roomType: roomTypeId,
        property: propertyId,
        status: { $in: ['confirmed', 'checked-in'] },
        checkInDate: { $lte: dateEnd },
        checkOutDate: { $gt: dateStart }
    });

    // Count unique rooms assigned
    const occupiedRoomIds = new Set();
    occupiedReservations.forEach(res => {
        if (res.roomNumbers && Array.isArray(res.roomNumbers)) {
            res.roomNumbers.forEach(roomId => {
                occupiedRoomIds.add(roomId.toString());
            });
        }
    });

    const occupiedRooms = occupiedRoomIds.size;
    const occupancyPercent = (occupiedRooms / totalRooms) * 100;
    
    return occupancyPercent;
}

// Helper function to apply dynamic pricing rules
function applyDynamicPricingRules(basePrice, occupancyPercent, rule, rateRoundOff) {
    if (!rule || !rule.enabled) {
        return basePrice;
    }

    let adjustedPrice = basePrice;

    // Apply demand scale
    adjustedPrice = adjustedPrice * (rule.demandScale || 1.0);

    // Apply occupancy rules
    if (rule.occupancyRules && Array.isArray(rule.occupancyRules)) {
        for (const occupancyRule of rule.occupancyRules) {
            if (!occupancyRule.enabled) continue;
            
            if (occupancyPercent >= occupancyRule.startPercent && occupancyPercent <= occupancyRule.endPercent) {
                // Apply first add/subtract
                if (occupancyRule.addSubtract1 !== undefined && occupancyRule.addSubtract1 !== null) {
                    adjustedPrice = adjustedPrice + occupancyRule.addSubtract1;
                }
                
                // Apply multiplier
                if (occupancyRule.multiplier !== undefined && occupancyRule.multiplier !== null && occupancyRule.multiplier > 0) {
                    adjustedPrice = adjustedPrice * occupancyRule.multiplier;
                }
                
                // Apply second add/subtract
                if (occupancyRule.addSubtract2 !== undefined && occupancyRule.addSubtract2 !== null) {
                    adjustedPrice = adjustedPrice + occupancyRule.addSubtract2;
                }
                
                break; // Only apply the first matching rule
            }
        }
    }

    // Apply rate round off
    if (rateRoundOff && rateRoundOff > 1) {
        adjustedPrice = Math.round(adjustedPrice / rateRoundOff) * rateRoundOff;
    }

    return Math.max(0, adjustedPrice); // Ensure price is not negative
}

// Unified function to get price for a single date
// Priority: Manual Price > Dynamic Pricing > Base Price
async function getPriceForDate(propertyId, roomTypeId, date, DailyRate, RoomType, DynamicPricingRule, Reservations, Rooms) {
    // Normalize date to UTC midnight
    const dateObj = new Date(date);
    dateObj.setUTCHours(0, 0, 0, 0);
    
    // Get room type
    const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
    if (!roomType) {
        throw new Error('Room type not found');
    }

    // Check for manual price first (highest priority)
    const manualRate = await DailyRate.findOne({
        roomType: roomTypeId,
        property: propertyId,
        date: dateObj
    });

    if (manualRate) {
        // Manual price exists - return it
        if (roomType.priceModel === 'perPerson') {
            return {
                adultRate: manualRate.adultRate || 0,
                childRate: manualRate.childRate || 0,
                source: 'manual'
            };
        } else {
            return {
                baseRate: manualRate.baseRate || 0,
                extraGuestRate: manualRate.extraGuestRate || 0,
                source: 'manual'
            };
        }
    }

    // No manual price - check dynamic pricing
    const pricingRule = await DynamicPricingRule.findOne({
        roomType: roomTypeId,
        property: propertyId
    });

    if (pricingRule && pricingRule.enabled) {
        // Calculate occupancy
        const occupancyPercent = await calculateOccupancyForDate(
            propertyId,
            roomTypeId,
            dateObj,
            Reservations,
            Rooms
        );

        // Get base rates from room type
        let baseAdultRate = roomType.adultRate || 0;
        let baseChildRate = roomType.childRate || 0;
        let baseRoomRate = roomType.baseRate || 0;
        let baseExtraGuestRate = roomType.extraGuestRate || 0;

        // Apply dynamic pricing rules
        if (roomType.priceModel === 'perPerson') {
            return {
                adultRate: applyDynamicPricingRules(
                    baseAdultRate,
                    occupancyPercent,
                    pricingRule,
                    pricingRule.rateRoundOff
                ),
                childRate: applyDynamicPricingRules(
                    baseChildRate,
                    occupancyPercent,
                    pricingRule,
                    pricingRule.rateRoundOff
                ),
                source: 'dynamic',
                occupancyPercent: occupancyPercent
            };
        } else {
            return {
                baseRate: applyDynamicPricingRules(
                    baseRoomRate,
                    occupancyPercent,
                    pricingRule,
                    pricingRule.rateRoundOff
                ),
                extraGuestRate: applyDynamicPricingRules(
                    baseExtraGuestRate,
                    occupancyPercent,
                    pricingRule,
                    pricingRule.rateRoundOff
                ),
                source: 'dynamic',
                occupancyPercent: occupancyPercent
            };
        }
    }

    // No dynamic pricing - return base price from room type
    if (roomType.priceModel === 'perPerson') {
        return {
            adultRate: roomType.adultRate || 0,
            childRate: roomType.childRate || 0,
            source: 'base'
        };
    } else {
        return {
            baseRate: roomType.baseRate || 0,
            extraGuestRate: roomType.extraGuestRate || 0,
            source: 'base'
        };
    }
}

// Unified pricing endpoint - handles manual, dynamic, and base pricing
// Can be used for single date or date range
router.get("/getPrice", async (req, res) => {
    try {
        // Validate query parameters
        const querySchema = {
            roomTypeId: { type: 'string', required: true, isObjectId: true },
            date: { type: 'string', required: false, isDate: true },
            startDate: { type: 'string', required: false, isDate: true },
            endDate: { type: 'string', required: false, isDate: true }
        };

        const validation = validateAndSetDefaults(req.query, querySchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { roomTypeId, date, startDate, endDate } = validation.validated;
        const propertyId = getPropertyId(req);
        const DailyRate = getModel(req, 'dailyRates');
        const RoomType = getModel(req, 'RoomType');
        const DynamicPricingRule = getModel(req, 'dynamicPricingRules');
        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');

        // Verify room type exists
        const roomType = await RoomType.findOne({ _id: roomTypeId, property: propertyId });
        if (!roomType) {
            return res.status(404).json({ message: 'Room type not found' });
        }

        // Handle single date
        if (date) {
            const price = await getPriceForDate(
                propertyId,
                roomTypeId,
                date,
                DailyRate,
                RoomType,
                DynamicPricingRule,
                Reservations,
                Rooms
            );
            return res.status(200).json({
                roomTypeId,
                date,
                priceModel: roomType.priceModel,
                ...price
            });
        }

        // Handle date range
        if (startDate && endDate) {
            // Parse dates
            let start, end;
            try {
                if (typeof startDate === 'string') {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
                        return res.status(400).json({ message: "startDate must be in YYYY-MM-DD format." });
                    }
                    start = new Date(startDate + 'T00:00:00.000Z');
                } else {
                    const year = startDate.getUTCFullYear();
                    const month = startDate.getUTCMonth();
                    const day = startDate.getUTCDate();
                    start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
                }

                if (typeof endDate === 'string') {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
                        return res.status(400).json({ message: "endDate must be in YYYY-MM-DD format." });
                    }
                    end = new Date(endDate + 'T00:00:00.000Z');
                } else {
                    const year = endDate.getUTCFullYear();
                    const month = endDate.getUTCMonth();
                    const day = endDate.getUTCDate();
                    end = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
                }

                if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                    return res.status(400).json({ message: "Invalid date values provided." });
                }

                if (end <= start) {
                    return res.status(400).json({ message: "endDate must be after startDate." });
                }
            } catch (dateError) {
                return res.status(400).json({ message: "Error parsing dates: " + dateError.message });
            }

            // Get prices for each date in range
            const ratesMap = {};
            let currentDate = new Date(start);
            
            while (currentDate < end) {
                const dateStr = currentDate.toISOString().split('T')[0];
                const price = await getPriceForDate(
                    propertyId,
                    roomTypeId,
                    currentDate,
                    DailyRate,
                    RoomType,
                    DynamicPricingRule,
                    Reservations,
                    Rooms
                );
                ratesMap[dateStr] = price;
                currentDate.setUTCDate(currentDate.getUTCDate() + 1);
            }

            return res.status(200).json({
                roomTypeId,
                priceModel: roomType.priceModel,
                startDate: start.toISOString().split('T')[0],
                endDate: end.toISOString().split('T')[0],
                rates: ratesMap
            });
        }

        return res.status(400).json({ message: 'Either date or both startDate and endDate must be provided' });
    } catch (error) {
        console.error('Error getting price:', error);
        res.status(500).json({ message: 'Server error getting price.' });
    }
});

module.exports = router;
