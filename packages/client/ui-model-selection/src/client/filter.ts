/**
 * Local catalog filter for the composer model pane. Filtering is
 * presentation-only: ids stay the selection keys, and a blank query keeps
 * every advertised group.
 *
 * @module dsh-client-ui-model-selection/filter
 */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Keep advertised groups whose name, id, or a contained model's name, id, or
 * description case-insensitively contains `search`. Empty groups drop out.
 * @param groups - the directory's advertised provider groups.
 * @param search - the in-menu filter text.
 * @returns the groups the model pane lists.
 */
export function filterModelGroups(
  groups: readonly ModelProviderGroup[],
  search: string,
): readonly ModelProviderGroup[] {
  const query = search.trim().toLowerCase()
  if (query === '') return groups
  const hits: ModelProviderGroup[] = []
  for (const group of groups) {
    const models = group.models.filter(model =>
      model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
      || group.name.toLowerCase().includes(query)
      || group.id.toLowerCase().includes(query)
      || (model.description?.toLowerCase().includes(query) ?? false),
    )
    if (models.length > 0) hits.push({ ...group, models })
  }
  return hits
}
