const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const reportSnapshotSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['dashboard', 'occupancy', 'revenue', 'channel-performance'],
        required: true
    },
    dateRange: {
        label: { type: String, required: true },
        start: { type: Date, required: true },
        end: { type: Date, required: true }
    },
    filters: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    summary: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    generatedAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

reportSnapshotSchema.plugin(propertyScoped);

reportSnapshotSchema.index({ type: 1, 'dateRange.start': 1, 'dateRange.end': 1, property: 1 });

const ReportSnapshotModel =
    mongoose.models.ReportSnapshot || mongoose.model('ReportSnapshot', reportSnapshotSchema);

module.exports = ReportSnapshotModel;
module.exports.schema = reportSnapshotSchema;

