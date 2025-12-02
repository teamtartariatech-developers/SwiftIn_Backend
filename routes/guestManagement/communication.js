const express = require('express');
const bodyParser = require('body-parser');
const router = express.Router();
const emailService = require('../../services/emailService');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { getTenantContext } = require('../../services/tenantManager');
const {
    validateAndSetDefaults,
    validatePagination,
    isValidObjectId,
    isValidEmail,
    isValidPhone,
} = require('../../utils/validation');

router.use(bodyParser.json());

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

// Lightweight 1x1 transparent GIF for open tracking
const OPEN_PIXEL_BUFFER = Buffer.from(
    'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    'base64'
);

// Public (unauthenticated) tracking pixel endpoint for campaign opens
router.get('/open', async (req, res) => {
    try {
        const { code, cid } = req.query;

        if (!code || !cid || !isValidObjectId(cid)) {
            res.set('Content-Type', 'image/gif');
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.set('Content-Length', OPEN_PIXEL_BUFFER.length);
            return res.status(200).end(OPEN_PIXEL_BUFFER);
        }

        const normalizedCode = String(code).toUpperCase().trim();
        const { models } = await getTenantContext(normalizedCode);
        const Campaign = models.Campaign;

        if (Campaign) {
            await Campaign.findByIdAndUpdate(cid, { $inc: { opened: 1 } }).catch(() => {});
        }
    } catch (error) {
        console.error('Error tracking campaign open:', error);
    } finally {
        // Always return a tiny transparent GIF so emails render without errors
        res.set('Content-Type', 'image/gif');
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Content-Length', OPEN_PIXEL_BUFFER.length);
        res.status(200).end(OPEN_PIXEL_BUFFER);
    }
});

// Authenticated routes below
router.use(authenticate);
router.use(requireModuleAccess('guest-management'));

// ========== CONVERSATIONS ==========

// Get all conversations with pagination and filters
router.get('/conversations', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 20 });
        const { status = 'open', assignedTo = '' } = req.query;
        const skip = (page - 1) * limit;
        const propertyId = getPropertyId(req);
        const Conversation = getModel(req, 'Conversation');

        const query = { property: propertyId };
        
        if (status) {
            query.status = status;
        }
        
        if (assignedTo) {
            query.assignedTo = assignedTo;
        }
        
        if (search && search.trim() !== '') {
            query.$or = [
                { guestName: { $regex: search, $options: 'i' } },
                { guestEmail: { $regex: search, $options: 'i' } },
                { roomNumber: { $regex: search, $options: 'i' } }
            ];
        }
        
        const total = await Conversation.countDocuments(query);
        
        const conversations = await Conversation.find(query)
            .skip(skip)
            .limit(limit)
            .sort({ lastMessageAt: -1 })
            .populate('guestId', 'guestName guestEmail guestNumber')
            .populate('reservationId', 'confirmationNumber');
        
        res.status(200).json({
            conversations,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalItems: total,
                itemsPerPage: limit
            }
        });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({ message: "Server error fetching conversations." });
    }
});

// Get single conversation with messages
router.get('/conversations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid conversation ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const Conversation = getModel(req, 'Conversation');
        const Message = getModel(req, 'Message');

        const conversation = await Conversation.findOne({ _id: id, property: propertyId })
            .populate('guestId', 'guestName guestEmail guestNumber guestType')
            .populate('reservationId');
        
        if (!conversation) {
            return res.status(404).json({ message: "Conversation not found" });
        }
        
        const messages = await Message.find({ conversationId: id, property: propertyId })
            .sort({ createdAt: 1 });
        
        res.status(200).json({
            conversation,
            messages
        });
    } catch (error) {
        console.error('Error fetching conversation:', error);
        res.status(500).json({ message: "Server error fetching conversation." });
    }
});

