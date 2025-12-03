const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, validatePagination, isValidObjectId } = require('../../utils/validation');

const router = express.Router();
router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('billing-finance'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Get all city ledger accounts
router.get('/accounts', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        let query = { property: propertyId };
        
        if (search) {
            query.$or = [
                { accountName: { $regex: search, $options: 'i' } },
                { accountCode: { $regex: search, $options: 'i' } },
                { contactPerson: { $regex: search, $options: 'i' } }
            ];
        }
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await CityLedgerAccount.countDocuments(query);
        
        const accounts = await CityLedgerAccount.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        
        // Calculate balances for each account
        accounts.forEach(account => account.calculateBalance());
        
        res.status(200).json({
            accounts,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / parseInt(limit)),
                totalItems: total,
                itemsPerPage: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Error fetching city ledger accounts:', error);
        res.status(500).json({ message: 'Failed to fetch city ledger accounts.' });
    }
});

// Create city ledger account
router.post('/accounts', async (req, res) => {
    try {
        const accountSchema = {
            accountName: { type: 'string', required: true },
            accountType: { type: 'string', required: true, enum: ['corporate', 'travel-agent', 'ota', 'other'] },
            contactPerson: { type: 'string', default: '' },
            email: { type: 'string', default: '' },
            phone: { type: 'string', default: '' },
            address: { type: 'string', default: '' },
            creditLimit: { type: 'number', default: 0, min: 0 },
            paymentTerms: { type: 'number', default: 30, min: 1 },
            remarks: { type: 'string', default: '' }
        };
        
        const validation = validateAndSetDefaults(req.body, accountSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const accountCode = await CityLedgerAccount.generateAccountCode(propertyId, validation.validated.accountType);
        
        const account = new CityLedgerAccount({
            ...validation.validated,
            accountCode,
            property: propertyId
        });
        
        await account.save();
        
        res.status(201).json(account);
    } catch (error) {
        console.error('Error creating city ledger account:', error);
        res.status(500).json({ message: 'Failed to create city ledger account.' });
    }
});

// Get single account
router.get('/accounts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const account = await CityLedgerAccount.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!account) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        account.calculateBalance();
        await account.save();
        
        res.status(200).json(account);
    } catch (error) {
        console.error('Error fetching account:', error);
        res.status(500).json({ message: 'Failed to fetch account.' });
    }
});

// Update account
router.put('/accounts/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const updateSchema = {
            accountName: { type: 'string' },
            contactPerson: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            address: { type: 'string' },
            creditLimit: { type: 'number', min: 0 },
            paymentTerms: { type: 'number', min: 1 },
            remarks: { type: 'string' },
            isActive: { type: 'boolean' }
        };
        
        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const account = await CityLedgerAccount.findOneAndUpdate(
            { _id: id, property: propertyId },
            validation.validated,
            { new: true }
        );
        
        if (!account) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        res.status(200).json(account);
    } catch (error) {
        console.error('Error updating account:', error);
        res.status(500).json({ message: 'Failed to update account.' });
    }
});

// Create invoice for account (from checkout)
router.post('/accounts/:id/invoices', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const invoiceSchema = {
            folioId: { type: 'string', default: '' },
            reservationId: { type: 'string', isObjectId: true },
            guestName: { type: 'string', required: true },
            amount: { type: 'number', required: true, min: 0 },
            dueDate: { type: 'string', isDate: true },
            description: { type: 'string', default: '' }
        };
        
        const validation = validateAndSetDefaults(req.body, invoiceSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const account = await CityLedgerAccount.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!account) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        const invoiceNumber = await CityLedgerAccount.generateInvoiceNumber(propertyId);
        
        // Calculate due date based on payment terms (default to 30 days if not set)
        const paymentTermsDays = account.paymentTerms || 30;
        const dueDate = validation.validated.dueDate 
            ? new Date(validation.validated.dueDate) 
            : new Date(Date.now() + paymentTermsDays * 24 * 60 * 60 * 1000);
        
        const invoice = {
            invoiceNumber,
            folioId: validation.validated.folioId,
            reservationId: validation.validated.reservationId,
            guestName: validation.validated.guestName,
            amount: validation.validated.amount,
            issueDate: new Date(),
            dueDate: dueDate,
            status: 'pending',
            description: validation.validated.description
        };
        
        account.invoices.push(invoice);
        account.calculateBalance();
        await account.save();
        
        res.status(201).json({ invoice, account });
    } catch (error) {
        console.error('Error creating invoice:', error);
        res.status(500).json({ message: 'Failed to create invoice.' });
    }
});

