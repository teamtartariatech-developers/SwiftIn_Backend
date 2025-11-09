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