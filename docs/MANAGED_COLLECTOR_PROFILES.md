# Managed Collector Profiles

Managed collector profiles let one authenticated household user maintain multiple fully separate PokéCollector collections without creating another login account.

The manager and every managed collector remain normal local `users` rows. Existing collection, wishlist, binder, product, trade, settings, dashboard, and Pokédex queries therefore continue to isolate data through `user_id`.

## Session model

A normal application token uses the primary user as both active collector and actor. Switching to a managed profile creates a delegated token:

```json
{
  "sub": "2",
  "actor_sub": "1",
  "profile_switch": true,
  "role": "trainer"
}
```

`sub` controls all normal data access and authorization. `actor_sub` is used only by the restricted profile-switch endpoints. A managed profile never inherits the manager's admin role.

## Behavior

- Managed profiles cannot use the password-login endpoint.
- Creating, editing, disabling, PIN management, and deletion require the primary managing profile to be active.
- A delegated profile may switch to another profile owned by the same actor or switch back to the actor.
- An optional 4–8 digit parent PIN can protect switching back.
- Profile switching replaces the application JWT and performs a full frontend reload so no React Query or editor state leaks between collectors.
- Managed profiles do not count as login-capable users when PokéCollector derives single-user versus multi-user mode.

## Deletion

The normal action is to disable a profile. Permanent deletion requires typing the profile name and removes all user-owned application data. Cleanup also detects the optional `photo_import_sessions` table so this feature remains compatible with the sibling bulk-photo-import branch.

## Future identity linking

A managed profile can later be linked to an independent authentication identity while retaining its existing local `User.id`. No collection migration is required.
