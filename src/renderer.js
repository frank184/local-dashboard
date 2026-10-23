import overviewPage from './pages/overview.html?raw';
import pluginsPage from './pages/plugins.html?raw';
import integrationsPage from './pages/integrations.html?raw';
import workflowsPage from './pages/workflows.html?raw';
import designSystemPage from './pages/design-system.html?raw';
import { bundledPlugins, pluginPageTemplates, pluginPageTitles, pluginSettingsPageTemplates } from './plugins/registry.js';
import { bundledIntegrations } from './integrations/registry.js';
import {
  createIcons,
  Activity,
  ArrowRight,
  Blocks,
  Cable,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  HeartPulse,
  Info,
  LayoutDashboard,
  ListTodo,
  Moon,
  MoreHorizontal,
  Palette,
  Plus,
  Pencil,
  Scale,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Unplug,
  X,
  ToggleLeft,
  ToggleRight,
  Watch,
  Workflow,
} from 'lucide';
import {
  CategoryScale,
  Chart,
  Filler,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';

Chart.register(CategoryScale, Filler, LineController, LineElement, LinearScale, PointElement, Tooltip);

const iconSet = {
  Activity,
  ArrowRight,
  Blocks,
  Cable,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  HeartPulse,
  Info,
  LayoutDashboard,
  ListTodo,
  Moon,
  MoreHorizontal,
  Palette,
  Plus,
  Pencil,
  Scale,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Unplug,
  X,
  ToggleLeft,
  ToggleRight,
  Watch,
  Workflow,
};

const featureRoutes = new Set(bundledPlugins.map(({ manifest }) => manifest.id));
const featureNavigation = document.querySelector('#feature-plugin-navigation');

const pageTemplates = {
  overview: overviewPage,
  plugins: pluginsPage,
  integrations: integrationsPage,
  workflows: workflowsPage,
  ...pluginPageTemplates,
  ...pluginSettingsPageTemplates,
  'design-system': designSystemPage,
};
const pageTitles = {
  overview: 'Overview',
  plugins: 'Plugins',
  integrations: 'Integrations',
  workflows: 'Workflows',
  ...pluginPageTitles,
  'plugins/calendar/settings': 'Calendar settings',
  'design-system': 'Design system',
};
const pageRoot = document.querySelector('#page-root');
const pageLabel = document.querySelector('#current-page-label');
const themeToggle = document.querySelector('.theme-toggle');
let currentPage = '';
let sidebarCollapsed = localStorage.getItem('local-dashboard-sidebar-collapsed') === 'true';
let activeCharts = [];
let calendarDate = new Date();
let calendarSearch = '';
let calendarMonthWheelDelta = 0;
let calendarMonthWheelReset = null;
let calendarMonthWheelLockedUntil = 0;
const calendarSourceVisibility = {}; 
let calendarView = 'week';
let calendarEvents = [];
let calendarSettings = { startHour: 0, endHour: 24 };
let calendarSidePanelCollapsed = false;
const themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themeChoice = localStorage.getItem('local-dashboard-theme') || 'system';

function applyTheme(choice = themeChoice) {
  themeChoice = ['system', 'light', 'dark'].includes(choice) ? choice : 'system';
  const resolvedTheme = themeChoice === 'system' ? (themeMediaQuery.matches ? 'dark' : 'light') : themeChoice;
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeMode = themeChoice;
  localStorage.setItem('local-dashboard-theme', themeChoice);
  if (themeToggle) {
    const isDark = resolvedTheme === 'dark';
    themeToggle.setAttribute('aria-pressed', String(isDark));
    themeToggle.title = `Switch to ${isDark ? 'light' : 'dark'} mode`;
    themeToggle.replaceChildren();
    const icon = document.createElement('i'); icon.className = 'icon'; icon.dataset.lucide = isDark ? 'sun' : 'moon'; icon.setAttribute('aria-hidden', 'true');
    themeToggle.append(icon); renderIcons(themeToggle);
  }
  if (currentPage === 'health') {
    destroyCharts();
    void hydratePage('health');
  }
}


function applySidebarState(persist = true) {
  document.body.classList.toggle('is-sidebar-collapsed', sidebarCollapsed);
  const toggle = document.querySelector('.sidebar-toggle');
  if (!toggle) return;
  toggle.setAttribute('aria-expanded', String(!sidebarCollapsed));
  toggle.setAttribute('aria-label', `${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation`);
  toggle.title = `${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation`;
  const icon = toggle.querySelector('[data-lucide]');
  if (icon) icon.dataset.lucide = sidebarCollapsed ? 'chevron-right' : 'chevron-left';
  const label = toggle.querySelector('span');
  if (label) label.textContent = `${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation`;
  renderIcons(toggle);
  if (persist) localStorage.setItem('local-dashboard-sidebar-collapsed', String(sidebarCollapsed));
}

function showSettingsDialog() {
  const form = document.createElement('form');
  form.className = 'dialog-form settings-form';
  form.innerHTML = `<label class="field field-wide">Appearance
    <select name="theme"><option value="system">Use system setting</option><option value="light">Light</option><option value="dark">Dark</option></select>
  </label><p class="dialog-copy field-wide settings-note">System setting follows your device appearance. Your choice is saved on this device.</p>`;
  form.elements.theme.value = themeChoice;
  const close = document.createElement('button'); close.className = 'button button-secondary'; close.type = 'button'; close.textContent = 'Done';
  const dialog = openDialog('Settings', form, [close]);
  close.addEventListener('click', () => dialog.close());
  form.elements.theme.addEventListener('change', () => applyTheme(form.elements.theme.value));
}

applyTheme();
applySidebarState(false);
document.querySelector('.sidebar-toggle')?.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  applySidebarState();
});
themeMediaQuery.addEventListener('change', () => {
  if (themeChoice === 'system') applyTheme('system');
});
document.querySelector('.avatar')?.addEventListener('click', showSettingsDialog);
themeToggle?.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

async function loadPluginNavigation() {
  try {
    const { plugins } = await window.dashboard.getPageData('navigation');
    featureNavigation.replaceChildren();
    for (const plugin of plugins.filter((item) => featureRoutes.has(item.id))) {
      pageTitles[plugin.id] = plugin.name;
      const link = document.createElement('a');
      link.className = 'nav-item';
      link.href = `#${plugin.id}`;
      link.title = plugin.name;
      link.setAttribute('aria-label', plugin.name);
      link.dataset.pluginId = plugin.id;
      const icon = document.createElement('i');
      icon.className = 'icon';
      icon.dataset.lucide = plugin.icon;
      icon.setAttribute('aria-hidden', 'true');
      link.append(icon, document.createTextNode(` ${plugin.name}`));
      featureNavigation.append(link);
    }
    renderIcons(featureNavigation);
    updateActiveNavigation(currentPage);
  } catch (error) {
    console.error('Could not load plugin navigation', error);
  }
}

function updateActiveNavigation(pageId) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    const nestedPluginId = pageId.startsWith('plugins/') ? pageId.split('/')[1] : null;
    const active = item.getAttribute('href') === `#${pageId}` || (nestedPluginId && item.getAttribute('href') === `#${nestedPluginId}`);
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}

function destroyCharts() {
  for (const chart of activeCharts) chart.destroy();
  activeCharts = [];
}

function renderIcons(root) {
  createIcons({ icons: iconSet, root, attrs: { 'stroke-width': 1.8 } });
}

// Hash links with a current route can still trigger native fragment scrolling. Keep
// the active navigation click on the current page a no-op.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a.nav-item');
  if (!link) return;
  const targetPage = link.getAttribute('href')?.slice(1);
  if (targetPage && targetPage === currentPage) event.preventDefault();
});

