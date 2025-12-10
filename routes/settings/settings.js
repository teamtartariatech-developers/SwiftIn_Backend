const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const { validateAndSetDefaults, isValidEmail, isValidObjectId } = require('../../utils/validation');
const {
  hashPassword,
  encryptPassword,
  decryptPassword,
} = require('../../utils/emailPasswordVault');
const emailService = require('../../services/emailService');

const router = express.Router();

router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('settings'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

const normalizeBoolean = (value, defaultValue = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }
  return defaultValue;
};

const sanitizeEmailIntegrationResponse = (integration) => {
  if (!integration) return null;

  return {
    id: integration._id,
    fromName: integration.fromName,
    fromEmail: integration.fromEmail,
    smtpHost: integration.smtpHost,
    smtpPort: integration.smtpPort,
    secure: integration.secure,
    authUser: integration.authUser,
    status: integration.status,
    verifiedAt: integration.verifiedAt,
    lastError: integration.lastError,
    updatedAt: integration.updatedAt,
    createdAt: integration.createdAt,
    hasPassword: Boolean(integration.authPasswordEncrypted),
  };
};

// ===== PROPERTY DETAILS ROUTES =====

// Get property details
router.get('/property', async (req, res) => {
  try {
    const propertyId = getPropertyId(req);
    const PropertyDetails = getModel(req, 'PropertyDetails');
    let property = await PropertyDetails.findOne({ property: propertyId });
    
    // If no property exists, create default one
    if (!property) {
      property = new PropertyDetails({
        propertyName: 'Phoenix Hotel & Resort',
        address: '123 Business District, Mumbai, Maharashtra 400001',
        phone: '+91 22 1234 5678',
        email: 'info@phoenixhotel.com',
        website: 'www.phoenixhotel.com',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        gstin: '27ABCDE1234F1Z5',
        checkInTime: '14:00',
        checkOutTime: '11:00',
        cancellationPolicy: 'Cancellation is free up to 24 hours before check-in. Cancellations made within 24 hours of check-in will be charged 50% of the total booking amount.',
        generalPolicies: 'Check-in time is 2:00 PM and check-out time is 11:00 AM. Early check-in and late check-out are subject to availability and may incur additional charges. Smoking is not allowed in any room. Pets are not allowed.',
        gstRate: 18,
        serviceChargeRate: 10,
        property: propertyId
      });
      await property.save();
    }
    
    res.status(200).json(property);
  } catch (error) {
    console.error('Error fetching property details:', error);
    res.status(500).json({ message: 'Server error fetching property details.' });
  }
});

