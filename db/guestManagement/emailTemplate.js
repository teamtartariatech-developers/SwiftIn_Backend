const mongoose = require('mongoose');
const propertyScoped = require('../plugins/propertyScoped');

const emailTemplateSchema = new mongoose.Schema(
    {
        template_name: {
            type: String,
            required: true,
            trim: true,
        },
        subject: {
            type: String,
            trim: true,
        },
        content: {
            type: String,
            required: true,
        },
    },
    { timestamps: true },
);

emailTemplateSchema.plugin(propertyScoped);
emailTemplateSchema.index({ template_name: 1, property: 1 }, { unique: true });

const EmailTemplateModel =
    mongoose.models.EmailTemplate || mongoose.model('EmailTemplate', emailTemplateSchema);

module.exports = EmailTemplateModel;
module.exports.schema = emailTemplateSchema;

