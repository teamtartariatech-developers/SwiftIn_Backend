/**
 * Generic script to add/update Email Templates to the database
 * 
 * Usage: 
 *   node scripts/addTemplate.js --name "Template Name" --subject "Email Subject" --file "path/to/template.html"
 *   node scripts/addTemplate.js --name "Template Name" --subject "Email Subject" --content "<html>...</html>"
 *   node scripts/addTemplate.js --name "cityLedgerInvoice" --subject "Invoice - {{accountName}}" --file "templates/cityLedgerInvoice.html"
 * 
 * Arguments:
 *   --name        (required) Template name (must match template_name field)
 *   --subject     (required) Email subject line (can include variables like {{variableName}})
 *   --file        (optional) Path to HTML template file
 *   --content     (optional) HTML content as string (use --file or --content, not both)
 *   --token       (optional) JWT token for authentication (defaults to hardcoded token)
 *   --property    (optional) Property ID (if not provided, will be extracted from JWT token)
 * 
 * Examples:
 *   node scripts/addTemplate.js --name "cityLedgerInvoice" --subject "Invoice - {{accountName}}" --file "templates/cityLedgerInvoice.html"
 *   node scripts/addTemplate.js --name "welcomeEmail" --subject "Welcome to {{propertyName}}" --content "<html><body>Welcome {{guestName}}</body></html>"
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

// Default JWT token (can be overridden with --token argument)
const DEFAULT_JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2OTEwYjdkMWE3MDUyOGZkMjkyMTFkNzMiLCJlbWFpbCI6InZ0NjQ4NEBnbWFpbC5jb20iLCJyb2xlIjoiQWRtaW4iLCJwcm9wZXJ0eUNvZGUiOiJERU1PNzc3IiwicHJvcGVydHlJZCI6IjY5MTBiN2M2ZDI0MWY5Nzc0Njk2NDUzZSIsImlhdCI6MTc2NDQzMjE3OSwiZXhwIjoxNzY1MDM2OTc5fQ.oZPIB1ig8rw6dLM7EjcPhFrggui0cOJno1sV4BIRmR8";

/**
 * Parse command line arguments
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const current = argv[i];
        if (!current.startsWith('--')) {
            continue;
        }
        const key = current.slice(2);
        const value = argv[i + 1];
        if (!value || value.startsWith('--')) {
            args[key] = true; // Boolean flag
        } else {
            args[key] = value;
            i += 1;
        }
    }
    return args;
}

/**
 * Read template file content
 */
function readTemplateFile(filePath) {
    try {
        // Try relative to script directory first
        let fullPath = path.join(__dirname, filePath);
        if (!fs.existsSync(fullPath)) {
            // Try relative to Backend directory
            fullPath = path.join(__dirname, '..', filePath);
        }
        if (!fs.existsSync(fullPath)) {
            // Try absolute path
            fullPath = filePath;
        }
        
        if (!fs.existsSync(fullPath)) {
            throw new Error(`Template file not found: ${filePath}`);
        }
        
        return fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
        throw new Error(`Error reading template file: ${error.message}`);
    }
}

/**
 * Main function to add/update email template
 */
async function addTemplate() {
    try {
        const args = parseArgs(process.argv.slice(2));
        
        // Validate required arguments
        if (!args.name) {
            console.error('❌ Error: --name is required');
            console.log('\nUsage: node scripts/addTemplate.js --name "TemplateName" --subject "Subject" --file "path/to/template.html"');
            process.exit(1);
        }
        
        if (!args.subject) {
            console.error('❌ Error: --subject is required');
            console.log('\nUsage: node scripts/addTemplate.js --name "TemplateName" --subject "Subject" --file "path/to/template.html"');
            process.exit(1);
        }
        
        if (!args.file && !args.content) {
            console.error('❌ Error: Either --file or --content is required');
            console.log('\nUsage: node scripts/addTemplate.js --name "TemplateName" --subject "Subject" --file "path/to/template.html"');
            process.exit(1);
        }
        
        if (args.file && args.content) {
            console.error('❌ Error: Use either --file or --content, not both');
            process.exit(1);
        }
        
        // Get template content
        let templateContent = '';
        if (args.file) {
            templateContent = readTemplateFile(args.file);
        } else {
            templateContent = args.content;
        }
        
        // Get JWT token
        const jwtToken = args.token || DEFAULT_JWT_TOKEN;
        
        // Decode JWT to get property ID
        const jwt = require('jsonwebtoken');
        const decoded = jwt.decode(jwtToken);
        
        if (!decoded) {
            throw new Error('Invalid JWT token');
        }
        
        const propertyId = args.property || decoded.propertyId;
        
        if (!propertyId) {
            throw new Error('Could not extract property ID from JWT token. Please provide --property argument.');
        }
        
        console.log('📧 Adding Email Template...\n');
        console.log(`Template Name: ${args.name}`);
        console.log(`Subject: ${args.subject}`);
        console.log(`Property ID: ${propertyId}`);
        console.log(`Content Length: ${templateContent.length} characters\n`);
        
        // Connect to MongoDB
        const mongoUri = process.env.MONGO_URI;
        if (!mongoUri) {
            throw new Error('MONGO_URI environment variable is not set');
        }
        
        await mongoose.connect(mongoUri);
        console.log('✅ Connected to MongoDB');
        
        // Get property code from JWT token
        const propertyCode = decoded.propertyCode;
        if (!propertyCode) {
            throw new Error('Could not extract property code from JWT token');
        }
        
        // Get tenant-aware EmailTemplate model
        const { getTenantContext } = require('../services/tenantManager');
        const tenant = await getTenantContext(propertyCode);
        const EmailTemplate = tenant.models.EmailTemplate;
        const ObjectId = mongoose.Types.ObjectId;
        const propertyObjectId = new ObjectId(propertyId);
        
        // Check if template already exists
        const existingTemplate = await EmailTemplate.findOne({
            template_name: args.name,
            property: propertyObjectId
        });
        
        if (existingTemplate) {
            console.log('📝 Template already exists. Updating...');
            existingTemplate.content = templateContent;
            existingTemplate.subject = args.subject;
            await existingTemplate.save();
            console.log('✅ Template updated successfully!');
        } else {
            const newTemplate = new EmailTemplate({
                template_name: args.name,
                subject: args.subject,
                content: templateContent,
                property: propertyObjectId
            });
            await newTemplate.save();
            console.log('✅ Template created successfully!');
        }
        
        console.log('\n📋 Template Details:');
        console.log(`   Template Name: ${args.name}`);
        console.log(`   Subject: ${args.subject}`);
        console.log(`   Property ID: ${propertyId}`);
        console.log(`   Content Size: ${templateContent.length} characters`);
        
        await mongoose.disconnect();
        console.log('\n✅ Disconnected from MongoDB');
        process.exit(0);
    } catch (error) {
        console.error('\n❌ Error adding email template:', error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    }
}

// Run the script
addTemplate();