function renderPage(requestedPage) {
  const pageId = Object.hasOwn(pageTemplates, requestedPage) ? requestedPage : 'overview';
  if (currentPage === pageId) return;
  if (pageId === 'calendar' && !sidebarCollapsed) {
    sidebarCollapsed = true;
    applySidebarState();
  }

  destroyCharts();
  pageRoot.innerHTML = pageTemplates[pageId];
  currentPage = pageId;
  document.body.classList.toggle('is-calendar-page', pageId === 'calendar');
  pageLabel.textContent = pageTitles[pageId];
  if (featureRoutes.has(pageId)) pageRoot.querySelector('h1').textContent = pageTitles[pageId];
  updateActiveNavigation(pageId);
  renderIcons(pageRoot);
  window.scrollTo({ top: 0, behavior: 'auto' });

  pageRoot.querySelector('.primary-button')?.addEventListener('click', () => {
    window.location.hash = 'plugins';
  });
  pageRoot.querySelectorAll('[data-action="new-event"]').forEach((button) => button.addEventListener('click', () => showEventForm()));
  pageRoot.querySelectorAll('[data-calendar-source]').forEach((toggle) => {
    toggle.checked = calendarSourceVisibility[toggle.dataset.calendarSource] !== false;
    toggle.addEventListener('change', () => { calendarSourceVisibility[toggle.dataset.calendarSource] = toggle.checked; renderCalendarBoard(calendarEvents); });
  });
  pageRoot.querySelector('[data-action="new-task"]')?.addEventListener('click', () => showTaskForm());
  pageRoot.querySelector('[data-action="new-plugin"]')?.addEventListener('click', () => showPluginForm());
  pageRoot.querySelectorAll('[data-calendar-nav]').forEach((button) => button.addEventListener('click', () => moveCalendar(button.dataset.calendarNav)));
  pageRoot.querySelector('#calendar-board')?.addEventListener('wheel', (event) => {
    if (calendarView !== 'month' || Math.abs(event.deltaY) < 12) return;
    if (Math.sign(calendarMonthWheelDelta) !== Math.sign(event.deltaY)) calendarMonthWheelDelta = 0;
    calendarMonthWheelDelta += event.deltaY;
    clearTimeout(calendarMonthWheelReset);
    calendarMonthWheelReset = setTimeout(() => { calendarMonthWheelDelta = 0; }, 220);
    if (Math.abs(calendarMonthWheelDelta) < 100 || Date.now() < calendarMonthWheelLockedUntil) return;
    event.preventDefault();
    const direction = calendarMonthWheelDelta > 0 ? 'next' : 'previous';
    calendarMonthWheelDelta = 0;
    calendarMonthWheelLockedUntil = Date.now() + 450;
    moveCalendar(direction);
  }, { passive: false });
  pageRoot.querySelectorAll('[data-mini-nav]').forEach((button) => button.addEventListener('click', () => {
    calendarDate.setDate(1); calendarDate.setMonth(calendarDate.getMonth() + (button.dataset.miniNav === 'previous' ? -1 : 1));
    renderCalendarBoard(calendarEvents);
  }));
  const calendarSearchInput = pageRoot.querySelector('.calendar-search');
  if (calendarSearchInput) {
    calendarSearchInput.value = calendarSearch;
    calendarSearchInput.addEventListener('input', (event) => { calendarSearch = event.target.value.trim().toLowerCase(); renderCalendarBoard(calendarEvents); });
  }
  pageRoot.querySelectorAll('[data-calendar-view]').forEach((button) => button.addEventListener('click', () => {
    calendarView = button.dataset.calendarView;
    pageRoot.querySelectorAll('[data-calendar-view]').forEach((item) => item.classList.toggle('active', item === button));
    renderCalendarBoard(calendarEvents);
  }));
  const sidePanelToggle = pageRoot.querySelector('[data-calendar-sidepanel-toggle]');
  if (sidePanelToggle) {
    applyCalendarSidePanelState();
    sidePanelToggle.addEventListener('click', async () => {
      calendarSidePanelCollapsed = !calendarSidePanelCollapsed;
      applyCalendarSidePanelState();
      try { await window.dashboard.setPluginSetting('calendar', 'side-panel-collapsed', calendarSidePanelCollapsed); }
      catch (error) { calendarSidePanelCollapsed = !calendarSidePanelCollapsed; applyCalendarSidePanelState(); window.alert(`Could not save Calendar preference: ${error.message}`); }
    });
  }
  const calendarSettingsForm = pageRoot.querySelector('#calendar-settings-form');
  if (calendarSettingsForm) bindCalendarSettingsForm(calendarSettingsForm);

  void hydratePage(pageId);
}

function applyCalendarSidePanelState() {
  const layout = pageRoot.querySelector('.calendar-layout');
  const rail = pageRoot.querySelector('.calendar-right-rail');
  const button = pageRoot.querySelector('[data-calendar-sidepanel-toggle]');
  if (!layout || !rail || !button) return;
  layout.classList.toggle('is-calendar-sidepanel-collapsed', calendarSidePanelCollapsed);
  rail.classList.toggle('is-calendar-sidepanel-collapsed', calendarSidePanelCollapsed);
  button.setAttribute('aria-expanded', String(!calendarSidePanelCollapsed));
  button.setAttribute('aria-label', `${calendarSidePanelCollapsed ? 'Expand' : 'Collapse'} calendar side panel`);
  button.title = `${calendarSidePanelCollapsed ? 'Expand' : 'Collapse'} side panel`;
  const icon = button.querySelector('[data-lucide]');
  if (icon) icon.dataset.lucide = calendarSidePanelCollapsed ? 'chevron-left' : 'chevron-right';
  renderIcons(button);
}

function formatCalendarHour(hour, isEnd = false) {
  if (hour === 24) return isEnd ? '12 AM (next day)' : '12 AM';
  const date = new Date(2020, 0, 1);
  date.setHours(hour, 0, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(date);
}

function bindCalendarSettingsForm(form) {
  const startSelect = form.elements.startHour;
  const endSelect = form.elements.endHour;
  const status = pageRoot.querySelector('#calendar-settings-status');
  for (let hour = 0; hour < 24; hour += 1) {
    const option = document.createElement('option'); option.value = String(hour); option.textContent = formatCalendarHour(hour); startSelect.append(option);
  }
  const populateEndHours = (startHour, selectedHour = 24) => {
    endSelect.replaceChildren();
    for (let hour = startHour + 1; hour <= 24; hour += 1) {
      const option = document.createElement('option'); option.value = String(hour); option.textContent = formatCalendarHour(hour, true); endSelect.append(option);
    }
    endSelect.value = String(Number(selectedHour) > startHour ? selectedHour : 24);
  };
  startSelect.addEventListener('change', () => populateEndHours(Number(startSelect.value), Number(endSelect.value)));
  void window.dashboard.getPluginSetting('calendar', 'visible-hours').then((saved) => {
    if (currentPage !== 'plugins/calendar/settings') return;
    calendarSettings = normalizeCalendarSettings(saved);
    startSelect.value = String(calendarSettings.startHour);
    populateEndHours(calendarSettings.startHour, calendarSettings.endHour);
  }).catch((error) => { if (status) status.textContent = `Could not load settings: ${error.message}`; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const next = normalizeCalendarSettings({ startHour: Number(startSelect.value), endHour: Number(endSelect.value) });
    if (next.endHour <= next.startHour) { if (status) status.textContent = 'End time must be later than start time.'; return; }
    const save = form.querySelector('[type="submit"]'); save.disabled = true;
    try {
      await window.dashboard.setPluginSetting('calendar', 'visible-hours', next);
      calendarSettings = next;
      if (status) status.textContent = 'Settings saved on this device.';
    } catch (error) { if (status) status.textContent = `Could not save settings: ${error.message}`; }
    finally { save.disabled = false; }
  });
}

function normalizeCalendarSettings(settings) {
  const startHour = Number(settings?.startHour ?? 0);
  const endHour = Number(settings?.endHour ?? 24);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23 || !Number.isInteger(endHour) || endHour < 1 || endHour > 24 || endHour <= startHour) {
    return { startHour: 0, endHour: 24 };
  }
  return { startHour, endHour };
}

async function hydratePage(pageId) {
  if (pageId === 'plugins/calendar/settings') return;
  if (!['plugins', 'integrations', 'workflows', 'calendar', 'todos', 'health'].includes(pageId)) return;
  try {
    const data = await window.dashboard.getPageData(pageId);
    if (currentPage !== pageId) return;
    if (pageId === 'plugins') renderPlugins(data.plugins || []);
    if (pageId === 'workflows') renderWorkflows(data.workflows || [], data.runs || []);
    if (pageId === 'calendar') {
      calendarEvents = data.events || [];
      calendarSettings = normalizeCalendarSettings(data.settings);
      calendarSidePanelCollapsed = Boolean(data.sidePanelCollapsed);
      applyCalendarSidePanelState();
      renderCalendarBoard(calendarEvents);
      const connectionData = await window.dashboard.getPageData('integrations');
      if (currentPage === 'calendar') renderCalendarIntegrations(connectionData.integrations || []);
    }
    if (pageId === 'integrations') renderIntegrations(data.integrations || []);
    if (pageId === 'todos') renderTodos(data.tasks || []);
    if (pageId === 'health') renderHealth(data);
  } catch (error) {
    console.error(`Could not load ${pageId} data`, error);
    if (pageId === 'integrations' && currentPage === pageId) {
      renderIntegrations([]);
      const message = document.createElement('p');
      message.className = 'form-error integration-load-error';
      message.textContent = `Could not load saved connections: ${error.message}`;
      pageRoot.querySelector('#integration-connection-list')?.prepend(message);
    }
  }
}

