const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const messageSchema = new mongoose.Schema({
    conversationId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Conversation', 
        required: true 
    },
    senderId: { 
        type: String, 
        required: true 
    }, // Staff member ID or 'guest' for guest messages
    senderName: { 
        type: String, 
        required: true 
    },
    senderType: { 
        type: String, 
        enum: ['staff', 'guest'], 
        required: true 
    },
    message: { 
        type: String, 
        required: true 
    },
    messageType: { 
        type: String, 
        enum: ['text', 'email', 'sms', 'system'], 
        default: 'text' 
    },
    priority: { 
        type: String, 
        enum: ['low', 'normal', 'high', 'urgent'], 
        default: 'normal' 
    },
    category: { 
        type: String, 
        enum: ['general', 'booking', 'service', 'complaint', 'feedback', 'maintenance'], 
        default: 'general' 
    },
    isRead: { 
        type: Boolean, 
        default: false 
    },
    readAt: { 
        type: Date 
    },
    attachments: [{
        filename: String,
        url: String,
        type: String
    }]
}, { timestamps: true });

messageSchema.plugin(propertyScoped);
messageSchema.index({ conversationId: 1, createdAt: -1, property: 1 });

const MessageModel =
    mongoose.models.Message || mongoose.model('Message', messageSchema);

module.exports = MessageModel;
module.exports.schema = messageSchema;

