const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');
const dailyRateSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType', // Link to your RoomType model
        required: true
    },
    baseRate: {
        type: Number,
        required: false,
        default: 0,
        min: 0
    },
    extraGuestRate: {
        type: Number,
        required: false,
        default: 0,
        min: 0
    },
    adultRate: {
        type: Number,
        required: false,
        default: 0,
        min: 0 
    },
    childRate: {
        type: Number,
        required: false, 
        default: 0,     
        min: 0
    }
}, { timestamps: true }); 

dailyRateSchema.plugin(propertyScoped);
dailyRateSchema.index({ date: 1, roomType: 1, property: 1 }, { unique: true });

const DailyRatesModel =
    mongoose.models.dailyRates || mongoose.model('dailyRates', dailyRateSchema);

module.exports = DailyRatesModel;
module.exports.schema = dailyRateSchema;
