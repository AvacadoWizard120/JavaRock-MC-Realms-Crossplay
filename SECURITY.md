# Security and Privacy

JavaRock authenticates to Microsoft/Xbox services and can record raw protocol traffic. Treat its local runtime data as sensitive.

## Data That Must Stay Private

Never commit or upload these paths:

- `.env`
- `.auth/`
- `.auth-profiles/`
- `saves.json`
- `.runtime/` and `.runtime-desktop/`
- `logs/`, `packet-logs/`, and `packet-census/`
- `viaproxy-run/`
- `tools/ViaProxy.jar`
- generated recipe databases
- packet captures, crash dumps, and Minecraft client logs

These files can contain cached credentials, account labels, Microsoft/Xbox profile names, XUIDs, Realm ids and names, player chat, inventory data, network endpoints, or short-lived session details.

## Before Publishing

Run:

```powershell
npm run check:public-release
```

For a project-specific deny list, pass comma-separated terms without writing them to a repository file:

```powershell
$env:PUBLIC_RELEASE_DENY_TERMS = "private-account-name,private-realm-name"
npm run check:public-release
Remove-Item Env:\PUBLIC_RELEASE_DENY_TERMS
```

The audit reports only the category, path, and line number. It does not print the matching secret or personal term.

## If Private Data Was Committed

Deleting the file in a later commit is not enough because the value remains in Git history.

1. Keep the affected repository private.
2. Revoke or invalidate exposed credentials and active sessions.
3. Create the public repository from a freshly sanitized tree with new Git history.
4. Do not merge private history into the public repository.
5. Re-run the public-release audit on the exact tree that will be published.

Microsoft device-code login should always be completed by the person who owns the local clone. Never distribute a pre-authenticated cache.

## Reporting a Vulnerability

Do not open a public issue containing tokens, account details, Realm identifiers, packet captures, or unredacted logs. Contact the repository owner privately and include only the minimum information needed to reproduce the problem.

## Scope

This project does not attempt to bypass Microsoft/Xbox authentication. Use it only with accounts, servers, and Realms you are authorized to access.