// Create new conversation
router.post('/conversations', async (req, res) => {
    try {
        // Validate and set defaults
        const conversationSchema = {
            guestId: { type: 'string', isObjectId: true },
            guestName: { type: 'string', required: true },
            guestEmail: { type: 'string', default: '', custom: (val) => !val || isValidEmail(val) || 'Invalid email format' },
            guestPhone: { type: 'string', default: '', custom: (val) => !val || isValidPhone(val) || 'Invalid phone number' },
            reservationId: { type: 'string', isObjectId: true },
            roomNumber: { type: 'string', default: '' },
            assignedTo: { type: 'string', default: '' },
            assignedToName: { type: 'string', default: '' },
            notes: { type: 'string', default: '' }
        };

        const validation = validateAndSetDefaults(req.body, conversationSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { guestId, guestName, guestEmail, guestPhone, reservationId, roomNumber, assignedTo, assignedToName, notes } = validation.validated;
        const propertyId = getPropertyId(req);
        const Conversation = getModel(req, 'Conversation');
        
        // Check if conversation already exists for this guest and reservation
        let conversation = await Conversation.findOne({
            guestId,
            reservationId: reservationId || null,
            status: { $in: ['open', 'closed'] },
            property: propertyId
        });
        
        if (conversation) {
            // Update existing conversation
            conversation.status = 'open';
            if (assignedTo) conversation.assignedTo = assignedTo;
            if (assignedToName) conversation.assignedToName = assignedToName;
            if (notes) conversation.notes = notes;
            await conversation.save();
            
            return res.status(200).json({ 
                message: "Conversation reopened", 
                conversation 
            });
        }
        
        // Create new conversation
        conversation = new Conversation({
            guestId,
            guestName,
            guestEmail,
            guestPhone,
            reservationId,
            roomNumber,
            assignedTo,
            assignedToName,
            notes,
            property: propertyId
        });
        
        await conversation.save();
        
        res.status(201).json({ 
            message: "Conversation created successfully", 
            conversation 
        });
    } catch (error) {
        console.error('Error creating conversation:', error);
        res.status(500).json({ message: "Server error creating conversation." });
    }
});

// Update conversation
router.put('/conversations/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid conversation ID format' });
        }

        // Validate update fields
        const updateSchema = {
            status: { type: 'string', enum: ['open', 'closed', 'archived'] },
            assignedTo: { type: 'string' },
            assignedToName: { type: 'string' },
            notes: { type: 'string' },
            guestName: { type: 'string' },
            guestEmail: { type: 'string', custom: (val) => !val || isValidEmail(val) || 'Invalid email format' },
            guestPhone: { type: 'string', custom: (val) => !val || isValidPhone(val) || 'Invalid phone number' }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }
        
        const updateData = { ...validation.validated };
        delete updateData.property;
        
        const Conversation = getModel(req, 'Conversation');
        const conversation = await Conversation.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updateData,
            { new: true, runValidators: true }
        );
        
        if (!conversation) {
            return res.status(404).json({ message: "Conversation not found" });
        }
        
        res.status(200).json({ 
            message: "Conversation updated successfully", 
            conversation 
        });
    } catch (error) {
        console.error('Error updating conversation:', error);
        res.status(500).json({ message: "Server error updating conversation." });
    }
});

// ========== MESSAGES ==========

// Get messages for a conversation
router.get('/conversations/:conversationId/messages', async (req, res) => {
    try {
        const { conversationId } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(conversationId)) {
            return res.status(400).json({ message: 'Invalid conversation ID format' });
        }
        
        const { page, limit } = validatePagination({ ...req.query, limit: req.query.limit || 50 });
        const skip = (page - 1) * limit;
        const propertyId = getPropertyId(req);
        const Message = getModel(req, 'Message');

        const messages = await Message.find({ conversationId, property: propertyId })
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });
        
        const total = await Message.countDocuments({ conversationId, property: propertyId });
        
        res.status(200).json({
            messages: messages.reverse(), // Reverse to show oldest first
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalItems: total
            }
        });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ message: "Server error fetching messages." });
    }
});

