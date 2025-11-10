const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../../middleware/auth');
const {
  hashPassword,
  verifyPassword,
  encryptPassword,
  decryptPassword,
} = require('../../utils/emailPasswordVault');

const router = express.Router();

router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('settings'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

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
    
    const payload = property.toObject();
    delete payload.emailPasswordHash;
    delete payload.emailPasswordEncrypted;

    res.status(200).json(payload);
  } catch (error) {
    console.error('Error fetching property details:', error);
    res.status(500).json({ message: 'Server error fetching property details.' });
  }
});

// Update property details
router.put('/property', async (req, res) => {
  try {
    const updateData = { ...req.body };
    const { emailPassword } = updateData;
    delete updateData.property;
    delete updateData.emailPassword;
    const propertyId = getPropertyId(req);
    const PropertyDetails = getModel(req, 'PropertyDetails');
    
    let property = await PropertyDetails.findOne({ property: propertyId });
    
    if (property) {
      if (property.emailPasswordHash) {
        if (!emailPassword) {
          return res.status(400).json({ message: 'Email password is required to save changes.' });
        }
        const isValid = await verifyPassword(emailPassword, property.emailPasswordHash);
        if (!isValid) {
          return res.status(403).json({ message: 'Invalid email password. Changes not saved.' });
        }
      } else if (!emailPassword) {
        return res.status(400).json({ message: 'Email password is required to save changes.' });
      }

      if (emailPassword) {
        updateData.emailPasswordHash = await hashPassword(emailPassword);
        updateData.emailPasswordEncrypted = encryptPassword(emailPassword);
      }

      // Update existing property
      const updatedProperty = await PropertyDetails.findOneAndUpdate(
        { _id: property._id, property: propertyId },
        updateData,
        { new: true, runValidators: true }
      );
      const responsePayload = updatedProperty.toObject();
      delete responsePayload.emailPasswordHash;
      delete responsePayload.emailPasswordEncrypted;
      res.status(200).json({ 
        message: 'Property details updated successfully', 
        property: responsePayload 
      });
    } else {
      if (!emailPassword) {
        return res.status(400).json({ message: 'Email password is required to create property details.' });
      }
      updateData.emailPasswordHash = await hashPassword(emailPassword);
      updateData.emailPasswordEncrypted = encryptPassword(emailPassword);
      // Create new property
      const newProperty = new PropertyDetails({
        ...updateData,
        property: propertyId,
      });
      await newProperty.save();
      const responsePayload = newProperty.toObject();
      delete responsePayload.emailPasswordHash;
      delete responsePayload.emailPasswordEncrypted;
      res.status(201).json({ 
        message: 'Property details created successfully', 
        property: responsePayload 
      });
    }
  } catch (error) {
    console.error('Error updating property details:', error);
    res.status(500).json({ message: 'Server error updating property details.' });
  }
});

router.post('/property/email/verify', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }
    const PropertyDetails = getModel(req, 'PropertyDetails');
    const property = await PropertyDetails.findOne({ property: getPropertyId(req) });
    if (!property || !property.emailPasswordHash) {
      return res.status(404).json({ message: 'No password configured for this property.' });
    }
    const isValid = await verifyPassword(password, property.emailPasswordHash);
    if (!isValid) {
      return res.status(401).json({ valid: false, message: 'Incorrect password.' });
    }
    return res.status(200).json({ valid: true });
  } catch (error) {
    console.error('Error verifying email password:', error);
    return res.status(500).json({ message: 'Server error verifying password.' });
  }
});

router.get('/property/email/password', async (req, res) => {
  try {
    const PropertyDetails = getModel(req, 'PropertyDetails');
    const property = await PropertyDetails.findOne({ property: getPropertyId(req) });
    if (!property || !property.emailPasswordEncrypted) {
      return res.status(404).json({ message: 'No stored password for this property.' });
    }
    const password = decryptPassword(property.emailPasswordEncrypted);
    return res.status(200).json({ email: property.email, password });
  } catch (error) {
    console.error('Error retrieving decrypted password:', error);
    return res.status(500).json({ message: 'Server error retrieving password.' });
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
