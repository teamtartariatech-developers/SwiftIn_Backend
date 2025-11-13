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

// Helper function to normalize payment method to match enum values
const normalizePaymentMethod = (method) => {
  if (!method) return 'Cash';
  
  const methodLower = method.toLowerCase().trim();
  const validMethods = {
    'cash': 'Cash',
    'credit card': 'Credit Card',
    'creditcard': 'Credit Card',
    'debit card': 'Debit Card',
    'debitcard': 'Debit Card',
    'upi': 'UPI',
    'bank transfer': 'Bank Transfer',
    'banktransfer': 'Bank Transfer',
    'wallet': 'Wallet',
    'cheque': 'Cheque',
    'check': 'Cheque'
  };
  
  return validMethods[methodLower] || 'Cash';
};
const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const emailService = require('../../services/emailService');

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
        const Reservations = getModel(req, 'Reservations');
        const reservation = new Reservations({
            ...req.body,
            property: getPropertyId(req),
        });

        await reservation.save();
        
        // Check if check-in date is today - if so, create folio and guest profile automatically
        if (reservation.checkInDate) {
            const checkInDate = new Date(reservation.checkInDate);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            checkInDate.setHours(0, 0, 0, 0);
            
            if (checkInDate.getTime() === today.getTime()) {
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
        const { page = 1, limit = 15, search = '', status = '' } = req.query;
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
                .sort({ createdAt: -1, checkInDate: 1 }),
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
        const reservations = await Reservations.find({ property: getPropertyId(req) }).sort({ createdAt: -1 });
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
        const { page = 1, limit = 50, search = '' } = req.query;
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
                .sort({ checkOutDate: 1, guestName: 1 }),
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

router.get('/:id', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const reservation = await Reservations.findOne({
            _id: req.params.id,
            property: getPropertyId(req),
        });

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
        const Reservations = getModel(req, 'Reservations');
        const oldReservation = await Reservations.findOne({
            _id: req.params.id,
            property: getPropertyId(req)
        });
        
        const reservation = await Reservations.findOneAndUpdate(
            { _id: req.params.id, property: getPropertyId(req) },
            { ...req.body, property: getPropertyId(req) },
            { new: true }
        );

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
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

router.delete('/:id', async (req, res) => {
    try {
        const Reservations = getModel(req, 'Reservations');
        const result = await Reservations.findOneAndDelete({
            _id: req.params.id,
            property: getPropertyId(req),
        });

        if (!result) {
            return res.status(404).json({ message: 'Reservation not found.' });
        }

        res.status(200).json({ message: 'Reservation deleted successfully.' });
    } catch (error) {
        console.error('Error deleting reservation:', error);
        res.status(500).json({ message: 'Server error deleting reservation.' });
    }
});

module.exports = router;
