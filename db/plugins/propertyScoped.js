const mongoose = require('mongoose');

/**
 * Adds a required property reference to a schema and applies helpful indexes.
 *
 * Usage:
 *   const propertyScoped = require('../plugins/propertyScoped');
 *   schema.plugin(propertyScoped);
 *
 * After applying the plugin, any document saved must include the `property` field.
 */
function propertyScoped(schema) {
    schema.add({
        property: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Property',
            required: true,
        },
    });

    // Convenience static to query by property
    schema.statics.forProperty = function (propertyId) {
        return this.find({ property: propertyId });
    };

    schema.methods.belongsToProperty = function (propertyId) {
        return this.property?.toString() === propertyId?.toString();
    };
}

module.exports = propertyScoped;