// Send message
router.post('/conversations/:conversationId/messages', async (req, res) => {
    try {
        const { conversationId } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(conversationId)) {
            return res.status(400).json({ message: 'Invalid conversation ID format' });
        }

        // Validate and set defaults
        const messageSchema = {
            senderId: { type: 'string', required: true },
            senderName: { type: 'string', required: true },
            senderType: { type: 'string', default: 'staff', enum: ['staff', 'guest', 'system'] },
            message: { type: 'string', required: true },
            messageType: { type: 'string', default: 'text', enum: ['text', 'image', 'file', 'link'] },
            priority: { type: 'string', default: 'normal', enum: ['low', 'normal', 'high', 'urgent'] },
            category: { type: 'string', default: 'general' },
            attachments: { isArray: true, default: [] }
        };

        const validation = validateAndSetDefaults(req.body, messageSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const { senderId, senderName, senderType, message, messageType, priority, category, attachments } = validation.validated;
        const propertyId = getPropertyId(req);
        const Conversation = getModel(req, 'Conversation');
        const Message = getModel(req, 'Message');

        // Verify conversation exists
        const conversation = await Conversation.findOne({ _id: conversationId, property: propertyId });
        if (!conversation) {
            return res.status(404).json({ message: "Conversation not found" });
        }
        
        // Create message
        const newMessage = new Message({
            conversationId,
            senderId,
            senderName,
            senderType,
            message,
            messageType,
            priority,
            category,
            attachments,
            property: propertyId
        });
        
        await newMessage.save();
        
        // Update conversation
        conversation.lastMessageAt = new Date();
        if (senderType === 'guest') {
            conversation.unreadCount = (conversation.unreadCount || 0) + 1;
        } else {
            // Mark as read if staff sent it
            conversation.unreadCount = 0;
        }
        await conversation.save();
        
        res.status(201).json({ 
            message: "Message sent successfully", 
            message: newMessage 
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ message: "Server error sending message." });
    }
});

// Mark messages as read
router.put('/conversations/:conversationId/messages/read', async (req, res) => {
    try {
        const { conversationId } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(conversationId)) {
            return res.status(400).json({ message: 'Invalid conversation ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const Message = getModel(req, 'Message');
        const Conversation = getModel(req, 'Conversation');

        await Message.updateMany(
            { conversationId, property: propertyId, isRead: false },
            { $set: { isRead: true, readAt: new Date() } }
        );
        
        const conversation = await Conversation.findOne({ _id: conversationId, property: propertyId });
        if (conversation) {
            conversation.unreadCount = 0;
            await conversation.save();
        }
        
        res.status(200).json({ message: "Messages marked as read" });
    } catch (error) {
        console.error('Error marking messages as read:', error);
        res.status(500).json({ message: "Server error marking messages as read." });
    }
});

// ========== CAMPAIGNS ==========

// Get all campaigns
router.get('/campaigns', async (req, res) => {
    try {
        const { page, limit, search } = validatePagination({ ...req.query, limit: req.query.limit || 20 });
        const { status = '' } = req.query;
        const skip = (page - 1) * limit;
        const propertyId = getPropertyId(req);
        const Campaign = getModel(req, 'Campaign');

        const query = { property: propertyId };
        
        if (status) {
            query.status = status;
        }
        
        if (search && search.trim() !== '') {
            query.name = { $regex: search, $options: 'i' };
        }
        
        const total = await Campaign.countDocuments(query);
        
        const campaigns = await Campaign.find(query)
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });
        
        // Calculate open rates
        const campaignsWithStats = campaigns.map(camp => ({
            ...camp.toObject(),
            openRate: camp.delivered > 0 ? ((camp.opened / camp.delivered) * 100).toFixed(2) : 0
        }));
        
        res.status(200).json({
            campaigns: campaignsWithStats,
            pagination: {
                currentPage: page,
                totalPages: Math.ceil(total / limit),
                totalItems: total,
                itemsPerPage: limit
            }
        });
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        res.status(500).json({ message: "Server error fetching campaigns." });
    }
});

