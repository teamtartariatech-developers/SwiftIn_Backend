const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
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
    const updateData = { ...req.body };
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
    const {
      fromName,
      fromEmail,
      smtpHost,
      smtpPort,
      secure,
      authUser,
      password,
    } = req.body || {};

    if (!fromName || !fromEmail || !smtpHost || !smtpPort || !authUser) {
      return res
        .status(400)
        .json({ message: 'fromName, fromEmail, smtpHost, smtpPort, and authUser are required.' });
    }

    const port = Number(smtpPort);
    if (!Number.isInteger(port) || port <= 0) {
      return res.status(400).json({ message: 'smtpPort must be a positive integer.' });
    }

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

    const verificationPayload = {
      smtpHost: smtpHost.trim(),
      smtpPort: port,
      secure: normalizeBoolean(secure),
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
      return res
        .status(400)
        .json({ message: verification.error || 'Unable to verify SMTP credentials.' });
    }

    const payload = {
      fromName: fromName.trim(),
      fromEmail: fromEmail.trim(),
      smtpHost: smtpHost.trim(),
      smtpPort: port,
      secure: normalizeBoolean(secure),
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
      integration: sanitizeEmailIntegrationResponse(integration),
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
    const TaxRule = getModel(req, 'TaxRule');
    const newTaxRule = new TaxRule({
      ...req.body,
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
    const updateData = { ...req.body };
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
    const ServiceFee = getModel(req, 'ServiceFee');
    const newServiceFee = new ServiceFee({
      ...req.body,
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
    const updateData = { ...req.body };
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

module.exports = router;
