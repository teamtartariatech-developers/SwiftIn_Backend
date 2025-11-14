const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const aiSettingsSchema = new mongoose.Schema({
  language: {
    type: String,
    required: true,
    default: 'english',
    enum: [
      'english',
      'hindi',
      'hindi-roman',
      'bengali',
      'bengali-roman',
      'telugu',
      'telugu-roman',
      'marathi',
      'marathi-roman',
      'tamil',
      'tamil-roman',
      'gujarati',
      'gujarati-roman',
      'kannada',
      'kannada-roman',
      'malayalam',
      'malayalam-roman',
      'odia',
      'odia-roman',
      'punjabi',
      'punjabi-roman',
      'assamese',
      'assamese-roman',
      'urdu',
      'urdu-roman'
    ],
    trim: true
  }
}, { timestamps: true });

aiSettingsSchema.plugin(propertyScoped);
aiSettingsSchema.index({ property: 1 }, { unique: true });

const AISettingsModel =
    mongoose.models.AISettings || mongoose.model('AISettings', aiSettingsSchema);

module.exports = AISettingsModel;
module.exports.schema = aiSettingsSchema;

