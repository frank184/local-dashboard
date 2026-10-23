import googleCalendar from './google-calendar/manifest.json';
import outlookCalendar from './outlook-calendar/manifest.json';
import fitbit from './fitbit/manifest.json';

export const bundledIntegrations = [googleCalendar, outlookCalendar, fitbit].map((manifest) => Object.freeze(manifest));
export const bundledIntegrationById = new Map(bundledIntegrations.map((manifest) => [manifest.providerId, manifest]));
