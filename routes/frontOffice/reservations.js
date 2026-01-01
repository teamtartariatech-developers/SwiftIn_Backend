const formatAddress = (address) => {
  if (!address) return '';
  if (typeof address === 'string') return address;

  const parts = [
    address.line1 || address.addressLine1,
    address.line2 || address.addressLine2,
    address.city,
    address.state,
    address.postalCode || address.zip,
    address.country,
  ];

  return parts.filter(Boolean).join(', ');
};

const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const emailService = require('../../services/emailService');
const { validateAndSetDefaults, validatePagination, validateDateRange, normalizePaymentMethod, isValidObjectId, isValidEmail, isValidPhone } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('front-office'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Helper function to create folio for a reservation
const createFolioForReservation = async (req, reservation) => {
    try {
        const propertyId = getPropertyId(req);
        const GuestFolio = getModel(req, 'GuestFolio');
        const Rooms = getModel(req, 'Rooms');
        const RoomType = getModel(req, 'RoomType');
        const TaxRule = getModel(req, 'TaxRule');
        const ServiceFee = getModel(req, 'ServiceFee');
        
        // Check if folio already exists for this reservation
        const existingFolio = await GuestFolio.findOne({ 
            reservationId: reservation._id,
            property: propertyId,
            status: 'active'
        });
        
        if (existingFolio) {
            return existingFolio; // Return existing folio
        }
        
        // Fetch RoomType to get priceModel and room name
        let roomTypeData = null;
        if (reservation.roomType) {
            roomTypeData = await RoomType.findOne({
                _id: reservation.roomType,
                property: propertyId,
            });
        }
        
        // Get room numbers from reservation
        let finalRoomNumbers = [];
        if (reservation.roomNumbers && reservation.roomNumbers.length > 0) {
            // If reservation has room IDs, fetch room numbers
            const rooms = await Rooms.find({ _id: { $in: reservation.roomNumbers }, property: propertyId });
            finalRoomNumbers = rooms.map(r => r.roomNumber);
        }
        
        // Generate folio ID
        const folioId = await GuestFolio.generateFolioId(propertyId);
        
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
        
        // Fetch active tax rules (use lean and cache)
        const { getTaxRules } = require('../../services/cacheService');
        const activeTaxRules = await getTaxRules(propertyId, async () => {
            return await TaxRule.find({
                property: propertyId,
                isActive: true
            }).lean();
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
        
        // Fetch active service fees (use lean and cache)
        const { getServiceFees } = require('../../services/cacheService');
        const activeServiceFees = await getServiceFees(propertyId, async () => {
            return await ServiceFee.find({
                property: propertyId,
                isActive: true
            }).lean();
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
        const payedAmount = reservation.payedAmount || 0;
        const paymentMethod = normalizePaymentMethod(reservation.paymentMethod);
        
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
        
        console.log(`Folio created for reservation ${reservation._id} with paid amount: ${payedAmount}`);
        return newFolio;
    } catch (error) {
        console.error('Error creating folio for reservation:', error);
        return null; // Don't throw, just log and return null
    }
};

const compileTemplate = (content, variables = {}) => {
  if (!content || typeof content !== 'string') {
    return '';
  }

  return Object.keys(variables).reduce((compiled, key) => {
    const safeValue = variables[key] != null ? String(variables[key]) : '';
    const pattern = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    return compiled.replace(pattern, safeValue);
  }, content);
};

const sendReservationEmail = async (req, reservation) => {
  try {
    if (!reservation?.guestEmail) {
      return;
    }

    const EmailTemplate = getModel(req, 'EmailTemplate');
    const template = await EmailTemplate.findOne({
      template_name: 'reservationMail',
      property: getPropertyId(req),
    });

    if (!template?.content) {
      return;
    }

    // Fetch PropertyDetails for additional variables from settings
    const PropertyDetails = getModel(req, 'PropertyDetails');
    const propertyDetails = await PropertyDetails.findOne({
      property: getPropertyId(req),
    });

    // Fetch RoomType to get priceModel for calculating totalGuests
    const RoomType = getModel(req, 'RoomType');
    let roomTypeData = null;
    if (reservation.roomType) {
      roomTypeData = await RoomType.findOne({
        _id: reservation.roomType,
        property: getPropertyId(req),
      });
    }

    const property = req.tenant?.property || {};
    const checkInValue = reservation.checkInDate || reservation.checkIn;
    const checkOutValue = reservation.checkOutDate || reservation.checkOut;
    
    // Calculate totalGuests based on room type pricing model
    let guestCount = null;
    if (roomTypeData && roomTypeData.priceModel) {
      if (roomTypeData.priceModel === 'perPerson') {
        // For perPerson: totalGuests = adultCount + childCount
        // Check multiple possible field names for adult and child counts
        const adultCount = reservation.adultCount ?? reservation.numberOfAdults ?? reservation.adults;
        const childCount = reservation.childCount ?? reservation.numberOfChildren ?? reservation.children;
        
        // If we have explicit adult/child counts, use them
        if (adultCount != null || childCount != null) {
          guestCount = (Number(adultCount) || 0) + (Number(childCount) || 0);
        } else {
          // If no explicit counts, use totalGuest as the total (it's likely already the sum)
          // Only fall back to baseOccupancy if totalGuest is also missing
          guestCount = reservation.totalGuest ?? reservation.totalGuests ?? reservation.numberOfGuests ?? 
                      (roomTypeData.baseOccupancy || 1);
        }
      } else if (roomTypeData.priceModel === 'perRoom') {
        // For perRoom: totalGuests = numberOfGuests + extraGuests
        const numberOfGuests = reservation.numberOfGuests ?? reservation.totalGuest ?? (roomTypeData.baseOccupancy || 1);
        const extraGuests = reservation.extraGuests ?? reservation.extraGuestCount ?? 0;
        guestCount = (Number(numberOfGuests) || 0) + (Number(extraGuests) || 0);
      } else {
        // For hybrid or unknown, use existing logic
        guestCount = reservation.totalGuest ?? reservation.totalGuests ?? reservation.numberOfGuests ?? reservation.guestCount;
      }
    } else {
      // Fallback to existing logic if room type not found
      guestCount = reservation.totalGuest ?? reservation.totalGuests ?? reservation.numberOfGuests ?? reservation.guestCount;
    }

    const variables = {
      guestName: reservation.guestName || '',
      reservationId: reservation.reservationId || reservation._id,
      checkInDate: checkInValue ? new Date(checkInValue).toLocaleDateString('en-GB') : '',
      checkOutDate: checkOutValue ? new Date(checkOutValue).toLocaleDateString('en-GB') : '',
      roomType: roomTypeData?.name || reservation.roomType || '',
      totalGuests: guestCount != null ? guestCount : '',
      totalAmount: reservation.totalAmount != null ? reservation.totalAmount : '',
      paidAmount: reservation.payedAmount != null ? reservation.payedAmount : '',
      balanceAmount: (reservation.totalAmount != null && reservation.payedAmount != null) 
        ? (reservation.totalAmount - reservation.payedAmount) 
        : (reservation.totalAmount != null ? reservation.totalAmount : ''),
      // Basic property info (from PropertyDetails if available, fallback to tenant property)
      propertyName: propertyDetails?.propertyName || property.name || '',
      propertyEmail: propertyDetails?.email || property.email || '',
      propertyPhone: propertyDetails?.phone || property.phone || '',
      propertyAddress: propertyDetails?.address || formatAddress(property.address) || '',
      // Additional property details from settings/property page
      propertyWebsite: propertyDetails?.website || '',
      checkInTime: propertyDetails?.checkInTime || '14:00',
      checkOutTime: propertyDetails?.checkOutTime || '11:00',
      cancellationPolicy: propertyDetails?.cancellationPolicy || '',
      generalPolicies: propertyDetails?.generalPolicies || '',
      gstin: propertyDetails?.gstin || '',
      currency: propertyDetails?.currency || 'INR',
      timezone: propertyDetails?.timezone || 'Asia/Kolkata',
      gstRate: propertyDetails?.gstRate != null ? String(propertyDetails.gstRate) : '18',
      serviceChargeRate: propertyDetails?.serviceChargeRate != null ? String(propertyDetails.serviceChargeRate) : '10',
    };

    if (variables.totalGuests !== '') {
      variables.totalGuests = String(variables.totalGuests);
    }

    if (variables.totalAmount !== '') {
      variables.totalAmount = String(variables.totalAmount);
    }

    if (variables.paidAmount !== '') {
      variables.paidAmount = String(variables.paidAmount);
    }

    if (variables.balanceAmount !== '') {
      variables.balanceAmount = String(variables.balanceAmount);
    }

    const htmlBody = compileTemplate(template.content, variables);
    const subject = template.subject || template.template_name || 'Reservation Confirmation';

    const sendResult = await emailService.sendEmail(
      req.tenant,
      reservation.guestEmail,
      subject,
      htmlBody,
      {}
    );

    if (!sendResult.success) {
      console.error('Failed to send reservation email:', sendResult.error);
    }
  } catch (error) {
    console.error('Error processing reservation email:', error);
  }
};

router.post('/', async (req, res) => {
    try {
        // Validate and set defaults for reservation creation
        const reservationSchema = {
            guestName: { type: 'string', required: true },
            guestEmail: { type: 'string', required: true, custom: (val) => isValidEmail(val) || 'Invalid email format' },
            guestNumber: { type: 'string', required: true, custom: (val) => isValidPhone(val) || 'Invalid phone number' },
            checkInDate: { type: 'string', required: true, isDate: true },
            checkOutDate: { type: 'string', required: true, isDate: true },
            roomType: { type: 'string', required: true, isObjectId: true },
            numberOfRooms: { type: 'number', default: 1, min: 1 },
            totalGuest: { type: 'number', required: true, min: 1 },
            totalAmount: { type: 'number', default: 0, min: 0 },
            payedAmount: { type: 'number', default: 0, min: 0 },
            paymentMethod: { type: 'string', default: 'Cash' },
            Source: { type: 'string', default: 'direct', enum: ['direct', 'website', 'booking.com', 'agoda', 'expedia', 'airbnb', 'phone', 'walk-in', 'travel-agent'] },
            travelAgentId: { type: 'string', isObjectId: true },
            adhaarNumber: { type: 'string', default: '' },
            status: { type: 'string', default: 'confirmed', enum: ['confirmed', 'checked-in', 'checked-out', 'cancelled'] },
            mealPlan: { type: 'string', default: 'EP', enum: ['EP', 'CP', 'MAP', 'AP'] },
            mealPlanAmount: { type: 'number', default: 0, min: 0 },
            mealPlanGuestCount: { type: 'number', default: 0, min: 0 },
            mealPlanNights: { type: 'number', default: 0, min: 0 },
            mealPlanRate: { type: 'number', default: 0, min: 0 },
            roomNumbers: { isArray: true, default: [] },
            notes: { isArray: true, default: [] }, // notes is an array of note objects, not a string
            mealPreferences: { isObject: true, default: { veg: 0, nonVeg: 0, jain: 0 } }
        };

        const validation = validateAndSetDefaults(req.body, reservationSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        // Validate date range
        const dateValidation = validateDateRange(validation.validated.checkInDate, validation.validated.checkOutDate);
        if (!dateValidation.isValid) {
            return res.status(400).json({ message: dateValidation.errors.join(', ') });
        }

        // Validate minimum stay requirement (use lean for performance)
        const RoomType = getModel(req, 'RoomType');
        const roomType = await RoomType.findOne({
            _id: validation.validated.roomType,
            property: getPropertyId(req),
        }).lean();

        if (!roomType) {
            return res.status(404).json({ message: 'Room type not found.' });
        }

        // Check minimum stay requirement
        const checkIn = dateValidation.checkIn;
        const checkOut = dateValidation.checkOut;
        const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
        
        if (roomType.minimumStay && nights < roomType.minimumStay) {
            return res.status(400).json({ 
                message: `Minimum stay requirement is ${roomType.minimumStay} night(s). Selected stay is ${nights} night(s).` 
            });
        }

        // Validate maximum stay requirement (if set)
        if (roomType.maximumStay && nights > roomType.maximumStay) {
            return res.status(400).json({ 
                message: `Maximum stay allowed is ${roomType.maximumStay} night(s). Selected stay is ${nights} night(s).` 
            });
        }

        // Validate deposit policy
        const PropertyDetails = getModel(req, 'PropertyDetails');
        const propertyDetails = await PropertyDetails.findOne({
            property: getPropertyId(req),
        });

        const depositPolicy = propertyDetails?.depositPolicy || 'none'; // 'none', 'percentage', 'fixed', 'first_night'
        const depositAmount = propertyDetails?.depositAmount || 0;
        const depositPercentage = propertyDetails?.depositPercentage || 0;
        
        let requiredDeposit = 0;
        if (depositPolicy === 'percentage' && depositPercentage > 0) {
            requiredDeposit = (validation.validated.totalAmount * depositPercentage) / 100;
        } else if (depositPolicy === 'fixed' && depositAmount > 0) {
            requiredDeposit = depositAmount;
        } else if (depositPolicy === 'first_night') {
            // Calculate first night charge
            if (roomType.priceModel === 'perRoom') {
                requiredDeposit = roomType.baseRate * (validation.validated.numberOfRooms || 1);
            } else if (roomType.priceModel === 'perPerson') {
                const adultCount = validation.validated.adultCount || validation.validated.numberOfAdults || 0;
                const childCount = validation.validated.childCount || validation.validated.numberOfChildren || 0;
                requiredDeposit = (roomType.adultRate || 0) * adultCount + (roomType.childRate || 0) * childCount;
            }
        }

        // Warn if deposit is less than required (but allow override for now - can be made strict)
        if (requiredDeposit > 0 && validation.validated.payedAmount < requiredDeposit) {
            // For production, you might want to make this strict:
            // return res.status(400).json({ message: `Deposit required: ₹${requiredDeposit.toFixed(2)}. Provided: ₹${validation.validated.payedAmount.toFixed(2)}` });
            console.warn(`Deposit policy: Required ₹${requiredDeposit.toFixed(2)}, provided ₹${validation.validated.payedAmount.toFixed(2)}`);
        }

        // Normalize payment method
        validation.validated.paymentMethod = normalizePaymentMethod(validation.validated.paymentMethod);

        // Determine status based on check-in date (if not explicitly set)
        if (!req.body.status) {
            const checkInDate = new Date(validation.validated.checkInDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            checkInDate.setHours(0, 0, 0, 0);
            
            if (checkInDate.getTime() === today.getTime()) {
                validation.validated.status = 'checked-in';
            } else {
                validation.validated.status = 'confirmed';
            }
        }

        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');
        const propertyId = getPropertyId(req);
        
        // Auto-assign rooms for non-same-day reservations
        const checkInDate = new Date(validation.validated.checkInDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        checkInDate.setHours(0, 0, 0, 0);
        const isSameDay = checkInDate.getTime() === today.getTime();
        
        let assignedRoomIds = validation.validated.roomNumbers || [];
        
        // If not same-day and no rooms assigned, auto-assign sequentially
        if (!isSameDay && (!assignedRoomIds || assignedRoomIds.length === 0)) {
            const numberOfRooms = validation.validated.numberOfRooms || 1;
            const roomTypeId = validation.validated.roomType;
            
            // Get all rooms of this type, sorted by room number
            const allRooms = await Rooms.find({
                roomType: roomTypeId,
                property: propertyId,
                status: { $nin: ['maintenance'] } // Exclude maintenance rooms
            }).sort({ roomNumber: 1 }); // Sort by room number ascending
            
            // Find available rooms for the date range
            const checkIn = dateValidation.checkIn;
            const checkOut = dateValidation.checkOut;
            
            // Get conflicting reservations
            const conflictingReservations = await Reservations.find({
                property: propertyId,
                roomType: roomTypeId,
                checkInDate: { $lt: checkOut },
                checkOutDate: { $gt: checkIn },
                status: { $nin: ['cancelled', 'no-show'] }
            })
            .select('roomNumbers') // Only select roomNumbers field
            .lean(); // Use lean() for better performance
            
            // Extract occupied room IDs
            const occupiedRoomIds = new Set();
            conflictingReservations.forEach(res => {
                if (res.roomNumbers && Array.isArray(res.roomNumbers)) {
                    res.roomNumbers.forEach(roomId => {
                        occupiedRoomIds.add(roomId.toString());
                    });
                }
            });
            
            // Find available rooms (not occupied and not in maintenance)
            const availableRooms = allRooms.filter(room => {
                const roomIdStr = room._id.toString();
                return !occupiedRoomIds.has(roomIdStr);
            });
            
            // Assign rooms sequentially from available rooms
            if (availableRooms.length >= numberOfRooms) {
                assignedRoomIds = availableRooms.slice(0, numberOfRooms).map(room => room._id);
                console.log(`Auto-assigned ${numberOfRooms} room(s) for non-same-day reservation: ${assignedRoomIds.map(id => id.toString())}`);
            } else {
                console.warn(`Not enough available rooms. Required: ${numberOfRooms}, Available: ${availableRooms.length}`);
                // Assign what we can, but reservation will be created without full room assignment
                assignedRoomIds = availableRooms.map(room => room._id);
            }
        }
        
        // Ensure notes is an array (not a string)
        const notesArray = Array.isArray(validation.validated.notes) 
            ? validation.validated.notes 
            : (validation.validated.notes && typeof validation.validated.notes === 'string' && validation.validated.notes.trim() 
                ? [] // If it's a non-empty string, ignore it (notes should be added via notes API)
                : []); // Default to empty array
        
        const reservation = new Reservations({
            ...validation.validated,
            checkInDate: dateValidation.checkIn,
            checkOutDate: dateValidation.checkOut,
            roomNumbers: assignedRoomIds, // Use auto-assigned or provided rooms
            notes: notesArray, // Ensure notes is always an array
            property: propertyId,
        });

        await reservation.save();
        
        // Handle travel agent commission if travel agent is selected
        if (validation.validated.Source === 'travel-agent' && validation.validated.travelAgentId) {
            try {
                const TravelAgent = getModel(req, 'TravelAgent');
                const travelAgent = await TravelAgent.findOne({
                    _id: validation.validated.travelAgentId,
                    property: propertyId
                });
                
                if (travelAgent) {
                    // Calculate commission
                    let commissionAmount = 0;
                    if (travelAgent.commissionType === 'percentage') {
                        commissionAmount = (validation.validated.totalAmount * travelAgent.commissionRate) / 100;
                    } else {
                        commissionAmount = travelAgent.commissionRate; // Fixed amount
                    }
                    
                    // Update travel agent stats
                    travelAgent.totalBookings += 1;
                    travelAgent.totalRevenue += validation.validated.totalAmount;
                    travelAgent.totalCommission += commissionAmount;
                    travelAgent.calculateCommission(); // Recalculate outstanding
                    await travelAgent.save();
                    
                    // Store commission in reservation (if reservation schema supports it)
                    // You may need to add a commissionAmount field to the reservation schema
                    console.log(`Travel agent commission calculated: ₹${commissionAmount} for agent ${travelAgent.agentCode}`);
                }
            } catch (error) {
                console.error('Error calculating travel agent commission:', error);
                // Don't fail reservation creation if commission calculation fails
            }
        }
        
        // Check if check-in date is today - if so, create folio and guest profile automatically
        if (reservation.checkInDate) {
            const checkInDateCheck = new Date(reservation.checkInDate);
            const todayCheck = new Date();
            todayCheck.setHours(0, 0, 0, 0);
            checkInDateCheck.setHours(0, 0, 0, 0);
            
            if (checkInDateCheck.getTime() === todayCheck.getTime()) {
                // Same day check-in, create folio automatically
                await createFolioForReservation(req, reservation);
                
                // Create or update guest profile for same-day reservation (like check-in)
                try {
                    const propertyId = getPropertyId(req);
                    const guestProfiles = getModel(req, 'GuestProfiles');
                    
                    // Check if guest already exists by email or phone
                    const identifierQuery = [];
                    if (reservation.guestEmail) identifierQuery.push({ guestEmail: reservation.guestEmail });
                    if (reservation.guestNumber) identifierQuery.push({ guestNumber: reservation.guestNumber });

                    let existingGuest = null;
                    if (identifierQuery.length > 0) {
                        existingGuest = await guestProfiles.findOne({
                            property: propertyId,
                            $or: identifierQuery
                        });
                    }

                    const checkIn = reservation.checkInDate ? new Date(reservation.checkInDate) : new Date();
                    const checkOut = reservation.checkOutDate ? new Date(reservation.checkOutDate) : new Date();
                    const totalSpend = reservation.payedAmount || reservation.advanceAmount || 0;

                    const buildStayRecord = () => {
                        return {
                            checkInDate: checkIn,
                            checkOutDate: checkOut,
                            amount: totalSpend
                        };
                    };

                    if (existingGuest) {
                        // Update existing guest
                        const newStayRecord = buildStayRecord();
                        const allRecords = [...existingGuest.records, newStayRecord];
                        const totalNights = allRecords.reduce((sum, record) => {
                            const checkIn = new Date(record.checkInDate);
                            const checkOut = new Date(record.checkOutDate);
                            const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
                            return sum + nights;
                        }, 0);
                        const averageStay = totalNights / allRecords.length;

                        await guestProfiles.findOneAndUpdate(
                            { _id: existingGuest._id, property: propertyId },
                            {
                                $set: {
                                    totalVisits: existingGuest.totalVisits + 1,
                                    totalSpend: existingGuest.totalSpend + totalSpend,
                                    AverageStay: Math.round(averageStay * 100) / 100,
                                    reservationId: reservation._id
                                },
                                $push: { records: newStayRecord }
                            },
                            { new: true, runValidators: true }
                        );
                        console.log(`Guest profile updated for same-day reservation: ${reservation._id}`);
                    } else {
                        // Create new guest
                        const newStayRecord = buildStayRecord();
                        const checkInDate = new Date(newStayRecord.checkInDate);
                        const checkOutDate = new Date(newStayRecord.checkOutDate);
                        const nights = Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24));
                        const averageStay = nights;

                        const newGuest = new guestProfiles({
                            guestName: reservation.guestName,
                            guestEmail: reservation.guestEmail,
                            guestNumber: reservation.guestNumber,
                            guestType: 'regular',
                            reservationId: reservation._id,
                            aadhaarNumber: reservation.adhaarNumber,
                            adultCount: reservation.totalGuest || 1,
                            childCount: 0,
                            totalVisits: 1,
                            totalSpend: totalSpend,
                            AverageStay: averageStay,
                            records: [newStayRecord],
                            property: propertyId
                        });
                        await newGuest.save();
                        console.log(`Guest profile created for same-day reservation: ${reservation._id}`);
                    }
                } catch (guestError) {
                    console.error('Error creating/updating guest profile for same-day reservation:', guestError);
                    // Don't fail the reservation creation if guest profile creation fails
                }
            }
        }
        
        await sendReservationEmail(req, reservation);
        res.status(201).json(reservation);
    } catch (error) {
        console.error('Error creating reservation:', error);
        res.status(500).json({ message: 'Server error creating reservation.' });
    }
});

router.get('/', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const { page, limit, search, status } = validatePagination(req.query);
        const propertyId = getPropertyId(req);

        const query = { property: propertyId };

        if (search) {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { guestEmail: { $regex: search, $options: 'i' } },
                { guestNumber: { $regex: search, $options: 'i' } },
            ];
        }

        if (status && status !== 'all') {
            query.status = status;
        }

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        const [total, reservations] = await Promise.all([
            Reservations.countDocuments(query),
            Reservations.find(query)
                .skip(skip)
                .limit(parseInt(limit, 10))
                .sort({ createdAt: -1, checkInDate: 1 })
                .lean(), // Use lean() for better performance
        ]);

        res.status(200).json({
            reservations,
            pagination: {
                currentPage: parseInt(page, 10),
                totalPages: Math.ceil(total / parseInt(limit, 10)),
                totalItems: total,
                itemsPerPage: parseInt(limit, 10),
            },
        });
    } catch (error) {
        console.error('Error fetching reservations:', error);
        res.status(500).json({ message: 'Server error fetching reservations.' });
    }
});

router.get('/all', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const reservations = await Reservations.find({ property: getPropertyId(req) })
            .sort({ createdAt: -1 })
            .lean(); // Use lean() for better performance
        res.status(200).json(reservations);
    } catch (error) {
        console.error('Error fetching reservations list:', error);
        res.status(500).json({ message: 'Server error fetching reservations.' });
    }
});

router.get('/departures/:date', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const { date } = req.params;
        
        // Validate date format
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
        }
        
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const propertyId = getPropertyId(req);

        const start = new Date(`${date}T00:00:00.000Z`);
        const end = new Date(`${date}T23:59:59.999Z`);

        const query = {
            property: propertyId,
            checkOutDate: { $gte: start, $lt: end },
            status: { $ne: 'checked-out' },
        };

        if (search) {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { guestEmail: { $regex: search, $options: 'i' } },
                { guestNumber: { $regex: search, $options: 'i' } },
                { roomNumber: { $regex: search, $options: 'i' } },
            ];
        }

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        const [total, departures] = await Promise.all([
            Reservations.countDocuments(query),
            Reservations.find(query)
                .skip(skip)
                .limit(parseInt(limit, 10))
                .sort({ checkOutDate: 1, guestName: 1 })
                .lean(), // Use lean() for better performance
        ]);

        res.status(200).json({
            departures,
            pagination: {
                currentPage: parseInt(page, 10),
                totalPages: Math.ceil(total / parseInt(limit, 10)),
                totalItems: total,
                itemsPerPage: parseInt(limit, 10),
            },
        });
    } catch (error) {
        console.error('Error fetching departures:', error);
        res.status(500).json({ message: 'Server error fetching departures.' });
    }
});

