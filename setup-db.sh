#!/bin/bash

# Setup script for Supabase database
# This script will apply the database migration to your Supabase project

echo "========================================"
echo "Supabase Database Setup"
echo "========================================"
echo ""

# Check if .env file exists
if [ ! -f .env ]; then
    echo "Error: .env file not found!"
    echo "Please create a .env file with your Supabase credentials:"
    echo "  VITE_SUPABASE_URL=your_supabase_project_url"
    echo "  VITE_SUPABASE_ANON_KEY=your_anon_key"
    exit 1
fi

# Load environment variables
export $(cat .env | grep -v '^#' | xargs)

if [ -z "$VITE_SUPABASE_URL" ]; then
    echo "Error: VITE_SUPABASE_URL not found in .env file"
    exit 1
fi

# Extract project ref from URL
PROJECT_REF=$(echo $VITE_SUPABASE_URL | sed -E 's/https:\/\/([^.]+).*/\1/')

echo "Detected Supabase Project: $PROJECT_REF"
echo ""
echo "To run the migration, you have two options:"
echo ""
echo "Option 1: Use psql (if you have it installed)"
echo "  Run: psql \"$VITE_SUPABASE_URL\" < supabase/migrations/001_initial_schema.sql"
echo ""
echo "Option 2: Manual (recommended)"
echo "  1. Go to: https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
echo "  2. Copy the contents of: supabase/migrations/001_initial_schema.sql"
echo "  3. Paste into the SQL editor"
echo "  4. Click 'Run'"
echo ""
echo "After running the migration, your database will be ready!"
echo "========================================"