function renderPlugins(plugins) {
  const list = pageRoot.querySelector('#plugin-card-grid');
  if (!list) return;
  list.replaceChildren();
  const count = pageRoot.querySelector('#plugin-count');
  if (count) count.textContent = `${plugins.filter((plugin) => plugin.installed).length} installed`;
  for (const plugin of plugins) {
    const card = document.createElement('article');
    card.className = `plugin-list-card${plugin.installed ? '' : ' is-uninstalled'}`;
    const top = document.createElement('div');
    top.className = 'plugin-list-card-top';
    const identity = document.createElement('div');
    identity.className = 'plugin-card-identity';
    const icon = document.createElement('span');
    icon.className = 'plugin-app-icon';
    const iconNode = document.createElement('i');
    iconNode.className = 'icon';
    iconNode.dataset.lucide = plugin.icon || 'blocks';
    icon.append(iconNode);
    const titleBlock = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = plugin.name;
    const subline = document.createElement('small');
    subline.textContent = `${plugin.domain_id.replaceAll('-', ' ')} · v${plugin.version}`;
    titleBlock.append(title, subline);
    identity.append(icon, titleBlock);
    top.append(identity);
    if (plugin.installed) {
      const menuButton = document.createElement('button');
      menuButton.className = 'icon-button plugin-menu-trigger';
      menuButton.type = 'button';
      menuButton.setAttribute('aria-label', `Manage ${plugin.name}`);
      const dots = document.createElement('i'); dots.className = 'icon'; dots.dataset.lucide = 'more-horizontal';
      menuButton.append(dots);
      const menu = document.createElement('div');
      menu.className = 'plugin-action-menu';
      menu.hidden = true;
      menuButton.addEventListener('click', (event) => {
        event.stopPropagation();
        pageRoot.querySelectorAll('.plugin-action-menu').forEach((item) => { if (item !== menu) item.hidden = true; });
        menu.hidden = !menu.hidden;
      });
      menu.append(menuAction('Edit details', 'pencil', () => showPluginForm(plugin)));
      menu.append(menuAction(plugin.enabled ? 'Disable' : 'Enable', plugin.enabled ? 'toggle-left' : 'toggle-right', async () => {
        await window.dashboard.savePlugin({ ...plugin, domainId: plugin.domain_id, enabled: !plugin.enabled });
        await refreshPluginData();
      }));
      menu.append(menuAction('Delete plugin', 'trash-2', async () => {
        menu.hidden = true;
        const accepted = await showConfirm(`Delete ${plugin.name}?`, 'This uninstalls the plugin and removes it from navigation. Its local records will be kept.', 'Delete plugin');
        if (!accepted) return;
        await window.dashboard.uninstallPlugin(plugin.id);
        if (currentPage === plugin.id) window.location.hash = 'plugins';
        await refreshPluginData();
      }, true));
      const menuWrap = document.createElement('div');
      menuWrap.className = 'plugin-menu-wrap';
      menuWrap.append(menuButton, menu);
      top.append(menuWrap);
    } else {
      const install = document.createElement('button');
      install.className = 'button button-secondary button-small';
      install.textContent = 'Install';
      install.addEventListener('click', async () => { await window.dashboard.installPlugin(plugin.id); await refreshPluginData(); });
      top.append(install);
    }
    const description = document.createElement('p');
    description.className = 'plugin-list-description';
    description.textContent = plugin.description || 'A built-in workspace capability.';
    const footer = document.createElement('div');
    footer.className = 'plugin-list-footer';
    const status = document.createElement('span');
    status.className = `badge ${plugin.installed && plugin.enabled ? 'badge-success' : 'badge-neutral'}`;
    status.innerHTML = `<i></i>${plugin.installed ? (plugin.enabled ? 'Enabled' : 'Disabled') : 'Not installed'}`;
    const kind = document.createElement('span');
    kind.textContent = plugin.kind;
    footer.append(status, kind);
    card.append(top, description, footer);
    list.append(card);
  }
  renderIcons(list);
}

function menuAction(label, iconName, action, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `plugin-action${danger ? ' is-danger' : ''}`;
  const icon = document.createElement('i'); icon.className = 'icon'; icon.dataset.lucide = iconName;
  button.append(icon, document.createTextNode(label));
  button.addEventListener('click', action);
  return button;
}

async function refreshPluginData() {
  const [{ plugins }, { plugins: navigation }] = await Promise.all([
    window.dashboard.getPageData('plugins'), window.dashboard.getPageData('navigation'),
  ]);
  renderPlugins(plugins);
  featureNavigation.replaceChildren();
  for (const plugin of navigation.filter((item) => featureRoutes.has(item.id))) {
    pageTitles[plugin.id] = plugin.name;
    const link = document.createElement('a');
    link.className = 'nav-item'; link.href = `#${plugin.id}`; link.title = plugin.name; link.setAttribute('aria-label', plugin.name);
    const icon = document.createElement('i'); icon.className = 'icon'; icon.dataset.lucide = plugin.icon;
    link.append(icon, document.createTextNode(` ${plugin.name}`)); featureNavigation.append(link);
  }
  renderIcons(featureNavigation);
}

function openDialog(title, contentNode, actions = []) {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog';
  const header = document.createElement('div'); header.className = 'dialog-header';
  const heading = document.createElement('h2'); heading.textContent = title;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.setAttribute('aria-label', 'Close');
  const closeIcon = document.createElement('i'); closeIcon.className = 'icon'; closeIcon.dataset.lucide = 'x'; close.append(closeIcon);
  close.addEventListener('click', () => dialog.close());
  header.append(heading, close);
  const footer = document.createElement('div'); footer.className = 'dialog-actions';
  for (const action of actions) footer.append(action);
  dialog.append(header, contentNode, footer);
  document.body.append(dialog);
  renderIcons(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
  return dialog;
}

function showConfirm(title, message, confirmLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const content = document.createElement('p'); content.className = 'dialog-copy'; content.textContent = message;
    const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
    const confirm = document.createElement('button'); confirm.className = 'button button-danger'; confirm.type = 'button'; confirm.textContent = confirmLabel;
    const dialog = openDialog(title, content, [cancel, confirm]);
    dialog.addEventListener('close', () => settle(false), { once: true });
    cancel.addEventListener('click', () => { settle(false); dialog.close(); });
    confirm.addEventListener('click', () => { settle(true); dialog.close(); });
  });
}

