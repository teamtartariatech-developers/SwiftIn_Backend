const nodemailer = require('nodemailer');
const { decryptPassword } = require('../utils/emailPasswordVault');

const DEFAULT_FROM_NAME = 'Hotel Management System';

const parseBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  return false;
};

const getEnvEmailConfig = () => {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const secure = parseBoolean(process.env.SMTP_SECURE);
  const authUser = process.env.SMTP_USER;
  const authPass = process.env.SMTP_PASSWORD;

  if (!smtpHost || !authUser || !authPass) {
    return null;
  }

  return {
    smtpHost,
    smtpPort: Number.isNaN(smtpPort) ? 587 : smtpPort,
    secure,
    authUser,
    authPass,
    fromEmail: process.env.SMTP_FROM || authUser,
    fromName: process.env.SMTP_FROM_NAME || DEFAULT_FROM_NAME,
  };
};

const buildTransportOptions = (config) => {
  if (!config?.smtpHost) {
    throw new Error('SMTP host is required');
  }
  if (!config?.authUser || !config?.authPass) {
    throw new Error('SMTP authentication is not configured');
  }

  return {
    host: config.smtpHost,
    port: config.smtpPort || 587,
    secure: parseBoolean(config.secure),
    auth: {
      user: config.authUser,
      pass: config.authPass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  };
};

const createTransporter = (config) => {
  const options = buildTransportOptions(config);
  return nodemailer.createTransport(options);
};

const resolveTenantEmailConfig = async (tenant) => {
  if (tenant) {
    const EmailIntegration = tenant.models.EmailIntegration;
    const integration = await EmailIntegration.findOne({ property: tenant.property._id });

    if (integration && integration.authPasswordEncrypted) {
      const authPass = decryptPassword(integration.authPasswordEncrypted);
      return {
        smtpHost: integration.smtpHost,
        smtpPort: integration.smtpPort,
        secure: integration.secure,
        authUser: integration.authUser,
        authPass,
        fromEmail: integration.fromEmail || integration.authUser,
        fromName: integration.fromName || tenant.property?.name || DEFAULT_FROM_NAME,
      };
    }
  }

  const envConfig = getEnvEmailConfig();
  if (envConfig) {
    return envConfig;
  }

  const error = new Error('EMAIL_INTEGRATION_NOT_CONFIGURED');
  error.code = 'EMAIL_INTEGRATION_NOT_CONFIGURED';
  throw error;
};

const sendEmail = async (tenant, to, subject, htmlContent, options = {}) => {
  try {
    const config = await resolveTenantEmailConfig(tenant);
    const transporter = createTransporter(config);

    const fromEmail = options.fromEmail || config.fromEmail || config.authUser;
    const fromName =
      options.fromName || config.fromName || tenant?.property?.name || DEFAULT_FROM_NAME;

    const mailOptions = {
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html: htmlContent,
      text: typeof htmlContent === 'string' ? htmlContent.replace(/<[^>]*>/g, '') : '',
    };

    const info = await transporter.sendMail(mailOptions);
    if (typeof transporter.close === 'function') {
      await transporter.close().catch(() => {});
    }

    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
};

const sendBulkEmails = async (tenant, recipients, subject, htmlContent, options = {}) => {
  const {
    batchSize = 10,
    delayBetweenBatches = 1000,
    onProgress = null,
    fromEmail: overrideFromEmail,
    fromName: overrideFromName,
  } = options;

  const config = await resolveTenantEmailConfig(tenant);
  const transporter = createTransporter(config);

  const fromEmail = overrideFromEmail || config.fromEmail || config.authUser;
  const fromName = overrideFromName || config.fromName || tenant?.property?.name || DEFAULT_FROM_NAME;

  const results = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    errors: [],
  };

  try {
    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);

      const batchPromises = batch.map(async (recipient) => {
        try {
          const mailOptions = {
            from: `${fromName} <${fromEmail}>`,
            to: recipient.email,
            subject,
            html: htmlContent,
            text: typeof htmlContent === 'string' ? htmlContent.replace(/<[^>]*>/g, '') : '',
          };

          await transporter.sendMail(mailOptions);
          results.sent += 1;
          return true;
        } catch (error) {
          results.failed += 1;
          results.errors.push({
            email: recipient.email,
            error: error.message,
          });
          return false;
        }
      });

      await Promise.all(batchPromises);

      if (onProgress) {
        onProgress({
          processed: Math.min(i + batchSize, recipients.length),
          total: recipients.length,
          sent: results.sent,
          failed: results.failed,
        });
      }

      if (i + batchSize < recipients.length) {
        await new Promise((resolve) => setTimeout(resolve, delayBetweenBatches));
      }
    }
  } finally {
    if (typeof transporter.close === 'function') {
      await transporter.close().catch(() => {});
    }
  }

  return results;
};

const verifyEmailConfig = async (config) => {
  try {
    const transporter = createTransporter(config);
    await transporter.verify();
    if (typeof transporter.close === 'function') {
      await transporter.close().catch(() => {});
    }
    return { success: true, message: 'Email configuration is valid' };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

module.exports = {
  sendEmail,
  sendBulkEmails,
  verifyEmailConfig,
  createTransporter,
  resolveTenantEmailConfig,
};
