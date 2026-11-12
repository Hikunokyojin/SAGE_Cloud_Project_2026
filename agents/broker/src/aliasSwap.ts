// WP3.5 L8: zero-downtime re-embedding. scripts/reembed-services.ts fills a new collection
// "<alias>_<timestamp>", then this plan moves the alias (which the Broker searches by name)
// to it in one atomic alias update and drops the old generations afterwards.

export type AliasAction =
  | { delete_alias: { alias_name: string } }
  | { create_alias: { collection_name: string; alias_name: string } };

export interface AliasSwapPlan {
  /** Collections to delete before the alias update (only a plain collection squatting on the alias name). */
  dropBefore: string[];
  /** One atomic alias update. */
  actions: AliasAction[];
  /** Old generations to delete once the alias points at the fresh one. */
  dropAfter: string[];
}

export function planAliasSwap(args: {
  alias: string;
  fresh: string;
  collections: string[];
  aliasTarget: string | undefined;
}): AliasSwapPlan {
  const { alias, fresh, collections, aliasTarget } = args;
  const dropBefore = collections.includes(alias) ? [alias] : [];
  const actions: AliasAction[] = [
    ...(aliasTarget ? [{ delete_alias: { alias_name: alias } }] : []),
    { create_alias: { collection_name: fresh, alias_name: alias } },
  ];
  const generation = new RegExp(`^${alias}_\\d+$`);
  const dropAfter = collections.filter((c) => c !== fresh && generation.test(c));
  return { dropBefore, actions, dropAfter };
}