router.get('/arrivals/:date', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const { date } = req.params;
        
        // Validate date format
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD' });
        }
        
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const propertyId = getPropertyId(req);

        const start = new Date(`${date}T00:00:00.000Z`);
        const end = new Date(`${date}T23:59:59.999Z`);

        const query = {
            property: propertyId,
            checkInDate: { $gte: start, $lte: end },
            status: { $ne: 'checked-out' },
        };

        if (search) {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { guestEmail: { $regex: search, $options: 'i' } },
                { guestNumber: { $regex: search, $options: 'i' } },
                { roomNumber: { $regex: search, $options: 'i' } },
            ];
        }

        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

        const [total, arrivals] = await Promise.all([
            Reservations.countDocuments(query),
            Reservations.find(query)
                .skip(skip)
                .limit(parseInt(limit, 10))
                .sort({ checkInDate: 1, guestName: 1 })
                .lean(), // Use lean() for better performance
        ]);

        res.status(200).json({
            arrivals,
            pagination: {
                currentPage: parseInt(page, 10),
                totalPages: Math.ceil(total / parseInt(limit, 10)),
                totalItems: total,
                itemsPerPage: parseInt(limit, 10),
            },
        });
    } catch (error) {
        console.error('Error fetching arrivals:', error);
        res.status(500).json({ message: 'Server error fetching arrivals.' });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid reservation ID format' });
        }
        
        const Reservations = getModel(req, 'Reservations');
        const reservation = await Reservations.findOne({
            _id: id,
            property: getPropertyId(req),
        })
        .populate('roomType', 'name')
        .populate('roomNumbers', 'roomNumber');

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        res.status(200).json(reservation);
    } catch (error) {
        console.error('Error fetching reservation:', error);
        res.status(500).json({ message: 'Server error fetching reservation.' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid reservation ID format' });
        }
        
        // Validate update fields (all optional, but validate types if provided)
        const updateSchema = {
            guestName: { type: 'string' },
            guestEmail: { type: 'string', custom: (val) => !val || isValidEmail(val) || 'Invalid email format' },
            guestNumber: { type: 'string', custom: (val) => !val || isValidPhone(val) || 'Invalid phone number' },
            checkInDate: { type: 'string', isDate: true },
            checkOutDate: { type: 'string', isDate: true },
            roomType: { type: 'string', isObjectId: true },
            numberOfRooms: { type: 'number', min: 1 },
            totalGuest: { type: 'number', min: 1 },
            totalAmount: { type: 'number', min: 0 },
            payedAmount: { type: 'number', min: 0 },
            paymentMethod: { type: 'string' },
            Source: { type: 'string', enum: ['direct', 'website', 'booking.com', 'agoda', 'expedia', 'airbnb', 'phone', 'walk-in', 'travel-agent'] },
            travelAgentId: { type: 'string', isObjectId: true },
            status: { type: 'string', enum: ['confirmed', 'checked-in', 'checked-out', 'cancelled'] },
            mealPlan: { type: 'string', enum: ['EP', 'CP', 'MAP', 'AP'] },
            mealPlanAmount: { type: 'number', min: 0 },
            mealPlanGuestCount: { type: 'number', min: 0 },
            mealPlanNights: { type: 'number', min: 0 },
            mealPlanRate: { type: 'number', min: 0 },
            mealPreferences: { isObject: true }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        // Normalize payment method if provided
        if (validation.validated.paymentMethod) {
            validation.validated.paymentMethod = normalizePaymentMethod(validation.validated.paymentMethod);
        }

        const Reservations = getModel(req, 'Reservations');
        const oldReservation = await Reservations.findOne({
            _id: id,
            property: getPropertyId(req)
        });
        
        // Build update object - only include roomNumbers if it's provided in the request
        const updateData = { ...validation.validated, property: getPropertyId(req) };
        if (req.body.roomNumbers !== undefined && Array.isArray(req.body.roomNumbers)) {
            updateData.roomNumbers = req.body.roomNumbers;
        }
        
        const reservation = await Reservations.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updateData,
            { new: true }
        );

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        // Handle travel agent commission if travel agent is added or changed
        if (validation.validated.Source === 'travel-agent' && validation.validated.travelAgentId) {
            try {
                const TravelAgent = getModel(req, 'TravelAgent');
                const travelAgent = await TravelAgent.findOne({
                    _id: validation.validated.travelAgentId,
                    property: getPropertyId(req)
                });
                
                if (travelAgent) {
                    // Check if this is a new travel agent assignment or update
                    const wasTravelAgent = oldReservation && oldReservation.Source === 'travel-agent' && oldReservation.travelAgentId;
                    const isNewAssignment = !wasTravelAgent || oldReservation.travelAgentId?.toString() !== validation.validated.travelAgentId.toString();
                    const amountChanged = validation.validated.totalAmount && oldReservation && oldReservation.totalAmount !== validation.validated.totalAmount;
                    
                    if (isNewAssignment || amountChanged) {
                        // Calculate commission
                        let commissionAmount = 0;
                        if (travelAgent.commissionType === 'percentage') {
                            commissionAmount = ((validation.validated.totalAmount || reservation.totalAmount || 0) * travelAgent.commissionRate) / 100;
                        } else {
                            commissionAmount = travelAgent.commissionRate; // Fixed amount
                        }
                        
                        // If this was a previous travel agent, subtract their commission
                        if (wasTravelAgent && oldReservation.travelAgentId && oldReservation.travelAgentId.toString() !== validation.validated.travelAgentId.toString()) {
                            const oldAgent = await TravelAgent.findOne({
                                _id: oldReservation.travelAgentId,
                                property: getPropertyId(req)
                            });
                            if (oldAgent) {
                                const oldCommission = oldAgent.commissionType === 'percentage' 
                                    ? ((oldReservation.totalAmount || 0) * oldAgent.commissionRate) / 100
                                    : oldAgent.commissionRate;
                                oldAgent.totalBookings = Math.max(0, oldAgent.totalBookings - 1);
                                oldAgent.totalRevenue = Math.max(0, oldAgent.totalRevenue - (oldReservation.totalAmount || 0));
                                oldAgent.totalCommission = Math.max(0, oldAgent.totalCommission - oldCommission);
                                oldAgent.calculateCommission();
                                await oldAgent.save();
                            }
                        }
                        
                        // Update new travel agent stats
                        if (isNewAssignment) {
                            travelAgent.totalBookings += 1;
                        }
                        travelAgent.totalRevenue = Math.max(0, travelAgent.totalRevenue - (oldReservation?.totalAmount || 0) + (validation.validated.totalAmount || reservation.totalAmount || 0));
                        travelAgent.totalCommission = Math.max(0, travelAgent.totalCommission - (wasTravelAgent && !isNewAssignment ? 0 : (oldReservation?.totalAmount || 0) * travelAgent.commissionRate / 100) + commissionAmount);
                        travelAgent.calculateCommission();
                        await travelAgent.save();
                    }
                }
            } catch (error) {
                console.error('Error updating travel agent commission:', error);
                // Don't fail reservation update if commission calculation fails
            }
        } else if (oldReservation && oldReservation.Source === 'travel-agent' && oldReservation.travelAgentId && validation.validated.Source !== 'travel-agent') {
            // Travel agent was removed, subtract commission
            try {
                const TravelAgent = getModel(req, 'TravelAgent');
                const oldAgent = await TravelAgent.findOne({
                    _id: oldReservation.travelAgentId,
                    property: getPropertyId(req)
                });
                if (oldAgent) {
                    const oldCommission = oldAgent.commissionType === 'percentage' 
                        ? ((oldReservation.totalAmount || 0) * oldAgent.commissionRate) / 100
                        : oldAgent.commissionRate;
                    oldAgent.totalBookings = Math.max(0, oldAgent.totalBookings - 1);
                    oldAgent.totalRevenue = Math.max(0, oldAgent.totalRevenue - (oldReservation.totalAmount || 0));
                    oldAgent.totalCommission = Math.max(0, oldAgent.totalCommission - oldCommission);
                    oldAgent.calculateCommission();
                    await oldAgent.save();
                }
            } catch (error) {
                console.error('Error removing travel agent commission:', error);
            }
        }
        
        // If status is being updated to 'checked-in', create folio automatically
        if (req.body.status === 'checked-in' && (!oldReservation || oldReservation.status !== 'checked-in')) {
            await createFolioForReservation(req, reservation);
        }

        res.status(200).json(reservation);
    } catch (error) {
        console.error('Error updating reservation:', error);
        res.status(500).json({ message: 'Server error updating reservation.' });
    }
});