// Get single campaign
router.get('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid campaign ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const Campaign = getModel(req, 'Campaign');

        const campaign = await Campaign.findOne({ _id: id, property: propertyId })
            .populate('templateId');
        
        if (!campaign) {
            return res.status(404).json({ message: "Campaign not found" });
        }
        
        const campaignData = campaign.toObject();
        campaignData.openRate = campaign.delivered > 0 ? ((campaign.opened / campaign.delivered) * 100).toFixed(2) : 0;
        
        res.status(200).json({ campaign: campaignData });
    } catch (error) {
        console.error('Error fetching campaign:', error);
        res.status(500).json({ message: "Server error fetching campaign." });
    }
});

// Create campaign
router.post('/campaigns', async (req, res) => {
    try {
        const campaignData = {
            ...req.body,
            property: getPropertyId(req),
        };
        const Campaign = getModel(req, 'Campaign');

        const campaign = new Campaign(campaignData);
        await campaign.save();
        
        res.status(201).json({ 
            message: "Campaign created successfully", 
            campaign 
        });
    } catch (error) {
        console.error('Error creating campaign:', error);
        res.status(500).json({ message: "Server error creating campaign." });
    }
});

// Update campaign
router.put('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid campaign ID format' });
        }

        // Validate update fields (all optional)
        const updateSchema = {
            name: { type: 'string' },
            subject: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['Draft', 'Scheduled', 'Sent', 'Cancelled'] },
            audience: { type: 'object' },
            scheduledAt: { type: 'string', isDate: true }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const updateData = { ...validation.validated };
        delete updateData.property;
        const Campaign = getModel(req, 'Campaign');

        const campaign = await Campaign.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updateData,
            { new: true, runValidators: true }
        );
        
        if (!campaign) {
            return res.status(404).json({ message: "Campaign not found" });
        }
        
        res.status(200).json({ 
            message: "Campaign updated successfully", 
            campaign 
        });
    } catch (error) {
        console.error('Error updating campaign:', error);
        res.status(500).json({ message: "Server error updating campaign." });
    }
});

