# MCP OAuth runbook

One-time setup for putting poof's MCP endpoint on its own hostname behind its
own Cloudflare Access application, authenticated with Access Managed OAuth so
that a hosted client such as ChatGPT can connect without a service token.

Steps run top-to-bottom. Later steps assume the earlier ones succeeded.

This runbook covers Zero Trust, client setup, and deployment configuration. It
requires no Worker code changes: `wrangler.jsonc` declares
`mcp.poof.5n7.me`, and `src/index.ts` serves `POST /mcp` there and nothing
else.

## What changes, and what does not

|                                  | Before                    | After                           |
| -------------------------------- | ------------------------- | ------------------------------- |
| MCP endpoint                     | `https://poof.5n7.me/mcp` | `https://mcp.poof.5n7.me/mcp`   |
| MCP credential                   | `poof-cli` service token  | OAuth authorization code + PKCE |
| MCP Access application           | shared with the library   | its own, with its own AUD tag   |
| Library, API, `/d`, `/v`, `/raw` | `poof.5n7.me`             | unchanged                       |
| CLI and CI credential            | `poof-cli` service token  | unchanged                       |

The CLI keeps its service token, and the Service Auth policy that accepts it
stays on the owner application. Only the MCP endpoint moves.

None of this is optional. Through step 5, `ACCESS_MCP_AUD` stays blank and
`POST /mcp` answers 503. Step 6 enables the endpoint only after the Access
application and its OAuth settings have been checked.

## Status