// Add charge to account
router.post('/accounts/:id/charges', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const chargeSchema = {
            description: { type: 'string', required: true },
            date: { type: 'string', isDate: true },
            amount: { type: 'number', required: true, min: 0 },
            department: { type: 'string', default: 'Other' },
            quantity: { type: 'number', default: 1, min: 1 },
            unitPrice: { type: 'number', default: 0, min: 0 },
            tax: { type: 'number', default: 0, min: 0 },
            discount: { type: 'number', default: 0, min: 0 },
            notes: { type: 'string', default: '' }
        };
        
        const validation = validateAndSetDefaults(req.body, chargeSchema);
        if (!validation.isValid) {
            console.error('Validation errors:', validation.errors);
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const account = await CityLedgerAccount.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!account) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        const charge = {
            description: validation.validated.description,
            date: validation.validated.date ? new Date(validation.validated.date) : new Date(),
            amount: Number(validation.validated.amount),
            department: validation.validated.department,
            quantity: Number(validation.validated.quantity) || 1,
            unitPrice: Number(validation.validated.unitPrice) || Number(validation.validated.amount),
            tax: Number(validation.validated.tax) || 0,
            discount: Number(validation.validated.discount) || 0,
            notes: validation.validated.notes || ''
        };
        
        // Validate charge amount
        if (isNaN(charge.amount) || charge.amount < 0) {
            return res.status(400).json({ message: 'Invalid amount. Amount must be a positive number.' });
        }
        
        // Initialize charges array if it doesn't exist
        if (!account.charges) {
            account.charges = [];
        }
        
        account.charges.push(charge);
        account.calculateBalance();
        await account.save();
        
        res.status(201).json({ charge, account });
    } catch (error) {
        console.error('Error adding charge:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ message: error.message || 'Failed to add charge.', error: error.toString() });
    }
});

// Record payment for account
router.post('/accounts/:id/payments', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const paymentSchema = {
            date: { type: 'string', isDate: true },
            amount: { type: 'number', required: true, min: 0 },
            method: { type: 'string', default: 'Bank Transfer' },
            transactionId: { type: 'string', default: '' },
            referenceNumber: { type: 'string', default: '' },
            notes: { type: 'string', default: '' },
            appliedToInvoices: { isArray: true, default: [] }
        };
        
        const validation = validateAndSetDefaults(req.body, paymentSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const account = await CityLedgerAccount.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!account) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        const payment = {
            date: validation.validated.date ? new Date(validation.validated.date) : new Date(),
            amount: validation.validated.amount,
            method: validation.validated.method,
            transactionId: validation.validated.transactionId,
            referenceNumber: validation.validated.referenceNumber,
            notes: validation.validated.notes,
            appliedToInvoices: validation.validated.appliedToInvoices || []
        };
        
        account.payments.push(payment);
        
        // Update invoice statuses if payments are applied
        if (payment.appliedToInvoices && payment.appliedToInvoices.length > 0) {
            payment.appliedToInvoices.forEach(({ invoiceId, amount }) => {
                const invoice = account.invoices.id(invoiceId);
                if (invoice) {
                    const paidAmount = (invoice.paidAmount || 0) + amount;
                    if (paidAmount >= invoice.amount) {
                        invoice.status = 'paid';
                    }
                }
            });
        }
        
        account.calculateBalance();
        await account.save();
        
        res.status(201).json({ payment, account });
    } catch (error) {
        console.error('Error recording payment:', error);
        res.status(500).json({ message: 'Failed to record payment.' });
    }
});

