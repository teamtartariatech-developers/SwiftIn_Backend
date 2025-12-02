const mongoose = require('mongoose');
const propertyScoped = require('./plugins/propertyScoped');

const auditLogSchema = new mongoose.Schema({
    auditDate: {
        type: Date,
        required: true
    },
    businessDate: {
        type: Date,
        required: true
    },
    runBy: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'in-progress', 'completed', 'failed'],
        default: 'pending'
    },
    summary: {
        totalRevenue: { type: Number, default: 0 },
        roomRevenue: { type: Number, default: 0 },
        fBRevenue: { type: Number, default: 0 },
        otherRevenue: { type: Number, default: 0 },
        totalCheckIns: { type: Number, default: 0 },
        totalCheckOuts: { type: Number, default: 0 },
        totalReservations: { type: Number, default: 0 },
        occupiedRooms: { type: Number, default: 0 },
        availableRooms: { type: Number, default: 0 },
        noShows: { type: Number, default: 0 }
    },
    pendingTasks: [{
        type: {
            type: String,
            enum: ['check-in', 'check-out', 'folio-posting', 'unposted-charge']
        },
        description: String,
        count: Number
    }],
    errors: [{
        type: String,
        message: String,
        timestamp: { type: Date, default: Date.now }
    }],
    completedAt: Date,
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

auditLogSchema.plugin(propertyScoped);
auditLogSchema.index({ auditDate: -1, property: 1 });
auditLogSchema.index({ businessDate: -1, property: 1 });

const NightAudit = mongoose.models.NightAudit || mongoose.model('NightAudit', auditLogSchema);

module.exports = NightAudit;
module.exports.schema = auditLogSchema;

