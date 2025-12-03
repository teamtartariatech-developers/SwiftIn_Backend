const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, validatePagination, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('front-office'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all paymaster rooms
router.get('/', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        let query = { property: propertyId };
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { paymasterCode: { $regex: search, $options: 'i' } }
            ];
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await PaymasterRoom.countDocuments(query);
        
        const paymasters = await PaymasterRoom.find(query)
            .populate('linkedGuests')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        
        // Calculate balances
        paymasters.forEach(pm => pm.calculateBalance());
        
        res.status(200).json({
            paymasters,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                itemsPerPage: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Error fetching paymaster rooms:', error);
        res.status(500).json({ message: 'Failed to fetch paymaster rooms.' });
    }
});

// Create paymaster room
router.post('/', async (req, res) => {
    try {
        // Handle both 'name' and 'paymasterName' for backward compatibility
        const name = req.body.name || req.body.paymasterName;
        if (!name) {
            return res.status(400).json({ message: 'Name is required' });
        }
        
        const paymasterSchema = {
            name: { type: 'string', required: true },
            description: { type: 'string', default: '' },
            accountType: { type: 'string', default: 'internal', enum: ['internal', 'f&b', 'event', 'package', 'miscellaneous'] },
            status: { type: 'string', default: 'open', enum: ['open', 'closed'] },
            linkedGuests: { isArray: true, default: [] },
            linkedDepartments: { isArray: true, default: [] }
        };
        
        const dataToValidate = {
            ...req.body,
            name: name
        };
        
        const validation = validateAndSetDefaults(dataToValidate, paymasterSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        const paymasterCode = await PaymasterRoom.generatePaymasterCode(propertyId);
        
        const paymaster = new PaymasterRoom({
            ...validation.validated,
            paymasterCode,
            property: propertyId
        });
        
        await paymaster.save();
        
        // Create folio for paymaster
        try {
            const GuestFolio = getModel(req, 'GuestFolio');
            const folioId = await GuestFolio.generateFolioId(propertyId);
            
            const folio = new GuestFolio({
                folioId,
                paymasterId: paymaster._id,
                guestName: paymaster.name,
                checkIn: new Date(),
                checkOut: new Date(), // Will be updated when checked out
                items: [],
                payments: [],
                totalCharges: 0,
                totalPayments: 0,
                balance: 0,
                status: 'active',
                property: propertyId
            });
            
            await folio.save();
        } catch (folioError) {
            console.error('Error creating folio for paymaster:', folioError);
            // Don't fail paymaster creation if folio creation fails
        }
        
        res.status(201).json(paymaster);
    } catch (error) {
        console.error('Error creating paymaster room:', error);
        res.status(500).json({ message: 'Failed to create paymaster room.' });
    }
});

// Get single paymaster
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid paymaster ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        const paymaster = await PaymasterRoom.findOne({
            _id: id,
            property: propertyId
        }).populate('linkedGuests');
        
        if (!paymaster) {
            return res.status(404).json({ message: 'Paymaster room not found.' });
        }
        
        paymaster.calculateBalance();
        await paymaster.save();
        
        res.status(200).json(paymaster);
    } catch (error) {
        console.error('Error fetching paymaster:', error);
        res.status(500).json({ message: 'Failed to fetch paymaster.' });
    }
});

// Update paymaster
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid paymaster ID format' });
        }
        
        const updateSchema = {
            name: { type: 'string' },
            description: { type: 'string' },
            accountType: { type: 'string', enum: ['internal', 'f&b', 'event', 'package', 'miscellaneous'] },
            linkedGuests: { isArray: true },
            linkedDepartments: { isArray: true },
            status: { type: 'string', enum: ['active', 'settled', 'archived'] }
        };
        
        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        const paymaster = await PaymasterRoom.findOneAndUpdate(
            { _id: id, property: propertyId },
            validation.validated,
            { new: true }
        );
        
        if (!paymaster) {
            return res.status(404).json({ message: 'Paymaster room not found.' });
        }
        
        res.status(200).json(paymaster);
    } catch (error) {
        console.error('Error updating paymaster:', error);
        res.status(500).json({ message: 'Failed to update paymaster.' });
    }
});

