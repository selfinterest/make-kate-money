# Local Supabase Demo Keys

## Are These Real Secrets? NO!

The JWT tokens in our test files are **NOT real secrets**. They are the standard demo keys that ship with every local Supabase installation worldwide.

## What Are These Keys?

These are the default development keys documented in the official Supabase documentation:
https://supabase.com/docs/guides/local-development

Every developer running `supabase start` gets these exact same keys.

## Key Details

### Anon Key (Public)
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
```

**Decodes to:**
```json
{
  "iss": "supabase-demo",   // Demo issuer (not a real issuer)
  "role": "anon",            // Anonymous role
  "exp": 1983812996          // Expires in 2033 (for demo purposes)
}
```

### Service Role Key (Admin)
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
```

**Decodes to:**
```json
{
  "iss": "supabase-demo",      // Demo issuer (not a real issuer)
  "role": "service_role",      // Service role (bypasses RLS)
  "exp": 1983812996            // Expires in 2033 (for demo purposes)
}
```

## Why Are They Safe?

1. **Issuer is "supabase-demo"** - Not a real production issuer
2. **Only work with 127.0.0.1** - Cannot access production systems
3. **Same for everyone** - Every local Supabase installation uses these
4. **Documented publicly** - In official Supabase documentation
5. **Cannot be used remotely** - Local only by design

## Verify Yourself

You can decode these JWT tokens at [jwt.io](https://jwt.io) to see they contain no secrets.

## Where Do They Come From?

When you run `supabase start`, these keys are printed in the output:

```bash
$ supabase start

Started supabase local development setup.

         API URL: http://127.0.0.1:54321
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Inbucket URL: http://127.0.0.1:54324
        anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## What About Production?

**Production Supabase uses completely different keys** that:
- Are generated uniquely for your project
- Are kept in environment variables (not committed)
- Have different issuers
- Point to remote URLs (not 127.0.0.1)

Our production config uses `process.env.SUPABASE_URL` and `process.env.SUPABASE_ANON_KEY` which are not in source control.

## Summary

✅ **Safe to commit** - These are public demo keys  
✅ **Same for everyone** - Not unique to our project  
✅ **Local only** - Cannot access production  
✅ **Officially documented** - Part of Supabase's local dev tools  
❌ **Not secrets** - Anyone can use them with local Supabase  

**Bottom line:** These keys are like the default "admin/admin" login that comes with local development tools. They're meant to make local development easy and are completely safe to commit to version control.