function showPluginForm(plugin = null) {
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<label class="field field-wide">Name<input name="name" required maxlength="60" placeholder="Sleep insights"></label>
    <label class="field">Category<select name="domainId"><option value="personal-health">Personal health</option><option value="personal-productivity">Personal productivity</option><option value="personal-finance">Personal finance</option></select></label>
    <label class="field">Plugin type<select name="kind"><option value="feature">Feature</option><option value="orchestration">Orchestration</option></select></label>
    <label class="field field-wide">Description<textarea name="description" rows="3" maxlength="180" placeholder="What does this plugin add?"></textarea></label>
    <label class="field">Icon<select name="icon"><option value="calendar-days">Calendar</option><option value="list-todo">Task list</option><option value="heart-pulse">Health</option><option value="blocks">Blocks</option><option value="activity">Activity</option><option value="sparkles">Sparkles</option><option value="workflow">Workflow</option></select></label>
    ${plugin ? '<label class="field dialog-checkbox"><input name="enabled" type="checkbox"> Enabled in workspace</label>' : '<p class="dialog-copy field-wide">This registers plugin metadata locally. Its manifest and assets still need an implemented page contribution before it can add a custom screen.</p>'}`;
  if (plugin) {
    form.elements.name.value = plugin.name; form.elements.domainId.value = plugin.domain_id;
    form.elements.kind.value = plugin.kind; form.elements.description.value = plugin.description || '';
    form.elements.icon.value = plugin.icon || 'blocks'; form.elements.enabled.checked = Boolean(plugin.enabled);
  }
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = plugin ? 'Save changes' : 'Create plugin';
  const dialog = openDialog(plugin ? 'Edit plugin' : 'New plugin', form, [cancel, save]);
  cancel.addEventListener('click', () => dialog.close()); save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try {
      const values = { name: form.elements.name.value.trim(), domainId: form.elements.domainId.value, kind: form.elements.kind.value, description: form.elements.description.value.trim(), icon: form.elements.icon.value };
      if (plugin) await window.dashboard.savePlugin({ ...values, id: plugin.id, enabled: form.elements.enabled.checked });
      else await window.dashboard.createPlugin(values);
      dialog.close(); await refreshPluginData();
    } catch (error) { window.alert(error.message); save.disabled = false; }
  });
}

function makeIntegrationMark(provider) {
  const wrap = document.createElement('span'); wrap.className = 'integration-app-icon';
  if (provider.brandIcon) {
    const image = document.createElement('img'); image.src = `./integration-icons/${provider.brandIcon}`; image.alt = `${provider.name} logo`;
    image.addEventListener('error', () => { const fallback = document.createElement('i'); fallback.className = 'icon'; fallback.dataset.lucide = provider.icon || 'cable'; wrap.replaceChildren(fallback); renderIcons(wrap); }, { once: true });
    wrap.append(image);
  } else { const icon = document.createElement('i'); icon.className = 'icon'; icon.dataset.lucide = provider.icon || 'cable'; wrap.append(icon); }
  return wrap;
}

function renderIntegrations(integrations) {
  const connectionList = pageRoot.querySelector('#integration-connection-list');
  const providerGrid = pageRoot.querySelector('#integration-provider-grid');
  if (!connectionList || !providerGrid) return;
  const providers = [
    ...bundledIntegrations.map((manifest) => ({
      ...manifest,
      id: manifest.providerId,
      googleCalendar: manifest.providerId === 'google-calendar',
      outlookCalendar: manifest.providerId === 'outlook-calendar',
      fitbit: manifest.providerId === 'fitbit',
    })),
    { id: 'apple-calendar', name: 'Apple Calendar', description: 'Connect calendars available through your Apple account.', icon: 'calendar-days', brandIcon: 'apple.svg', pluginId: 'apple-calendar-connector', category: 'Calendar' },
    { id: 'google-health-api', name: 'Google Health API', description: 'Google’s cloud health API successor to Fitbit Web API. Requires a Google Cloud project and OAuth client; this connector is not implemented in the app yet.', icon: 'heart-pulse', brandIcon: 'google.svg', pluginId: 'google-health-api-connector', category: 'Health', unavailable: true },
    { id: 'health-connect', name: 'Health Connect (Android)', description: 'Android device health data store. Requires a companion Android app; it is separate from Google Health API.', icon: 'heart-pulse', brandIcon: 'android.svg', pluginId: 'health-connect-connector', category: 'Health', unavailable: true },
    { id: 'withings', name: 'Withings', description: 'Import weight measurements into Health.', icon: 'scale', brandIcon: 'withings.png', pluginId: 'withings-connector', category: 'Health' },
    { id: 'strava', name: 'Strava', description: 'Bring workouts and activity into your local data.', icon: 'activity', brandIcon: 'strava.svg', pluginId: 'strava-connector', category: 'Health' },
  ];
  for (const provider of providers) {
    const savedAccount = integrations.find((item) => item.provider_id === provider.id && item.config_json);
    if (savedAccount) { try { provider.clientId = JSON.parse(savedAccount.config_json).clientId || ''; } catch {} }
  }
  const count = pageRoot.querySelector('#integration-count');
  if (count) count.textContent = `${integrations.length} connection${integrations.length === 1 ? '' : 's'}`;
  connectionList.replaceChildren();
  if (!integrations.length) {
    const empty = document.createElement('div'); empty.className = 'integration-empty'; empty.textContent = 'No external accounts connected yet.'; connectionList.append(empty);
  }
  for (const integration of integrations) {
    const row = document.createElement('article'); row.className = 'integration-connection-card';
    const provider = providers.find((item) => item.id === integration.provider_id) || { icon: 'cable', category: 'Service' };
    const iconWrap = makeIntegrationMark(provider);
    const copy = document.createElement('div'); copy.className = 'integration-connection-copy';
    const name = document.createElement('strong'); name.textContent = integration.display_name;
    const account = document.createElement('small'); account.textContent = integration.account_label || 'Account label not set';
    copy.append(name, account);
    if (integration.last_sync_at) { const lastSync = document.createElement('small'); lastSync.textContent = `Last synced ${new Date(`${integration.last_sync_at}Z`).toLocaleString()}`; copy.append(lastSync); }
    const status = document.createElement('span'); status.className = `badge ${integration.status === 'connected' ? 'badge-success' : integration.status === 'error' ? 'badge-warning' : 'badge-neutral'}`;
    status.innerHTML = `<i></i>${integration.status === 'connected' ? 'Connected' : integration.status === 'paused' ? 'Paused' : integration.status === 'error' ? 'Sync error' : 'Setup required'}`;
    const edit = integrationAction('Edit connection', 'pencil', async () => { await showIntegrationEditForm(integration); });
    const toggle = integrationAction(integration.status === 'paused' ? 'Resume connection' : 'Pause connection', integration.status === 'paused' ? 'play' : 'pause', async () => {
      await window.dashboard.setIntegrationStatus(integration.id, integration.status === 'paused' ? 'connected' : 'paused');
      const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations);
    });
    toggle.disabled = !['connected', 'error', 'paused'].includes(integration.status);
    const remove = integrationAction('Remove connection', 'unplug', async () => {
      if (await showConfirm(`Remove ${integration.display_name}?`, 'This removes its local credentials and workflow. Imported records are kept.', 'Remove connection')) {
        await window.dashboard.removeIntegration(integration.id); const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations);
      }
    });
    let syncButton = null;
    if (integration.provider_id === 'fitbit' && integration.has_credentials && ['connected', 'error'].includes(integration.status)) {
      syncButton = document.createElement('button'); syncButton.type = 'button'; syncButton.className = 'button button-secondary button-small'; syncButton.textContent = 'Sync now';
      syncButton.addEventListener('click', async () => { syncButton.disabled = true; syncButton.textContent = 'Syncing…'; try { await window.dashboard.syncFitbit(integration.id); } catch (error) { window.alert(error.message); } finally { const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations); } });
    }
    if (['google-calendar', 'outlook-calendar'].includes(integration.provider_id) && integration.has_credentials) {
      const manageCalendars = document.createElement('button'); manageCalendars.type = 'button'; manageCalendars.className = 'button button-secondary button-small'; manageCalendars.textContent = 'Calendars';
      manageCalendars.addEventListener('click', () => showIntegrationCalendarsForm(integration));
      const syncGoogle = document.createElement('button'); syncGoogle.type = 'button'; syncGoogle.className = 'button button-secondary button-small'; syncGoogle.textContent = 'Sync now';
      syncGoogle.addEventListener('click', async () => { syncGoogle.disabled = true; syncGoogle.textContent = 'Syncing…'; try { if (integration.provider_id === 'google-calendar') await window.dashboard.syncGoogleCalendar(integration.id); else await window.dashboard.syncOutlookCalendar(integration.id); } catch (error) { window.alert(error.message); } finally { const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations); } });
      syncButton = document.createElement('span'); syncButton.className = 'integration-google-actions'; syncButton.append(manageCalendars, syncGoogle);
    }
    const actions = document.createElement('div'); actions.className = 'integration-row-actions';
    if (integration.provider_id === 'fitbit') {
      const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.className = 'button button-secondary button-small'; reconnect.textContent = integration.has_credentials ? 'Reauthorize' : 'Connect';
      reconnect.addEventListener('click', () => showIntegrationForm({ ...provider, reconnectId: integration.id })); actions.append(reconnect);
    }
    if (['google-calendar', 'outlook-calendar'].includes(integration.provider_id) && integration.has_credentials) {
      const reconnect = document.createElement('button'); reconnect.type = 'button'; reconnect.className = 'button button-secondary button-small'; reconnect.textContent = 'Reauthorize';
      reconnect.addEventListener('click', () => showIntegrationForm({ ...provider, reconnectId: integration.id, accountLabel: integration.account_label, clientId: JSON.parse(integration.config_json || '{}').clientId || provider.clientId })); actions.append(reconnect);
    }
    if (syncButton) actions.append(syncButton); actions.append(edit, toggle, remove);
    row.append(iconWrap, copy, status, actions); connectionList.append(row);
  }
  providerGrid.replaceChildren();
  for (const provider of providers) {
    const accountCount = integrations.filter((item) => item.provider_id === provider.id).length;
    const card = document.createElement('article'); card.className = 'integration-provider-card';
    const head = document.createElement('div'); head.className = 'integration-provider-head';
    const iconWrap = makeIntegrationMark(provider);
    const category = document.createElement('span'); category.className = 'badge badge-neutral'; category.textContent = provider.category;
    head.append(iconWrap, category);
    const name = document.createElement('h3'); name.textContent = provider.name;
    const description = document.createElement('p'); description.textContent = provider.description;
    const availability = document.createElement('small'); availability.className = 'integration-provider-availability';
    availability.textContent = provider.unavailable ? 'Connector coming later' : provider.fitbit || provider.googleCalendar || provider.outlookCalendar ? `${accountCount} account${accountCount === 1 ? '' : 's'} connected` : 'Setup entry only';
    const connect = document.createElement('button'); connect.type = 'button'; connect.className = 'button button-secondary button-small'; connect.textContent = provider.unavailable ? 'Coming later' : provider.googleCalendar || provider.outlookCalendar ? 'Connect account' : accountCount ? 'Add another account' : provider.fitbit ? 'Connect Fitbit' : 'Add account'; connect.disabled = Boolean(provider.unavailable);
    connect.addEventListener('click', () => showIntegrationForm(provider));
    card.append(head, name, description, availability, connect); providerGrid.append(card);
  }
  renderIcons(connectionList); renderIcons(providerGrid);
}

async function showIntegrationCalendarsForm(integration) {
  const calendars = await window.dashboard.getIntegrationCalendars(integration.id);
  const form = document.createElement('form'); form.className = 'dialog-form';
  const intro = document.createElement('p'); intro.className = 'dialog-copy field-wide'; intro.textContent = `Choose which calendars to sync from ${integration.account_label || integration.display_name}. Events are read from this account and cached locally.`; form.append(intro);
  if (!calendars.length) { const empty = document.createElement('p'); empty.className = 'dialog-copy field-wide'; empty.textContent = 'No calendars were found for this account. Try syncing or reauthorizing it.'; form.append(empty); }
  for (const calendar of calendars) {
    const label = document.createElement('label'); label.className = 'field field-wide google-calendar-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(calendar.selected); input.dataset.calendarId = calendar.id;
    const text = document.createElement('span'); text.textContent = calendar.summary;
    label.append(input, text); form.append(label);
  }
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = 'Save calendars';
  const dialog = openDialog('Google Calendar sources', form, [cancel, save]); cancel.addEventListener('click', () => dialog.close()); save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try {
      const selections = [...form.querySelectorAll('input[data-calendar-id]')].map((input) => ({ id: input.dataset.calendarId, selected: input.checked }));
      await window.dashboard.setIntegrationCalendars(integration.id, selections);
      if (integration.provider_id === 'google-calendar') await window.dashboard.syncGoogleCalendar(integration.id);
      else await window.dashboard.syncOutlookCalendar(integration.id);
      dialog.close(); const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations);
    } catch (error) { window.alert(error.message); save.disabled = false; }
  });
}

function integrationAction(label, iconName, action) {
  const button = document.createElement('button'); button.type = 'button'; button.className = `button button-secondary button-small integration-action${iconName === 'trash-2' ? ' integration-action-danger' : ''}`; button.setAttribute('aria-label', label); button.title = label;
  const icon = document.createElement('i'); icon.className = 'icon'; icon.dataset.lucide = iconName; button.append(icon);
  button.append(document.createTextNode(label));
  button.addEventListener('click', action); return button;
}

async function showIntegrationEditForm(integration) {
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<label class="field field-wide">Connection name<input name="displayName" required maxlength="80"></label><label class="field field-wide">Account label<input name="accountLabel" maxlength="80"></label>`;
  form.elements.displayName.value = integration.display_name; form.elements.accountLabel.value = integration.account_label || '';
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = 'Save connection';
  const dialog = openDialog('Edit connection', form, [cancel, save]); cancel.addEventListener('click', () => dialog.close()); save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try { await window.dashboard.updateIntegration(integration.id, { displayName: form.elements.displayName.value.trim(), accountLabel: form.elements.accountLabel.value.trim() }); dialog.close(); const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations); }
    catch (error) { window.alert(error.message); save.disabled = false; }
  });
}

