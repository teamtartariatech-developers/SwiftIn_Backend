const nodemailer = require('nodemailer');

// Create reusable transporter object using the default SMTP transport
const createTransporter = () => {
    // Use environment variables for email configuration
    // For development, you can use services like Gmail, Outlook, etc.
    // For production, use proper SMTP server
    
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true' ? true : false, // true for 465, false for other ports
        auth: {
            user: process.env.SMTP_USER, // Your email
            pass: process.env.SMTP_PASSWORD // Your email password or app password
        },
        // For Gmail, you may need to use an App Password instead of regular password
        // Enable this if using Gmail with 2FA
        tls: {
            rejectUnauthorized: false
        }
    });

    return transporter;
};

// Send email to a single recipient
const sendEmail = async (to, subject, htmlContent, fromEmail = null) => {
    try {
        const transporter = createTransporter();
        
        const from = fromEmail || process.env.SMTP_FROM || process.env.SMTP_USER;
        const fromName = process.env.SMTP_FROM_NAME || 'Hotel Management System';
        
        const mailOptions = {
            from: `${fromName} <${from}>`,
            to: to,
            subject: subject,
            html: htmlContent,
            // Optional: Add text version for better compatibility
            text: htmlContent.replace(/<[^>]*>/g, ''), // Strip HTML tags for text version
        };

        const info = await transporter.sendMail(mailOptions);
        return {
            success: true,
            messageId: info.messageId,
            response: info.response
        };
    } catch (error) {
        console.error('Error sending email:', error);
        return {
            success: false,
            error: error.message
        };
    }
};

// Send bulk emails (with rate limiting to avoid spam)
const sendBulkEmails = async (recipients, subject, htmlContent, options = {}) => {
    const {
        batchSize = 10, // Send emails in batches
        delayBetweenBatches = 1000, // Delay in ms between batches
        onProgress = null // Callback function for progress updates
    } = options;

    const results = {
        total: recipients.length,
        sent: 0,
        failed: 0,
        errors: []
    };

    // Process recipients in batches
    for (let i = 0; i < recipients.length; i += batchSize) {
        const batch = recipients.slice(i, i + batchSize);
        
        // Send emails in parallel for this batch
        const batchPromises = batch.map(async (recipient) => {
            const result = await sendEmail(recipient.email, subject, htmlContent);
            
            if (result.success) {
                results.sent++;
            } else {
                results.failed++;
                results.errors.push({
                    email: recipient.email,
                    error: result.error
                });
            }
            
            return result;
        });

        await Promise.all(batchPromises);
        
        // Call progress callback if provided
        if (onProgress) {
            onProgress({
                processed: Math.min(i + batchSize, recipients.length),
                total: recipients.length,
                sent: results.sent,
                failed: results.failed
            });
        }
        
        // Delay before next batch (except for last batch)
        if (i + batchSize < recipients.length) {
            await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }
    }

    return results;
};

// Verify email configuration
const verifyEmailConfig = async () => {
    try {
        const transporter = createTransporter();
        await transporter.verify();
        return { success: true, message: 'Email configuration is valid' };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

module.exports = {
    sendEmail,
    sendBulkEmails,
    verifyEmailConfig,
    createTransporter
};
