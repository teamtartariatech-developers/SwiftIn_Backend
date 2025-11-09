const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const inventoryBlockSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true
    },
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: true
    },
    blockedInventory: {
        type: Number,
        required: true,
        min: 0,
        default: 0
    },
    reason: {
        type: String,
        default: 'Manual block'
    },
    createdBy: {
        type: String,
        default: 'admin'
    }
}, { timestamps: true });

inventoryBlockSchema.plugin(propertyScoped);

// Ensure unique combination of date and roomType
inventoryBlockSchema.index({ date: 1, roomType: 1, property: 1 }, { unique: true });

const InventoryBlockModel =
    mongoose.models.InventoryBlock || mongoose.model('InventoryBlock', inventoryBlockSchema);

module.exports = InventoryBlockModel;
module.exports.schema = inventoryBlockSchema;
