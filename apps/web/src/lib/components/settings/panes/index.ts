import type { Component } from "svelte";
import type { SettingsPaneMeta } from "../settings-panes";
import AccountPane, { pane as account } from "./AccountPane.svelte";
import AgentPane, { pane as ai } from "./AgentPane.svelte";
import GeneralPane, { pane as general } from "./GeneralPane.svelte";
import IntegrationsPane, { pane as integrations } from "./IntegrationsPane.svelte";
import RecapsPane, { pane as recap } from "./RecapsPane.svelte";
import RepositoriesPane, { pane as repositories } from "./RepositoriesPane.svelte";
import TeamCachePane, { pane as cache } from "./TeamCachePane.svelte";
import TypeSafePane, { pane as jev } from "./TypeSafePane.svelte";
import UpdatesPane, { pane as updates } from "./UpdatesPane.svelte";

const entry = <P extends SettingsPaneMeta>(pane: P, component: Component) => ({
  ...pane,
  component,
});

/**
 * Every settings pane, in nav order. Clusters are separated by a gap in the
 * nav: you → what the agent does → team → the app.
 */
export const SETTINGS_PANE_CLUSTERS = [
  [entry(general, GeneralPane), entry(account, AccountPane), entry(repositories, RepositoriesPane)],
  [
    entry(ai, AgentPane),
    entry(recap, RecapsPane),
    entry(jev, TypeSafePane),
    entry(integrations, IntegrationsPane),
  ],
  [entry(cache, TeamCachePane)],
  [entry(updates, UpdatesPane)],
] as const;

export const SETTINGS_PANES = SETTINGS_PANE_CLUSTERS.flat();

export type SettingsPaneEntry = (typeof SETTINGS_PANES)[number];
