const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const campaignSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    subject: { 
        type: String 
    },
    content: { 
        type: String, 
        required: true 
    },
    status: { 
        type: String, 
        enum: ['Draft', 'Scheduled', 'Sent'], 
        default: 'Draft' 
    },
    campaignType: { 
        type: String, 
        enum: ['email', 'sms', 'push'], 
        default: 'email' 
    },
    audience: {
        type: {
            type: String, 
            enum: ['all', 'segment', 'custom'], 
            default: 'all' 
        },
        segment: {
            guestType: [String], // ['vip', 'corporate', etc.]
            tags: [String], // Tags for segmentation
            minVisits: Number,
            minSpend: Number,
            lastVisitDays: Number
        },
        customRecipients: [{
            guestId: mongoose.Schema.Types.ObjectId,
            email: String,
            name: String
        }]
    },
    scheduledAt: { 
        type: Date 
    },
    sentAt: { 
        type: Date 
    },
    recipients: { 
        type: Number, 
        default: 0 
    },
    delivered: { 
        type: Number, 
        default: 0 
    },
    opened: { 
        type: Number, 
        default: 0 
    },
    clicked: { 
        type: Number, 
        default: 0 
    },
    bounced: { 
        type: Number, 
        default: 0 
    },
    createdBy: { 
        type: String, 
        required: true 
    }, // Staff member ID
    templateId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'MessageTemplate' 
    }
}, { timestamps: true });

campaignSchema.plugin(propertyScoped);

// Calculate open rate
campaignSchema.virtual('openRate').get(function() {
    if (this.delivered === 0) return 0;
    return ((this.opened / this.delivered) * 100).toFixed(2);
});

campaignSchema.index({ status: 1, scheduledAt: 1, property: 1 });
campaignSchema.index({ createdBy: 1, property: 1 });

const CampaignModel =
    mongoose.models.Campaign || mongoose.model('Campaign', campaignSchema);

module.exports = CampaignModel;
module.exports.schema = campaignSchema;

