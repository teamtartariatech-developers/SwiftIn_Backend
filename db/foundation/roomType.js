const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const roomTypeSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  totalInventory: { type: Number, required: true, min: 1 },
  
  // Occupancy
  baseOccupancy: { type: Number, required: true, min: 1 },
  maxOccupancy: { type: Number, required: true, min: 1 },

  // Pricing
  priceModel: { type: String, enum: ['perRoom', 'perPerson', 'hybrid'], default: 'perRoom' },
  baseRate: { type: Number, required: true, min: 0 },
  extraGuestRate: { type: Number, default: 0, min: 0 },
  adultRate: { type: Number, min: 0 },
  childRate: { type: Number, min: 0 },
  // Meal plan
  MealPlan: { EP : Number, CP: Number, MAP: Number, AP: Number},

  // Amenities
  amenities: { type: [String], default: [] },

  // Status
  active: { type: Boolean, default: true }
}, { timestamps: true });

roomTypeSchema.plugin(propertyScoped);
roomTypeSchema.index({ name: 1, property: 1 }, { unique: true });

const RoomTypeModel =
    mongoose.models.RoomType || mongoose.model('RoomType', roomTypeSchema);

module.exports = RoomTypeModel;
module.exports.schema = roomTypeSchema;
