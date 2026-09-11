# Supabase Backend Setup Guide

This guide details the database modifications and storage bucket configurations required to support the new features (Account Deletion, Notification Preferences, and Image Upload).

---

## 1. Account Deletion (RPC Database Function)

Since Supabase prevents deleting accounts directly from client SDKs, account deletion is handled via a secure database RPC function. Run the following SQL in your Supabase SQL Editor:

```sql
-- Create a secure RPC function to delete the authenticated user's account
create or replace function delete_user_account()
returns void
security definer -- Runs with the privileges of the creator (bypass client restrictions)
set search_path = public
as $$
declare
  current_user_id uuid;
begin
  -- Retrieve the user ID of the calling authenticated user
  current_user_id := auth.uid();
  
  if current_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- 1. Cascade-deletes profile and related user data (assuming tables reference auth.users with ON DELETE CASCADE)
  -- 2. Delete the user from auth.users (requires security definer context)
  delete from auth.users where id = current_user_id;
end;
$$ language plpgsql;
```

---

## 2. Notification Preferences Column

We store notification settings inside a `notification_preferences` JSONB column in the `profiles` table. Run the following SQL to add the column if it does not already exist:

```sql
-- Add the notification_preferences column to the profiles table
alter table profiles 
add column if not exists notification_preferences jsonb default '{"dealReminders": true, "newDealsNearby": true, "weeklyDigest": false}'::jsonb;
```

---

## 3. Image Upload (Storage Bucket Setup)

To allow users to pick and upload specials boards or venue photos, configure a Supabase Storage bucket:

1. Go to your **Supabase Dashboard** -> **Storage**.
2. Click **New Bucket**.
3. Set **Bucket Name** to `venue-images`.
4. Set the bucket to **Public** (so anyone can view the images via the public URL).
5. Click **Save**.

### Row-Level Security (RLS) Policies for `venue-images`

Add the following storage RLS policies in Supabase:

- **Allow public reading of images:**
  ```sql
  -- Target: select
  -- Policy: Anyone can view venue images
  (bucket_id = 'venue-images')
  ```
- **Allow authenticated users to upload images:**
  ```sql
  -- Target: insert
  -- Policy: Only authenticated users can upload
  (bucket_id = 'venue-images' and auth.role() = 'authenticated')
  ```
