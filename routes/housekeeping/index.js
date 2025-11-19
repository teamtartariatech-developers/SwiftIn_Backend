const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { broadcastHousekeepingMessage } = require('../../services/housekeepingWebsocket');
const { validateAndSetDefaults, isValidObjectId } = require('../../utils/validation');

const router = express.Router();

router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('housekeeping'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

const mapMessage = (doc) => ({
  id: doc._id,
  text: doc.text,
  createdAt: doc.createdAt,
  userId: doc.user?.id,
  userName: doc.user?.name,
  userRole: doc.user?.role,
});

router.get('/maintenance', async (req, res) => {
  try {
    const MaintenanceLog = getModel(req, 'MaintenanceLog');
    const propertyId = getPropertyId(req);
    const { status = '' } = req.query;

    const filter = { property: propertyId };
    if (status && status !== 'all') {
      // Validate status enum
      const validStatuses = ['open', 'in-progress', 'resolved', 'cancelled'];
      if (validStatuses.includes(status)) {
        filter.status = status;
      }
    }

    const logs = await MaintenanceLog.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ logs });
  } catch (error) {
    console.error('Failed to fetch maintenance logs:', error);
    res.status(500).json({ message: 'Server error fetching maintenance logs.' });
  }
});

router.post('/maintenance', async (req, res) => {
  try {
    // Validate and set defaults
    const maintenanceSchema = {
      location: { type: 'string', required: true },
      description: { type: 'string', required: true },
      priority: { type: 'string', default: 'medium', enum: ['low', 'medium', 'high', 'urgent'] },
      notes: { type: 'string', default: '' }
    };

    const validation = validateAndSetDefaults(req.body, maintenanceSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const { location, description, priority, notes } = validation.validated;

    const MaintenanceLog = getModel(req, 'MaintenanceLog');
    const propertyId = getPropertyId(req);

    const log = new MaintenanceLog({
      location,
      description,
      priority,
      notes,
      property: propertyId,
      reportedBy: {
        id: req.user.id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
      },
      history: [
        {
          status: 'open',
          note: notes,
          updatedBy: {
            id: req.user.id,
            name: req.user.name,
            role: req.user.role,
          },
          updatedAt: new Date(),
        },
      ],
    });

    await log.save();
    res.status(201).json(log);
  } catch (error) {
    console.error('Failed to create maintenance log:', error);
    res.status(500).json({ message: 'Server error creating maintenance log.' });
  }
});

router.put('/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid maintenance log ID format' });
    }

    // Validate update fields
    const updateSchema = {
      status: { type: 'string', enum: ['open', 'in-progress', 'resolved', 'cancelled'] },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      notes: { type: 'string' },
      assignedTo: { type: 'object' }
    };

    const validation = validateAndSetDefaults(req.body, updateSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const { status, priority, notes, assignedTo } = validation.validated;
    const propertyId = getPropertyId(req);
    const MaintenanceLog = getModel(req, 'MaintenanceLog');

    const update = {};
    const historyEntry = {
      updatedBy: {
        id: req.user.id,
        name: req.user.name,
        role: req.user.role,
      },
      updatedAt: new Date(),
    };
    let hasHistoryChange = false;

    if (status) {
      update.status = status;
      historyEntry.status = status;
      hasHistoryChange = true;
      if (status === 'resolved') {
        update.resolvedAt = new Date();
      } else if (status === 'open') {
        update.resolvedAt = null;
      }
    }

    if (priority) {
      update.priority = priority;
    }

    if (notes) {
      update.notes = notes;
      historyEntry.note = notes;
      hasHistoryChange = true;
    }

    if (assignedTo?.name) {
      update.assignedTo = {
        id: assignedTo.id,
        name: assignedTo.name,
      };
      const assignmentNote = `Assigned to ${assignedTo.name}`;
      historyEntry.note = historyEntry.note ? `${historyEntry.note} • ${assignmentNote}` : assignmentNote;
      hasHistoryChange = true;
    }

    if (!Object.keys(update).length && !hasHistoryChange) {
      return res.status(400).json({ message: 'No changes provided.' });
    }

    const updateQuery = {
      $set: update,
    };

    if (hasHistoryChange) {
      updateQuery.$push = {
        history: historyEntry,
      };
    }

    const log = await MaintenanceLog.findOneAndUpdate(
      { _id: id, property: propertyId },
      updateQuery,
      { new: true }
    );

    if (!log) {
      return res.status(404).json({ message: 'Maintenance log not found.' });
    }

    res.json(log);
  } catch (error) {
    console.error('Failed to update maintenance log:', error);
    res.status(500).json({ message: 'Server error updating maintenance log.' });
  }
});

router.get('/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid maintenance log ID format' });
    }
    
    const propertyId = getPropertyId(req);
    const MaintenanceLog = getModel(req, 'MaintenanceLog');
    const log = await MaintenanceLog.findOne({ _id: id, property: propertyId });
    if (!log) {
      return res.status(404).json({ message: 'Maintenance log not found.' });
    }
    res.json(log);
  } catch (error) {
    console.error('Failed to fetch maintenance log:', error);
    res.status(500).json({ message: 'Server error fetching maintenance log.' });
  }
});

router.get('/messages', async (req, res) => {
  try {
    // Validate query parameters
    const querySchema = {
      limit: { type: 'number', default: 50, min: 1, max: 200 }
    };

    const validation = validateAndSetDefaults(req.query, querySchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const HousekeepingMessage = getModel(req, 'HousekeepingMessage');
    const propertyId = getPropertyId(req);
    const limit = validation.validated.limit;

    const messages = await HousekeepingMessage.find({ property: propertyId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      messages: messages.reverse().map(mapMessage),
    });
  } catch (error) {
    console.error('Failed to fetch housekeeping messages:', error);
    res.status(500).json({ message: 'Server error fetching messages.' });
  }
});

router.post('/messages', async (req, res) => {
  try {
    // Validate and set defaults
    const messageSchema = {
      text: { type: 'string', required: true, custom: (val) => val && val.trim().length > 0 || 'Message text is required and cannot be empty' }
    };

    const validation = validateAndSetDefaults(req.body, messageSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const { text } = validation.validated;

    const HousekeepingMessage = getModel(req, 'HousekeepingMessage');
    const propertyId = getPropertyId(req);

    const doc = await HousekeepingMessage.create({
      text: text.trim(),
      property: propertyId,
      user: {
        id: req.user.id,
        name: req.user.name,
        role: req.user.role,
      },
    });

    const payload = mapMessage(doc);
    broadcastHousekeepingMessage({
      ...payload,
      property: propertyId.toString(),
    });

    res.status(201).json(payload);
  } catch (error) {
    console.error('Failed to create housekeeping message:', error);
    res.status(500).json({ message: 'Server error posting message.' });
  }
});

module.exports = router;