function escapeAttribute(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function showIntegrationForm(provider) {
  const form = document.createElement('form'); form.className = 'dialog-form';
  if (provider.googleCalendar || provider.outlookCalendar) {
    const isOutlook = Boolean(provider.outlookCalendar);
    if (isOutlook) {
      form.innerHTML = `<p class="dialog-copy field-wide">Register a Microsoft Entra application for accounts in any organization and personal Microsoft accounts. Add the <strong>Mobile and desktop applications</strong> platform with redirect URI <code>http://localhost</code>, enable public client flows, and grant delegated <code>User.Read</code> and <code>Calendars.Read</code>. Sign-in opens in your browser. Tokens stay in this device’s credential store.</p>
        <label class="field field-wide">Microsoft application (client) ID<input name="clientId" required maxlength="180" autocomplete="off"></label>
        <label class="field field-wide">Account label<input name="accountLabel" required maxlength="80" placeholder="Work Outlook"></label>`;
      if (provider.clientId) form.elements.clientId.value = provider.clientId;
    } else {
    form.innerHTML = `<p class="dialog-copy field-wide">Google sign-in uses the app’s <code>GOOGLE_CALENDAR_CLIENT_ID</code> environment setting. Configure it in the local <code>.env</code> file, then restart the app. Sign-in opens in your browser and requests read-only calendar access. Tokens stay in this device’s credential store.</p>
      <label class="field field-wide">Account label<input name="accountLabel" required maxlength="80" placeholder="Personal Gmail"></label>`;
    }
    if (provider.accountLabel) form.elements.accountLabel.value = provider.accountLabel;
  } else if (provider.fitbit) {
    form.innerHTML = `<p class="dialog-copy field-wide">Fitbit’s legacy Web API is scheduled to shut down October 30, 2026. Create a Fitbit OAuth app, set its redirect URL to <code>http://127.0.0.1:53682/oauth/callback</code>, then enter its client ID. Sleep and weight access are requested. Tokens are kept in your desktop credential store.</p>
      <label class="field field-wide">Fitbit OAuth client ID<input name="clientId" required maxlength="120" autocomplete="off"></label>
      <label class="field field-wide">Account label<input name="accountLabel" required maxlength="80" placeholder="Personal Fitbit"></label>`;
  } else {
    form.innerHTML = `<p class="dialog-copy field-wide">This provider has no working connector yet. The entry will be saved as setup required.</p>
      <label class="field field-wide">Account label<input name="accountLabel" required maxlength="80" placeholder="Personal account"></label>`;
  }
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = provider.googleCalendar ? 'Connect with Google' : provider.outlookCalendar ? 'Connect with Microsoft' : provider.fitbit ? 'Authorize Fitbit' : 'Save setup';
  const dialog = openDialog(`Add ${provider.name}`, form, [cancel, save]);
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true; save.textContent = provider.googleCalendar || provider.outlookCalendar || provider.fitbit ? 'Waiting for sign-in…' : 'Saving…';
    try {
      const accountLabel = form.elements.accountLabel.value.trim();
      if (provider.googleCalendar) await window.dashboard.connectGoogleCalendar({ accountLabel, integrationId: provider.reconnectId });
      else if (provider.outlookCalendar) await window.dashboard.connectOutlookCalendar({ clientId: form.elements.clientId.value.trim(), accountLabel, integrationId: provider.reconnectId });
      else if (provider.fitbit) await window.dashboard.connectFitbit({ clientId: form.elements.clientId.value.trim(), accountLabel, integrationId: provider.reconnectId });
      else await window.dashboard.addIntegration({ providerId: provider.id, displayName: provider.name, accountLabel, pluginId: provider.pluginId });
      dialog.close(); const { integrations } = await window.dashboard.getPageData('integrations'); renderIntegrations(integrations);
    } catch (error) { window.alert(error.message); save.disabled = false; save.textContent = provider.googleCalendar ? 'Connect with Google' : provider.outlookCalendar ? 'Connect with Microsoft' : provider.fitbit ? 'Authorize Fitbit' : 'Save setup'; }
  });
}

function localDateTimeValue(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function getEventStart(event) {
  const value = event.startAt || event.occurred_at;
  if (event.allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day); }
  return new Date(value);
}
function calendarWeekStart(date) {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}
function sameLocalDate(left, right) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}
function moveCalendar(direction) {
  if (direction === 'today') calendarDate = new Date();
  else {
    const amount = direction === 'previous' ? -1 : 1;
    if (calendarView === 'month') {
      const day = calendarDate.getDate();
      calendarDate.setDate(1);
      calendarDate.setMonth(calendarDate.getMonth() + amount);
      calendarDate.setDate(Math.min(day, new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 0).getDate()));
    }
    else calendarDate.setDate(calendarDate.getDate() + amount * (calendarView === 'week' && window.matchMedia('(max-width: 760px)').matches ? 1 : 7));
  }
  renderCalendarBoard(calendarEvents);
}

