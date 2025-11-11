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

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('front-office'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

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

    const property = req.tenant?.property || {};
    const checkInValue = reservation.checkInDate || reservation.checkIn;
    const checkOutValue = reservation.checkOutDate || reservation.checkOut;
    const guestCount =
      reservation.totalGuest ??
      reservation.totalGuests ??
      reservation.numberOfGuests ??
      reservation.guestCount;

    const variables = {
      guestName: reservation.guestName || '',
      reservationId: reservation.reservationId || reservation._id,
      checkInDate: checkInValue ? new Date(checkInValue).toLocaleDateString('en-GB') : '',
      checkOutDate: checkOutValue ? new Date(checkOutValue).toLocaleDateString('en-GB') : '',
      roomType: reservation.roomType || '',
      totalGuests: guestCount != null ? guestCount : '',
      totalAmount: reservation.totalAmount != null ? reservation.totalAmount : '',
      propertyName: property.name || '',
      propertyEmail: property.email || '',
      propertyPhone: property.phone || '',
      propertyAddress: formatAddress(property.address),
    };

    if (variables.totalGuests !== '') {
      variables.totalGuests = String(variables.totalGuests);
    }

    if (variables.totalAmount !== '') {
      variables.totalAmount = String(variables.totalAmount);
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
        const reservation = await Reservations.findOneAndUpdate(
            { _id: req.params.id, property: getPropertyId(req) },
            { ...req.body, property: getPropertyId(req) },
            { new: true }
        );

        if (!reservation) {
            return res.status(404).json({ message: 'Reservation not found.' });
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
