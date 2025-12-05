const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();

// Dummy SMTP configuration - user will change these values
const DUMMY_SMTP_CONFIG = {
  host: 'smtp.example.com',
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: 'dummy@example.com',
    pass: 'dummy_password',
  },
  fromEmail: 'dummy@example.com',
  fromName: 'Independent Mailer',
};

// Create transporter with dummy config
const createTransporter = () => {
  return nodemailer.createTransport({
    host: DUMMY_SMTP_CONFIG.host,
    port: DUMMY_SMTP_CONFIG.port,
    secure: DUMMY_SMTP_CONFIG.secure,
    auth: {
      user: DUMMY_SMTP_CONFIG.auth.user,
      pass: DUMMY_SMTP_CONFIG.auth.pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
};

// POST /api/mailer
router.post('/', async (req, res) => {
  try {
    const { subject, body, to } = req.body;

    // Validate required fields
    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'subject is required and must be a string',
      });
    }

    if (!body || typeof body !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'body is required and must be a string',
      });
    }

    // Use provided 'to' email or default to dummy email
    const recipientEmail = to && typeof to === 'string' ? to : DUMMY_SMTP_CONFIG.fromEmail;

    // Create transporter
    const transporter = createTransporter();

    // Prepare email options
    const mailOptions = {
      from: `${DUMMY_SMTP_CONFIG.fromName} <${DUMMY_SMTP_CONFIG.fromEmail}>`,
      to: recipientEmail,
      subject: subject,
      html: body,
      text: body.replace(/<[^>]*>/g, ''), // Plain text version
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);

    // Close transporter
    if (typeof transporter.close === 'function') {
      try {
        transporter.close();
      } catch (closeError) {
        // Ignore close error
      }
    }

    res.status(200).json({
      success: true,
      message: 'Email sent successfully',
      info: {
        messageId: info.messageId,
        response: info.response,
      },
    });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send email',
      error: error.message,
    });
  }
});

module.exports = router;

