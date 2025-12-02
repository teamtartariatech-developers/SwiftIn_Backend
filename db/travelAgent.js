const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const commissionPaymentSchema = new mongoose.Schema({
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
    appliedToBookings: [{
        reservationId: mongoose.Schema.Types.ObjectId,
        amount: Number
    }]
}, { _id: true });

const travelAgentSchema = new mongoose.Schema({
    agentCode: {
        type: String,
        required: true,
        unique: true
    },
    companyName: {
        type: String,
        required: true
    },
    contactPerson: String,
    email: String,
    phone: String,
    address: String,
    commissionRate: {
        type: Number,
        required: true,
        min: 0,
        max: 100,
        default: 10
    },
    commissionType: {
        type: String,
        enum: ['percentage', 'fixed'],
        default: 'percentage'
    },
    paymentMode: {
        type: String,
        enum: ['post-paid', 'pre-paid', 'monthly'],
        default: 'post-paid'
    },
    paymentTerms: {
        type: String,
        default: 'Net 30'
    },
    totalBookings: {
        type: Number,
        default: 0
    },
    totalRevenue: {
        type: Number,
        default: 0
    },
    totalCommission: {
        type: Number,
        default: 0
    },
    totalPaid: {
        type: Number,
        default: 0
    },
    outstandingCommission: {
        type: Number,
        default: 0
    },
    commissionPayments: [commissionPaymentSchema],
    remarks: String,
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

travelAgentSchema.plugin(propertyScoped);
travelAgentSchema.index({ agentCode: 1, property: 1 }, { unique: true });
travelAgentSchema.index({ companyName: 1, property: 1 });

// Method to calculate outstanding commission
travelAgentSchema.methods.calculateCommission = function() {
    const totalPaid = this.commissionPayments.reduce((sum, pay) => sum + pay.amount, 0);
    this.totalPaid = totalPaid;
    this.outstandingCommission = this.totalCommission - totalPaid;
    return this.outstandingCommission;
};

// Generate unique agent code
travelAgentSchema.statics.generateAgentCode = async function(propertyId) {
    const prefix = 'TA';
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    
    const filter = {
        agentCode: new RegExp(`^${prefix}${year}`),
    };
    
    if (propertyId) {
        filter.property = propertyId;
    }
    
    const lastAgent = await this.findOne(filter).sort({ agentCode: -1 });
    
    if (lastAgent) {
        const lastSuffix = parseInt(lastAgent.agentCode.slice(-4)) || 0;
        const newSuffix = String(lastSuffix + 1).padStart(4, '0');
        return `${prefix}${year}${newSuffix}`;
    }
    
    return `${prefix}${year}0001`;
};

const TravelAgent = mongoose.models.TravelAgent || mongoose.model('TravelAgent', travelAgentSchema);

module.exports = TravelAgent;
module.exports.schema = travelAgentSchema;

