#!/bin/bash

# Script to start local Supabase for integration testing
# This ensures a clean database is available for tests

set -e

echo "🚀 Starting local Supabase for integration tests..."

# Check if Supabase CLI is available (via npx or local installation)
if ! npx --version &> /dev/null; then
    echo "❌ npx is not available. Please ensure Node.js is installed."
    exit 1
fi

# Check if supabase is in devDependencies
if ! npx supabase --version &> /dev/null; then
    echo "❌ Supabase CLI is not installed in this project."
    echo "Install it with: npm install --save-dev supabase"
    exit 1
fi

echo "✅ Found Supabase CLI (using npx)"

# Start Supabase (or reset if already running)
if npx supabase status &> /dev/null; then
    echo "⚠️  Supabase is already running. Resetting database..."
    npx supabase db reset --db-url postgresql://postgres:postgres@127.0.0.1:54322/postgres
else
    echo "📦 Starting Supabase..."
    npx supabase start
fi

echo ""
echo "✅ Supabase is ready for testing!"
echo ""
echo "Database URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres"
echo "API URL: http://127.0.0.1:54321"
echo "Studio URL: http://127.0.0.1:54323"
echo ""
echo "Run tests with: npm run test:integration"
echo "Stop Supabase with: npx supabase stop"

