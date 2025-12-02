const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const roomBlockSchema = new mongoose.Schema({
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: true
    },
    numberOfRooms: {
        type: Number,
        required: true,
        min: 1
    },
    assignedRooms: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rooms'
    }],
    availableRooms: {
        type: Number,
        default: 0
    }
}, { _id: true });

const groupReservationSchema = new mongoose.Schema({
    groupCode: {
        type: String,
        required: true,
        unique: true
    },
    groupName: {
        type: String,
        required: true
    },
    contactPerson: {
        type: String,
        required: true
    },
    contactEmail: String,
    contactPhone: String,
    checkInDate: {
        type: Date,
        required: true
    },
    checkOutDate: {
        type: Date,
        required: true
    },
    roomBlocks: [roomBlockSchema],
    totalRooms: {
        type: Number,
        default: 0
    },
    assignedRooms: {
        type: Number,
        default: 0
    },
    reservations: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations'
    }],
    paymentMode: {
        type: String,
        enum: ['entire-bill', 'partial-bill', 'individual-bills'],
        default: 'individual-bills'
    },
    totalAmount: {
        type: Number,
        default: 0
    },
    discountType: {
        type: String,
        enum: ['percent', 'amount'],
        default: 'percent'
    },
    discountValue: {
        type: Number,
        default: 0,
        min: 0
    },
    discountAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    paidAmount: {
        type: Number,
        default: 0
    },
    balance: {
        type: Number,
        default: 0
    },
    groupFolio: {
        totalCharges: { type: Number, default: 0 },
        totalPayments: { type: Number, default: 0 },
        balance: { type: Number, default: 0 },
        items: [{
            description: String,
            date: Date,
            amount: Number,
            department: String,
            reservationId: mongoose.Schema.Types.ObjectId
        }],
        payments: [{
            date: Date,
            method: String,
            amount: Number,
            transactionId: String,
            notes: String
        }]
    },
    status: {
        type: String,
        enum: ['confirmed', 'checked-in', 'checked-out', 'cancelled'],
        default: 'confirmed'
    },
    notes: String
}, { timestamps: true });

groupReservationSchema.plugin(propertyScoped);
groupReservationSchema.index({ groupCode: 1, property: 1 }, { unique: true });
groupReservationSchema.index({ groupName: 1, property: 1 });

// Method to calculate group totals
groupReservationSchema.methods.calculateTotals = function() {
    this.totalRooms = this.roomBlocks.reduce((sum, block) => sum + block.numberOfRooms, 0);
    this.assignedRooms = this.roomBlocks.reduce((sum, block) => sum + block.assignedRooms.length, 0);
    
    // Calculate available rooms
    this.roomBlocks.forEach(block => {
        block.availableRooms = block.numberOfRooms - block.assignedRooms.length;
    });
    
    return {
        totalRooms: this.totalRooms,
        assignedRooms: this.assignedRooms,
        availableRooms: this.totalRooms - this.assignedRooms
    };
};

// Generate unique group code
groupReservationSchema.statics.generateGroupCode = async function(propertyId) {
    const prefix = 'GRP';
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    
    const filter = {
        groupCode: new RegExp(`^${prefix}${year}${month}`),
    };
    
    if (propertyId) {
        filter.property = propertyId;
    }
    
    const lastGroup = await this.findOne(filter).sort({ groupCode: -1 });
    
    if (lastGroup) {
        const lastSuffix = parseInt(lastGroup.groupCode.slice(-3)) || 0;
        const newSuffix = String(lastSuffix + 1).padStart(3, '0');
        return `${prefix}${year}${month}${newSuffix}`;
    }
    
    return `${prefix}${year}${month}001`;
};

const GroupReservation = mongoose.models.GroupReservation || mongoose.model('GroupReservation', groupReservationSchema);

module.exports = GroupReservation;
module.exports.schema = groupReservationSchema;