// Update property details
router.put('/property', async (req, res) => {
  try {
    // Validate update fields (all optional)
    const propertySchema = {
      propertyName: { type: 'string' },
      address: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string', custom: (val) => !val || isValidEmail(val) || 'Invalid email format' },
      website: { type: 'string' },
      currency: { type: 'string' },
      timezone: { type: 'string' },
      gstin: { type: 'string' },
      checkInTime: { type: 'string' },
      checkOutTime: { type: 'string' },
      cancellationPolicy: { type: 'string' },
      generalPolicies: { type: 'string' },
      gstRate: { type: 'number', min: 0, max: 100 },
      serviceChargeRate: { type: 'number', min: 0, max: 100 }
    };

    const validation = validateAndSetDefaults(req.body, propertySchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const updateData = { ...validation.validated };
    delete updateData.property;

    const propertyId = getPropertyId(req);
    const PropertyDetails = getModel(req, 'PropertyDetails');

    const existingProperty = await PropertyDetails.findOne({ property: propertyId });

    if (existingProperty) {
      const updatedProperty = await PropertyDetails.findOneAndUpdate(
        { _id: existingProperty._id, property: propertyId },
        updateData,
        { new: true, runValidators: true },
      );

      return res.status(200).json({
        message: 'Property details updated successfully',
        property: updatedProperty,
      });
    }

    const newProperty = new PropertyDetails({
      ...updateData,
      property: propertyId,
    });
    await newProperty.save();

    res.status(201).json({
      message: 'Property details created successfully',
      property: newProperty,
    });
  } catch (error) {
    console.error('Error updating property details:', error);
    res.status(500).json({ message: 'Server error updating property details.' });
  }
});

// Get Property model info (including allowedrooms)
router.get('/property/info', async (req, res) => {
  try {
    const property = req.tenant.property;
    res.status(200).json({
      _id: property._id,
      name: property.name,
      code: property.code,
      status: property.status,
      allowedrooms: property.allowedrooms || 15,
      metadata: property.metadata,
    });
  } catch (error) {
    console.error('Error fetching property info:', error);
    res.status(500).json({ message: 'Server error fetching property info.' });
  }
});

// ===== EMAIL INTEGRATION ROUTES =====

router.get('/integrations/email', async (req, res) => {
  try {
    const EmailIntegration = getModel(req, 'EmailIntegration');
    const integration = await EmailIntegration.findOne({ property: getPropertyId(req) });

    if (!integration) {
      return res.status(200).json({
        status: 'disconnected',
        hasPassword: false,
      });
    }

    res.status(200).json(sanitizeEmailIntegrationResponse(integration));
  } catch (error) {
    console.error('Error fetching email integration:', error);
    res.status(500).json({ message: 'Server error fetching email integration.' });
  }
});

router.post('/integrations/email', async (req, res) => {
  try {
    // Validate and set defaults
    const emailSchema = {
      fromName: { type: 'string', required: true },
      fromEmail: { type: 'string', required: true, custom: (val) => isValidEmail(val) || 'Invalid email format' },
      smtpHost: { type: 'string', required: true },
      smtpPort: { type: 'number', required: true, min: 1, max: 65535, custom: (val) => Number.isInteger(val) || 'smtpPort must be an integer' },
      secure: { type: 'boolean' },
      authUser: { type: 'string', required: true },
      password: { type: 'string' }
    };

    const validation = validateAndSetDefaults(req.body || {}, emailSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const {
      fromName,
      fromEmail,
      smtpHost,
      smtpPort,
      secure,
      authUser,
      password,
    } = validation.validated;

    const port = smtpPort; // Already validated as integer

    const EmailIntegration = getModel(req, 'EmailIntegration');
    const propertyId = getPropertyId(req);
    const existing = await EmailIntegration.findOne({ property: propertyId });

    let authPassword = password?.trim();
    if (!authPassword && existing?.authPasswordEncrypted) {
      authPassword = decryptPassword(existing.authPasswordEncrypted);
    }

    if (!authPassword) {
      return res.status(400).json({ message: 'SMTP password is required.' });
    }

    const normalizedSecure =
      secure === undefined || secure === null ? port === 465 : normalizeBoolean(secure);

    const verificationPayload = {
      smtpHost: smtpHost.trim(),
      smtpPort: port,
      secure: normalizedSecure,
      authUser: authUser.trim(),
      authPass: authPassword,
    };

    const verification = await emailService.verifyEmailConfig(verificationPayload);
    if (!verification.success) {
      if (existing) {
        existing.status = 'error';
        existing.lastError = verification.error;
        await existing.save().catch(() => {});
      }
      return res.status(400).json({
        message: verification.error || 'Unable to verify SMTP credentials.',
        attempts: verification.attempts || [],
        appliedConfig: verification.appliedConfig,
      });
    }

    const payload = {
      fromName: fromName.trim(),
      fromEmail: fromEmail.trim(),
      smtpHost: smtpHost.trim(),
      smtpPort: port,
      secure: verification.appliedConfig?.secure ?? normalizedSecure,
      authUser: authUser.trim(),
      status: 'connected',
      verifiedAt: new Date(),
      lastError: null,
    };

    if (password) {
      payload.authPasswordHash = await hashPassword(authPassword);
      payload.authPasswordEncrypted = encryptPassword(authPassword);
    } else if (existing) {
      payload.authPasswordHash = existing.authPasswordHash;
      payload.authPasswordEncrypted = existing.authPasswordEncrypted;
    }

    let integration;
    if (existing) {
      integration = await EmailIntegration.findOneAndUpdate(
        { _id: existing._id, property: propertyId },
        payload,
        { new: true, runValidators: true },
      );
    } else {
      integration = new EmailIntegration({
        ...payload,
        property: propertyId,
      });
      await integration.save();
    }

    res.status(existing ? 200 : 201).json({
      message: existing
        ? 'Email integration updated successfully.'
        : 'Email integration connected successfully.',
      integration: {
        ...sanitizeEmailIntegrationResponse(integration),
        appliedConfig: verification.appliedConfig,
        hasPassword: Boolean(integration.authPasswordEncrypted),
        attempts: verification.attempts || [],
      },
    });
  } catch (error) {
    console.error('Error saving email integration:', error);
    res.status(500).json({ message: 'Server error saving email integration.' });
  }
});

router.delete('/integrations/email', async (req, res) => {
  try {
    const EmailIntegration = getModel(req, 'EmailIntegration');
    const deleted = await EmailIntegration.findOneAndDelete({ property: getPropertyId(req) });
    if (!deleted) {
      return res.status(404).json({ message: 'Email integration not found.' });
    }
    res.status(200).json({ message: 'Email integration disconnected successfully.' });
  } catch (error) {
    console.error('Error deleting email integration:', error);
    res.status(500).json({ message: 'Server error disconnecting email integration.' });
  }
});

// ===== TAX RULES ROUTES =====

// Get all tax rules
router.get('/taxes', async (req, res) => {
  try {
    const TaxRule = getModel(req, 'TaxRule');
    const taxRules = await TaxRule.find({
      property: getPropertyId(req),
      isActive: true
    }).sort({ createdAt: -1 });
    res.status(200).json(taxRules);
  } catch (error) {
    console.error('Error fetching tax rules:', error);
    res.status(500).json({ message: 'Server error fetching tax rules.' });
  }
});

// Create tax rule
router.post('/taxes', async (req, res) => {
  try {
    // Validate and set defaults
    const taxSchema = {
      name: { type: 'string', required: true },
      rate: { type: 'number', required: true, min: 0 },
      isPercentage: { type: 'boolean', default: true },
      applicableOn: { type: 'string', default: 'total_amount', enum: ['room_rate', 'total_amount', 'all'] },
      isActive: { type: 'boolean', default: true }
    };

    const validation = validateAndSetDefaults(req.body, taxSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const TaxRule = getModel(req, 'TaxRule');
    const newTaxRule = new TaxRule({
      ...validation.validated,
      property: getPropertyId(req),
    });
    await newTaxRule.save();
    res.status(201).json({ 
      message: 'Tax rule created successfully', 
      taxRule: newTaxRule 
    });
  } catch (error) {
    console.error('Error creating tax rule:', error);
    res.status(500).json({ message: 'Server error creating tax rule.' });
  }
});

// Update tax rule
router.put('/taxes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tax rule ID format' });
    }

    // Validate update fields
    const updateSchema = {
      name: { type: 'string' },
      rate: { type: 'number', min: 0 },
      isPercentage: { type: 'boolean' },
      applicableOn: { type: 'string', enum: ['room_rate', 'total_amount', 'all'] },
      isActive: { type: 'boolean' }
    };

    const validation = validateAndSetDefaults(req.body, updateSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const updateData = { ...validation.validated };
    delete updateData.property;
    const TaxRule = getModel(req, 'TaxRule');

    const updatedTaxRule = await TaxRule.findOneAndUpdate(
      { _id: id, property: getPropertyId(req) },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!updatedTaxRule) {
      return res.status(404).json({ message: 'Tax rule not found.' });
    }
    
    res.status(200).json({ 
      message: 'Tax rule updated successfully', 
      taxRule: updatedTaxRule 
    });
  } catch (error) {
    console.error('Error updating tax rule:', error);
    res.status(500).json({ message: 'Server error updating tax rule.' });
  }
});

