const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const propertyDetailsSchema = new mongoose.Schema({
  propertyName: { type: String, required: true },
  address: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  website: { type: String, default: '' },
  currency: { type: String, required: true, default: 'INR' },
  timezone: { type: String, required: true, default: 'Asia/Kolkata' },
  gstin: { type: String, required: true },
  // Additional business settings
  checkInTime: { type: String, default: '14:00' },
  checkOutTime: { type: String, default: '11:00' },
  // Policy settings
  cancellationPolicy: { type: String, default: '' },
  generalPolicies: { type: String, default: '' },
  // Tax settings
  gstRate: { type: Number, default: 18, min: 0, max: 100 },
  serviceChargeRate: { type: Number, default: 10, min: 0, max: 100 },
  emailPasswordHash: { type: String, default: null },
  emailPasswordEncrypted: { type: String, default: null },
  // Status
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

propertyDetailsSchema.plugin(propertyScoped);
propertyDetailsSchema.index({ property: 1 }, { unique: true });

const PropertyDetailsModel =
    mongoose.models.PropertyDetails || mongoose.model('PropertyDetails', propertyDetailsSchema);

module.exports = PropertyDetailsModel;
module.exports.schema = propertyDetailsSchema;
