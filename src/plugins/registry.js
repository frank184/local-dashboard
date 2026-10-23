import calendarManifest from './calendar/manifest.json';
import calendarPage from './calendar/page.html?raw';
import calendarSettingsPage from './calendar/settings.html?raw';
import todosManifest from './todos/manifest.json';
import todosPage from './todos/page.html?raw';
import healthManifest from './health/manifest.json';
import healthPage from './health/page.html?raw';
import healthSettingsPage from './health/settings.html?raw';

// This is the renderer's build-time catalog. SQLite controls whether a plugin
// is installed/enabled; the manifest supplies its trusted bundled UI contract.
export const bundledPlugins = [
  { manifest: Object.freeze(calendarManifest), pageTemplate: calendarPage },
  { manifest: Object.freeze(todosManifest), pageTemplate: todosPage },
  { manifest: Object.freeze(healthManifest), pageTemplate: healthPage },
];

export const bundledPluginById = new Map(bundledPlugins.map((plugin) => [plugin.manifest.id, plugin]));
export const pluginPageTemplates = Object.fromEntries(bundledPlugins.map(({ manifest, pageTemplate }) => [manifest.id, pageTemplate]));
export const pluginPageTitles = Object.fromEntries(bundledPlugins.map(({ manifest }) => [manifest.id, manifest.name]));
export const pluginSettingsPageTemplates = { 'plugins/calendar/settings': calendarSettingsPage, 'plugins/health/settings': healthSettingsPage };