// Send campaign (update status and calculate recipients)
router.post('/campaigns/:id/send', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid campaign ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const Campaign = getModel(req, 'Campaign');
        const GuestProfiles = getModel(req, 'GuestProfiles');

        const campaign = await Campaign.findOne({ _id: id, property: propertyId });
        if (!campaign) {
            return res.status(404).json({ message: "Campaign not found" });
        }
        
        if (campaign.status === 'Sent') {
            return res.status(400).json({ message: "Campaign has already been sent." });
        }
        
        // Calculate recipients based on audience
        let recipients = [];
        let query = { property: propertyId };
        
        if (campaign.audience.type === 'all') {
            // Get all guests
            query = { property: propertyId };
        } else if (campaign.audience.type === 'segment') {
            // Build query based on segment criteria
            // Use OR logic: guests matching guestType OR tags will be included
            if (campaign.audience.segment) {
                const segmentConditions = [];
                
                // Guest Type segmentation
                if (campaign.audience.segment.guestType && campaign.audience.segment.guestType.length > 0) {
                    segmentConditions.push({ guestType: { $in: campaign.audience.segment.guestType } });
                }
                
                // Tag-based segmentation
                if (campaign.audience.segment.tags && campaign.audience.segment.tags.length > 0) {
                    segmentConditions.push({ tags: { $in: campaign.audience.segment.tags } });
                }
                
                // Additional criteria (minVisits, minSpend, etc.) - these use AND logic
                if (campaign.audience.segment.minVisits) {
                    query.totalVisits = { $gte: campaign.audience.segment.minVisits };
                }
                if (campaign.audience.segment.minSpend) {
                    query.totalSpend = { $gte: campaign.audience.segment.minSpend };
                }
                if (campaign.audience.segment.lastVisitDays) {
                    const dateThreshold = new Date();
                    dateThreshold.setDate(dateThreshold.getDate() - campaign.audience.segment.lastVisitDays);
                    query['records.checkOutDate'] = { $gte: dateThreshold };
                }
                
                // Combine guestType and tags with OR logic
                if (segmentConditions.length > 0) {
                    if (segmentConditions.length === 1) {
                        Object.assign(query, segmentConditions[0]);
                    } else {
                        // Use $or to match guests with ANY of the selected guestTypes or tags
                        query.$or = segmentConditions;
                    }
                }
            }
        } else if (campaign.audience.type === 'custom') {
            recipients = campaign.audience.customRecipients || [];
        }
        
        // Fetch guests from database if not custom
        if (campaign.audience.type !== 'custom') {
            const guests = await GuestProfiles.find(query).select('_id guestName guestEmail');
            recipients = guests
                .filter(g => g.guestEmail && g.guestEmail.trim()) // Only include guests with valid emails
                .map(g => ({
                    guestId: g._id,
                    email: g.guestEmail.trim(),
                    name: g.guestName || 'Guest'
                }));
        } else {
            // For custom recipients, filter out invalid emails
            recipients = (campaign.audience.customRecipients || [])
                .filter(r => r && r.email && r.email.trim())
                .map(r => ({
                    guestId: r.guestId,
                    email: r.email.trim(),
                    name: r.name || 'Guest'
                }));
        }
        
        if (recipients.length === 0) {
            console.error('Campaign send failed: No recipients found', {
                campaignId: id,
                audienceType: campaign.audience.type,
                audience: campaign.audience
            });
            return res.status(400).json({ 
                message: "No recipients found for this campaign. Please ensure your audience selection includes guests with valid email addresses.",
                details: {
                    audienceType: campaign.audience.type,
                    hint: campaign.audience.type === 'all' 
                        ? 'No guests in the system have email addresses.'
                        : campaign.audience.type === 'segment'
                        ? 'No guests match your segment criteria or they don\'t have email addresses.'
                        : 'No valid email addresses in your custom recipient list.'
                }
            });
        }
        
        // Validate campaign has required fields
        if (!campaign.subject || !campaign.subject.trim()) {
            return res.status(400).json({ 
                message: "Campaign subject is required. Please select a template that includes a subject line." 
            });
        }
        
        if (!campaign.content || !campaign.content.trim()) {
            return res.status(400).json({ 
                message: "Campaign content is required. Please select a template that includes content." 
            });
        }
        
        // Prepare email content (inject tracking pixel for open-rate analytics)
        const subject = campaign.subject.trim();
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const trackingUrl = `${baseUrl}/api/guestmanagement/communication/open?code=${encodeURIComponent(
            req.tenant.property.code
        )}&cid=${campaign._id.toString()}`;
        const trackingPixelHtml = `<img src="${trackingUrl}" alt="" width="1" height="1" style="display:none;" />`;
        const htmlContent = `${campaign.content || ''}${trackingPixelHtml}`;
        
        // Send emails using tenant-specific integration
        let emailResults;
        try {
            emailResults = await emailService.sendBulkEmails(
                req.tenant,
                recipients,
                subject,
                htmlContent,
            );
        } catch (emailError) {
            if (emailError.code === 'EMAIL_INTEGRATION_NOT_CONFIGURED') {
                return res.status(400).json({
                    message: 'Email integration is not configured. Please connect an SMTP provider in Settings > Email Integration.',
                    code: 'EMAIL_INTEGRATION_NOT_CONFIGURED'
                });
            }
            throw emailError; // Re-throw other errors
        }
        
        // Update campaign with results
        campaign.status = 'Sent';
        campaign.sentAt = new Date();
        campaign.recipients = recipients.length;
        campaign.delivered = emailResults.sent;
        campaign.bounced = emailResults.failed;

        // Bump template usage metrics if this campaign was created from a template
        if (campaign.templateId && req.tenant?.models?.MessageTemplate) {
            const MessageTemplate = req.tenant.models.MessageTemplate;
            await MessageTemplate.findByIdAndUpdate(campaign.templateId, {
                $inc: { usageCount: 1 },
                $set: { lastUsedAt: new Date() },
            }).catch(() => {});
        }

        await campaign.save();
        
        res.status(200).json({ 
            message: "Campaign sent successfully", 
            campaign,
            results: {
                totalRecipients: recipients.length,
                sent: emailResults.sent,
                failed: emailResults.failed,
                errors: emailResults.errors
            }
        });
    } catch (error) {
        console.error('Error sending campaign:', error);
        if (error.code === 'EMAIL_INTEGRATION_NOT_CONFIGURED') {
            return res.status(400).json({
                message: 'Email integration is not configured. Please connect an SMTP provider in Settings.',
            });
        }
        res.status(500).json({ message: "Server error sending campaign.", error: error.message });
    }
});

