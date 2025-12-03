const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const cityLedgerInvoiceSchema = new mongoose.Schema({
    invoiceNumber: {
        type: String,
        required: true
    },
    folioId: String,
    reservationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations'
    },
    guestName: String,
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    issueDate: {
        type: Date,
        default: Date.now
    },
    dueDate: Date,
    status: {
        type: String,
        enum: ['pending', 'paid', 'overdue', 'cancelled'],
        default: 'pending'
    },
    description: String
}, { _id: true });

const cityLedgerPaymentSchema = new mongoose.Schema({
    date: {
        type: Date,
        default: Date.now
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    method: {
        type: String,
        enum: ['Cash', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Cheque'],
        default: 'Bank Transfer'
    },
    transactionId: String,
    referenceNumber: String,
    notes: String,
    appliedToInvoices: [{
        invoiceId: mongoose.Schema.Types.ObjectId,
        amount: Number
    }]
}, { _id: true });

const cityLedgerChargeSchema = new mongoose.Schema({
    description: {
        type: String,
        required: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    department: {
        type: String,
        enum: ['Room', 'F&B', 'Spa', 'Laundry', 'Other'],
        default: 'Other'
    },
    quantity: {
        type: Number,
        default: 1,
        min: 1
    },
    unitPrice: {
        type: Number,
        default: 0,
        min: 0
    },
    tax: {
        type: Number,
        default: 0,
        min: 0
    },
    discount: {
        type: Number,
        default: 0,
        min: 0
    },
    notes: String
}, { _id: true });

const cityLedgerAccountSchema = new mongoose.Schema({
    accountCode: {
        type: String,
        required: true,
        unique: true
    },
    accountName: {
        type: String,
        required: true
    },
    accountType: {
        type: String,
        enum: ['corporate', 'travel-agent', 'ota', 'other'],
        required: true
    },
    contactPerson: String,
    email: String,
    phone: String,
    address: String,
    creditLimit: {
        type: Number,
        default: 0,
        min: 0
    },
    paymentTerms: {
        type: Number,
        default: 30,
        min: 1
    },
    charges: [cityLedgerChargeSchema],
    invoices: [cityLedgerInvoiceSchema],
    payments: [cityLedgerPaymentSchema],
    outstandingBalance: {
        type: Number,
        default: 0
    },
    totalInvoiced: {
        type: Number,
        default: 0
    },
    totalPaid: {
        type: Number,
        default: 0
    },
    remarks: String,
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

cityLedgerAccountSchema.plugin(propertyScoped);
cityLedgerAccountSchema.index({ accountCode: 1, property: 1 }, { unique: true });
cityLedgerAccountSchema.index({ accountName: 1, property: 1 });

// Method to calculate outstanding balance
cityLedgerAccountSchema.methods.calculateBalance = function() {
    // Calculate from charges if available, otherwise from invoices
    let totalCharges = 0;
    if (this.charges && this.charges.length > 0) {
        totalCharges = this.charges.reduce((sum, charge) => {
            return sum + charge.amount + (charge.tax || 0) - (charge.discount || 0);
        }, 0);
    } else {
        totalCharges = this.invoices
            .filter(inv => inv.status !== 'cancelled')
            .reduce((sum, inv) => sum + inv.amount, 0);
    }
    
    const totalPaid = this.payments.reduce((sum, pay) => sum + pay.amount, 0);
    
    this.totalInvoiced = totalCharges;
    this.totalPaid = totalPaid;
    this.outstandingBalance = totalCharges - totalPaid;
    
    return this.outstandingBalance;
};

// Generate unique account code
cityLedgerAccountSchema.statics.generateAccountCode = async function(propertyId, accountType) {
    const prefix = accountType === 'corporate' ? 'CORP' : 
                   accountType === 'travel-agent' ? 'TA' : 
                   accountType === 'ota' ? 'OTA' : 'CL';
    
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    
    const filter = {
        accountCode: new RegExp(`^${prefix}${year}`),
    };
    
    if (propertyId) {
        filter.property = propertyId;
    }
    
    const lastAccount = await this.findOne(filter).sort({ accountCode: -1 });
    
    if (lastAccount) {
        const lastSuffix = parseInt(lastAccount.accountCode.slice(-4)) || 0;
        const newSuffix = String(lastSuffix + 1).padStart(4, '0');
        return `${prefix}${year}${newSuffix}`;
    }
    
    return `${prefix}${year}0001`;
};

// Generate unique invoice number
cityLedgerAccountSchema.statics.generateInvoiceNumber = async function(propertyId) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    
    const filter = {
        'invoices.invoiceNumber': new RegExp(`^INV${year}${month}`),
    };
    
    if (propertyId) {
        filter.property = propertyId;
    }
    
    const account = await this.findOne(filter).sort({ 'invoices.invoiceNumber': -1 });
    
    if (account && account.invoices.length > 0) {
        const lastInvoice = account.invoices.sort((a, b) => 
            b.invoiceNumber.localeCompare(a.invoiceNumber)
        )[0];
        const lastSuffix = parseInt(lastInvoice.invoiceNumber.slice(-4)) || 0;
        const newSuffix = String(lastSuffix + 1).padStart(4, '0');
        return `INV${year}${month}${newSuffix}`;
    }
    
    return `INV${year}${month}0001`;
};

const CityLedgerAccount = mongoose.models.CityLedgerAccount || mongoose.model('CityLedgerAccount', cityLedgerAccountSchema);

module.exports = CityLedgerAccount;
module.exports.schema = cityLedgerAccountSchema;

