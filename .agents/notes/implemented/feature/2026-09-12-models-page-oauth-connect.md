# Agent Note: Models-page provider connect

Status: implemented

English | [中文](2026-09-12-models-page-oauth-connect.zh.md)

## Problem

Hosted OAuth routes (`openai-codex`, `cursor`, `google-antigravity`) connected only through the `/login` slash command. OpenCode Go was present in pi-ai's catalog but reached the Models page only as an ordinary settings profile, even though its provider-owned login is a single API-key prompt. The page had no direct Connect lifecycle for either kind of provider login.

## Decision

The directory offers dormant, method-marked login entries, and the Models page drives each provider-owned login from a Connect card.

`LlmConfigurableProvider` and live provider metadata carry `auth: 'oauth' | 'api-key'`, meaning the route connects through a provider-owned login rather than a settings profile. `directoryEntries()` declares the three hosted routes and OpenCode Go as dormant entries; a stored profile overwrites its entry (keeping the ordinary settings path), and an injected live credential withdraws it, so the page never renders both a Connect card and a connected row. The page join treats either marker as configured only on a live route, keeps dormant login rows out of the credential batch and the Add menu, and renders method-specific Connect cards with pending state and per-card refusal text.

Sign-in rides a new namespace-scoped `llm/loginOAuth` Remote, mirroring `registerModelDiscovery`: the provider being connected has no live registration to name yet, so the namespace is the key. `llm-pi-ai` registers the offer; it runs `loginHostedOAuth` with the same authorize-URL behavior as `/login` (emit `commands/open-url` for GUI subscribers, host browser opener otherwise) and refreshes routes on success. The concurrent-login guard moved from the command handler into store-keyed `loginHostedOAuth`, so a `/login` line and a Connect click share it. The Connect click calls the new `CommandUiContract.prepareOAuthLoginTab()` under its own user gesture, so the arriving authorize URL navigates the prepared tab instead of a popup-blocked fresh one.

OpenCode Go rides a separate namespace-scoped `llm/loginApiKey` Remote so its secret is an explicit typed argument rather than command text. The client validates printable non-space ASCII, submits the trimmed value from a password field, and clears the field immediately. The host validates again at the Remote boundary, drives pi-ai's `api_key` login method, and persists the record in the existing owner-only `$DSH_HOME/oauth-credentials.json` store. That credential injects the live `opencode-go` route without writing `settings.yaml`; disconnect deletes the record and restores the dormant card.

## Alternatives considered

**Keep `logout` as an undecorated service method.** The previous client forced the method through an untyped narrow cast, but the gateway only claims `@Remote` descriptors. Provider-managed Connect needs a real disconnect lifecycle, so `logout` is now decorated and consumed through the generated type.

**Register hosted sign-ins as authorization-seam flows.** The seam already covers installed catalog providers and stays the chat/ACP path. Routing the Models button through it would require the page to render the full notify/prompt interaction per provider; one namespace remote over the shared hosted interaction is narrower.

**Have the button submit `/login` through the command dispatcher.** Command execution is session-scoped and the settings surface holds no session; threading one through would couple settings to the composer for no behavioral gain.

**Add `/login opencode-go <key>`.** Command lines are model-visible and retained as interaction text, so placing a secret in one would expand its exposure. The Models password field and a secret-bearing Remote keep the API key out of command and session records.

**Hand-edit the generated API catalog.** `api-catalog.ts` will list the new remote once generated, but generation is currently blocked by unrelated pre-existing `session/checkpoints` JSDoc violations; hand-editing a generated artifact to work around them would drift on the next regen.

## Consequences

`/login` and `/logout` behave exactly as before, including the in-flight OAuth refusal text. The Models page connects and disconnects OAuth and OpenCode Go without the composer. API-key validation never includes the submitted key in a diagnostic, and the browser clears its copy before the Remote settles. The tab handoff, secret persistence, refusal display, and directory withdraw/restore lifecycle are covered in `catalog.spec.ts`, `oauth-login.spec.ts`, `topology.spec.ts`, the Models store/component specs, and the ui-commands service spec. The `session/checkpoints` JSDoc violations and the `api-catalog.ts` regen that depends on them remain open and unrelated.