function renderCalendarBoard(events) {
  const board = pageRoot.querySelector('#calendar-board');
  if (!board) return;
  board.replaceChildren();
  board.classList.toggle('calendar-board-week', calendarView === 'week');
  board.classList.toggle('calendar-board-month', calendarView === 'month');
  const period = pageRoot.querySelector('.calendar-period');
  const monthTitle = pageRoot.querySelector('#calendar-month-title');
  if (monthTitle) monthTitle.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarDate);
  const visibleEvents = events.filter((event) => {
    const sourceId = event.integration_id || 'local';
    const matchesSource = calendarSourceVisibility[sourceId] !== false;
    const matchesSearch = !calendarSearch || `${event.title || ''} ${event.location || ''} ${event.sourceName || event.source || ''}`.toLowerCase().includes(calendarSearch);
    return matchesSource && matchesSearch;
  });
  renderCalendarMiniMonth();
  renderCalendarUpcoming(visibleEvents);
  const weekStart = calendarWeekStart(calendarDate);
  const compactDay = calendarView === 'week' && window.matchMedia('(max-width: 760px)').matches;
  const weekDates = compactDay ? [new Date(calendarDate)] : Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart); date.setDate(date.getDate() + index); return date;
  });
  if (calendarView === 'month') {
    const first = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1);
    const gridStart = calendarWeekStart(first);
    const gridDates = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart); date.setDate(date.getDate() + index); return date;
    });
    period.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarDate);
    const grid = document.createElement('div'); grid.className = 'calendar-month-grid';
    for (const dayName of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      const heading = document.createElement('div'); heading.className = 'calendar-month-heading'; heading.textContent = dayName; grid.append(heading);
    }
    for (const date of gridDates) {
      const cell = document.createElement('div');
      cell.className = `calendar-month-cell${date.getMonth() === calendarDate.getMonth() ? '' : ' is-outside'}${sameLocalDate(date, new Date()) ? ' is-today' : ''}`;
      const day = document.createElement('button'); day.type = 'button'; day.className = 'calendar-month-day'; day.textContent = String(date.getDate());
      day.addEventListener('click', () => { calendarDate = new Date(date); calendarView = 'week'; pageRoot.querySelectorAll('[data-calendar-view]').forEach((item) => item.classList.toggle('active', item.dataset.calendarView === 'week')); renderCalendarBoard(calendarEvents); });
      cell.append(day);
      for (const event of visibleEvents.filter((item) => sameLocalDate(getEventStart(item), date)).slice(0, 3)) {
        const block = document.createElement('button'); block.type = 'button'; block.className = `calendar-month-event color-${event.color || 'green'}`; block.textContent = event.title;
        block.addEventListener('click', (click) => { click.stopPropagation(); showEventForm(event); }); cell.append(block);
      }
      grid.append(cell);
    }
    board.append(grid);
    return;
  }

  period.textContent = compactDay
    ? new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(weekDates[0])
    : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(weekDates[0])} – ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(weekDates[6])}`;
  if (calendarView === 'list') {
    const list = document.createElement('div'); list.className = 'calendar-agenda-list';
    for (const date of weekDates) {
      const dayEvents = visibleEvents.filter((event) => sameLocalDate(getEventStart(event), date)).sort((a, b) => getEventStart(a) - getEventStart(b));
      const section = document.createElement('section'); section.className = 'calendar-agenda-day';
      const heading = document.createElement('h3'); heading.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(date); section.append(heading);
      if (!dayEvents.length) { const empty = document.createElement('p'); empty.textContent = 'No events'; section.append(empty); }
      for (const event of dayEvents) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'calendar-agenda-event';
        const time = document.createElement('span'); time.textContent = event.allDay ? 'All day' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(getEventStart(event));
        const title = document.createElement('strong'); title.textContent = event.title;
        const detail = document.createElement('small'); detail.textContent = event.detail || event.location || '';
        row.append(time, title, detail); row.addEventListener('click', () => showEventForm(event)); section.append(row);
      }
      list.append(section);
    }
    board.append(list);
    return;
  }

  const header = document.createElement('div'); header.className = 'calendar-week-header';
  header.append(document.createElement('div'));
  for (const date of weekDates) {
    const day = document.createElement('div'); day.className = `calendar-day-heading${sameLocalDate(date, new Date()) ? ' is-today' : ''}`;
    const weekday = document.createElement('small'); weekday.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
    const number = document.createElement('strong'); number.textContent = String(date.getDate()); day.append(weekday, number); header.append(day);
  }
  board.append(header);
  const allDayRow = document.createElement('div'); allDayRow.className = 'calendar-all-day-row';
  const allDayLabel = document.createElement('div'); allDayLabel.className = 'calendar-all-day-label'; allDayLabel.textContent = 'All day'; allDayRow.append(allDayLabel);
  for (const date of weekDates) {
    const cell = document.createElement('div'); cell.className = 'calendar-all-day-cell';
    for (const event of visibleEvents.filter((item) => item.allDay && sameLocalDate(getEventStart(item), date))) {
      const block = document.createElement('button'); block.type = 'button'; block.className = `calendar-all-day-event color-${event.color || 'blue'}`; block.textContent = event.title;
      block.addEventListener('click', () => showEventForm(event)); cell.append(block);
    }
    allDayRow.append(cell);
  }
  board.append(allDayRow);
  const grid = document.createElement('div'); grid.className = 'calendar-week-grid';
  const { startHour, endHour } = normalizeCalendarSettings(calendarSettings);
  const hourCount = endHour - startHour;
  const hourHeight = 64;
  grid.style.setProperty('--calendar-hour-count', String(hourCount));
  grid.style.setProperty('--calendar-hour-height', `${hourHeight}px`);
  grid.style.height = `${hourCount * hourHeight}px`;
  const times = document.createElement('div'); times.className = 'calendar-time-column';
  for (let hour = startHour; hour < endHour; hour += 1) {
    const label = document.createElement('span'); const time = new Date(); time.setHours(hour, 0, 0, 0);
    label.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(time); times.append(label);
  }
  grid.append(times);
  for (const date of weekDates) {
    const column = document.createElement('div'); column.className = 'calendar-day-column';
    for (let hour = startHour; hour < endHour; hour += 1) { const slot = document.createElement('div'); slot.className = 'calendar-hour-slot'; column.append(slot); }
    for (const event of visibleEvents.filter((item) => !item.allDay && sameLocalDate(getEventStart(item), date))) {
      const start = getEventStart(event); const minutes = start.getHours() * 60 + start.getMinutes() - startHour * 60;
      if (minutes < 0 || minutes >= hourCount * 60) continue;
      const duration = Math.max(30, (new Date(event.endAt || new Date(start.getTime() + 60 * 60_000)) - start) / 60_000);
      const visibleDuration = Math.min(duration, hourCount * 60 - minutes);
      const block = document.createElement('button'); block.type = 'button'; block.className = `calendar-event-block${duration < 45 ? ' is-compact' : ''} color-${event.color || (event.category === 'personal-health' ? 'green' : 'blue')}`;
      const hourScale = hourHeight / 60;
      block.style.top = `${minutes * hourScale}px`; block.style.height = `${visibleDuration * hourScale}px`;
      const title = document.createElement('strong'); title.textContent = event.title;
      const time = document.createElement('small'); time.textContent = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(start);
      block.append(title, time); block.addEventListener('click', () => showEventForm(event)); column.append(block);
    }
    grid.append(column);
  }
  board.append(grid);
}


function renderCalendarMiniMonth() {
  const grid = pageRoot.querySelector('#calendar-mini-month');
  const title = pageRoot.querySelector('#calendar-mini-title');
  if (!grid || !title) return;
  title.textContent = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(calendarDate);
  grid.replaceChildren();
  for (const label of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
    const weekday = document.createElement('span'); weekday.className = 'calendar-mini-weekday'; weekday.textContent = label; grid.append(weekday);
  }
  const monthStart = new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1);
  const first = calendarWeekStart(monthStart);
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(first); date.setDate(first.getDate() + index);
    const day = document.createElement('button'); day.type = 'button'; day.className = 'calendar-mini-day';
    if (date.getMonth() !== calendarDate.getMonth()) day.classList.add('is-outside');
    if (sameLocalDate(date, new Date())) day.classList.add('is-today');
    if (sameLocalDate(date, calendarDate)) day.classList.add('is-selected');
    day.textContent = String(date.getDate());
    day.addEventListener('click', () => { calendarDate = new Date(date); calendarView = 'week'; pageRoot.querySelectorAll('[data-calendar-view]').forEach((item) => item.classList.toggle('active', item.dataset.calendarView === 'week')); renderCalendarBoard(calendarEvents); });
    grid.append(day);
  }
}

function renderCalendarUpcoming(events) {
  const list = pageRoot.querySelector('#calendar-upcoming');
  if (!list) return;
  list.replaceChildren();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const next = events.filter((event) => {
    const start = getEventStart(event);
    return event.allDay ? start >= today : new Date(event.endAt || start.getTime() + 60 * 60_000) >= now;
  }).sort((a, b) => getEventStart(a) - getEventStart(b)).slice(0, 4);
  if (!next.length) {
    const empty = document.createElement('p'); empty.className = 'calendar-upcoming-empty'; empty.textContent = calendarSearch ? 'No matching events.' : 'No upcoming events'; list.append(empty); return;
  }
  for (const event of next) {
    const row = document.createElement('div'); row.className = 'calendar-upcoming-row';
    const date = document.createElement('span'); date.className = 'calendar-upcoming-date';
    date.textContent = event.allDay ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(getEventStart(event)) : new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(getEventStart(event));
    const button = document.createElement('button'); button.type = 'button'; button.className = `calendar-upcoming-event color-${event.color || 'blue'}`; button.textContent = event.title || '(No title)'; button.addEventListener('click', () => showEventForm(event));
    row.append(date, button); list.append(row);
  }
}

function renderCalendarIntegrations(integrations) {
  const summary = pageRoot.querySelector('#calendar-integration-summary');
  if (!summary) return;
  summary.replaceChildren();
  const calendarConnections = integrations.filter((item) => item.provider_id.includes('calendar'));
  for (const integration of calendarConnections) {
    const row = document.createElement('label'); row.className = 'calendar-account-line';
    const toggle = document.createElement('input'); toggle.className = 'calendar-visibility-toggle'; toggle.type = 'checkbox'; toggle.dataset.calendarSource = integration.id;
    toggle.checked = calendarSourceVisibility[integration.id] !== false;
    const check = document.createElement('span'); check.className = `calendar-check ${integration.provider_id === 'google-calendar' ? 'google' : 'outlook'}`;
    const name = document.createElement('span'); name.className = 'calendar-account-name';
    const accountName = integration.account_label || (integration.provider_id === 'google-calendar' ? 'Google Calendar' : 'Outlook Calendar');
    name.textContent = accountName;
    const color = document.createElement('span'); color.className = `calendar-color-dot ${integration.provider_id === 'google-calendar' ? 'google' : 'outlook'}`;
    row.append(toggle, check, name, color); summary.append(row);
    toggle.addEventListener('change', () => { calendarSourceVisibility[integration.id] = toggle.checked; renderCalendarBoard(calendarEvents); });
  }
  if (!calendarConnections.length) {
    const empty = document.createElement('p'); empty.className = 'calendar-no-accounts'; empty.textContent = 'Connect calendars to see them here.'; summary.append(empty);
  }
}

function showEventForm(eventRecord = null) {
  if (eventRecord?.integration_id) {
    const description = [eventRecord.description || eventRecord.detail, eventRecord.location && `Location: ${eventRecord.location}`, eventRecord.sourceName || eventRecord.source || 'Connected calendar'].filter(Boolean).join('\n\n');
    const content = document.createElement('div'); content.className = 'dialog-form';
    const title = document.createElement('h3'); title.textContent = eventRecord.title || '(No title)';
    const time = document.createElement('p'); time.textContent = eventRecord.allDay ? `All day · ${getEventStart(eventRecord).toLocaleDateString()}` : `${getEventStart(eventRecord).toLocaleString()} – ${new Date(eventRecord.endAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    const detail = document.createElement('p'); detail.textContent = description;
    content.append(title, time, detail);
    const close = document.createElement('button'); close.className = 'button button-secondary'; close.type = 'button'; close.textContent = 'Done';
    const dialog = openDialog('Connected event', content, [close]); close.addEventListener('click', () => dialog.close());
    return;
  }
  const start = eventRecord ? getEventStart(eventRecord) : new Date(calendarDate);
  if (!eventRecord) { start.setHours(Math.max(8, Math.min(20, start.getHours() + 1)), 0, 0, 0); }
  const end = eventRecord?.endAt ? new Date(eventRecord.endAt) : new Date(start.getTime() + 60 * 60_000);
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<label class="field field-wide">Title<input name="title" required maxlength="100" placeholder="Event title"></label>
    <label class="field field-wide calendar-all-day-toggle"><input name="allDay" type="checkbox"> All-day event</label>
    <label class="field" data-time-field>Date<input name="eventDate" type="date"></label>
    <label class="field" data-time-field>Starts<input name="startAt" type="datetime-local" required></label><label class="field" data-time-field>Ends<input name="endAt" type="datetime-local" required></label>
    <label class="field">Location<input name="location" maxlength="120" placeholder="Optional"></label><label class="field field-wide">Notes<textarea name="description" rows="3" maxlength="500" placeholder="Add details"></textarea></label><p class="form-error field-wide" hidden></p>`;
  form.elements.title.value = eventRecord?.title || '';
  form.elements.startAt.value = localDateTimeValue(start);
  form.elements.endAt.value = localDateTimeValue(end);
  form.elements.eventDate.value = localDateKey(start);
  form.elements.allDay.checked = Boolean(eventRecord?.allDay);
  const syncAllDayFields = () => {
    const allDay = form.elements.allDay.checked;
    form.querySelectorAll('[data-time-field]').forEach((field) => { field.hidden = allDay && field.querySelector('[name="eventDate"]') === null; });
    form.elements.eventDate.required = allDay;
    form.elements.startAt.required = !allDay; form.elements.endAt.required = !allDay;
  };
  form.elements.allDay.addEventListener('change', syncAllDayFields); syncAllDayFields();
  form.elements.location.value = eventRecord?.location || '';
  form.elements.description.value = eventRecord?.description || eventRecord?.detail || '';
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const actions = [cancel];
  let remove;
  if (eventRecord) {
    remove = document.createElement('button'); remove.className = 'button button-quiet is-danger-text'; remove.type = 'button'; remove.textContent = 'Delete'; actions.push(remove);
  }
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = eventRecord ? 'Save changes' : 'Create event'; actions.push(save);
  const dialog = openDialog(eventRecord ? 'Edit event' : 'New event', form, actions);
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', () => form.requestSubmit());
  remove?.addEventListener('click', async () => {
    if (await showConfirm('Delete this event?', 'This removes the event from your local calendar.', 'Delete event')) {
      await window.dashboard.deleteCalendarEvent(eventRecord.id); dialog.close(); await reloadCalendar();
    }
  });
  form.addEventListener('submit', async (submitEvent) => {
    submitEvent.preventDefault();
    const error = form.querySelector('.form-error');
    const allDay = form.elements.allDay.checked;
    if (!allDay && new Date(form.elements.endAt.value) <= new Date(form.elements.startAt.value)) { error.textContent = 'The end time must be after the start time.'; error.hidden = false; return; }
    error.hidden = true;
    const date = form.elements.eventDate.value;
    const values = { id: eventRecord?.id, title: form.elements.title.value.trim(), startAt: allDay ? date : form.elements.startAt.value, endAt: allDay ? date : form.elements.endAt.value, allDay, location: form.elements.location.value.trim(), description: form.elements.description.value.trim() };
    if (eventRecord) await window.dashboard.updateCalendarEvent(values);
    else await window.dashboard.createCalendarEvent(values);
    dialog.close(); await reloadCalendar();
  });
}

async function reloadCalendar() {
  const { events } = await window.dashboard.getPageData('calendar');
  calendarEvents = events || []; renderCalendarBoard(calendarEvents);
}

function renderTodos(tasks) {
  pageRoot.querySelectorAll('.todo-row, .todo-empty').forEach((row) => row.remove());
  const openCount = tasks.filter((task) => !task.completed).length;
  const today = localDateKey(new Date());
  const dueToday = tasks.filter((task) => task.occurred_at.slice(0, 10) === today && !task.completed).length;
  const completedCount = tasks.filter((task) => task.completed).length;
  const summaryValues = pageRoot.querySelectorAll('.todo-summary strong');
  [openCount, dueToday, completedCount].forEach((value, index) => { if (summaryValues[index]) summaryValues[index].textContent = String(value); });
  pageRoot.querySelectorAll('.todo-list-card').forEach((list) => {
    const upcoming = list.classList.contains('upcoming-tasks');
    const filtered = tasks.filter((task) => upcoming ? task.occurred_at.slice(0, 10) > today && !task.completed : task.occurred_at.slice(0, 10) === today);
    if (!filtered.length) { const empty = document.createElement('p'); empty.className = 'todo-empty'; empty.textContent = upcoming ? 'Nothing coming up yet.' : 'No tasks due today. Add a task when you are ready.'; list.append(empty); }
    for (const task of filtered) {
      const row = document.createElement('article'); row.className = `todo-row${task.completed ? ' is-complete' : ''}`;
      const checkbox = document.createElement('input'); checkbox.className = 'task-check'; checkbox.type = 'checkbox'; checkbox.checked = task.completed; checkbox.setAttribute('aria-label', `Complete ${task.title}`);
      checkbox.addEventListener('change', async () => { await window.dashboard.setTaskCompleted(task.id, checkbox.checked); row.classList.toggle('is-complete', checkbox.checked); });
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'task-copy task-edit-trigger'; copy.setAttribute('aria-label', `Edit ${task.title}`);
      const title = document.createElement('strong'); title.textContent = task.title;
      const detail = document.createElement('small'); detail.textContent = `${task.detail || 'No notes'} · Due ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(task.occurred_at))}`;
      copy.append(title, detail); copy.addEventListener('click', () => showTaskForm(task));
      const badge = document.createElement('span'); badge.className = task.category === 'health' ? 'badge badge-domain' : 'badge badge-neutral'; badge.textContent = task.category === 'health' ? 'Health plan' : 'Personal';
      row.append(checkbox, copy, badge); list.append(row);
    }
  });
  const todayLabel = pageRoot.querySelector('.todo-list-heading p');
  if (todayLabel) todayLabel.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
}

function renderWorkflows(workflows, runs) {
  const list = pageRoot.querySelector('#workflow-list'); const runList = pageRoot.querySelector('#workflow-run-list');
  if (!list || !runList) return;
  list.replaceChildren(); runList.replaceChildren();
  const count = pageRoot.querySelector('#workflow-count'); if (count) count.textContent = `${workflows.length} workflow${workflows.length === 1 ? '' : 's'}`;
  if (!workflows.length) { const empty = document.createElement('div'); empty.className = 'integration-empty'; empty.textContent = 'No workflows yet. Connect Fitbit to create its local sync workflow.'; list.append(empty); }
  for (const workflow of workflows) {
    const card = document.createElement('article'); card.className = 'workflow-card';
    const copy = document.createElement('div'); copy.className = 'workflow-copy';
    const title = document.createElement('strong'); title.textContent = workflow.name;
    const description = document.createElement('small'); description.textContent = `${workflow.integration_name || 'Integration removed'} · every ${Math.round((workflow.definition.intervalMinutes || 0) / 60)} hours · fetch sleep + weight → normalize → SQLite`;
    const timing = document.createElement('small'); timing.textContent = workflow.last_run_at ? `Last run ${new Date(`${workflow.last_run_at}Z`).toLocaleString()} · next ${workflow.next_run_at ? new Date(workflow.next_run_at).toLocaleString() : 'paused'}` : `Next run ${workflow.next_run_at ? new Date(workflow.next_run_at).toLocaleString() : 'paused'} · no runs yet`;
    copy.append(title, description, timing);
    const status = document.createElement('span'); status.className = `badge ${workflow.enabled ? 'badge-success' : 'badge-neutral'}`; status.textContent = workflow.enabled ? 'Scheduled' : 'Paused';
    const actions = document.createElement('div'); actions.className = 'workflow-actions';
    const run = document.createElement('button'); run.type = 'button'; run.className = 'button button-secondary button-small'; run.textContent = 'Run now';
    run.disabled = !workflow.integration_id || !['connected', 'error'].includes(workflow.integration_status);
    run.addEventListener('click', async () => { run.disabled = true; run.textContent = 'Running…'; try { await window.dashboard.runWorkflow(workflow.id); } catch (error) { window.alert(error.message); } finally { await reloadWorkflows(); } });
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'button button-quiet button-small'; toggle.textContent = workflow.enabled ? 'Pause' : 'Resume';
    toggle.addEventListener('click', async () => { await window.dashboard.setWorkflowEnabled(workflow.id, !workflow.enabled); await reloadWorkflows(); });
    actions.append(run, toggle); card.append(copy, status, actions); list.append(card);
  }
  if (!runs.length) { const empty = document.createElement('div'); empty.className = 'integration-empty'; empty.textContent = 'Workflow executions will appear here.'; runList.append(empty); }
  for (const run of runs) {
    const row = document.createElement('article'); row.className = 'workflow-run-row';
    const title = document.createElement('strong'); title.textContent = run.workflow_name;
    const detail = document.createElement('small'); detail.textContent = run.error_text || `${run.started_at}${run.result ? ` · ${run.result.recordCount} records` : ''}`;
    const status = document.createElement('span'); status.className = `badge ${run.status === 'succeeded' ? 'badge-success' : run.status === 'failed' ? 'badge-warning' : 'badge-neutral'}`; status.textContent = run.status;
    row.append(title, detail, status); runList.append(row);
  }
  renderIcons(list); renderIcons(runList);
}

async function reloadWorkflows() {
  const data = await window.dashboard.getPageData('workflows'); renderWorkflows(data.workflows || [], data.runs || []);
}

function showTaskForm(task = null) {
  const dueDate = task ? new Date(task.dueAt || task.occurred_at) : new Date(Date.now() + 60 * 60_000);
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<label class="field field-wide">Task<input name="title" required maxlength="120" placeholder="What needs doing?"></label>
    <label class="field field-wide">Notes<input name="detail" maxlength="240" placeholder="Optional details"></label>
    <label class="field">Category<select name="category"><option value="personal">Personal</option><option value="health">Health plan</option></select></label>
    <label class="field">Due<input name="dueAt" type="datetime-local" required></label>`;
  form.elements.title.value = task?.title || ''; form.elements.detail.value = task?.detail || ''; form.elements.category.value = task?.category || 'personal'; form.elements.dueAt.value = localDateTimeValue(dueDate);
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const actions = [cancel];
  if (task) {
    const remove = document.createElement('button'); remove.className = 'button button-quiet is-danger-text'; remove.type = 'button'; remove.textContent = 'Delete'; actions.push(remove);
    remove.addEventListener('click', async () => { if (await showConfirm('Delete this task?', 'This permanently removes it from your local task list.', 'Delete task')) { await window.dashboard.deleteTask(task.id); dialog.close(); await reloadTodos(); } });
  }
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = task ? 'Save changes' : 'Create task'; actions.push(save);
  const dialog = openDialog(task ? 'Edit task' : 'New task', form, actions);
  cancel.addEventListener('click', () => dialog.close()); save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try {
      const values = { id: task?.id, title: form.elements.title.value.trim(), detail: form.elements.detail.value.trim(), category: form.elements.category.value, dueAt: form.elements.dueAt.value };
      if (task) await window.dashboard.updateTask(values); else await window.dashboard.createTask(values);
      dialog.close(); await reloadTodos();
    } catch (error) { window.alert(error.message); save.disabled = false; }
  });
}