// Delete tax rule (soft delete)
router.delete('/taxes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid tax rule ID format' });
    }
    
    const TaxRule = getModel(req, 'TaxRule');
    const updatedTaxRule = await TaxRule.findOneAndUpdate(
      { _id: id, property: getPropertyId(req) },
      { isActive: false },
      { new: true }
    );
    
    if (!updatedTaxRule) {
      return res.status(404).json({ message: 'Tax rule not found.' });
    }
    
    res.status(200).json({ 
      message: 'Tax rule deleted successfully', 
      taxRule: updatedTaxRule 
    });
  } catch (error) {
    console.error('Error deleting tax rule:', error);
    res.status(500).json({ message: 'Server error deleting tax rule.' });
  }
});

// ===== SERVICE FEES ROUTES =====

// Get all service fees
router.get('/fees', async (req, res) => {
  try {
    const ServiceFee = getModel(req, 'ServiceFee');
    const serviceFees = await ServiceFee.find({
      property: getPropertyId(req),
      isActive: true
    }).sort({ createdAt: -1 });
    res.status(200).json(serviceFees);
  } catch (error) {
    console.error('Error fetching service fees:', error);
    res.status(500).json({ message: 'Server error fetching service fees.' });
  }
});

// Create service fee
router.post('/fees', async (req, res) => {
  try {
    // Validate and set defaults
    const feeSchema = {
      name: { type: 'string', required: true },
      amount: { type: 'number', required: true, min: 0 },
      isPercentage: { type: 'boolean', default: false },
      applicableOn: { type: 'string', required: true, enum: ['per_night', 'per_booking', 'per_person', 'per_person_per_night', 'room_rate', 'total_amount'] },
      isActive: { type: 'boolean', default: true }
    };

    const validation = validateAndSetDefaults(req.body, feeSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const ServiceFee = getModel(req, 'ServiceFee');
    const newServiceFee = new ServiceFee({
      ...validation.validated,
      property: getPropertyId(req),
    });
    await newServiceFee.save();
    res.status(201).json({ 
      message: 'Service fee created successfully', 
      serviceFee: newServiceFee 
    });
  } catch (error) {
    console.error('Error creating service fee:', error);
    res.status(500).json({ message: 'Server error creating service fee.' });
  }
});

// Update service fee
router.put('/fees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid service fee ID format' });
    }

    // Validate update fields
    const updateSchema = {
      name: { type: 'string' },
      amount: { type: 'number', min: 0 },
      isPercentage: { type: 'boolean' },
      applicableOn: { type: 'string', enum: ['per_night', 'per_booking', 'per_person', 'per_person_per_night', 'room_rate', 'total_amount'] },
      isActive: { type: 'boolean' }
    };

    const validation = validateAndSetDefaults(req.body, updateSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const updateData = { ...validation.validated };
    delete updateData.property;
    const ServiceFee = getModel(req, 'ServiceFee');

    const updatedServiceFee = await ServiceFee.findOneAndUpdate(
      { _id: id, property: getPropertyId(req) },
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!updatedServiceFee) {
      return res.status(404).json({ message: 'Service fee not found.' });
    }
    
    res.status(200).json({ 
      message: 'Service fee updated successfully', 
      serviceFee: updatedServiceFee 
    });
  } catch (error) {
    console.error('Error updating service fee:', error);
    res.status(500).json({ message: 'Server error updating service fee.' });
  }
});

