#!/bin/bash

# Migration Helper Script for Reddit Stock Watcher
# This script provides common migration operations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SUPABASE_DIR="$PROJECT_ROOT/supabase"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to create a new migration
create_migration() {
    if [ -z "$1" ]; then
        print_error "Migration name is required"
        echo "Usage: $0 create-migration <migration-name>"
        echo "Example: $0 create-migration add_user_table"
        exit 1
    fi
    
    local migration_name="$1"
    print_status "Creating new migration: $migration_name"
    
    cd "$PROJECT_ROOT"
    supabase migration new "$migration_name"
    
    print_success "Migration created successfully"
    print_status "Edit the migration file in supabase/migrations/ to add your changes"
}

# Function to apply migrations
apply_migrations() {
    print_status "Applying migrations..."
    
    cd "$PROJECT_ROOT"
    supabase db push
    
    print_success "Migrations applied successfully"
}

# Function to reset database (local only)
reset_database() {
    print_warning "This will reset your local database and apply all migrations from scratch"
    read -p "Are you sure? (y/N): " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print_status "Resetting database..."
        
        cd "$PROJECT_ROOT"
        supabase db reset
        
        print_success "Database reset successfully"
    else
        print_status "Database reset cancelled"
    fi
}

# Function to generate TypeScript types
generate_types() {
    print_status "Generating TypeScript types from database schema..."
    
    cd "$PROJECT_ROOT"
    supabase gen types typescript --local > lib/database.types.ts
    
    print_success "TypeScript types generated in lib/database.types.ts"
}

# Function to show migration status
show_status() {
    print_status "Migration status:"
    
    cd "$PROJECT_ROOT"
    supabase migration list
}

# Function to show help
show_help() {
    echo "Reddit Stock Watcher - Migration Helper"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  create-migration <name>    Create a new migration file"
    echo "  apply                     Apply pending migrations"
    echo "  reset                     Reset local database (destructive)"
    echo "  generate-types            Generate TypeScript types from schema"
    echo "  status                    Show migration status"
    echo "  help                      Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 create-migration add_indexes"
    echo "  $0 apply"
    echo "  $0 generate-types"
}

# Main script logic
case "${1:-help}" in
    "create-migration")
        create_migration "$2"
        ;;
    "apply")
        apply_migrations
        ;;
    "reset")
        reset_database
        ;;
    "generate-types")
        generate_types
        ;;
    "status")
        show_status
        ;;
    "help"|*)
        show_help
        ;;
esac
