const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const taxRuleSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['gst', 'service_charge', 'city_tax', 'tourism_tax', 'other'], required: true },
  rate: { type: Number, required: true, min: 0, max: 100 },
  isPercentage: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  description: { type: String, default: '' },
  applicableOn: { type: String, enum: ['room_rate', 'total_amount', 'food_beverage', 'all'], default: 'total_amount' }
}, { timestamps: true });

taxRuleSchema.plugin(propertyScoped);
taxRuleSchema.index({ name: 1, property: 1 }, { unique: true });

const serviceFeeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['cleaning_fee', 'resort_fee', 'amenity_fee', 'booking_fee', 'other'], required: true },
  amount: { type: Number, required: true, min: 0 },
  isPercentage: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  description: { type: String, default: '' },
  applicableOn: { type: String, enum: ['room_rate', 'total_amount', 'per_night', 'per_booking'], default: 'per_booking' }
}, { timestamps: true });

serviceFeeSchema.plugin(propertyScoped);
serviceFeeSchema.index({ name: 1, property: 1 }, { unique: true });

const TaxRuleModel =
  mongoose.models.TaxRule || mongoose.model('TaxRule', taxRuleSchema);
const ServiceFeeModel =
  mongoose.models.ServiceFee || mongoose.model('ServiceFee', serviceFeeSchema);

module.exports = {
  TaxRule: TaxRuleModel,
  ServiceFee: ServiceFeeModel,
  taxRuleSchema,
  serviceFeeSchema,
};