// Estimate recipients for a potential campaign audience (no email sending)
router.post('/campaigns/estimate', async (req, res) => {
    try {
        const { audience } = req.body || {};

        if (!audience || !audience.type) {
            return res.status(400).json({ message: 'Audience configuration is required.' });
        }

        const propertyId = getPropertyId(req);
        const GuestProfiles = getModel(req, 'GuestProfiles');

        let totalRecipients = 0;

        if (audience.type === 'custom') {
            const customRecipients = Array.isArray(audience.customRecipients)
                ? audience.customRecipients
                : [];
            totalRecipients = customRecipients.filter((r) => r?.email).length;
        } else {
            let query = { property: propertyId };

            if (audience.type === 'all') {
                query = { property: propertyId };
            } else if (audience.type === 'segment' && audience.segment) {
                const segmentConditions = [];

                if (Array.isArray(audience.segment.guestType) && audience.segment.guestType.length > 0) {
                    segmentConditions.push({ guestType: { $in: audience.segment.guestType } });
                }

                if (Array.isArray(audience.segment.tags) && audience.segment.tags.length > 0) {
                    segmentConditions.push({ tags: { $in: audience.segment.tags } });
                }

                if (audience.segment.minVisits) {
                    query.totalVisits = { $gte: audience.segment.minVisits };
                }
                if (audience.segment.minSpend) {
                    query.totalSpend = { $gte: audience.segment.minSpend };
                }
                if (audience.segment.lastVisitDays) {
                    const dateThreshold = new Date();
                    dateThreshold.setDate(dateThreshold.getDate() - audience.segment.lastVisitDays);
                    query['records.checkOutDate'] = { $gte: dateThreshold };
                }

                if (segmentConditions.length > 0) {
                    if (segmentConditions.length === 1) {
                        Object.assign(query, segmentConditions[0]);
                    } else {
                        query.$or = segmentConditions;
                    }
                }
            }

            totalRecipients = await GuestProfiles.countDocuments(query);
        }

        return res.status(200).json({
            totalRecipients,
            audienceType: audience.type,
        });
    } catch (error) {
        console.error('Error estimating campaign recipients:', error);
        res.status(500).json({ message: 'Server error estimating recipients.' });
    }
});

// Delete campaign
router.delete('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid campaign ID format' });
        }
        
        const Campaign = getModel(req, 'Campaign');
        const campaign = await Campaign.findOneAndDelete({ _id: id, property: getPropertyId(req) });
        
        if (!campaign) {
            return res.status(404).json({ message: "Campaign not found" });
        }
        
        res.status(200).json({ message: "Campaign deleted successfully" });
    } catch (error) {
        console.error('Error deleting campaign:', error);
        res.status(500).json({ message: "Server error deleting campaign." });
    }
});

