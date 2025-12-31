const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const reservations = new mongoose.Schema({
    guestName: String,
    guestNumber: String,
    guestEmail: String,
    checkInDate: Date,
    checkOutDate: Date,
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: true
    },
    roomNumbers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rooms',
        required: true
    }],
    numberOfRooms: Number,
    totalGuest: Number,
    totalAmount: Number,
    payedAmount: Number,
    mealPlan: {
        type: String,
        enum: ['EP', 'CP', 'MAP', 'AP'],
        default: 'EP'
    },
    mealPlanAmount: { type: Number, default: 0 },
    mealPlanRate: { type: Number, default: 0 },
    mealPlanGuestCount: { type: Number, default: 0 },
    mealPlanNights: { type: Number, default: 0 },
    mealPreferences: {
        veg: { type: Number, default: 0 },
        nonVeg: { type: Number, default: 0 },
        jain: { type: Number, default: 0 }
    },
    paymentMethod: String,
    Source: String,
    adhaarNumber: String,
    status: String,
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'GroupReservation'
    },
    travelAgentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'TravelAgent'
    },
    billToCityLedger: {
        type: Boolean,
        default: false
    },
    cityLedgerAccountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CityLedgerAccount'
    },
    notes: [{
        content: {
            type: String,
            required: true
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }]
}, { timestamps: true });

reservations.plugin(propertyScoped);

const Reservations =
    mongoose.models.Reservations || mongoose.model('Reservations', reservations);

module.exports = Reservations;
module.exports.schema = reservations;