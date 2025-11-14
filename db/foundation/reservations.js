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
    paymentMethod: String,
    Source: String,
    adhaarNumber: String,
    status: String
}, { timestamps: true });

reservations.plugin(propertyScoped);

const Reservations =
    mongoose.models.Reservations || mongoose.model('Reservations', reservations);

module.exports = Reservations;
module.exports.schema = reservations;