// Add charge to paymaster
router.post('/:id/charges', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid paymaster ID format' });
        }
        
        const chargeSchema = {
            description: { type: 'string', required: true },
            date: { type: 'string', isDate: true, default: () => new Date() },
            amount: { type: 'number', required: true, min: 0 },
            department: { type: 'string', default: 'Other', enum: ['Room', 'F&B', 'Spa', 'Laundry', 'Event', 'Package', 'Other'] },
            quantity: { type: 'number', default: 1, min: 1 },
            unitPrice: { type: 'number', min: 0 },
            tax: { type: 'number', default: 0, min: 0 },
            discount: { type: 'number', default: 0, min: 0 },
            notes: { type: 'string', default: '' },
            linkedGuests: { isArray: true, default: [] },
            linkedDepartments: { isArray: true, default: [] }
        };
        
        const validation = validateAndSetDefaults(req.body, chargeSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        if (!validation.validated.unitPrice) {
            validation.validated.unitPrice = validation.validated.amount;
        }
        
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        const paymaster = await PaymasterRoom.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!paymaster) {
            return res.status(404).json({ message: 'Paymaster room not found.' });
        }
        
        const charge = {
            description: validation.validated.description,
            date: validation.validated.date ? new Date(validation.validated.date) : new Date(),
            amount: validation.validated.amount,
            department: validation.validated.department,
            quantity: validation.validated.quantity || 1,
            unitPrice: validation.validated.unitPrice || validation.validated.amount,
            tax: validation.validated.tax || 0,
            discount: validation.validated.discount || 0,
            notes: validation.validated.notes,
            linkedGuests: validation.validated.linkedGuests || [],
            linkedDepartments: validation.validated.linkedDepartments || []
        };
        
        paymaster.charges.push(charge);
        paymaster.calculateBalance();
        await paymaster.save();
        
        res.status(200).json(paymaster);
    } catch (error) {
        console.error('Error adding charge:', error);
        res.status(500).json({ message: 'Failed to add charge.' });
    }
});

// Add payment to paymaster
router.post('/:id/payments', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid paymaster ID format' });
        }
        
        const paymentSchema = {
            date: { type: 'string', isDate: true, default: () => new Date() },
            method: { type: 'string', default: 'Cash' },
            amount: { type: 'number', required: true, min: 0 },
            transactionId: { type: 'string', default: '' },
            notes: { type: 'string', default: '' }
        };
        
        const validation = validateAndSetDefaults(req.body, paymentSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        const paymaster = await PaymasterRoom.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!paymaster) {
            return res.status(404).json({ message: 'Paymaster room not found.' });
        }
        
        const payment = {
            date: validation.validated.date ? new Date(validation.validated.date) : new Date(),
            method: validation.validated.method,
            amount: validation.validated.amount,
            transactionId: validation.validated.transactionId,
            notes: validation.validated.notes
        };
        
        paymaster.payments.push(payment);
        paymaster.calculateBalance();
        await paymaster.save();
        
        res.status(200).json(paymaster);
    } catch (error) {
        console.error('Error adding payment:', error);
        res.status(500).json({ message: 'Failed to add payment.' });
    }
});

