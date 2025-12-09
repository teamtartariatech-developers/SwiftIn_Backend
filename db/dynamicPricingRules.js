const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const occupancyRuleSchema = new mongoose.Schema({
    startPercent: {
        type: Number,
        required: true,
        min: 0,
        max: 100
    },
    endPercent: {
        type: Number,
        required: true,
        min: 0,
        max: 100
    },
    addSubtract1: {
        type: Number,
        default: 0
    },
    multiplier: {
        type: Number,
        default: 1,
        min: 0
    },
    addSubtract2: {
        type: Number,
        default: 0
    },
    enabled: {
        type: Boolean,
        default: true
    }
}, { _id: true });

const dynamicPricingRuleSchema = new mongoose.Schema({
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: true
    },
    enabled: {
        type: Boolean,
        default: false
    },
    demandScale: {
        type: Number,
        default: 1.0,
        min: 0
    },
    occupancyRules: {
        type: [occupancyRuleSchema],
        default: []
    },
    rateRoundOff: {
        type: Number,
        default: 1,
        min: 1
    }
}, { timestamps: true });

dynamicPricingRuleSchema.plugin(propertyScoped);
dynamicPricingRuleSchema.index({ roomType: 1, property: 1 }, { unique: true });

const DynamicPricingRule = mongoose.models.dynamicPricingRules || mongoose.model('dynamicPricingRules', dynamicPricingRuleSchema);

module.exports = DynamicPricingRule;
module.exports.schema = dynamicPricingRuleSchema;

