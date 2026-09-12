# Agent Note: Model favorites

Status: implemented

English | [中文](2026-09-12-model-favorites.zh.md)

## Problem

Deployments advertise dozens of models across several providers, and the composer seat and `/model` popup both list them in provider-group order. A user who alternates between two or three models scrolls past the full catalog on every switch.

## Decision

`dsh-client-ui-model-selection` pins a browser-local favorites list to the top of both selection entries. `ModelDirectoryResolver` owns one persisted `ModelFavoritesState` store (`dsh.modelFavorites.v1` in `localStorage`); the composer seat and the `/model` popup read the same instance, so a star toggled in the seat reorders the popup on its next open. The seat renders a Favorites group first with a per-row star toggle (`favorites.title`, `favorites.add`, `favorites.remove`), while keeping each favorited model in its provider group with its star filled; the popup orders favorited rows first in catalog order, then the remaining models, then provider-failure rows. Favorite ids are `provider/model` strings; unknown ids are retained in storage but never listed, and a malformed stored value resets to the normalized list. Favorites are presentation-only viewing state: they never enter the session log, the `session.selectModel` payload, or the model request.

## Alternatives considered

**Host-backed settings namespace.** Rejected because favorites are per-browser viewing state like drafts and panel widths, not per-deployment configuration; a Host namespace would require a new settings schema, provider, and settings-UI surface for a preference that must work on read-only non-loopback clients.

**Per-session favorites.** Rejected because the pinned models are a property of the user, not the conversation; scoping by session would force re-starring in every new session and orphan a storage key per pruned session.

**Star toggles inside the `/model` popup.** Rejected because the popupSelect shell owns its rows and offers no per-row action slot; teaching the shared shell a business-specific toggle would couple every popupSelect consumer to model favorites.

**Removing favorited models from their provider groups.** Rejected because provider groups are the complete catalog view; hiding a model from its group would make the group look incomplete and hide the unstar affordance where the user found the model.

## Consequences

- Switching between a few models needs no scrolling: favorites stay first in both entries, and the popup order follows the seat toggle without a reload.
- Favorites survive reloads per browser and never leak across devices; non-browser runtimes keep an empty in-memory list.
- Unknown or malformed stored ids cannot break the selector: they are skipped or reset, and selection still uses provider/model/effort ids.
- Unit coverage owns id normalization, toggle ordering, catalog-order listing, store persistence and reset, popup ordering through the shared service, and seat starring, filtering, and selection from the Favorites group.
