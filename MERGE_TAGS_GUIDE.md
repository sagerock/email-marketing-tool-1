# Merge Tags Reference Guide

## Available Merge Tags

Use these tags in your email templates to personalize content for each recipient:

### Contact Data
| Merge Tag | Description | Example Output |
|-----------|-------------|----------------|
| `{{first_name}}` | Recipient's first name | John |
| `{{last_name}}` | Recipient's last name | Doe |
| `{{email}}` | Recipient's email address | john@example.com |

### System Generated
| Merge Tag | Description | Example Output |
|-----------|-------------|----------------|
| `{{unsubscribe_url}}` | Unique unsubscribe link for recipient | https://mail.sagerock.com/unsubscribe?token=abc123 |
| `{{mailing_address}}` | Your company's physical address | 123 Main St, Suite 100, San Francisco, CA 94105 |

## CAN-SPAM Requirements

**Required in ALL commercial emails:**
1. ✅ Unsubscribe link: `{{unsubscribe_url}}`
2. ✅ Physical mailing address: `{{mailing_address}}`

## Example Email Footer

Here's a CAN-SPAM compliant footer template:

```html
<div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #ccc; font-size: 12px; color: #666;">
  <p>
    This email was sent to <a href="mailto:{{email}}">{{email}}</a>
  </p>
  <p>
    <strong>{{mailing_address}}</strong>
  </p>
  <p>
    <a href="{{unsubscribe_url}}" style="color: #0077c8;">Unsubscribe from this list</a>
  </p>
</div>
```

## Marketing Cloud Format (for reference)

If you're migrating from Marketing Cloud, here's how the tags map:

| Marketing Cloud | This System |
|-----------------|-------------|
| `%%first_name%%` or `%%FirstName%%` | `{{first_name}}` |
| `%%last_name%%` or `%%LastName%%` | `{{last_name}}` |
| `%%emailaddr%%` | `{{email}}` |
| `%%Member_Addr%%`, `%%Member_City%%`, etc. | `{{mailing_address}}` (single field) |
| Unsubscribe URL | `{{unsubscribe_url}}` |

## Setting Your Mailing Address

1. Go to **Settings** page
2. Click **Edit** on your client
3. Fill in the **Mailing Address** field
4. Click **Update Client**

The mailing address will automatically be inserted wherever you use `{{mailing_address}}` in your emails.

## Notes

- Tags are **case-insensitive** (`{{first_name}}` = `{{FIRST_NAME}}` = `{{First_Name}}`)
- Tags use **double curly braces** `{{ }}` (not single braces or percent signs)
- Missing data shows as empty string (e.g., if no last name, `{{last_name}}` becomes "")
- Mailing address falls back to "No mailing address configured" if not set in Settings

## Testing

Use the **Send Test** feature on any campaign to:
- See how merge tags are replaced
- Test with placeholder data (John Doe, john@example.com)
- Verify your footer includes required elements
