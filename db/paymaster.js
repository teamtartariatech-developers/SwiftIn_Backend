const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const paymasterChargeSchema = new mongoose.Schema({
    description: String,
    date: Date,
    amount: Number,
    department: {
        type: String,
        enum: ['Room', 'F&B', 'Spa', 'Laundry', 'Event', 'Package', 'Other']
    },
    quantity: {
        type: Number,
        default: 1
    },
    unitPrice: Number,
    tax: {
        type: Number,
        default: 0
    },
    discount: {
        type: Number,
        default: 0
    },
    notes: String,
    linkedGuests: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations'
    }],
    linkedDepartments: [String]
}, { _id: true });

const paymasterPaymentSchema = new mongoose.Schema({
    date: Date,
    method: {
        type: String,
        enum: ['Cash', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Wallet', 'Cheque']
    },
    amount: Number,
    transactionId: String,
    notes: String
}, { _id: true });

const paymasterRoomSchema = new mongoose.Schema({
    paymasterCode: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    description: String,
    accountType: {
        type: String,
        enum: ['internal', 'f&b', 'event', 'package', 'miscellaneous'],
        default: 'internal'
    },
    linkedGuests: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations'
    }],
    linkedDepartments: [String],
    charges: [paymasterChargeSchema],
    payments: [paymasterPaymentSchema],
    totalCharges: {
        type: Number,
        default: 0
    },
    totalPayments: {
        type: Number,
        default: 0
    },
    balance: {
        type: Number,
        default: 0
    },
    status: {
        type: String,
        enum: ['open', 'closed'],
        default: 'open'
    },
    invoiceGenerated: {
        type: Boolean,
        default: false
    },
    invoiceNumber: String
}, { timestamps: true });

paymasterRoomSchema.plugin(propertyScoped);
paymasterRoomSchema.index({ paymasterCode: 1, property: 1 }, { unique: true });

// Method to calculate balance
paymasterRoomSchema.methods.calculateBalance = function() {
    this.totalCharges = this.charges.reduce((sum, charge) => {
        const itemTotal = (charge.amount + (charge.tax || 0) - (charge.discount || 0)) * (charge.quantity || 1);
        return sum + itemTotal;
    }, 0);
    
    this.totalPayments = this.payments.reduce((sum, payment) => sum + payment.amount, 0);
    this.balance = this.totalCharges - this.totalPayments;
    this.updatedAt = new Date();
    return this.balance;
};

// Generate unique paymaster code (PM001, PM002, etc.)
paymasterRoomSchema.statics.generatePaymasterCode = async function(propertyId) {
    const prefix = 'PM';
    
    const filter = {
        paymasterCode: new RegExp(`^${prefix}\\d+$`),
    };
    
    if (propertyId) {
        filter.property = propertyId;
    }
    
    const lastPaymaster = await this.findOne(filter).sort({ paymasterCode: -1 });
    
    if (lastPaymaster) {
        const lastNumber = parseInt(lastPaymaster.paymasterCode.replace(prefix, '')) || 0;
        const newNumber = lastNumber + 1;
        return `${prefix}${String(newNumber).padStart(3, '0')}`;
    }
    
    return `${prefix}001`;
};

const PaymasterRoom = mongoose.models.PaymasterRoom || mongoose.model('PaymasterRoom', paymasterRoomSchema);

module.exports = PaymasterRoom;
module.exports.schema = paymasterRoomSchema;

