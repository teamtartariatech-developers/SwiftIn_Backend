const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const guestProfiles = new mongoose.Schema({
    guestName: { type: String, required: true },
    guestEmail: { type: String },
    guestNumber: { type: String },
    reservationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Reservations',
        required: true
    },
    aadhaarNumber: { type: String },
    adultCount: { type: Number, default: 1, min: 0 },
    childCount: { type: Number, default: 0, min: 0 },
    totalVisits: { type: Number, default: 1 },
    totalSpend: { type: Number, default: 0 },
    guestType: { type: String, enum: ['regular', 'vip', 'family', 'corporate', 'couple', 'other', 'friends'], default: 'regular' },
    records : [{
        checkInDate: { type: Date, required: true },
        checkOutDate: { type: Date, required: true },
        amount: { type: Number, required: true },
    }],
    AverageStay: { type: Number, default: 0 }
}, { timestamps: true });

guestProfiles.plugin(propertyScoped);
guestProfiles.index(
    { guestEmail: 1, property: 1 },
    { unique: true, partialFilterExpression: { guestEmail: { $exists: true, $nin: [null, ''] } } }
);
guestProfiles.index({ reservationId: 1, property: 1 });

const GuestProfilesModel =
    mongoose.models.GuestProfiles || mongoose.model('GuestProfiles', guestProfiles);

module.exports = GuestProfilesModel;
module.exports.schema = guestProfiles;