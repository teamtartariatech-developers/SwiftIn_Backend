const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const emailIntegrationSchema = new mongoose.Schema(
  {
    fromName: { type: String, required: true },
    fromEmail: { type: String, required: true },
    smtpHost: { type: String, required: true },
    smtpPort: { type: Number, required: true },
    secure: { type: Boolean, default: false },
    authUser: { type: String, required: true },
    authPasswordHash: { type: String, default: null },
    authPasswordEncrypted: { type: String, default: null },
    status: {
      type: String,
      enum: ['connected', 'disconnected', 'error'],
      default: 'connected',
    },
    verifiedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

emailIntegrationSchema.plugin(propertyScoped);
emailIntegrationSchema.index({ property: 1 }, { unique: true });

const EmailIntegrationModel =
  mongoose.models.EmailIntegration || mongoose.model('EmailIntegration', emailIntegrationSchema);

module.exports = EmailIntegrationModel;
module.exports.schema = emailIntegrationSchema;