// Send paymaster folio email
router.post('/:id/send-email', async (req, res) => {
    try {
        const { id } = req.params;
        const propertyId = getPropertyId(req);
        const tenant = req.tenant;
        
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid paymaster ID format' });
        }
        
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        const GuestFolio = getModel(req, 'GuestFolio');
        const EmailTemplate = getModel(req, 'EmailTemplate');
        const PropertyDetails = getModel(req, 'PropertyDetails');
        const emailService = require('../../services/emailService');
        
        // Find paymaster
        const paymaster = await PaymasterRoom.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!paymaster) {
            return res.status(404).json({ message: 'Paymaster room not found' });
        }
        
        // Find associated folio
        const folio = await GuestFolio.findOne({
            paymasterId: id,
            property: propertyId,
            status: 'active'
        }).populate('paymasterId');
        
        if (!folio) {
            return res.status(404).json({ message: 'No active folio found for this paymaster' });
        }
        
        // Get email template
        const emailTemplate = await EmailTemplate.findOne({
            template_name: 'paymasterFolioInvoice',
            property: propertyId
        });
        
        if (!emailTemplate) {
            return res.status(404).json({ 
                message: 'Email template "paymasterFolioInvoice" not found. Please add it to the database.' 
            });
        }
        
        // Get recipient email - paymaster folios use guestEmail field
        const recipientEmail = folio.guestEmail || '';
        
        if (!recipientEmail) {
            return res.status(400).json({ 
                message: 'No email address found for this folio. Please add an email address to the folio.' 
            });
        }
        
        // Get property details
        const propertyDetails = await PropertyDetails.findOne({ property: propertyId });
        
        // Prepare replacements
        const replacements = {
            folioId: folio.folioId,
            guestName: folio.guestName,
            paymasterCode: paymaster.paymasterCode || '',
            paymasterName: paymaster.name || folio.guestName,
            accountType: paymaster.accountType || '',
            totalCharges: folio.totalCharges?.toLocaleString('en-IN') || '0',
            totalPayments: folio.totalPayments?.toLocaleString('en-IN') || '0',
            balance: folio.balance?.toLocaleString('en-IN') || '0',
            propertyName: propertyDetails?.name || 'Hotel',
            propertyEmail: propertyDetails?.email || '',
            propertyPhone: propertyDetails?.phone || '',
            propertyAddress: propertyDetails?.address || '',
            gstin: propertyDetails?.gstin || ''
        };
        
        // Build charges table HTML
        let chargesTableHtml = '';
        if (folio.items && folio.items.length > 0) {
            chargesTableHtml = '<table class="charges-table"><thead><tr><th>Date</th><th>Description</th><th>Department</th><th class="amount">Amount</th></tr></thead><tbody>';
            folio.items.forEach(item => {
                const itemAmount = ((item.amount || 0) + (item.tax || 0) - (item.discount || 0)) * (item.quantity || 1);
                chargesTableHtml += `<tr>
                    <td>${item.date ? new Date(item.date).toLocaleDateString('en-GB') : ''}</td>
                    <td>${item.description || ''}</td>
                    <td>${item.department || 'Other'}</td>
                    <td class="amount">₹${itemAmount.toLocaleString('en-IN')}</td>
                </tr>`;
            });
            chargesTableHtml += '</tbody></table>';
        } else {
            chargesTableHtml = '<p style="color: #6b7280; font-style: italic;">No charges available.</p>';
        }
        
        // Replace variables in email content
        let emailContent = emailTemplate.content || '';
        let emailSubject = emailTemplate.subject || `Paymaster Folio Statement - ${paymaster.paymasterCode}`;
        
        // Replace all variables
        Object.keys(replacements).forEach(key => {
            const regex = new RegExp(`{{${key}}}`, 'g');
            emailContent = emailContent.replace(regex, replacements[key]);
            emailSubject = emailSubject.replace(regex, replacements[key]);
        });
        
        // Replace charges table placeholder
        emailContent = emailContent.replace('{{chargesTable}}', chargesTableHtml);
        
        // Send email
        const emailResult = await emailService.sendEmail(
            tenant,
            recipientEmail,
            emailSubject,
            emailContent
        );
        
        if (!emailResult.success) {
            return res.status(500).json({ 
                message: 'Failed to send email', 
                error: emailResult.error 
            });
        }
        
        res.status(200).json({ 
            message: 'Email sent successfully',
            email: recipientEmail
        });
    } catch (error) {
        console.error('Error sending paymaster email:', error);
        res.status(500).json({ message: 'Server error sending email', error: error.message });
    }
});

// Delete paymaster room
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid paymaster ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const PaymasterRoom = getModel(req, 'PaymasterRoom');
        
        const deletedPaymaster = await PaymasterRoom.findOneAndDelete({
            _id: id,
            property: propertyId
        });
        
        if (!deletedPaymaster) {
            return res.status(404).json({ message: 'Paymaster room not found.' });
        }
        
        res.status(200).json({
            message: 'Paymaster room deleted successfully.',
            paymaster: deletedPaymaster
        });
    } catch (error) {
        console.error('Error deleting paymaster room:', error);
        res.status(500).json({ message: 'Failed to delete paymaster room.' });
    }
});

module.exports = router;