async function reloadTodos() {
  const { tasks } = await window.dashboard.getPageData('todos'); renderTodos(tasks || []);
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderHealth(data) {
  const sleep = data.sleep || [];
  const weight = data.weight || [];
  const values = sleep.slice(-7).map((row) => row.durationHours);
  const average = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  pageRoot.querySelector('.health-metric-value').textContent = `${Math.floor(average)}h ${String(Math.round((average % 1) * 60)).padStart(2, '0')}m`;
  pageRoot.querySelectorAll('.health-metric-value')[1].innerHTML = `${weight.at(-1)?.kilograms.toFixed(1) ?? '—'} <small>kg</small>`;
  renderHealthCharts(sleep, weight);
}

function renderHealthCharts(sleepRecords, weightRecords) {
  const chartLabels = sleepRecords.map((row) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(row.occurred_at)));
  const themeColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const gridColor = themeColor('--chart-grid');
  const tickColor = themeColor('--chart-tick');
  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: themeColor('--chart-tooltip'),
        padding: 10,
        cornerRadius: 8,
        titleFont: { family: 'Inter, system-ui, sans-serif', size: 10, weight: '600' },
        bodyFont: { family: 'Inter, system-ui, sans-serif', size: 10 },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        border: { display: false },
        ticks: { color: tickColor, maxTicksLimit: 7, font: { family: 'Inter, system-ui, sans-serif', size: 9 } },
      },
      y: {
        grid: { color: gridColor },
        border: { display: false, dash: [3, 4] },
        ticks: { color: tickColor, font: { family: 'Inter, system-ui, sans-serif', size: 9 }, padding: 8 },
      },
    },
  };

  const sleepCanvas = pageRoot.querySelector('#sleep-chart');
  if (sleepCanvas) {
    activeCharts.push(new Chart(sleepCanvas, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'Sleep duration',
          data: sleepRecords.map((row) => row.durationHours),
          borderColor: themeColor('--color-primary'),
          backgroundColor: themeColor('--chart-primary-fill'),
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: themeColor('--color-primary'),
          pointBorderColor: themeColor('--color-surface'),
          pointBorderWidth: 1.5,
          fill: true,
          tension: .36,
        }],
      },
      options: {
        ...baseOptions,
        scales: {
          ...baseOptions.scales,
          y: {
            ...baseOptions.scales.y,
            min: 5,
            max: 10,
            ticks: { ...baseOptions.scales.y.ticks, stepSize: 1, callback: (value) => `${value}h` },
          },
        },
        plugins: {
          ...baseOptions.plugins,
          tooltip: {
            ...baseOptions.plugins.tooltip,
            callbacks: { label: (context) => ` ${context.parsed.y.toFixed(1)} hours` },
          },
        },
      },
    }));
  }

  const weightCanvas = pageRoot.querySelector('#weight-chart');
  if (weightCanvas) {
    activeCharts.push(new Chart(weightCanvas, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'Weight',
          data: weightRecords.map((row) => row.kilograms),
          borderColor: themeColor('--chart-weight'),
          backgroundColor: themeColor('--chart-weight-fill'),
          borderWidth: 2,
          pointRadius: 2,
          pointHoverRadius: 4,
          pointBackgroundColor: themeColor('--chart-weight'),
          pointBorderColor: themeColor('--color-surface'),
          pointBorderWidth: 1.5,
          fill: true,
          tension: .36,
        }],
      },
      options: {
        ...baseOptions,
        scales: {
          ...baseOptions.scales,
          y: {
            ...baseOptions.scales.y,
            min: 70,
            max: 75,
            ticks: { ...baseOptions.scales.y.ticks, stepSize: 1, callback: (value) => `${value} kg` },
          },
        },
        plugins: {
          ...baseOptions.plugins,
          tooltip: {
            ...baseOptions.plugins.tooltip,
            callbacks: { label: (context) => ` ${context.parsed.y.toFixed(1)} kg` },
          },
        },
      },
    }));
  }
}

renderIcons(document.querySelector('.sidebar'));
void loadPluginNavigation();

function routeFromHash() {
  const requestedPage = window.location.hash.slice(1) || 'overview';
  if (!Object.hasOwn(pageTemplates, requestedPage)) {
    window.history.replaceState(null, '', '#overview');
    renderPage('overview');
    return;
  }
  renderPage(requestedPage);
}

window.addEventListener('hashchange', routeFromHash);
window.addEventListener('resize', () => { if (currentPage === 'calendar') renderCalendarBoard(calendarEvents); });
document.addEventListener('keydown', (event) => {
  if (currentPage !== 'calendar' || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key.toLowerCase() === 'j') moveCalendar('next');
  if (event.key.toLowerCase() === 'k') moveCalendar('previous');
  if (event.key.toLowerCase() === 't') moveCalendar('today');
  const viewKeys = { w: 'week', m: 'month', a: 'list' };
  const view = viewKeys[event.key.toLowerCase()];
  if (view) {
    calendarView = view;
    pageRoot.querySelectorAll('[data-calendar-view]').forEach((button) => button.classList.toggle('active', button.dataset.calendarView === view));
    renderCalendarBoard(calendarEvents);
  }
});
routeFromHash();
