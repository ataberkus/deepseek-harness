# Agent Note: LM Studio is a first-class local pi-ai route

Status: implemented

English | [中文](2026-08-20-lm-studio-local-provider.zh.md)

## Problem

A local LM Studio server speaks the OpenAI-compatible Chat Completions protocol but does not require authentication. Treating it as an ordinary hand-declared route makes the Models page ask for values the server does not need, while pi-ai still requires a non-empty key-shaped input for its OpenAI client. The server's model ids are opaque and deployment-specific, so inventing a catalog entry or normalizing an id would make discovery and later requests address a different model.

## Decision

`dsh-llm-pi-ai` declares `lmstudio` as a named route in its configurable-provider directory. It is not a synthetic pi-ai catalog model. The route supplies these defaults when the profile omits them:

- `api`: `openai-completions`;
- `baseURL`: `http://127.0.0.1:1234/v1`;
- display name: `LM Studio`.

The profile still requires an explicit `models` list. Its entries are persisted user choices, and their ids remain byte-for-byte unchanged. A profile may override the endpoint or protocol, and an explicit `apiKeyEnv` resolves through the normal Harness credential seam and takes precedence over the local keyless behavior.

When `apiKeyEnv` is absent, request resolution supplies the non-secret value `lm-studio` only for the `lmstudio` route. This satisfies pi-ai's OpenAI client without storing or exposing a credential. Other routes keep their existing distinction between provider-native ambient discovery and a named reference that fails with `MISSING_CREDENTIAL` when it cannot resolve.

The existing `llm.discoverModels` path is the discovery mechanism. For LM Studio, it asks the configured compatibility endpoint's `/models` resource, presents the returned ids to the Models page, and writes only the models the user adopts into `settings.yaml`. Runtime model resolution reads that explicit list; it does not poll LM Studio or replace the list on each request. The route's opaque ids therefore remain the sole identifiers across discovery, settings, picker metadata, and requests. The declared-provider catalog decision remains authoritative for route materialization and is extended by this note ([declared provider catalog](../architecture/2026-08-03-pi-ai-declared-provider-catalog.md)).

The configurable-provider view carries optional setup defaults for `api` and `baseURL`. The LLM registry clones those nested values, the Host API projects and validates them, and the Models editor seeds a draft only when neither the user layer nor the effective profile already provides a field. Applying the draft persists the adopted defaults as ordinary profile fields, so explicit edits and composition values are never overwritten.

## Alternatives considered

- **Keep LM Studio as a custom provider only.** This preserves the old surface but makes every local setup repeat the same endpoint and protocol values and presents a key field for a keyless server. A named route gives the Models page a discoverable option without changing the generic custom-provider path.
- **Add a fake LM Studio model to the installed catalog.** This would make a deployment-specific id look authoritative, lose arbitrary loaded ids, and couple the route to one model. The named route has no synthetic model and keeps the catalog boundary intact.
- **Refresh a runtime LM Studio catalog on every request.** This would make request behavior depend on mutable endpoint state and require cache invalidation and an offline policy. Discovery is a user action; the persisted model list remains the source of truth for requests.
- **Always require a real API key or send no key.** Sending no key fails inside pi-ai before a keyless server can answer, while storing a real key is unnecessary. The route-local non-secret placeholder satisfies the library without weakening explicit credential precedence or the fail-loud rule for named references.

## Consequences

LM Studio is visible as a dormant first-class option before a profile exists, and its editor can discover models using the documented local endpoint without an initial key. Users must explicitly adopt the returned list, so a model loaded later in LM Studio is not automatically selectable until discovery is repeated. The defaults metadata is optional and generic, allowing other configurable-provider directories to seed the same editor fields without coupling the Host API or UI to LM Studio.

The local endpoint is a product default, not a network guarantee: users running LM Studio elsewhere must edit `baseURL`, and servers with authentication must set `apiKeyEnv`. The placeholder is never a credential record and is never used when an explicit reference is configured.

## Testing

The pi-ai catalog, configuration, discovery, and adapter suites cover the named directory entry, exact defaults, explicit overrides, opaque ids, keyless requests, and credential precedence. LLM topology, Host API projection/schema, and Models editor suites cover nested-default cloning, wire projection, draft seeding, discovery payloads, and persisted profile fields. The assembled Web replay and GUI gates remain the product-level verification for the Models page composition.