// Checkout account - Create invoice and send emails
router.post('/accounts/:id/checkout', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        const EmailTemplate = getModel(req, 'EmailTemplate');
        const ScheduledEmail = getModel(req, 'ScheduledEmail');
        const PropertyDetails = getModel(req, 'PropertyDetails');
        
        const account = await CityLedgerAccount.findOne({
            _id: id,
            property: propertyId
        });
        
        if (!account) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        
        // Calculate balance
        account.calculateBalance();
        
        // Check if balance is settled
        const balanceThreshold = 0.01;
        if (account.outstandingBalance > balanceThreshold) {
            return res.status(400).json({ 
                message: `Cannot checkout with outstanding balance of ₹${account.outstandingBalance.toFixed(2)}. Please settle the balance first.` 
            });
        }
        
        // Calculate total charges
        let totalCharges = 0;
        if (account.charges && account.charges.length > 0) {
            totalCharges = account.charges.reduce((sum, charge) => {
                return sum + charge.amount + (charge.tax || 0) - (charge.discount || 0);
            }, 0);
        }
        
        if (totalCharges === 0) {
            return res.status(400).json({ message: 'No charges to invoice.' });
        }
        
        // Generate invoice number
        const invoiceNumber = await CityLedgerAccount.generateInvoiceNumber(propertyId);
        
        // Calculate due date based on payment terms
        const paymentTermsDays = account.paymentTerms || 30;
        const issueDate = new Date();
        const dueDate = new Date(Date.now() + paymentTermsDays * 24 * 60 * 60 * 1000);
        
        // Create invoice
        const invoice = {
            invoiceNumber,
            amount: totalCharges,
            issueDate: issueDate,
            dueDate: dueDate,
            status: 'pending',
            description: `Invoice for ${account.accountName} - Account ${account.accountCode}`
        };
        
        account.invoices.push(invoice);
        await account.save();
        
        // Get the saved invoice ID
        const savedInvoice = account.invoices[account.invoices.length - 1];
        const invoiceId = savedInvoice._id;
        
        // Get property details for email
        const propertyDetails = await PropertyDetails.findOne({ property: propertyId });
        
        // Get email template
        const emailTemplate = await EmailTemplate.findOne({
            template_name: 'cityLedgerInvoice',
            property: propertyId
        });
        
        if (!emailTemplate) {
            console.warn('City Ledger invoice email template not found. Email will not be sent.');
        } else if (account.email) {
            // Prepare email content
            const emailService = require('../../services/emailService');
            const tenant = req.tenant;
            
            // Replace variables in email template
            let emailContent = emailTemplate.content || '';
            let emailSubject = emailTemplate.subject || 'Invoice - {{accountName}}';
            
            // Replace variables
            const replacements = {
                accountName: account.accountName,
                accountCode: account.accountCode,
                contactPerson: account.contactPerson || 'Valued Customer',
                invoiceNumber: invoiceNumber,
                issueDate: issueDate.toLocaleDateString('en-GB'),
                dueDate: dueDate.toLocaleDateString('en-GB'),
                totalAmount: totalCharges.toLocaleString('en-IN'),
                paymentTerms: paymentTermsDays,
                propertyName: propertyDetails?.name || 'Hotel',
                propertyEmail: propertyDetails?.email || '',
                propertyPhone: propertyDetails?.phone || '',
                propertyAddress: propertyDetails?.address || '',
                gstin: propertyDetails?.gstin || '',
                currency: 'INR'
            };
            
            // Replace all variables
            Object.keys(replacements).forEach(key => {
                const regex = new RegExp(`{{${key}}}`, 'g');
                emailContent = emailContent.replace(regex, replacements[key]);
                emailSubject = emailSubject.replace(regex, replacements[key]);
            });
            
            // Build charges table HTML
            let chargesTableHtml = '';
            if (account.charges && account.charges.length > 0) {
                chargesTableHtml = '<table class="charges-table"><thead><tr><th>Date</th><th>Description</th><th class="amount">Amount</th></tr></thead><tbody>';
                account.charges.forEach(charge => {
                    const chargeAmount = charge.amount + (charge.tax || 0) - (charge.discount || 0);
                    chargesTableHtml += `<tr><td>${new Date(charge.date).toLocaleDateString('en-GB')}</td><td>${charge.description}</td><td class="amount">₹${chargeAmount.toLocaleString('en-IN')}</td></tr>`;
                });
                chargesTableHtml += '</tbody></table>';
            } else {
                chargesTableHtml = '<p style="color: #6b7280; font-style: italic;">No charges available.</p>';
            }
            
            // Replace charges table placeholder
            emailContent = emailContent.replace('{{chargesTable}}', chargesTableHtml);
            
            // Send immediate email
            try {
                await emailService.sendEmail(
                    tenant,
                    account.email,
                    emailSubject,
                    emailContent
                );
                console.log(`Invoice email sent immediately to ${account.email}`);
            } catch (emailError) {
                console.error('Error sending immediate invoice email:', emailError);
            }
            
            // Schedule reminder email after payment terms days
            if (ScheduledEmail) {
                const scheduledDate = new Date(Date.now() + paymentTermsDays * 24 * 60 * 60 * 1000);
                await ScheduledEmail.create({
                    type: 'city-ledger-reminder',
                    targetId: account._id,
                    invoiceId: invoiceId,
                    recipientEmail: account.email,
                    subject: `Payment Reminder - Invoice ${invoiceNumber}`,
                    content: emailContent,
                    scheduledAt: scheduledDate,
                    status: 'pending',
                    property: propertyId,
                    metadata: {
                        invoiceNumber,
                        amount: totalCharges,
                        paymentTerms: paymentTermsDays
                    }
                });
                console.log(`Reminder email scheduled for ${scheduledDate.toISOString()}`);
            }
        }
        
        res.status(200).json({ 
            message: 'Checkout successful. Invoice created and email sent.',
            invoice,
            account
        });
    } catch (error) {
        console.error('Error during checkout:', error);
        res.status(500).json({ message: 'Failed to checkout account.' });
    }
});

// Get outstanding summary
router.get('/outstanding', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const CityLedgerAccount = getModel(req, 'CityLedgerAccount');
        
        const accounts = await CityLedgerAccount.find({
            property: propertyId,
            isActive: true
        });
        
        let totalOutstanding = 0;
        let totalInvoiced = 0;
        let totalPaid = 0;
        
        accounts.forEach(account => {
            account.calculateBalance();
            totalOutstanding += account.outstandingBalance;
            totalInvoiced += account.totalInvoiced;
            totalPaid += account.totalPaid;
        });
        
        res.status(200).json({
            totalOutstanding,
            totalInvoiced,
            totalPaid,
            accountCount: accounts.length
        });
    } catch (error) {
        console.error('Error fetching outstanding summary:', error);
        res.status(500).json({ message: 'Failed to fetch outstanding summary.' });
    }
});

module.exports = router;

