const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const housekeepingMessageSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    user: {
      id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
      role: String,
    },
  },
  {
    timestamps: true,
  }
);

housekeepingMessageSchema.plugin(propertyScoped);
housekeepingMessageSchema.index({ property: 1, createdAt: -1 });

const HousekeepingMessage =
  mongoose.models.HousekeepingMessage ||
  mongoose.model('HousekeepingMessage', housekeepingMessageSchema);

module.exports = HousekeepingMessage;
module.exports.schema = housekeepingMessageSchema;

