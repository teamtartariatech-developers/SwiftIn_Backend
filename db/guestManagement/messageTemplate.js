const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const messageTemplateSchema = new mongoose.Schema({
    name: { 
        type: String, 
        required: true 
    },
    category: { 
        type: String, 
        enum: ['welcome', 'check-in', 'check-out', 'booking-confirmation', 'service-request', 'feedback', 'promotional', 'custom'], 
        required: true 
    },
    subject: { 
        type: String 
    },
    content: { 
        type: String, 
        required: true 
    },
    templateType: { 
        type: String, 
        enum: ['email', 'sms', 'text'], 
        default: 'email' 
    },
    variables: [{
        type: String // e.g., ['{{guestName}}', '{{roomNumber}}', '{{checkInDate}}']
    }],
    isActive: { 
        type: Boolean, 
        default: true 
    },
    usageCount: { 
        type: Number, 
        default: 0 
    },
    createdBy: { 
        type: String, 
        required: true 
    },
    lastUsedAt: { 
        type: Date 
    }
}, { timestamps: true });

messageTemplateSchema.plugin(propertyScoped);

messageTemplateSchema.index({ category: 1, isActive: 1, property: 1 });
messageTemplateSchema.index({ name: 1, property: 1 }, { unique: true });

const MessageTemplateModel =
    mongoose.models.MessageTemplate || mongoose.model('MessageTemplate', messageTemplateSchema);

module.exports = MessageTemplateModel;
module.exports.schema = messageTemplateSchema;

