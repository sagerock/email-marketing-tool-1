#!/bin/bash
# Verification script for Email Marketing Tool setup

echo "═══════════════════════════════════════════════════"
echo "  Email Marketing Tool - Setup Verification"
echo "═══════════════════════════════════════════════════"
echo ""

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Check environment variables
echo "🔍 Environment Variables..."
echo ""
echo "✅ VITE_SUPABASE_URL: $VITE_SUPABASE_URL"
if [ -n "$VITE_SUPABASE_ANON_KEY" ]; then
    echo "✅ VITE_SUPABASE_ANON_KEY: ***${VITE_SUPABASE_ANON_KEY: -10}"
else
    echo "❌ VITE_SUPABASE_ANON_KEY: Missing"
fi
echo "✅ BASE_URL: ${BASE_URL:-Not set (using default)}"
echo ""

# Check backend API
echo "🔍 Backend API Status..."
echo ""
HEALTH_CHECK=$(curl -s https://api.mail.sagerock.com/api/health 2>&1)
if echo "$HEALTH_CHECK" | grep -q "\"status\":\"ok\""; then
    echo "✅ Backend API: Online"
    echo "✅ Health endpoint: https://api.mail.sagerock.com/api/health"
else
    echo "❌ Backend API: Offline or error"
    echo "   Response: $HEALTH_CHECK"
fi
echo ""

# Check frontend
echo "🔍 Frontend Status..."
echo ""
FRONTEND_CHECK=$(curl -s -o /dev/null -w "%{http_code}" https://mail.sagerock.com 2>&1)
if [ "$FRONTEND_CHECK" = "200" ]; then
    echo "✅ Frontend: Online at https://mail.sagerock.com"
else
    echo "❌ Frontend: HTTP $FRONTEND_CHECK"
fi
echo ""

# Database verification instructions
echo "🔍 Database Verification..."
echo ""
echo "To verify database setup, please check Supabase:"
echo ""
echo "1. Go to: https://supabase.com/dashboard/project/ckloewflialohuvixmvd"
echo "2. Navigate to: Table Editor"
echo "3. Verify these tables exist:"
echo "   • clients"
echo "   • contacts (with unsubscribed, unsubscribe_token columns)"
echo "   • templates"
echo "   • campaigns"
echo "   • analytics_events"
echo ""
echo "If tables are missing, run migrations:"
echo "   1. Go to SQL Editor in Supabase"
echo "   2. Run: supabase/migrations/001_initial_schema.sql"
echo "   3. Run: supabase/migrations/002_add_unsubscribe.sql"
echo ""

# SendGrid webhook instructions
echo "🔍 SendGrid Webhook Configuration..."
echo ""
echo "⚠️  Action Required: Configure webhook in SendGrid"
echo ""
echo "1. Go to: https://app.sendgrid.com/settings/mail_settings"
echo "2. Click: Event Webhook"
echo "3. Set HTTP POST URL: https://api.mail.sagerock.com/api/webhook/sendgrid"
echo "4. Enable these events:"
echo "   ✓ Delivered"
echo "   ✓ Opened"
echo "   ✓ Clicked"
echo "   ✓ Bounced"
echo "   ✓ Spam Reports"
echo "   ✓ Unsubscribed"
echo "5. Click 'Test Your Integration'"
echo "6. Enable the webhook"
echo ""

# Summary
echo "═══════════════════════════════════════════════════"
echo "  Next Steps"
echo "═══════════════════════════════════════════════════"
echo ""
echo "1. ✅ Verify database tables in Supabase (see above)"
echo "2. ✅ Add a client in Settings page with SendGrid API key"
echo "3. ✅ Configure SendGrid webhook (see above)"
echo "4. ✅ Add test contacts"
echo "5. ✅ Create and send test campaign"
echo ""
echo "For detailed setup:"
echo "  • Database: See DEPLOYMENT.md"
echo "  • Unsubscribe: See UNSUBSCRIBE_SETUP.md"
echo "  • Railway: See RAILWAY_ENV.md"
echo ""