// Cancel reservation endpoint
router.post('/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid reservation ID format' });
        }
        
        const Reservations = getModel(req, 'Reservations');
        const reservation = await Reservations.findOne({
            _id: id,
            property: getPropertyId(req),
        });

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        // Cannot cancel already checked-out or cancelled reservations
        if (reservation.status === 'checked-out') {
            return res.status(400).json({ message: 'Cannot cancel a checked-out reservation.' });
        }
        
        if (reservation.status === 'cancelled') {
            return res.status(400).json({ message: 'Reservation is already cancelled.' });
        }

        // Get cancellation policy from settings (if available)
        const PropertyDetails = getModel(req, 'PropertyDetails');
        const propertyDetails = await PropertyDetails.findOne({
            property: getPropertyId(req),
        });

        // Calculate cancellation fee based on policy
        let cancellationFee = 0;
        const checkInDate = new Date(reservation.checkInDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        checkInDate.setHours(0, 0, 0, 0);
        const daysUntilCheckIn = Math.ceil((checkInDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

        // Default cancellation policy: Free cancellation if > 24 hours before check-in
        // Otherwise, charge first night or percentage based on property settings
        if (daysUntilCheckIn <= 0) {
            // Same day or past check-in date - full charge
            cancellationFee = reservation.totalAmount || 0;
        } else if (daysUntilCheckIn === 1) {
            // Less than 24 hours - charge first night
            const RoomType = getModel(req, 'RoomType');
            const roomType = await RoomType.findOne({ _id: reservation.roomType, property: getPropertyId(req) });
            if (roomType) {
                cancellationFee = roomType.baseRate * (reservation.numberOfRooms || 1);
            }
        }
        // More than 24 hours - no fee (can be customized based on property policy)

        // Update reservation status
        reservation.status = 'cancelled';
        reservation.cancelledAt = new Date();
        reservation.cancellationFee = cancellationFee;
        await reservation.save();

        // If rooms were assigned, mark them as available (clean)
        if (reservation.roomNumbers && reservation.roomNumbers.length > 0) {
            const Rooms = getModel(req, 'Rooms');
            try {
                const rooms = await Rooms.find({
                    _id: { $in: reservation.roomNumbers },
                    property: getPropertyId(req)
                });
                for (const room of rooms) {
                    if (room.status === 'occupied') {
                        room.status = 'clean'; // Mark as clean since guest never checked in
                        await room.save();
                    }
                }
            } catch (roomError) {
                console.error('Error updating room statuses during cancellation:', roomError);
            }
        }

        // Send cancellation email if guest email exists
        if (reservation.guestEmail) {
            try {
                const EmailTemplate = getModel(req, 'EmailTemplate');
                const template = await EmailTemplate.findOne({
                    template_name: 'cancellationMail',
                    property: getPropertyId(req),
                });

                if (template?.content) {
                    const variables = {
                        guestName: reservation.guestName || '',
                        reservationId: reservation._id,
                        checkInDate: reservation.checkInDate ? new Date(reservation.checkInDate).toLocaleDateString('en-GB') : '',
                        cancellationFee: cancellationFee > 0 ? cancellationFee.toFixed(2) : '0',
                        refundAmount: cancellationFee > 0 ? ((reservation.payedAmount || 0) - cancellationFee).toFixed(2) : (reservation.payedAmount || 0).toFixed(2),
                    };

                    const htmlBody = compileTemplate(template.content, variables);
                    const subject = template.subject || 'Reservation Cancellation';
                    await emailService.sendEmail(req.tenant, reservation.guestEmail, subject, htmlBody, {});
                }
            } catch (emailError) {
                console.error('Error sending cancellation email:', emailError);
            }
        }

        res.status(200).json({
            message: 'Reservation cancelled successfully.',
            reservation: reservation,
            cancellationFee: cancellationFee,
            refundAmount: Math.max(0, (reservation.payedAmount || 0) - cancellationFee)
        });
    } catch (error) {
        console.error('Error cancelling reservation:', error);
        res.status(500).json({ message: 'Server error cancelling reservation.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid reservation ID format' });
        }
        
        const Reservations = getModel(req, 'Reservations');
        const reservation = await Reservations.findOne({
            _id: id,
            property: getPropertyId(req),
        });

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        // Only allow deletion of cancelled or confirmed reservations (not checked-in/out)
        if (reservation.status === 'checked-in' || reservation.status === 'checked-out') {
            return res.status(400).json({ 
                message: 'Cannot delete checked-in or checked-out reservations. Cancel them instead.' 
            });
        }

        const result = await Reservations.findOneAndDelete({
            _id: id,
            property: getPropertyId(req),
        });

        res.status(200).json({ message: 'Reservation deleted successfully.' });
    } catch (error) {
        console.error('Error deleting reservation:', error);
        res.status(500).json({ message: 'Server error deleting reservation.' });
    }
});

