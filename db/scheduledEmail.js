const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const scheduledEmailSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['city-ledger-invoice', 'city-ledger-reminder'],
        required: true
    },
    targetId: { // CityLedgerAccount ID
        type: mongoose.Schema.Types.ObjectId,
        ref: 'CityLedgerAccount',
        required: true
    },
    invoiceId: { // Specific invoice ID within the account
        type: mongoose.Schema.Types.ObjectId,
        required: true
    },
    recipientEmail: {
        type: String,
        required: true
    },
    subject: String,
    content: String, // Store rendered content or template ID? Rendered is safer for snapshots.
    scheduledAt: {
        type: Date,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'sent', 'failed', 'cancelled'],
        default: 'pending'
    },
    attempts: {
        type: Number,
        default: 0
    },
    lastError: String,
    metadata: Object // Store extra data like payment terms, amount, etc.
}, { timestamps: true });

scheduledEmailSchema.plugin(propertyScoped);

const ScheduledEmail = mongoose.models.ScheduledEmail || mongoose.model('ScheduledEmail', scheduledEmailSchema);

module.exports = ScheduledEmail;

