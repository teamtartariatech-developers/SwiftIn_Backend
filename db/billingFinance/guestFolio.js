const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const folioItemSchema = new mongoose.Schema({
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

const paymentSchema = new mongoose.Schema({
    date: Date,
    method: {
        type: String,
        enum: ['Cash', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Wallet', 'Cheque']
    },
    amount: Number,
    transactionId: String,
    notes: String
}, { _id: true });

const guestFolioSchema = new mongoose.Schema({
    folioId: {
        type: String,
        unique: true,
        required: true
    },
    reservationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations',
        required: false // Optional for paymaster folios
    },
    paymasterId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PaymasterRoom',
        required: false // Optional for guest folios
    },
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GroupReservation',
        required: false // Optional for group folios
    },
    guestName: {
        type: String,
        required: true
    },
    guestEmail: String,
    guestPhone: String,
    roomNumber: String,
    roomNumbers: [String], // Array of room numbers
    checkIn: {
        type: Date,
        required: true
    },
    checkOut: {
        type: Date,
        required: true
    },
    items: [folioItemSchema],
    payments: [paymentSchema],
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
        enum: ['active', 'settled', 'archived'],
        default: 'active'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

guestFolioSchema.plugin(propertyScoped);
guestFolioSchema.index({ folioId: 1, property: 1 }, { unique: true });

// Update balance when items or payments change
guestFolioSchema.methods.calculateBalance = function() {
    this.totalCharges = this.items.reduce((sum, item) => {
        const itemTotal = (item.amount + (item.tax || 0) - (item.discount || 0)) * (item.quantity || 1);
        return sum + itemTotal;
    }, 0);
    
    this.totalPayments = this.payments.reduce((sum, payment) => sum + payment.amount, 0);
    this.balance = this.totalCharges - this.totalPayments;
    this.updatedAt = new Date();
    return this.balance;
};

// Generate unique folio ID
guestFolioSchema.statics.generateFolioId = async function(propertyId) {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    // Find the last folio created today
    const filter = {
        folioId: new RegExp(`^F${year}${month}${day}`),
    };

    if (propertyId) {
        filter.property = propertyId;
    }

    const lastFolio = await this.findOne(filter).sort({ folioId: -1 });
    
    if (lastFolio) {
        const lastSuffix = parseInt(lastFolio.folioId.slice(-3)) || 0;
        const newSuffix = String(lastSuffix + 1).padStart(3, '0');
        return `F${year}${month}${day}${newSuffix}`;
    }
    
    return `F${year}${month}${day}001`;
};

const GuestFolioModel =
    mongoose.models.GuestFolio || mongoose.model('GuestFolio', guestFolioSchema);

module.exports = GuestFolioModel;
module.exports.schema = guestFolioSchema;

