# Email Template Setup Guide

## Overview

The reservation creation route automatically sends confirmation emails to guests when a reservation is created. This guide explains how to set up email templates in MongoDB.

## Email Sending Function

**Location:** `Backend/routes/frontOffice/reservations.js`

The `sendReservationEmail()` function is called automatically when:
- A new reservation is created via `POST /frontoffice/reservations`
- The reservation has a `guestEmail` field

## Email Template Schema

The email template is stored in the `EmailTemplate` collection with the following structure:

```javascript
{
  template_name: String,    // Required, unique per property
  content: String,          // Required, HTML content with variables
  subject: String,          // Optional, email subject line
  property: ObjectId,       // Auto-added by propertyScoped plugin
  createdAt: Date,          // Auto-added
  updatedAt: Date           // Auto-added
}
```

## Required Template Name

The system looks for a template with:
- **template_name:** `"reservationMail"` (exact match, case-sensitive)
- **property:** Your property ID

## Available Template Variables

You can use these variables in your email template using `{{variableName}}` syntax:

### Guest & Reservation Information
| Variable | Description | Example |
|----------|-------------|---------|
| `{{guestName}}` | Guest's full name | "John Doe" |
| `{{reservationId}}` | Reservation ID or confirmation number | "CONF-123456" |
| `{{checkInDate}}` | Check-in date (formatted) | "15/03/2024" |
| `{{checkOutDate}}` | Check-out date (formatted) | "18/03/2024" |
| `{{roomType}}` | Room type name | "Deluxe Suite" |
| `{{totalGuests}}` | Number of guests | "2" |
| `{{totalAmount}}` | Total reservation amount | "15000" |
| `{{paidAmount}}` | Amount already paid/advance payment | "5000" |
| `{{balanceAmount}}` | Remaining balance (totalAmount - paidAmount) | "10000" |

### Basic Property Information
| Variable | Description | Example |
|----------|-------------|---------|
| `{{propertyName}}` | Property/hotel name | "Phoenix Hotel & Resort" |
| `{{propertyEmail}}` | Property email address | "info@phoenixhotel.com" |
| `{{propertyPhone}}` | Property phone number | "+91 22 1234 5678" |
| `{{propertyAddress}}` | Property full address | "123 Business District, Mumbai..." |
| `{{propertyWebsite}}` | Property website URL | "www.phoenixhotel.com" |

### Check-in/Check-out Times (from Settings)
| Variable | Description | Example |
|----------|-------------|---------|
| `{{checkInTime}}` | Check-in time | "14:00" |
| `{{checkOutTime}}` | Check-out time | "11:00" |

### Policies (from Settings/Property Details)
| Variable | Description | Example |
|----------|-------------|---------|
| `{{cancellationPolicy}}` | Cancellation policy text | "Cancellation is free up to 24 hours..." |
| `{{generalPolicies}}` | General policies text | "Check-in time is 2:00 PM..." |

### Business Details (from Settings)
| Variable | Description | Example |
|----------|-------------|---------|
| `{{gstin}}` | GSTIN number | "27ABCDE1234F1Z5" |
| `{{currency}}` | Currency code | "INR" |
| `{{timezone}}` | Timezone | "Asia/Kolkata" |
| `{{gstRate}}` | GST rate percentage | "18" |
| `{{serviceChargeRate}}` | Service charge rate percentage | "10" |

## How to Add Template in MongoDB

### Method 1: Using MongoDB Compass (GUI)

1. **Connect to your MongoDB database**
2. **Select your database** (the one your app uses)
3. **Find or create the `emailtemplates` collection**
4. **Click "Insert Document"**
5. **Add the following document:**