// Add note to reservation
router.post('/:id/notes', async (req, res) => {
    try {
        const { id } = req.params;
        const { content } = req.body;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid reservation ID format' });
        }
        
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ message: 'Note content is required and cannot be empty' });
        }
        
        const Reservations = getModel(req, 'Reservations');
        const reservation = await Reservations.findOne({
            _id: id,
            property: getPropertyId(req),
        });

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        // Add note
        const newNote = {
            content: content.trim(),
            createdBy: req.tenant.user._id,
            createdAt: new Date()
        };

        if (!reservation.notes) {
            reservation.notes = [];
        }
        reservation.notes.push(newNote);
        await reservation.save();

        res.status(200).json({ 
            message: 'Note added successfully.',
            note: newNote,
            reservation: reservation
        });
    } catch (error) {
        console.error('Error adding note:', error);
        res.status(500).json({ message: 'Server error adding note.' });
    }
});

// Delete note from reservation
router.delete('/:id/notes/:noteId', async (req, res) => {
    try {
        const { id, noteId } = req.params;
        
        // Validate ObjectIds
        if (!isValidObjectId(id) || !isValidObjectId(noteId)) {
            return res.status(400).json({ message: 'Invalid ID format' });
        }
        
        const Reservations = getModel(req, 'Reservations');
        const reservation = await Reservations.findOne({
            _id: id,
            property: getPropertyId(req),
        });

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        if (!reservation.notes || reservation.notes.length === 0) {
            return res.status(404).json({ message: 'No notes found.' });
        }

        // Remove note
        const noteIndex = reservation.notes.findIndex(note => note._id.toString() === noteId);
        if (noteIndex === -1) {
            return res.status(404).json({ message: 'Note not found.' });
        }

        reservation.notes.splice(noteIndex, 1);
        await reservation.save();

        res.status(200).json({ 
            message: 'Note deleted successfully.',
            reservation: reservation
        });
    } catch (error) {
        console.error('Error deleting note:', error);
        res.status(500).json({ message: 'Server error deleting note.' });
    }
});

