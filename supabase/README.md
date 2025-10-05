# Supabase Migrations Guide

This directory contains the Supabase database migrations and configuration for the Reddit Stock Watcher project.

## Directory Structure

```
supabase/
├── migrations/          # Database migration files
│   └── 20240101000000_initial_schema.sql
├── seed.sql            # Initial seed data
├── config.toml         # Supabase CLI configuration
└── README.md          # This file
```

## Migration Workflow

### Creating a New Migration

Use the migration helper script to create new migrations:

```bash
# Create a new migration
./scripts/migration-helper.sh create-migration add_new_feature

# This creates a timestamped file in supabase/migrations/
```

### Applying Migrations

```bash
# Apply pending migrations
./scripts/migration-helper.sh apply

# Or use Supabase CLI directly
supabase db push
```

### Local Development

For local development with Supabase:

```bash
# Start local Supabase stack
supabase start

# Reset local database (applies all migrations + seeds)
./scripts/migration-helper.sh reset

# Generate TypeScript types from schema
./scripts/migration-helper.sh generate-types
```

### Production Deployment

When deploying to production:

1. **Test migrations locally first**
2. **Apply migrations to staging environment**
3. **Apply migrations to production**

```bash
# Link to your Supabase project
supabase link --project-ref your-project-ref

# Push migrations to remote
supabase db push
```

## Migration Best Practices

### 1. Naming Conventions
- Use descriptive names: `add_user_authentication`, `update_post_indexes`
- Include action verb: `add_`, `update_`, `remove_`, `create_`

### 2. Migration Structure
- Each migration should be idempotent (safe to run multiple times)
- Use `IF NOT EXISTS` for tables and indexes
- Use `ON CONFLICT DO NOTHING` for initial data

### 3. Schema Changes
- **Adding columns**: Use `ALTER TABLE ADD COLUMN IF NOT EXISTS`
- **Dropping columns**: Be careful with production data
- **Indexes**: Add with `CREATE INDEX IF NOT EXISTS`
- **Constraints**: Add with `ALTER TABLE ADD CONSTRAINT IF NOT EXISTS`

### 4. Data Migrations
- Use separate migrations for data changes
- Always backup before destructive operations
- Test with production-like data volumes

## Example Migration

```sql
-- Migration: 20240102000000_add_user_table.sql

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add index for email lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Add RLS policy (if needed)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own data" ON users
  FOR SELECT USING (auth.uid() = id);
```

## Troubleshooting

### Migration Fails
1. Check the migration file syntax
2. Verify database permissions
3. Review Supabase logs: `supabase logs`

### Schema Drift
If your local schema differs from migrations:

```bash
# Generate migration from current schema
supabase db diff --schema public > new_migration.sql

# Review and apply the generated migration
```

### Rollback
Supabase doesn't support automatic rollbacks. To rollback:

1. Create a new migration that reverses changes
2. Test thoroughly before applying
3. Consider data backup for destructive operations

## Useful Commands

```bash
# Show migration status
./scripts/migration-helper.sh status

# Generate TypeScript types
./scripts/migration-helper.sh generate-types

# View local database
supabase db dump --local

# Connect to local database
supabase db connect --local
```

## Environment Variables

Make sure these are set in your environment:

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_ANON_KEY`: Your Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY`: Your service role key (for server operations)

## Integration with CI/CD

For automated deployments, add migration steps to your CI/CD pipeline:

```yaml
# Example GitHub Actions step
- name: Apply Database Migrations
  run: |
    supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
    supabase db push
```
