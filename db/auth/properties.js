const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        code: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            trim: true,
        },
        status: {
            type: String,
            enum: ['Active', 'Inactive'],
            default: 'Active',
        },
        metadata: {
            address: String,
            city: String,
            country: String,
            timeZone: String,
        },
    },
    { timestamps: true }
);

propertySchema.index({ name: 1 });

const Property =
    mongoose.models.Property || mongoose.model('Property', propertySchema);

module.exports = Property;
module.exports.schema = propertySchema;