Managed OAuth is Beta. As of 2026-09-04 the Cloudflare One navigation on the
[Managed OAuth page](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
marks the entry Beta. Neither the page body nor the
[changelog announcement](https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/)
repeats the label, so the navigation is the only evidence. Treat it as Beta and
roll out accordingly: expect the settings in step 5 to move, and recheck the
label yourself rather than trusting the date on this paragraph. Cloudflare
documents MCP server portals as beta, but that is a separate feature which poof
does not use, and its label says nothing about Managed OAuth.

The Codex flow was verified against the live application on 2026-09-04: OAuth
login completed and Codex called the `ls` tool. The hosted ChatGPT callback and
the remaining negative checks still need live verification. The automated
coverage in `test/access-jwt.spec.ts` separately checks that poof accepts the
documented Access JWT claims and rejects invalid or misplaced tokens.

## Prerequisites

- The `5n7.me` zone on the Cloudflare account that runs poof. Note its account
  ID; step 4 pins the policy to it.
- `docs/SETUP.md` completed, so `poof.5n7.me` is live and the owner Access
  application exists.
- Wrangler authenticated (`bunx wrangler whoami`).
- The owner's exact Cloudflare account email.
- An API token in `CF_API_TOKEN` carrying two account-scoped permissions:
  `Access: Organizations, Identity Providers, and Groups Write` for step 2, and
  `Access: Apps and Policies Revoke` (or `Access: Apps and Policies Write`) for
  the revoke in [Roll back](#roll-back). Create it before rolling out. Rollback
  is the wrong moment to discover the token cannot revoke anything.

## 1. Deploy the hostname first

For a new rollout, leave `ACCESS_MCP_AUD` blank before this first deployment.

```sh
bun run deploy
```

`wrangler.jsonc` declares `mcp.poof.5n7.me` as a second custom domain, so this
creates the DNS record and the route.

The hostname is then live with no Access application in front of it, but the
blank audience makes the Worker refuse the endpoint. Confirm both statuses
before going on:

```sh
curl -si https://mcp.poof.5n7.me/mcp -X POST -d '{}' | head -1
# HTTP/2 503

curl -si https://mcp.poof.5n7.me/raw/anything | head -1
# HTTP/2 404
```

The two statuses differ on purpose. The Access middleware reads
`ACCESS_MCP_AUD`, and it is mounted on the exact path `/mcp` and nowhere else,
so `/mcp` is the only path a blank audience turns into a 503. Every other path
on this hostname is a 404 because no route is mounted there at all.

If `POST /mcp` returns anything other than 503, stop. Either the deploy did not
take or `ACCESS_MCP_AUD` is not blank, and in both cases the endpoint may be
serving tool calls to anyone.

## 2. Make Cloudflare the only identity provider

The MCP application authenticates the owner through Cloudflare account login,
with no third-party IdP involved. In **Zero Trust > Integrations > Identity
providers**, keep the **Cloudflare** provider and enable **Restrict to account
members**, which limits logins to members of this Cloudflare account rather than
anyone holding any Cloudflare account.

Through the API:

```sh
curl https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/identity_providers \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Cloudflare","type":"cloudflare","config":{"restrict_to_account_members":true}}'
```

This call needs the `Access: Organizations, Identity Providers, and Groups
Write` permission from Prerequisites. A Zero Trust organization created recently
already has this provider with the restriction on, so check before re-creating
it.

Do not add a second login method to the MCP application. One-Time PIN as a
backup on the owner application is a separate decision and stays where it is.

## 3. Turn on account MFA

Account membership is the authorization check in step 4, so the Cloudflare
account login is what stands between an attacker and the tool set. Enable
two-factor authentication on the owner's Cloudflare account under **My Profile >
Authentication**, and on every other member of the account.

This is an account setting rather than an Access one. Access checks that the
login succeeded, not how hard it was, and account MFA is all this deployment
requires.

Access can also prompt for a second factor itself, independently of the IdP.
That feature is Independent MFA, and it is not a policy selector. Turn it on at
**Zero Trust > Access controls > Access settings > Allow multi-factor
authentication (MFA)**, then configure it per application under
**Applications > (this app) > Configure > Authentication > MFA**. It is optional
here and adds a second enrolment for the owner to carry.

## 4. Create the MCP Access application

In **Zero Trust > Access controls > Applications**, add a **Self-hosted**
application:

- **Application domain**: `mcp.poof.5n7.me`, with no path. The hostname serves
  one endpoint, so scoping by path adds nothing.
- **Identity providers**: Cloudflare only, from step 2.

Once it exists, copy its application ID from the URL or the overview and keep it
alongside the account ID. Rollback needs it as `MCP_APP_ID`, and it is easier to
record now than to look up while revoking.

Give it exactly one policy, with the selectors split across Include and Require
the way Cloudflare evaluates them:

| Rule    | Selector                  | Value                               |
| ------- | ------------------------- | ----------------------------------- |
| Include | Emails                    | the owner's exact address           |
| Require | Login Methods             | the Cloudflare provider from step 2 |
| Require | Cloudflare Account Member | the account ID from Prerequisites   |

The split is load-bearing. Cloudflare documents Include as an OR: "In case more
than one Include rule is specified, users need to meet only one of the
criteria." Putting the login method or the account-member check under Include
alongside the email would widen the policy to anyone satisfying any one of them,
which is every member of the account. Require is the AND: "A user must meet all
specified Require rules to be allowed access." One Include naming the single
allowed identity, with the rest as Require, is the arrangement that means what
it reads as.

Use the **Emails** selector with the exact address, not **Emails ending in**. A
domain match is an OR over everyone at that domain.

Add no Service Auth policy to this application. The MCP endpoint is reached
through OAuth by a human-authorized client. A service token here would be a
second credential that skips the account login and the MFA in step 3, and
anything that read it out of a config file could reuse it. The Worker enforces
the same rule independently: `accessAuth("mcp")` refuses a service-token
assertion even when it carries the right audience, so adding such a policy by
hand gets a 403 rather than the tool set.

## 5. Enable Managed OAuth and dynamic client registration

On the new application, open **Advanced settings**:

| Setting                 | Value                    | API field                                            |
| ----------------------- | ------------------------ | ---------------------------------------------------- |
| Managed OAuth           | on                       | `oauth_configuration.enabled`                        |
| Dynamic registration    | on                       | `dynamic_client_registration.enabled`                |
| Access token lifetime   | `15m`                    | `grant.access_token_lifetime`                        |
| Grant session duration  | `336h` (14 days)         | `grant.session_duration`                             |
| Allow loopback clients  | on                       | `dynamic_client_registration.allow_any_on_loopback`  |
| Allow localhost clients | off                      | `dynamic_client_registration.allow_any_on_localhost` |
| Allowed redirect URIs   | leave empty until step 7 | `dynamic_client_registration.allowed_uris`           |

Cloudflare's own advice is a short access token lifetime with a longer grant,
and 15 minutes is its documented default.

Loopback is on and localhost is off on purpose. Loopback means literal
`127.0.0.1`, which resolves nowhere but the machine itself. `localhost` is a
name, and a name can be pointed somewhere else by a resolver, a hosts file, or
DNS rebinding. Local CLI clients use loopback anyway; RFC 8252 tells them to.

Leave **Allowed redirect URIs** empty here. ChatGPT does not show its callback
until the connector exists, so step 7 creates the connector first and comes back
with the value. The empty list blocks hosted callbacks while the explicit
loopback setting still allows local clients such as Codex.

## 6. Copy the AUD tag into the Worker

From the new application's overview, copy the **Application Audience (AUD)
tag** into `wrangler.jsonc`:

```jsonc
"vars": {
  "ACCESS_MCP_AUD": "the-mcp-app-aud-tag",
  ...
}
```

It must differ from `ACCESS_AUD`. Two equal tags mean one application, and one
application means a grant issued for the MCP endpoint also opens `/api/*`. The
Worker refuses both surfaces with a 503 rather than serve that, so a
copy-and-paste slip here shows up immediately instead of silently widening the
grant.

Then regenerate types and deploy:

```sh
bun run typecheck   # runs `wrangler types` first
bun run deploy
```

## 7. Connect the hosted ChatGPT client

ChatGPT fixes the order. The callback URL does not exist until the connector
does, and the connector cannot complete a login until that callback is
allowlisted.

1. **Create the connector.** In ChatGPT, add an MCP connector pointing at
   `https://mcp.poof.5n7.me/mcp`, with no trailing slash. The path is exact:
   `/mcp/` and `/mcp/anything` return 404. Do not start the login yet.

2. **Read the callback URL** from the connector's app management page. OpenAI
   documents two shapes, and which one appears depends on the authorization
   server:

   - `https://chatgpt.com/connector_platform_oauth_redirect`, the stable
     platform-wide callback, used when the authorization server supports issuer
     identification (it advertises `authorization_response_iss_parameter_supported`
     and returns a matching `iss` on the authorization response).
   - `https://chatgpt.com/connector/oauth/{callback_id}`, specific to this one
     connector, used otherwise.

   Do not guess which applies. Copy the value the page displays.

3. **Allowlist it.** Paste that exact string into **Allowed redirect URIs** on
   the Access application from step 5, and save.

   Paste it verbatim, with no trailing `/*`. Cloudflare accepts `/*` to match
   sub-paths, and on the callback-specific form that would authorize a redirect
   to any path under `https://chatgpt.com/connector/oauth/`, including callback
   IDs belonging to connectors nobody in this account created. A registered
   redirect URI should name one destination.

4. **Authenticate.** Start the connector's login. It should redirect to a
   Cloudflare account login, prompt for the second factor, and come back
   connected with the nine tools listed.

## Verify

Work through these checks in order after every Access or Worker change.

1. The endpoint is not open. From a machine with no session:
   ```sh
   curl -si https://mcp.poof.5n7.me/mcp -X POST -d '{}' | head -1
   ```
   Expect `401` with a `WWW-Authenticate: Bearer` header carrying a
   `resource_metadata` pointer. A `200` means Access is not in front of the
   hostname. A `503` means `ACCESS_MCP_AUD` is still blank or equal to
   `ACCESS_AUD`.

2. Discovery resolves. With Managed OAuth on, Cloudflare serves the
   authorization server metadata on the application domain:
   ```sh
   curl -s https://mcp.poof.5n7.me/.well-known/oauth-authorization-server
   ```
   Check that `code_challenge_methods_supported` contains `S256` and that a
   `registration_endpoint` is advertised. OpenAI's clients require the first and
   use the second for dynamic registration.

   This is the one assumption here that the Worker could break. `src/index.ts`
   answers 404 for every path on that hostname except `/mcp`, so this works only
   if Cloudflare answers at the edge, ahead of the origin. A response of poof's
   `Not Found` rather than Cloudflare's JSON means discovery is reaching the
   origin and every client will fail. Stop and reconsider the host isolation at
   that point instead of working around it in the client.

3. Someone else cannot connect. Repeat the step 7 login with a Cloudflare
   account that is not a member of this account. Access should deny at the login
   step, not at the tool call.

4. A service token cannot connect. Create a throwaway service token, add it
   to the _owner_ application only, and send it at the MCP hostname:
   ```sh
   curl -si https://mcp.poof.5n7.me/mcp -X POST \
     -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" -d '{}' | head -1
   ```
   Expect a refusal, not a tool list. Delete the throwaway token afterwards.

5. The owner surface did not move. The library, the CLI, and CI all still
   use `poof.5n7.me` and the `poof-cli` service token:
   ```sh
   poof ls
   curl -si https://poof.5n7.me/mcp -X POST \
     -H "CF-Access-Client-Id: $POOF_ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $POOF_ACCESS_CLIENT_SECRET" \
     -d '{}' | head -1   # expect 404
   ```
   The service-token headers are what make this check mean anything. Without
   them the owner Access application answers first, and the result says nothing
   about the Worker. With them the request crosses the edge and reaches the
   origin, so a 404 is the Worker's own: the owner application's JWT authorizes
   no tool calls.

6. The public paths are where they were. A live share link still works on
   the owner host and is absent from the MCP host:
   ```sh
   curl -si https://poof.5n7.me/v/$TOKEN     | head -1   # expect 200
   curl -si https://mcp.poof.5n7.me/v/$TOKEN | head -1   # expect 404
   ```

7. Token lifetime is what was configured. The token response should carry
   `"expires_in": 900`. A larger number means step 5 did not save.

## Roll back

Blanking the Worker's audience comes first, because it closes tool execution
whatever state the Access tokens are in. A deploy can fail or take time to
propagate, so confirm the 503 before touching the Access application.

1. Blank the audience and deploy. Set `ACCESS_MCP_AUD` back to `""` in
   `wrangler.jsonc` and run `bun run deploy`. From here no token of any kind
   authorizes a tool call, because the Worker has no audience to match against.

2. Verify with a request that would otherwise work. Use a client that still
   holds a live access token, or replay one, so the check proves the Worker is
   refusing rather than that the credential expired:

   ```sh
   curl -si https://mcp.poof.5n7.me/mcp -X POST \
     -H "Authorization: Bearer $STILL_VALID_TOKEN" \
     -H "Content-Type: application/json" -d '{}' | head -1
   # HTTP/2 503
   ```

   503 means the request reached the Worker and the Worker refused it. A 200
   means the deploy did not take. A 401 means Access rejected it at the edge
   before the Worker saw it, which is fine for security but does not yet prove
   step 1 landed, so re-run with a token that Access still accepts.

3. Disable Managed OAuth on the application, under Advanced settings. This
   stops new grants being issued. It does not touch the ones already out.

4. Revoke the tokens already issued, and remove the connector. Use
   Cloudflare's [Revoke application tokens](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/revoke_tokens/)
   operation, which "revokes all tokens issued for an application":

   ```sh
   curl -X POST \
     https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps/$MCP_APP_ID/revoke_tokens \
     -H "Authorization: Bearer $CF_API_TOKEN"
   ```

   `MCP_APP_ID` is the application ID recorded in step 4, and `CF_API_TOKEN`
   needs `Access: Apps and Policies Revoke` or `Access: Apps and Policies
   Write`.

   Then remove the connector in ChatGPT.

   Revoke first and treat the connector removal as tidying up rather than as a
   revocation. Cloudflare documents no separate OAuth-grant operation, and
   nothing in ChatGPT's documentation says deleting a connector invalidates the
   refresh token it holds. Assume it does not. The revoke above ends the
   credential; removing the connector only stops the client presenting it.

5. Optionally delete the Access application, if the endpoint is not coming back.

Deleting the application changes its AUD tag. Cloudflare assigns the tag per
application and it "will never change unless you delete or recreate the Access
application", so a delete-and-recreate is not a round trip. The new application
has a new tag, `ACCESS_MCP_AUD` has to be filled in again from step 6, and every
client has to re-authorize. To pause rather than tear down, stop after step 4
and leave the application in place.

The CLI, CI, the library, and every share link are untouched throughout, because
none of them ever reach the MCP hostname.
