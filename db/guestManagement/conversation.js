const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const conversationSchema = new mongoose.Schema({
    guestId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'GuestProfiles', 
        required: true 
    },
    guestName: { 
        type: String, 
        required: true 
    },
    guestEmail: { 
        type: String, 
        required: true 
    },
    guestPhone: { 
        type: String 
    },
    reservationId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Reservations' 
    },
    roomNumber: { 
        type: String 
    },
    status: { 
        type: String, 
        enum: ['open', 'closed', 'archived'], 
        default: 'open' 
    },
    assignedTo: { 
        type: String 
    }, // Staff member ID
    assignedToName: { 
        type: String 
    },
    lastMessageAt: { 
        type: Date, 
        default: Date.now 
    },
    unreadCount: { 
        type: Number, 
        default: 0 
    },
    tags: [{
        type: String
    }],
    notes: { 
        type: String 
    }
}, { timestamps: true });

conversationSchema.plugin(propertyScoped);

// Index for faster queries
conversationSchema.index({ guestId: 1, status: 1, property: 1 });
conversationSchema.index({ assignedTo: 1, status: 1, property: 1 });
conversationSchema.index({ lastMessageAt: -1, property: 1 });

const ConversationModel =
    mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);

module.exports = ConversationModel;
module.exports.schema = conversationSchema;