// Get campaign analytics
router.get('/campaigns/:id/analytics', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid campaign ID format' });
        }
        
        const propertyId = getPropertyId(req);
        const Campaign = getModel(req, 'Campaign');

        const campaign = await Campaign.findOne({ _id: id, property: propertyId });
        
        if (!campaign) {
            return res.status(404).json({ message: "Campaign not found" });
        }
        
        const openRate = campaign.delivered > 0 ? ((campaign.opened / campaign.delivered) * 100).toFixed(2) : 0;
        const clickRate = campaign.delivered > 0 ? ((campaign.clicked / campaign.delivered) * 100).toFixed(2) : 0;
        const bounceRate = campaign.recipients > 0 ? ((campaign.bounced / campaign.recipients) * 100).toFixed(2) : 0;
        
        res.status(200).json({
            campaign: {
                name: campaign.name,
                status: campaign.status,
                sentAt: campaign.sentAt
            },
            analytics: {
                recipients: campaign.recipients,
                delivered: campaign.delivered,
                opened: campaign.opened,
                clicked: campaign.clicked,
                bounced: campaign.bounced,
                openRate: parseFloat(openRate),
                clickRate: parseFloat(clickRate),
                bounceRate: parseFloat(bounceRate)
            }
        });
    } catch (error) {
        console.error('Error fetching campaign analytics:', error);
        res.status(500).json({ message: "Server error fetching campaign analytics." });
    }
});

// ========== TEMPLATES ==========

// Get all templates
router.get('/templates', async (req, res) => {
    try {
        const { category = '', search = '', isActive = '' } = req.query;
        const propertyId = getPropertyId(req);
        const MessageTemplate = getModel(req, 'MessageTemplate');
        
        const query = { property: propertyId };
        
        if (category) {
            query.category = category;
        }
        
        if (isActive !== '') {
            query.isActive = isActive === 'true';
        }
        
        if (search && search.trim() !== '') {
            query.name = { $regex: search, $options: 'i' };
        }
        
        const templates = await MessageTemplate.find(query)
            .sort({ category: 1, name: 1 });
        
        res.status(200).json({ templates });
    } catch (error) {
        console.error('Error fetching templates:', error);
        res.status(500).json({ message: "Server error fetching templates." });
    }
});

// Get single template
router.get('/templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid template ID format' });
        }
        
        const MessageTemplate = getModel(req, 'MessageTemplate');
        
        const template = await MessageTemplate.findOne({ _id: id, property: getPropertyId(req) });
        
        if (!template) {
            return res.status(404).json({ message: "Template not found" });
        }
        
        res.status(200).json({ template });
    } catch (error) {
        console.error('Error fetching template:', error);
        res.status(500).json({ message: "Server error fetching template." });
    }
});

// Create template
router.post('/templates', async (req, res) => {
    try {
        const templateData = {
            ...req.body,
            property: getPropertyId(req),
        };
        const MessageTemplate = getModel(req, 'MessageTemplate');
        
        const template = new MessageTemplate(templateData);
        await template.save();
        
        res.status(201).json({ 
            message: "Template created successfully", 
            template 
        });
    } catch (error) {
        console.error('Error creating template:', error);
        res.status(500).json({ message: "Server error creating template." });
    }
});

// Update template
router.put('/templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid template ID format' });
        }

        // Validate update fields (all optional)
        const updateSchema = {
            name: { type: 'string' },
            subject: { type: 'string' },
            content: { type: 'string' },
            category: { type: 'string' },
            isActive: { type: 'boolean' }
        };

        const validation = validateAndSetDefaults(req.body, updateSchema);
        if (!validation.isValid) {
            return res.status(400).json({ message: validation.errors.join(', ') });
        }

        const updateData = { ...validation.validated };
        delete updateData.property;
        const MessageTemplate = getModel(req, 'MessageTemplate');
        
        const template = await MessageTemplate.findOneAndUpdate(
            { _id: id, property: getPropertyId(req) },
            updateData,
            { new: true, runValidators: true }
        );
        
        if (!template) {
            return res.status(404).json({ message: "Template not found" });
        }
        
        res.status(200).json({ 
            message: "Template updated successfully", 
            template 
        });
    } catch (error) {
        console.error('Error updating template:', error);
        res.status(500).json({ message: "Server error updating template." });
    }
});