```json
{
  "template_name": "reservationMail",
  "subject": "Reservation Confirmation - {{propertyName}}",
  "content": "<!DOCTYPE html><html><head><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#333;} .container{max-width:600px;margin:0 auto;padding:20px;} .header{background-color:#0f5f9c;color:white;padding:20px;text-align:center;} .content{padding:20px;background-color:#f9f9f9;} .footer{text-align:center;padding:20px;color:#666;font-size:12px;}</style></head><body><div class=\"container\"><div class=\"header\"><h1>{{propertyName}}</h1></div><div class=\"content\"><h2>Reservation Confirmation</h2><p>Dear {{guestName}},</p><p>Thank you for choosing {{propertyName}}! Your reservation has been confirmed.</p><h3>Reservation Details:</h3><ul><li><strong>Reservation ID:</strong> {{reservationId}}</li><li><strong>Check-in:</strong> {{checkInDate}}</li><li><strong>Check-out:</strong> {{checkOutDate}}</li><li><strong>Room Type:</strong> {{roomType}}</li><li><strong>Guests:</strong> {{totalGuests}}</li><li><strong>Total Amount:</strong> ₹{{totalAmount}}</li><li><strong>Paid Amount:</strong> ₹{{paidAmount}}</li><li><strong>Balance Due:</strong> ₹{{balanceAmount}}</li></ul><p>We look forward to welcoming you!</p><p>Best regards,<br>{{propertyName}} Team</p></div><div class=\"footer\"><p>{{propertyAddress}}<br>Phone: {{propertyPhone}} | Email: {{propertyEmail}}</p></div></div></body></html>",
  "property": "YOUR_PROPERTY_ID_HERE"
}
```

**Important:** Replace `"YOUR_PROPERTY_ID_HERE"` with your actual property ObjectId.

### Method 2: Using MongoDB Shell (mongosh)

```javascript
// Connect to your database
use your_database_name

// Insert the email template
db.emailtemplates.insertOne({
  template_name: "reservationMail",
  subject: "Reservation Confirmation - {{propertyName}}",
  content: `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #0f5f9c; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; background-color: #f9f9f9; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>{{propertyName}}</h1>
    </div>
    <div class="content">
      <h2>Reservation Confirmation</h2>
      <p>Dear {{guestName}},</p>
      <p>Thank you for choosing {{propertyName}}! Your reservation has been confirmed.</p>
      <h3>Reservation Details:</h3>
      <ul>
        <li><strong>Reservation ID:</strong> {{reservationId}}</li>
        <li><strong>Check-in:</strong> {{checkInDate}}</li>
        <li><strong>Check-out:</strong> {{checkOutDate}}</li>
        <li><strong>Room Type:</strong> {{roomType}}</li>
        <li><strong>Guests:</strong> {{totalGuests}}</li>
        <li><strong>Total Amount:</strong> ₹{{totalAmount}}</li>
        <li><strong>Paid Amount:</strong> ₹{{paidAmount}}</li>
        <li><strong>Balance Due:</strong> ₹{{balanceAmount}}</li>
      </ul>
      <p>We look forward to welcoming you!</p>
      <p>Best regards,<br>{{propertyName}} Team</p>
    </div>
    <div class="footer">
      <p>{{propertyAddress}}<br>Phone: {{propertyPhone}} | Email: {{propertyEmail}}</p>
    </div>
  </div>
</body>
</html>`,
  property: ObjectId("YOUR_PROPERTY_ID_HERE")
})
```

**Important:** Replace `"YOUR_PROPERTY_ID_HERE"` with your actual property ObjectId.

### Method 3: Find Your Property ID First

If you don't know your property ID, run this query first:

```javascript
// In MongoDB shell
db.properties.findOne({}, { _id: 1, name: 1 })
```

Or in MongoDB Compass, check the `properties` collection and copy the `_id` field.

## Sample HTML Template

