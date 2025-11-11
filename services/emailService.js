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

  const port = Number(config.smtpPort) || 587;
  const secure = config.secure != null ? parseBoolean(config.secure) : port === 465;
  const requireTLS =
    config.requireTLS != null ? parseBoolean(config.requireTLS) : secure ? false : true;

  return {
    host: config.smtpHost,
    port,
    secure,
    auth: {
      user: config.authUser,
      pass: config.authPass,
    },
    requireTLS,
    connectionTimeout: config.connectionTimeout || 15000,
    greetingTimeout: config.greetingTimeout || 15000,
    socketTimeout: config.socketTimeout || 15000,
    tls: {
      rejectUnauthorized: false,
    },
  };
};

const createTransporter = (config) => {
  const options = buildTransportOptions(config);
  return nodemailer.createTransport(options);
};

const isNetworkTimeout = (error) => {
  if (!error) return false;
  return ['ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND'].includes(error.code);
};

const dedupeAttempts = (attempts) => {
  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = `${attempt.smtpHost}-${attempt.smtpPort}-${attempt.secure ? 's' : 'n'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildVerificationAttempts = (config) => {
  const basePort = Number(config.smtpPort) || 587;
  const host = (config.smtpHost || '').toLowerCase();
  const attempts = [
    {
      ...config,
      smtpPort: basePort,
      secure: config.secure != null ? parseBoolean(config.secure) : basePort === 465,
    },
  ];

  const pushAttempt = (attempt) => {
    attempts.push({ ...config, ...attempt });
  };

  if (host.includes('gmail') || host.includes('googlemail')) {
    pushAttempt({ smtpPort: 465, secure: true, requireTLS: false });
    pushAttempt({ smtpPort: 587, secure: false, requireTLS: true });
  } else {
    pushAttempt({ smtpPort: 465, secure: true, requireTLS: false });
    pushAttempt({ smtpPort: 587, secure: false, requireTLS: true });
  }

  return dedupeAttempts(attempts);
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
  const attempts = buildVerificationAttempts(config);
  const errors = [];

  for (const attempt of attempts) {
    try {
      const transporter = createTransporter(attempt);
      await transporter.verify();
      if (typeof transporter.close === 'function') {
        await transporter.close().catch(() => {});
      }
      return {
        success: true,
        message: 'Email configuration is valid',
        appliedConfig: {
          host: attempt.smtpHost,
          port: attempt.smtpPort,
          secure: parseBoolean(attempt.secure),
        },
      };
    } catch (error) {
      errors.push({
        attempt: {
          host: attempt.smtpHost,
          port: attempt.smtpPort,
          secure: parseBoolean(attempt.secure),
        },
        error: {
          message: error.message,
          code: error.code,
        },
      });

      if (!isNetworkTimeout(error)) {
        break;
      }
    }
  }

  const primaryError = errors[errors.length - 1] || {};
  let message = primaryError.error?.message || 'Unable to verify SMTP credentials.';

  if (isNetworkTimeout(primaryError.error)) {
    message =
      'Connection timeout. Please verify the port, firewall rules, and that SMTP/IMAP access is allowed for the account. For Gmail, try port 465 with SSL enabled or port 587 with TLS (secure disabled).';
  }

  return {
    success: false,
    error: message,
    attempts: errors,
  };
};

module.exports = {
  sendEmail,
  sendBulkEmails,
  verifyEmailConfig,
  createTransporter,
  resolveTenantEmailConfig,
};