// Delete template
router.delete('/templates/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Validate ObjectId
        if (!isValidObjectId(id)) {
            return res.status(400).json({ message: 'Invalid template ID format' });
        }
        
        const MessageTemplate = getModel(req, 'MessageTemplate');
        
        const template = await MessageTemplate.findOneAndDelete({ _id: id, property: getPropertyId(req) });
        
        if (!template) {
            return res.status(404).json({ message: "Template not found" });
        }
        
        res.status(200).json({ message: "Template deleted successfully" });
    } catch (error) {
        console.error('Error deleting template:', error);
        res.status(500).json({ message: "Server error deleting template." });
    }
});

// ========== TAGS ==========

// Get all available tags from guest profiles
router.get('/tags', async (req, res) => {
    try {
        const GuestProfiles = getModel(req, 'GuestProfiles');
        const guests = await GuestProfiles.find({
            property: getPropertyId(req),
            tags: { $exists: true, $ne: [] }
        }).select('tags');
        const allTags = new Set();
        
        guests.forEach(guest => {
            if (guest.tags && Array.isArray(guest.tags)) {
                guest.tags.forEach(tag => {
                    if (tag && tag.trim()) {
                        allTags.add(tag.trim());
                    }
                });
            }
        });
        
        res.status(200).json({ 
            tags: Array.from(allTags).sort() 
        });
    } catch (error) {
        console.error('Error fetching tags:', error);
        res.status(500).json({ message: "Server error fetching tags." });
    }
});

// ========== ANALYTICS ==========

// Get communication analytics
router.get('/analytics', async (req, res) => {
    try {
        const propertyId = getPropertyId(req);
        const Conversation = getModel(req, 'Conversation');
        const Message = getModel(req, 'Message');
        const Campaign = getModel(req, 'Campaign');

        const totalConversations = await Conversation.countDocuments({ property: propertyId });
        const openConversations = await Conversation.countDocuments({ property: propertyId, status: 'open' });
        const totalMessages = await Message.countDocuments({ property: propertyId });
        const totalCampaigns = await Campaign.countDocuments({ property: propertyId, status: 'Sent' });
        
        // Get recent activity
        const recentMessages = await Message.find({ property: propertyId })
            .sort({ createdAt: -1 })
            .limit(10)
            .populate('conversationId', 'guestName');
        
        // Calculate average open rate for campaigns
        const sentCampaigns = await Campaign.find({ property: propertyId, status: 'Sent' });
        let totalOpenRate = 0;
        let campaignsWithDeliveries = 0;
        
        sentCampaigns.forEach(camp => {
            if (camp.delivered > 0) {
                totalOpenRate += (camp.opened / camp.delivered) * 100;
                campaignsWithDeliveries++;
            }
        });
        
        const avgOpenRate = campaignsWithDeliveries > 0 
            ? (totalOpenRate / campaignsWithDeliveries).toFixed(2)
            : 0;
        
        res.status(200).json({
            overview: {
                totalConversations,
                openConversations,
                closedConversations: totalConversations - openConversations,
                totalMessages,
                totalCampaigns,
                avgOpenRate: parseFloat(avgOpenRate)
            },
            recentActivity: recentMessages
        });
    } catch (error) {
        console.error('Error fetching analytics:', error);
        res.status(500).json({ message: "Server error fetching analytics." });
    }
});

module.exports = router;