// Shift reservation to different room/room type
router.post('/:id/shift', async (req, res) => {
    try {
        const { id } = req.params;
        const { roomNumbers, roomTypeId } = req.body;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid reservation ID format' });
        }
        
        if (!roomNumbers || !Array.isArray(roomNumbers) || roomNumbers.length === 0) {
            return res.status(400).json({ message: 'roomNumbers array is required and must not be empty' });
        }
        
        // Validate all room IDs
        for (const roomId of roomNumbers) {
            if (!isValidObjectId(roomId)) {
                return res.status(400).json({ message: `Invalid room ID format: ${roomId}` });
            }
        }
        
        if (roomTypeId && !isValidObjectId(roomTypeId)) {
            return res.status(400).json({ message: 'Invalid roomTypeId format' });
        }
        
        const propertyId = getPropertyId(req);
        const Reservations = getModel(req, 'Reservations');
        const Rooms = getModel(req, 'Rooms');
        const RoomType = getModel(req, 'RoomType');
        const GuestFolio = getModel(req, 'GuestFolio');
        
        // Get reservation
        const reservation = await Reservations.findOne({
            _id: id,
            property: propertyId,
        });
        
        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }
        
        // Check if reservation is checked-in
        if (reservation.status !== 'checked-in') {
            return res.status(400).json({ message: 'Can only shift checked-in reservations.' });
        }
        
        // Get folio
        const folio = await GuestFolio.findOne({
            reservationId: reservation._id,
            property: propertyId,
            status: 'active'
        });
        
        if (!folio) {
            return res.status(404).json({ message: 'Active folio not found for this reservation.' });
        }
        
        // Validate new rooms exist and are clean
        const newRooms = await Rooms.find({
            _id: { $in: roomNumbers },
            property: propertyId
        });
        
        if (newRooms.length !== roomNumbers.length) {
            return res.status(400).json({ message: 'One or more rooms not found.' });
        }
        
        // Check if all new rooms are clean
        const dirtyRooms = newRooms.filter(room => room.status !== 'clean');
        if (dirtyRooms.length > 0) {
            const dirtyRoomNumbers = dirtyRooms.map(r => r.roomNumber).join(', ');
            return res.status(400).json({ message: `The following rooms are not clean: ${dirtyRoomNumbers}` });
        }
        
        // Get new room type (if provided, otherwise use existing)
        const currentRoomTypeId = reservation.roomType.toString();
        const newRoomTypeId = roomTypeId || currentRoomTypeId;
        const newRoomType = await RoomType.findOne({
            _id: newRoomTypeId,
            property: propertyId
        });
        
        if (!newRoomType) {
            return res.status(404).json({ message: 'New room type not found.' });
        }
        
        const isRoomTypeChanged = roomTypeId && newRoomTypeId !== currentRoomTypeId;
        
        // Get old rooms to update their status
        const oldRoomIds = reservation.roomNumbers || [];
        const oldRooms = oldRoomIds.length > 0 ? await Rooms.find({
            _id: { $in: oldRoomIds },
            property: propertyId
        }) : [];
        
        // Calculate time stayed in previous room
        const checkInDate = new Date(reservation.checkInDate);
        const now = new Date();
        const shiftTime = now;
        
        // Calculate full days stayed (11 AM cutoff logic)
        // Night ends at 11 AM next day, so if shift is before 11 AM, don't count last night as full
        const nextDay11AM = new Date(checkInDate);
        nextDay11AM.setDate(nextDay11AM.getDate() + 1);
        nextDay11AM.setHours(11, 0, 0, 0);
        
        let fullNightsStayed = 0;
        
        if (shiftTime >= nextDay11AM) {
            // If shift time is after 11 AM next day, count full nights
            fullNightsStayed = Math.floor((shiftTime - checkInDate) / (1000 * 60 * 60 * 24));
            // If shift time is after 11 AM on a day, add that night
            const shiftDay11AM = new Date(shiftTime);
            shiftDay11AM.setHours(11, 0, 0, 0);
            if (shiftTime >= shiftDay11AM) {
                fullNightsStayed = Math.max(1, fullNightsStayed);
            }
        }
        // If less than 11 AM next day, fullNightsStayed remains 0
        
        // Get old room type for pricing
        const oldRoomType = await RoomType.findOne({
            _id: reservation.roomType,
            property: propertyId
        });
        
        // Calculate charges for previous room if stayed >= 1 full night
        if (fullNightsStayed >= 1 && oldRoomType && oldRooms.length > 0) {
            const oldRoomNumbers = oldRooms.map(r => r.roomNumber);
            const oldRoomTypeName = oldRoomType.name || 'Room';
            const priceModel = oldRoomType.priceModel || 'perRoom';
            
            // Calculate charge per room per night
            let chargePerRoomPerNight = 0;
            if (priceModel === 'perRoom') {
                chargePerRoomPerNight = oldRoomType.baseRate || 0;
            } else if (priceModel === 'perPerson') {
                const adultCount = reservation.adultCount || reservation.numberOfAdults || 0;
                const childCount = reservation.childCount || reservation.numberOfChildren || 0;
                const adultRate = oldRoomType.adultRate || 0;
                const childRate = oldRoomType.childRate || 0;
                chargePerRoomPerNight = (adultCount * adultRate) + (childCount * childRate);
            }
            
            // Add charges for each old room for each full night
            oldRoomNumbers.forEach(roomNum => {
                const chargePerRoom = chargePerRoomPerNight * fullNightsStayed;
                
                folio.items.push({
                    description: `Accommodation - ${oldRoomTypeName} (Room ${roomNum}) - ${fullNightsStayed} night${fullNightsStayed > 1 ? 's' : ''}`,
                    date: checkInDate,
                    amount: chargePerRoom,
                    department: 'Room',
                    quantity: 1,
                    unitPrice: chargePerRoom,
                    tax: 0,
                    discount: 0
                });
            });
        }
        
        // Update reservation with new rooms and room type
        reservation.roomNumbers = roomNumbers;
        if (isRoomTypeChanged) {
            reservation.roomType = newRoomTypeId;
        }
        await reservation.save();
        
        // Get new room numbers
        const newRoomNumbers = newRooms.map(r => r.roomNumber);
        
        // Update folio with new room numbers
        folio.roomNumbers = newRoomNumbers;
        folio.roomNumber = newRoomNumbers[0] || '';
        
        // Calculate remaining nights from shift time to checkout
        const checkOutDate = new Date(reservation.checkOutDate);
        const remainingNights = Math.max(0, Math.ceil((checkOutDate - shiftTime) / (1000 * 60 * 60 * 24)));
        
        if (remainingNights > 0) {
            // Calculate charge for new room type
            const newPriceModel = newRoomType.priceModel || 'perRoom';
            let chargePerRoomPerNight = 0;
            
            if (newPriceModel === 'perRoom') {
                chargePerRoomPerNight = newRoomType.baseRate || 0;
            } else if (newPriceModel === 'perPerson') {
                const adultCount = reservation.adultCount || reservation.numberOfAdults || 0;
                const childCount = reservation.childCount || reservation.numberOfChildren || 0;
                const adultRate = newRoomType.adultRate || 0;
                const childRate = newRoomType.childRate || 0;
                chargePerRoomPerNight = (adultCount * adultRate) + (childCount * childRate);
            }
            
            // Add charges for new rooms for remaining nights
            newRoomNumbers.forEach(roomNum => {
                const chargePerRoom = chargePerRoomPerNight * remainingNights;
                folio.items.push({
                    description: `Accommodation - ${newRoomType.name} (Room ${roomNum}) - ${remainingNights} night${remainingNights > 1 ? 's' : ''}`,
                    date: shiftTime,
                    amount: chargePerRoom,
                    department: 'Room',
                    quantity: 1,
                    unitPrice: chargePerRoom,
                    tax: 0,
                    discount: 0
                });
            });
        }
        
        // Recalculate folio balance
        folio.calculateBalance();
        await folio.save();
        
        // Update room statuses
        // Mark old rooms as dirty
        for (const oldRoom of oldRooms) {
            oldRoom.status = 'dirty';
            await oldRoom.save();
        }
        
        // Mark new rooms as occupied
        for (const newRoom of newRooms) {
            newRoom.status = 'occupied';
            await newRoom.save();
        }
        
        res.status(200).json({
            message: 'Reservation shifted successfully.',
            reservation: reservation,
            folio: folio,
            fullNightsStayed: fullNightsStayed,
            remainingNights: remainingNights
        });
    } catch (error) {
        console.error('Error shifting reservation:', error);
        res.status(500).json({ message: 'Server error shifting reservation.' });
    }
});

module.exports = router;
