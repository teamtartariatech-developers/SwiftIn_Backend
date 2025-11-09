const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const reviewSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    review: {
        type: String,
        required: true,
        trim: true
    },
    rating: {
        type: Number,
        required: true,
        min: 1,
        max: 5,
        validate: {
            validator: Number.isInteger,
            message: 'Rating must be an integer between 1 and 5'
        }
    },
    source: {
        type: String,
        required: true,
        enum: ['Google', 'MakeMyTrip', 'Booking.com', 'Direct', 'TripAdvisor', 'Expedia'],
        trim: true
    },
    sentiment: {
        type: String,
        required: true,
        enum: ['positive', 'neutral', 'negative'],
        trim: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    verified: {
        type: Boolean,
        default: false
    }
}, { 
    timestamps: true 
});

reviewSchema.plugin(propertyScoped);

// Index for better query performance
reviewSchema.index({ source: 1, sentiment: 1, property: 1 });
reviewSchema.index({ rating: 1, property: 1 });
reviewSchema.index({ date: -1, property: 1 });

const ReviewModel =
    mongoose.models.Review || mongoose.model('Review', reviewSchema);

module.exports = ReviewModel;
module.exports.schema = reviewSchema;
