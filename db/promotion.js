const mongoose = require("mongoose");
const propertyScoped = require("./plugins/propertyScoped");

const promotionSchema = new mongoose.Schema({
    name: String,
    couponCode: String,
    lastdate: Date,
    discount: Number,
    discountType: String, // percentage or fixed
    isActive: Boolean,
}, { timestamps: true });

promotionSchema.plugin(propertyScoped);
promotionSchema.index({ couponCode: 1, property: 1 }, { unique: true, sparse: true });

const PromotionModel =
    mongoose.models.Promotion || mongoose.model('Promotion', promotionSchema);

module.exports = PromotionModel;
module.exports.schema = promotionSchema;