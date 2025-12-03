# Email Template Management Scripts

## Generic Template Addition Script

The `addTemplate.js` script is a generic utility to add or update email templates in the database.

### Usage

```bash
# Using a template file
node scripts/addTemplate.js --name "templateName" --subject "Email Subject" --file "path/to/template.html"

# Using inline content
node scripts/addTemplate.js --name "templateName" --subject "Email Subject" --content "<html>...</html>"

# With custom JWT token
node scripts/addTemplate.js --name "templateName" --subject "Email Subject" --file "template.html" --token "your-jwt-token"

# With explicit property ID
node scripts/addTemplate.js --name "templateName" --subject "Email Subject" --file "template.html" --property "propertyId"
```

### Arguments

- `--name` (required): Template name (must match `template_name` field in database)
- `--subject` (required): Email subject line (can include variables like `{{variableName}}`)
- `--file` (optional): Path to HTML template file
- `--content` (optional): HTML content as string (use `--file` or `--content`, not both)
- `--token` (optional): JWT token for authentication (defaults to hardcoded token)
- `--property` (optional): Property ID (if not provided, will be extracted from JWT token)

### Examples

#### City Ledger Invoice Template
```bash
node scripts/addTemplate.js --name "cityLedgerInvoice" --subject "Invoice - {{accountName}}" --file "scripts/templates/cityLedgerInvoice.html"
```

#### Reservation Confirmation Template
```bash
node scripts/addTemplate.js --name "reservationMail" --subject "Reservation Confirmation - {{propertyName}}" --file "scripts/templates/reservationConfirmation.html"
```

#### Custom Template with Inline Content
```bash
node scripts/addTemplate.js --name "welcomeEmail" --subject "Welcome to {{propertyName}}" --content "<html><body><h1>Welcome {{guestName}}!</h1></body></html>"
```

### Template Variables

Templates support variable replacement using `{{variableName}}` syntax. Common variables include:

- `{{propertyName}}` - Property/hotel name
- `{{propertyEmail}}` - Property email address
- `{{propertyPhone}}` - Property phone number
- `{{propertyAddress}}` - Property address
- `{{gstin}}` - GSTIN number
- `{{accountName}}` - Account name (for city ledger)
- `{{invoiceNumber}}` - Invoice number
- `{{totalAmount}}` - Total amount
- And many more depending on the template type

### Template Files Location

Store template HTML files in `Backend/scripts/templates/` directory for easy management.

### Notes

- The script will update existing templates if they already exist
- Property ID is automatically extracted from JWT token if not provided
- Template content is validated before saving
- The script connects directly to MongoDB using `MONGO_URI` from `.env`