// Delete service fee (soft delete)
router.delete('/fees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid service fee ID format' });
    }
    
    const ServiceFee = getModel(req, 'ServiceFee');
    const updatedServiceFee = await ServiceFee.findOneAndUpdate(
      { _id: id, property: getPropertyId(req) },
      { isActive: false },
      { new: true }
    );
    
    if (!updatedServiceFee) {
      return res.status(404).json({ message: 'Service fee not found.' });
    }
    
    res.status(200).json({ 
      message: 'Service fee deleted successfully', 
      serviceFee: updatedServiceFee 
    });
  } catch (error) {
    console.error('Error deleting service fee:', error);
    res.status(500).json({ message: 'Server error deleting service fee.' });
  }
});

// ===== AI SETTINGS ROUTES =====

// Get AI settings
router.get('/ai', async (req, res) => {
  try {
    const propertyId = getPropertyId(req);
    const AISettings = getModel(req, 'AISettings');
    let aiSettings = await AISettings.findOne({ property: propertyId });
    
    // If no AI settings exist, create default one
    if (!aiSettings) {
      aiSettings = new AISettings({
        language: 'english',
        property: propertyId
      });
      await aiSettings.save();
    }
    
    res.status(200).json(aiSettings);
  } catch (error) {
    console.error('Error fetching AI settings:', error);
    res.status(500).json({ message: 'Server error fetching AI settings.' });
  }
});

// Update AI settings
router.put('/ai', async (req, res) => {
  try {
    // Validate and set defaults
    const validLanguages = [
      'english',
      'hindi',
      'hindi-roman',
      'bengali',
      'bengali-roman',
      'telugu',
      'telugu-roman',
      'marathi',
      'marathi-roman',
      'tamil',
      'tamil-roman',
      'gujarati',
      'gujarati-roman',
      'kannada',
      'kannada-roman',
      'malayalam',
      'malayalam-roman',
      'odia',
      'odia-roman',
      'punjabi',
      'punjabi-roman',
      'assamese',
      'assamese-roman',
      'urdu',
      'urdu-roman'
    ];

    const aiSchema = {
      language: { type: 'string', required: true, enum: validLanguages },
      model: { type: 'string' },
      temperature: { type: 'number', min: 0, max: 2 },
      maxTokens: { type: 'number', min: 1, max: 4000 },
      enabled: { type: 'boolean', default: true }
    };

    const validation = validateAndSetDefaults(req.body, aiSchema);
    if (!validation.isValid) {
      return res.status(400).json({ message: validation.errors.join(', ') });
    }

    const { language, model, temperature, maxTokens, enabled } = validation.validated;
    
    const propertyId = getPropertyId(req);
    const AISettings = getModel(req, 'AISettings');
    
    const existingSettings = await AISettings.findOne({ property: propertyId });
    
    const updateData = { language };
    if (model !== undefined) updateData.model = model;
    if (temperature !== undefined) updateData.temperature = temperature;
    if (maxTokens !== undefined) updateData.maxTokens = maxTokens;
    if (enabled !== undefined) updateData.enabled = enabled;

    if (existingSettings) {
      const updatedSettings = await AISettings.findOneAndUpdate(
        { _id: existingSettings._id, property: propertyId },
        updateData,
        { new: true, runValidators: true }
      );
      
      return res.status(200).json({
        message: 'AI settings updated successfully',
        aiSettings: updatedSettings,
      });
    }
    
    const newSettings = new AISettings({
      ...updateData,
      property: propertyId,
    });
    await newSettings.save();
    
    res.status(201).json({
      message: 'AI settings created successfully',
      aiSettings: newSettings,
    });
  } catch (error) {
    console.error('Error updating AI settings:', error);
    res.status(500).json({ message: 'Server error updating AI settings.' });
  }
});

module.exports = router;
