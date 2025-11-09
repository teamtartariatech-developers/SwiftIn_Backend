const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const billItemSchema = new mongoose.Schema({
    description: String,
    date: Date,
    amount: Number,
    department: {
        type: String,
        enum: ['Room', 'F&B', 'Spa', 'Laundry', 'Other']
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
    notes: String
}, { _id: true });

const billPaymentSchema = new mongoose.Schema({
    date: Date,
    method: {
        type: String,
        enum: ['Cash', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Wallet', 'Cheque']
    },
    amount: Number,
    transactionId: String,
    notes: String
}, { _id: true });

const billSchema = new mongoose.Schema({
    billId: {
        type: String,
        unique: true,
        required: true
    },
    folioId: {
        type: String,
        required: true
    },
    reservationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations',
        required: true
    },
    guestName: {
        type: String,
        required: true
    },
    guestEmail: String,
    guestPhone: String,
    roomNumber: String,
    roomNumbers: [String],
    checkIn: {
        type: Date,
        required: true
    },
    checkOut: {
        type: Date,
        required: true
    },
    items: [billItemSchema],
    payments: [billPaymentSchema],
    totalCharges: {
        type: Number,
        default: 0
    },
    totalPayments: {
        type: Number,
        default: 0
    },
    finalBalance: {
        type: Number,
        default: 0
    },
    checkoutDate: {
        type: Date,
        default: Date.now
    },
    archivedAt: {
        type: Date,
        default: Date.now
    }
});

billSchema.plugin(propertyScoped);
billSchema.index({ billId: 1, property: 1 }, { unique: true });

// Generate unique bill ID
billSchema.statics.generateBillId = async function(propertyId) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    // Find the last bill created today
    const filter = {
        billId: new RegExp(`^B${year}${month}${day}`),
    };

    if (propertyId) {
        filter.property = propertyId;
    }

    const lastBill = await this.findOne(filter).sort({ billId: -1 });
    
    if (lastBill) {
        const lastSuffix = parseInt(lastBill.billId.slice(-3)) || 0;
        const newSuffix = String(lastSuffix + 1).padStart(3, '0');
        return `B${year}${month}${day}${newSuffix}`;
    }
    
    return `B${year}${month}${day}001`;
};

const BillModel = mongoose.models.Bill || mongoose.model('Bill', billSchema);

module.exports = BillModel;
module.exports.schema = billSchema;

