const express = require('express');
const bodyParser = require('body-parser');
const { authenticate, requireModuleAccess } = require('../middleware/auth');
const emailService = require('../services/emailService');

const router = express.Router();

router.use(bodyParser.json());
router.use(authenticate);
router.use(requireModuleAccess('guest-management'));

const getModel = (req, name) => req.tenant.models[name];
const getPropertyId = (req) => req.tenant.property._id;

const normaliseRecipients = (value) => {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const applyTemplateVariables = (content, variables = {}) => {
  if (!content || typeof content !== 'string') {
    return '';
  }

  return Object.keys(variables).reduce((compiled, key) => {
    const safeValue = variables[key] != null ? String(variables[key]) : '';
    const pattern = new RegExp(`{{\s*${key}\s*}}`, 'g');
    return compiled.replace(pattern, safeValue);
  }, content);
};

router.post('/send-template', async (req, res) => {
  try {
    const { templateName, to, subject, variables = {}, fromEmail, fromName } = req.body;
    if (!templateName || typeof templateName !== 'string') {
      return res.status(400).json({ message: 'templateName is required.' });
    }

    const recipients = normaliseRecipients(to);
    if (recipients.length === 0) {
      return res.status(400).json({ message: 'At least one recipient email address is required.' });
    }

    const EmailTemplate = getModel(req, 'EmailTemplate');
    const propertyId = getPropertyId(req);

    const template = await EmailTemplate.findOne({ template_name: templateName, property: propertyId });
    if (!template) {
      return res.status(404).json({ message: 'Email template not found.' });
    }

    const compiledHtml = applyTemplateVariables(template.content, variables);
    const mailSubject = subject || templateName;

    const sendResult = await emailService.sendEmail(
      req.tenant,
      recipients.join(','),
      mailSubject,
      compiledHtml,
      { fromEmail, fromName }
    );

    if (!sendResult.success) {
      return res.status(502).json({ message: 'Failed to send email.', error: sendResult.error });
    }

    res.status(200).json({
      message: 'Email sent successfully.',
      info: {
        messageId: sendResult.messageId,
        response: sendResult.response,
      },
    });
  } catch (error) {
    console.error('Error sending templated email:', error);
    res.status(500).json({ message: 'Server error sending email.' });
  }
});

module.exports = router;