Here's a complete, professional email template you can use:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      line-height: 1.6;
      color: #333;
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
    }
    .email-container {
      max-width: 600px;
      margin: 20px auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      background: linear-gradient(135deg, #0f5f9c 0%, #1a7fc4 100%);
      color: white;
      padding: 30px 20px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
    }
    .content {
      padding: 30px 20px;
    }
    .greeting {
      font-size: 18px;
      margin-bottom: 20px;
    }
    .details-box {
      background-color: #f9f9f9;
      border-left: 4px solid #0f5f9c;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .details-box h3 {
      margin-top: 0;
      color: #0f5f9c;
    }
    .details-box ul {
      list-style: none;
      padding: 0;
    }
    .details-box li {
      padding: 8px 0;
      border-bottom: 1px solid #e0e0e0;
    }
    .details-box li:last-child {
      border-bottom: none;
    }
    .details-box strong {
      color: #0f5f9c;
      min-width: 150px;
      display: inline-block;
    }
    .footer {
      background-color: #f9f9f9;
      padding: 20px;
      text-align: center;
      color: #666;
      font-size: 12px;
      border-top: 1px solid #e0e0e0;
    }
    .footer p {
      margin: 5px 0;
    }
    .cta-button {
      display: inline-block;
      background-color: #0f5f9c;
      color: white;
      padding: 12px 30px;
      text-decoration: none;
      border-radius: 5px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <h1>{{propertyName}}</h1>
    </div>
    <div class="content">
      <div class="greeting">
        <p>Dear {{guestName}},</p>
      </div>
      <p>Thank you for choosing {{propertyName}}! We are delighted to confirm your reservation.</p>
      
      <div class="details-box">
        <h3>Reservation Details</h3>
        <ul>
          <li><strong>Reservation ID:</strong> {{reservationId}}</li>
          <li><strong>Check-in Date:</strong> {{checkInDate}} at {{checkInTime}}</li>
          <li><strong>Check-out Date:</strong> {{checkOutDate}} at {{checkOutTime}}</li>
          <li><strong>Room Type:</strong> {{roomType}}</li>
          <li><strong>Number of Guests:</strong> {{totalGuests}}</li>
          <li><strong>Total Amount:</strong> ₹{{totalAmount}}</li>
          <li><strong>Paid Amount:</strong> ₹{{paidAmount}}</li>
          <li><strong>Balance Due:</strong> ₹{{balanceAmount}}</li>
        </ul>
      </div>
      
      <div class="details-box" style="margin-top: 20px;">
        <h3>Important Information</h3>
        <p><strong>Cancellation Policy:</strong></p>
        <p>{{cancellationPolicy}}</p>
        <p><strong>General Policies:</strong></p>
        <p>{{generalPolicies}}</p>
      </div>
      
      <p>Visit us at: <a href="https://{{propertyWebsite}}">{{propertyWebsite}}</a></p>
      <p>GSTIN: {{gstin}}</p>
      
      <p>We look forward to welcoming you and ensuring you have a comfortable and memorable stay.</p>
      <p>If you have any questions or need to make changes to your reservation, please don't hesitate to contact us.</p>
      
      <p>Best regards,<br>
      <strong>The {{propertyName}} Team</strong></p>
    </div>
    <div class="footer">
      <p><strong>{{propertyName}}</strong></p>
      <p>{{propertyAddress}}</p>
      <p>Phone: {{propertyPhone}} | Email: {{propertyEmail}}</p>
      <p style="margin-top: 15px; font-size: 11px; color: #999;">
        This is an automated confirmation email. Please do not reply to this message.
      </p>
    </div>
  </div>
</body>
</html>
```

## Important Notes

1. **Property ID is Required:** The template must be associated with your property ID. Without it, the system won't find the template.

2. **Template Name Must Match:** The `template_name` must be exactly `"reservationMail"` (case-sensitive).

3. **Subject Field:** While the schema doesn't explicitly define `subject`, the code uses it. If not provided, it defaults to the template name or "Reservation Confirmation".

4. **Variable Syntax:** Use double curly braces `{{variableName}}` for variables. Spaces are allowed: `{{ guestName }}` or `{{guestName}}` both work.

5. **HTML Content:** The `content` field should contain valid HTML. The system will replace variables and send as HTML email.

6. **Email Configuration:** Make sure your SMTP settings are configured in:
   - Environment variables, OR
   - EmailIntegration collection in MongoDB

## Testing

After adding the template:

1. Create a test reservation with a valid email address
2. Check the server logs for email sending status
3. Verify the email was received
4. Check that all variables were replaced correctly

## Troubleshooting

- **No email sent:** Check if `guestEmail` is provided in reservation
- **Template not found:** Verify `template_name` is exactly `"reservationMail"` and `property` ID matches
- **Variables not replaced:** Ensure variable names match exactly (case-sensitive)
- **Email delivery failed:** Check SMTP configuration in EmailIntegration or environment variables

