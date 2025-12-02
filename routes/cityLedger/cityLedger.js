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
            paymentTerms: { type: 'string', default: 'Net 30' },
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
            paymentTerms: { type: 'string' },
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
        
        const invoice = {
            invoiceNumber,
            folioId: validation.validated.folioId,
            reservationId: validation.validated.reservationId,
            guestName: validation.validated.guestName,
            amount: validation.validated.amount,
            issueDate: new Date(),
            dueDate: validation.validated.dueDate ? new Date(validation.validated.dueDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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

// Record payment for account
router.post('/accounts/:id/payments', async (req, res) => {
    try {
        const { id } = req.params;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid account ID format' });
        }
        
        const paymentSchema = {
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
            date: new Date(),
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

