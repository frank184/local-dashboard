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
  Check,
  FileUp,
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
  Wallet,
  ShieldCheck,
} from 'lucide';
import {
  CategoryScale,
  Chart,
  Filler,
  LineController,
  LineElement,
  Legend,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';

Chart.register(CategoryScale, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip);

const iconSet = {
  Activity,
  ArrowRight,
  Blocks,
  Cable,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Clock,
  Check,
  FileUp,
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
  Wallet,
  ShieldCheck,
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
  'plugins/health/settings': 'Health settings',
  'design-system': 'Design system',
};
const pageRoot = document.querySelector('#page-root');
const pageLabel = document.querySelector('#current-page-label');
const themeToggle = document.querySelector('.theme-toggle');
let currentPage = '';
let sidebarCollapsed = localStorage.getItem('local-dashboard-sidebar-collapsed') === 'true';
let activeCharts = [];
let healthWeightModeCleanup = null;
let healthPageData = null;
let healthSettings = { weightUnit: 'lb', dateRange: '18m' };
let financeTransactions = [];
let financeCurrencyCode = localStorage.getItem('local-dashboard-finance-currency') || 'CAD';
let financeLastImportRun = null;
let financeImportWorkflowEnabled = true;
let integrationRecords = [];
let integrationSearch = '';
let integrationCategory = '';
let calendarDate = new Date();
let calendarSearch = '';
let calendarMonthWheelDelta = 0;
let calendarMonthWheelReset = null;
let calendarMonthWheelLockedUntil = 0;
const calendarSourceVisibility = {};
const calendarIntegrationGroups = new Map();
const calendarVisibilityGroups = new Map();
let calendarView = 'week';
let calendarEvents = [];
let calendarSettings = { startHour: 0, endHour: 24 };
let calendarSidePanelCollapsed = false;
let workflowSidePanelCollapsed = localStorage.getItem('local-dashboard-workflow-sidepanel-collapsed') === 'true';
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
  healthWeightModeCleanup?.();
  healthWeightModeCleanup = null;
}

function renderIcons(root) {
  createIcons({ icons: iconSet, root, attrs: { 'stroke-width': 1.8 } });
}

// Hash links with a current route can still trigger native fragment scrolling. Keep
// the active navigation click on the current page a no-op.
document.addEventListener('click', (event) => {
  const addIntegrationLink = event.target.closest('a[href="#available-integrations"]');
  if (addIntegrationLink) {
    event.preventDefault();
    pageRoot.querySelector('#available-integrations')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
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
  document.body.classList.toggle('is-workflows-page', pageId === 'workflows');
  document.documentElement.classList.toggle('is-workflows-page', pageId === 'workflows');
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
  pageRoot.querySelector('[data-action="new-finance-transaction"]')?.addEventListener('click', () => showFinanceTransactionForm());
  pageRoot.querySelector('[data-action="import-finance-statement"]')?.addEventListener('click', () => showFinanceStatementImport());
  const workflowPanelToggle = pageRoot.querySelector('[data-workflow-sidepanel-toggle]');
  if (workflowPanelToggle) {
    applyWorkflowSidePanelState();
    workflowPanelToggle.addEventListener('click', () => {
      workflowSidePanelCollapsed = !workflowSidePanelCollapsed;
      localStorage.setItem('local-dashboard-workflow-sidepanel-collapsed', String(workflowSidePanelCollapsed));
      applyWorkflowSidePanelState();
    });
    pageRoot.querySelector('[data-workflow-sidepanel-backdrop]')?.addEventListener('click', () => {
      workflowSidePanelCollapsed = true;
      localStorage.setItem('local-dashboard-workflow-sidepanel-collapsed', 'true');
      applyWorkflowSidePanelState();
    });
  }
  pageRoot.querySelector('#finance-currency')?.addEventListener('change', (event) => {
    financeCurrencyCode = event.target.value; localStorage.setItem('local-dashboard-finance-currency', financeCurrencyCode);
    renderFinance(financeTransactions, financeLastImportRun);
  });
  pageRoot.querySelector('[data-action="clear-finance-samples"]')?.addEventListener('click', async () => {
    const samples = financeTransactions.filter((record) => record.sourceName === 'Local sample').length;
    if (!samples || !await showConfirm('Clear sample transactions?', 'This removes the example entries from the local ledger. Entries you added stay in place.', 'Clear sample data')) return;
    await window.dashboard.clearFinanceSamples();
    const data = await window.dashboard.getPageData('finance'); financeTransactions = data.transactions || []; financeLastImportRun = data.lastImportRun; financeImportWorkflowEnabled = data.importWorkflowEnabled !== false; renderFinance(financeTransactions, financeLastImportRun);
  });
  pageRoot.querySelector('[data-action="new-plugin"]')?.addEventListener('click', () => showPluginForm());
  const integrationSearchInput = pageRoot.querySelector('#integration-search');
  const integrationCategorySelect = pageRoot.querySelector('#integration-category');
  if (integrationSearchInput && integrationCategorySelect) {
    integrationSearchInput.value = integrationSearch;
    integrationSearchInput.addEventListener('input', () => updateIntegrationQuery(integrationSearchInput.value, integrationCategorySelect.value));
    integrationCategorySelect.addEventListener('change', () => updateIntegrationQuery(integrationSearchInput.value, integrationCategorySelect.value));
  }
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
  const healthSettingsForm = pageRoot.querySelector('#health-settings-form');
  if (healthSettingsForm) bindHealthSettingsForm(healthSettingsForm);
  pageRoot.querySelectorAll('[data-health-range]').forEach((button) => button.addEventListener('click', () => {
    if (!healthPageData) return;
    healthSettings = { ...healthSettings, dateRange: button.dataset.healthRange };
    pageRoot.querySelectorAll('[data-health-range]').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    destroyCharts();
    renderHealth(healthPageData);
  }));

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

function applyWorkflowSidePanelState() {
  const layout = pageRoot.querySelector('.workflows-layout');
  const rail = pageRoot.querySelector('.workflow-right-rail');
  const button = pageRoot.querySelector('[data-workflow-sidepanel-toggle]');
  if (!layout || !rail || !button) return;
  const narrowDrawer = window.matchMedia('(max-width: 920px)').matches;
  const backdrop = pageRoot.querySelector('[data-workflow-sidepanel-backdrop]');
  const main = layout.querySelector('.workflows-main');
  layout.classList.toggle('is-workflow-sidepanel-collapsed', workflowSidePanelCollapsed);
  document.body.classList.toggle('is-workflow-sidepanel-collapsed', workflowSidePanelCollapsed);
  rail.classList.toggle('is-workflow-sidepanel-collapsed', workflowSidePanelCollapsed);
  if (backdrop) backdrop.hidden = !narrowDrawer || workflowSidePanelCollapsed;
  if (main) main.inert = narrowDrawer && !workflowSidePanelCollapsed;
  button.setAttribute('aria-expanded', String(!workflowSidePanelCollapsed));
  button.setAttribute('aria-label', `${workflowSidePanelCollapsed ? 'Expand' : 'Collapse'} task registry`);
  button.title = `${workflowSidePanelCollapsed ? 'Expand' : 'Collapse'} task registry`;
  const icon = button.querySelector('[data-lucide]');
  if (icon) icon.dataset.lucide = workflowSidePanelCollapsed ? 'chevron-left' : 'chevron-right';
  renderIcons(button);
}
window.addEventListener('resize', applyWorkflowSidePanelState);

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
  if (pageId === 'plugins/calendar/settings' || pageId === 'plugins/health/settings') return;
  if (!['plugins', 'integrations', 'workflows', 'calendar', 'todos', 'health', 'finance'].includes(pageId)) return;
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
    if (pageId === 'health') { healthPageData = data; healthSettings = normalizeHealthSettings(data.settings); renderHealth(data); }
    if (pageId === 'finance') { financeTransactions = data.transactions || []; financeLastImportRun = data.lastImportRun; financeImportWorkflowEnabled = data.importWorkflowEnabled !== false; renderFinance(financeTransactions, financeLastImportRun); }
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
  integrationRecords = integrations;
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
  const categorySelect = pageRoot.querySelector('#integration-category');
  if (categorySelect) {
    const categories = [...new Set(providers.map((provider) => provider.category).filter(Boolean))].sort();
    categorySelect.replaceChildren(new Option('All categories', ''));
    for (const category of categories) categorySelect.add(new Option(category, category));
    if (categories.includes(integrationCategory)) categorySelect.value = integrationCategory;
    else integrationCategory = categorySelect.value = '';
  }
  for (const provider of providers) {
    const savedAccount = integrations.find((item) => item.provider_id === provider.id && item.config_json);
    if (savedAccount) { try { provider.clientId = JSON.parse(savedAccount.config_json).clientId || ''; } catch {} }
  }
  const count = pageRoot.querySelector('#integration-count');
  const matchingIntegrations = integrations.filter((integration) => {
    const provider = providers.find((item) => item.id === integration.provider_id);
    return matchesIntegrationQuery(provider, `${integration.display_name} ${integration.account_label || ''}`);
  });
  if (count) count.textContent = `${matchingIntegrations.length}${matchingIntegrations.length !== integrations.length ? ` of ${integrations.length}` : ''} connection${integrations.length === 1 ? '' : 's'}`;
  connectionList.replaceChildren();
  if (!matchingIntegrations.length) {
    const empty = document.createElement('div'); empty.className = 'integration-empty';
    empty.textContent = integrations.length ? 'No connections match this search.' : 'No external accounts connected yet.';
    connectionList.append(empty);
  }
  for (const integration of matchingIntegrations) {
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
      const reconnectProvider = { ...provider, reconnectId: integration.id, accountLabel: integration.account_label, clientId: JSON.parse(integration.config_json || '{}').clientId || provider.clientId };
      reconnect.addEventListener('click', () => integration.provider_id === 'google-calendar' ? connectGoogleCalendarDirect(reconnectProvider, reconnect) : connectOutlookCalendarDirect(reconnectProvider, reconnect)); actions.append(reconnect);
    }
    if (syncButton) actions.append(syncButton); actions.append(edit, toggle, remove);
    row.append(iconWrap, copy, status, actions); connectionList.append(row);
  }
  providerGrid.replaceChildren();
  const matchingProviders = providers.filter((provider) => matchesIntegrationQuery(provider));
  const resultsLabel = pageRoot.querySelector('#integration-results-label');
  if (resultsLabel) resultsLabel.textContent = `${matchingProviders.length} available`;
  for (const provider of matchingProviders) {
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
    connect.addEventListener('click', () => provider.googleCalendar ? connectGoogleCalendarDirect(provider, connect) : provider.outlookCalendar ? connectOutlookCalendarDirect(provider, connect) : showIntegrationForm(provider));
    card.append(head, name, description, availability, connect); providerGrid.append(card);
  }
  if (!matchingProviders.length) {
    const empty = document.createElement('p'); empty.className = 'integration-provider-empty'; empty.textContent = 'No integrations match this search.';
    providerGrid.append(empty);
  }
  renderIcons(connectionList); renderIcons(providerGrid);
}

function matchesIntegrationQuery(provider, extraText = '') {
  if (integrationCategory && provider?.category !== integrationCategory) return false;
  const haystack = `${provider?.name || ''} ${provider?.description || ''} ${provider?.category || ''} ${provider?.id || ''} ${extraText}`.toLowerCase();
  return integrationSearch.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

function updateIntegrationQuery(search, category) {
  integrationSearch = search.trim();
  integrationCategory = category;
  const params = new URLSearchParams();
  if (integrationCategory) params.set('category', integrationCategory);
  if (integrationSearch) params.set('q', integrationSearch);
  const query = params.toString();
  window.history.replaceState(null, '', `#integrations${query ? `?${query}` : ''}`);
  renderIntegrations(integrationRecords);
}

function integrationAccountEmail(integration) {
  try { return JSON.parse(integration.config_json || '{}').email || ''; } catch { return ''; }
}

function showCalendarIntegrationSetup(integration, calendars, afterConnect = false) {
  const email = integrationAccountEmail(integration) || integration.email || '';
  const form = document.createElement('form'); form.className = 'dialog-form integration-calendar-setup';
  const intro = document.createElement('p'); intro.className = 'dialog-copy field-wide';
  intro.textContent = `${afterConnect && email ? `Connected as ${email}. ` : ''}Choose which calendars to sync. The account email and calendar names are kept as defaults; add optional labels to make them easier to recognize.`;
  form.append(intro);

  const accountField = document.createElement('label'); accountField.className = 'field field-wide'; accountField.textContent = 'Account label';
  const accountInput = document.createElement('input'); accountInput.name = 'accountLabel'; accountInput.maxLength = 80; accountInput.placeholder = email || integration.display_name;
  const existingLabel = integration.account_label || '';
  if (existingLabel && existingLabel !== email) accountInput.value = existingLabel;
  accountField.append(accountInput); form.append(accountField);

  const calendarsHeading = document.createElement('h3'); calendarsHeading.className = 'field-wide integration-calendar-setup-heading'; calendarsHeading.textContent = 'Calendars in this account'; form.append(calendarsHeading);
  const calendarList = document.createElement('div'); calendarList.className = 'field-wide integration-calendar-setup-list';
  if (!calendars.length) {
    const empty = document.createElement('p'); empty.className = 'dialog-copy'; empty.textContent = 'No calendars were found for this account. Try syncing or reauthorizing it.'; calendarList.append(empty);
  }
  for (const calendar of calendars) {
    const row = document.createElement('div'); row.className = 'integration-calendar-label-row';
    const choice = document.createElement('label'); choice.className = 'field google-calendar-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = Boolean(calendar.selected); checkbox.dataset.calendarId = calendar.id;
    const calendarName = document.createElement('span'); calendarName.textContent = calendar.summary;
    choice.append(checkbox, calendarName);
    const label = document.createElement('input'); label.className = 'integration-calendar-name-input'; label.type = 'text'; label.maxLength = 80;
    label.value = calendar.display_label || ''; label.placeholder = calendar.summary; label.setAttribute('aria-label', `Optional label for ${calendar.summary}`);
    row.append(choice, label); calendarList.append(row);
  }
  form.append(calendarList);

  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = 'Save & sync';
  const dialog = openDialog(afterConnect ? 'Finish calendar setup' : 'Calendar settings', form, [cancel, save]);
  dialog.classList.add('integration-calendar-dialog');
  cancel.addEventListener('click', async () => {
    dialog.close();
    if (afterConnect) { const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations); }
  });
  save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try {
      const calendarSettings = [...calendarList.querySelectorAll('.integration-calendar-label-row')].map((row) => ({
        id: row.querySelector('[data-calendar-id]').dataset.calendarId,
        selected: row.querySelector('[data-calendar-id]').checked,
        displayLabel: row.querySelector('.integration-calendar-name-input').value,
      }));
      await window.dashboard.configureCalendarIntegration(integration.id, { accountLabel: accountInput.value, calendars: calendarSettings });
      dialog.close(); const data = await window.dashboard.getPageData('integrations'); renderIntegrations(data.integrations);
    } catch (error) { window.alert(error.message); save.disabled = false; }
  });
}

async function showIntegrationCalendarsForm(integration) {
  const calendars = await window.dashboard.getIntegrationCalendars(integration.id);
  showCalendarIntegrationSetup(integration, calendars);
}

async function connectOutlookCalendarDirect(provider, trigger) {
  const originalText = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = 'Waiting for Microsoft…';
  try {
    const connection = await window.dashboard.connectOutlookCalendar({ integrationId: provider.reconnectId });
    const { integrations } = await window.dashboard.getPageData('integrations');
    renderIntegrations(integrations);
    showCalendarIntegrationSetup({
      id: connection.id,
      provider_id: provider.id,
      display_name: provider.name,
      account_label: connection.accountLabel,
      email: connection.email,
    }, connection.calendars, true);
  } catch (error) {
    window.alert(error.message);
  } finally {
    if (trigger.isConnected) {
      trigger.disabled = false;
      trigger.textContent = originalText;
    }
  }
}

async function connectGoogleCalendarDirect(provider, trigger) {
  const originalText = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = 'Waiting for Google…';
  try {
    const connection = await window.dashboard.connectGoogleCalendar({ integrationId: provider.reconnectId });
    const { integrations } = await window.dashboard.getPageData('integrations');
    renderIntegrations(integrations);
    showCalendarIntegrationSetup({
      id: connection.id,
      provider_id: provider.id,
      display_name: provider.name,
      account_label: connection.accountLabel,
      email: connection.email,
    }, connection.calendars, true);
  } catch (error) {
    window.alert(error.message);
  } finally {
    if (trigger.isConnected) {
      trigger.disabled = false;
      trigger.textContent = originalText;
    }
  }
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
  if (provider.googleCalendar) {
    form.innerHTML = `<p class="dialog-copy field-wide">Google sign-in uses the app’s <code>GOOGLE_CALENDAR_CLIENT_ID</code> setting and requests read-only calendar access. Sign in first; you can label the account and choose its calendars next. Tokens stay in this device’s credential store.</p>`;
  } else if (provider.fitbit) {
    form.innerHTML = `<p class="dialog-copy field-wide">Fitbit’s legacy Web API is scheduled to shut down October 30, 2026. Create a Fitbit OAuth app, set its redirect URL to <code>http://127.0.0.1:53682/oauth/callback</code>, then enter its client ID. Sleep and weight access are requested. Tokens are kept in your desktop credential store.</p>
      <label class="field field-wide">Fitbit OAuth client ID<input name="clientId" required maxlength="120" autocomplete="off"></label>
      <label class="field field-wide">Account label<input name="accountLabel" required maxlength="80" placeholder="Personal Fitbit"></label>`;
  } else {
    form.innerHTML = `<p class="dialog-copy field-wide">This provider has no working connector yet. The entry will be saved as setup required.</p>
      <label class="field field-wide">Account label<input name="accountLabel" required maxlength="80" placeholder="Personal account"></label>`;
  }
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = provider.googleCalendar ? 'Connect with Google' : provider.fitbit ? 'Authorize Fitbit' : 'Save setup';
  const dialog = openDialog(`Add ${provider.name}`, form, [cancel, save]);
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true; save.textContent = provider.googleCalendar || provider.fitbit ? 'Waiting for sign-in…' : 'Saving…';
    try {
      const accountLabel = form.elements.accountLabel?.value.trim() || '';
      if (provider.googleCalendar) {
        const connection = await window.dashboard.connectGoogleCalendar({ integrationId: provider.reconnectId });
        dialog.close();
        showCalendarIntegrationSetup({ id: connection.id, provider_id: provider.id, display_name: provider.name, account_label: connection.accountLabel, email: connection.email }, connection.calendars, true);
        return;
      }
      else if (provider.fitbit) await window.dashboard.connectFitbit({ clientId: form.elements.clientId.value.trim(), accountLabel, integrationId: provider.reconnectId });
      else await window.dashboard.addIntegration({ providerId: provider.id, displayName: provider.name, accountLabel, pluginId: provider.pluginId });
      dialog.close(); const { integrations } = await window.dashboard.getPageData('integrations'); renderIntegrations(integrations);
    } catch (error) { window.alert(error.message); save.disabled = false; save.textContent = provider.googleCalendar ? 'Connect with Google' : provider.fitbit ? 'Authorize Fitbit' : 'Save setup'; }
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
  const filteredEvents = events.filter((event) => {
    const sourceId = event.integration_id || 'local';
    const visibilityKey = calendarIntegrationGroups.get(sourceId) || sourceId;
    const calendarVisibilityKey = event.calendarId
      ? calendarVisibilityGroups.get(`${sourceId}:${event.calendarId}`)
      : null;
    const matchesSource = calendarVisibilityKey
      ? calendarSourceVisibility[calendarVisibilityKey] !== false
      : calendarSourceVisibility[visibilityKey] !== false;
    const matchesSearch = !calendarSearch || `${event.title || ''} ${event.location || ''} ${event.sourceName || event.source || ''}`.toLowerCase().includes(calendarSearch);
    return matchesSource && matchesSearch;
  });
  const seenOutlookEvents = new Set();
  const visibleEvents = filteredEvents.filter((event) => {
    if (event.source_plugin_id !== 'outlook-calendar-connector' || !event.integration_id || !event.iCalUID) return true;
    const key = `${calendarIntegrationGroups.get(event.integration_id) || event.integration_id}:${event.iCalUID}`;
    if (seenOutlookEvents.has(key)) return false;
    seenOutlookEvents.add(key);
    return true;
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
  calendarIntegrationGroups.clear();
  calendarVisibilityGroups.clear();
  const calendarConnections = integrations.filter((item) => item.provider_id.includes('calendar'));
  const groupedConnections = new Map();
  for (const integration of calendarConnections) {
    let accountEmail = '';
    try { accountEmail = JSON.parse(integration.config_json || '{}').email?.trim().toLowerCase() || ''; } catch {}
    const groupKey = accountEmail ? `${integration.provider_id}:${accountEmail}` : integration.id;
    calendarIntegrationGroups.set(integration.id, groupKey);
    const group = groupedConnections.get(groupKey) || [];
    group.push(integration);
    groupedConnections.set(groupKey, group);
  }
  for (const [groupKey, group] of groupedConnections) {
    const integration = group[0];
    const account = document.createElement('div'); account.className = 'calendar-account-group';
    const row = document.createElement('label'); row.className = 'calendar-account-line';
    const toggle = document.createElement('input'); toggle.className = 'calendar-visibility-toggle'; toggle.type = 'checkbox'; toggle.dataset.calendarSource = groupKey;
    const childCalendars = new Map();
    for (const connection of group) {
      for (const calendar of connection.calendars || []) {
        if (!calendar.selected) continue;
        const childKey = `${groupKey}:calendar:${calendar.external_calendar_id}`;
        calendarVisibilityGroups.set(`${connection.id}:${calendar.external_calendar_id}`, childKey);
        if (!childCalendars.has(childKey)) childCalendars.set(childKey, calendar);
      }
    }
    const childKeys = [...childCalendars.keys()];
    const childVisibility = childKeys.map((key) => calendarSourceVisibility[key] !== false);
    toggle.checked = childVisibility.length ? childVisibility.every(Boolean) : calendarSourceVisibility[groupKey] !== false;
    toggle.indeterminate = childVisibility.some(Boolean) && childVisibility.some((visible) => !visible);
    const check = document.createElement('span'); check.className = `calendar-check ${integration.provider_id === 'google-calendar' ? 'google' : 'outlook'}`;
    const name = document.createElement('span'); name.className = 'calendar-account-name';
    const accountName = integration.account_label || (integration.provider_id === 'google-calendar' ? 'Google Calendar' : 'Outlook Calendar');
    name.textContent = accountName;
    if (group.length > 1) name.title = `${accountName} (${group.length} connections)`;
    const color = document.createElement('span'); color.className = `calendar-color-dot ${integration.provider_id === 'google-calendar' ? 'google' : 'outlook'}`;
    row.append(toggle, check, name, color); account.append(row);
    for (const [childKey, calendar] of childCalendars) {
      const calendarRow = document.createElement('label'); calendarRow.className = 'calendar-account-line calendar-child-line';
      const calendarToggle = document.createElement('input'); calendarToggle.className = 'calendar-visibility-toggle'; calendarToggle.type = 'checkbox'; calendarToggle.dataset.calendarSource = childKey;
      calendarToggle.checked = calendarSourceVisibility[childKey] !== false;
      const calendarCheck = document.createElement('span'); calendarCheck.className = `calendar-check ${integration.provider_id === 'google-calendar' ? 'google' : 'outlook'}`;
      const calendarName = document.createElement('span'); calendarName.className = 'calendar-account-name'; calendarName.textContent = calendar.display_label || calendar.summary;
      calendarName.title = calendar.display_label || calendar.summary;
      const calendarColor = document.createElement('span'); calendarColor.className = `calendar-color-dot ${integration.provider_id === 'google-calendar' ? 'google' : 'outlook'}`;
      calendarRow.append(calendarToggle, calendarCheck, calendarName, calendarColor); account.append(calendarRow);
      calendarToggle.addEventListener('change', () => {
        calendarSourceVisibility[childKey] = calendarToggle.checked;
        const visible = childKeys.map((key) => calendarSourceVisibility[key] !== false);
        toggle.checked = visible.length ? visible.every(Boolean) : calendarSourceVisibility[groupKey] !== false;
        toggle.indeterminate = visible.some(Boolean) && visible.some((value) => !value);
        renderCalendarBoard(calendarEvents);
      });
    }
    summary.append(account);
    toggle.addEventListener('change', () => {
      if (childKeys.length) {
        for (const childKey of childKeys) calendarSourceVisibility[childKey] = toggle.checked;
      } else calendarSourceVisibility[groupKey] = toggle.checked;
      toggle.indeterminate = false;
      for (const calendarToggle of account.querySelectorAll('.calendar-child-line .calendar-visibility-toggle')) calendarToggle.checked = toggle.checked;
      renderCalendarBoard(calendarEvents);
    });
  }
  if (!calendarConnections.length) {
    const empty = document.createElement('p'); empty.className = 'calendar-no-accounts'; empty.textContent = 'Connect calendars to see them here.'; summary.append(empty);
  }
  renderCalendarBoard(calendarEvents);
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
  const actionList = pageRoot.querySelector('#workflow-action-list');
  if (!list || !runList || !actionList) return;
  list.replaceChildren(); runList.replaceChildren(); actionList.replaceChildren();
  const scheduled = workflows.filter((workflow) => workflow.trigger_type === 'schedule' || workflow.trigger_type === 'event');
  const actions = workflows.filter((workflow) => workflow.trigger_type === 'manual');
  const count = pageRoot.querySelector('#workflow-count'); if (count) count.textContent = `${scheduled.length} rule${scheduled.length === 1 ? '' : 's'}`;
  const runCount = pageRoot.querySelector('#workflow-run-count'); if (runCount) runCount.textContent = `${runs.length} recent`;
  const actionCount = pageRoot.querySelector('#workflow-action-count'); if (actionCount) actionCount.textContent = `${actions.length} task${actions.length === 1 ? '' : 's'}`;
  const makeTable = (container, headings, className) => {
    container.removeAttribute('tabindex'); container.removeAttribute('role'); container.removeAttribute('aria-label');
    const table = document.createElement('table'); table.className = `workflow-table ${className}`;
    table.setAttribute('aria-label', className.includes('history') ? 'Workflow run history' : 'Scheduled and event workflow rules');
    const thead = document.createElement('thead'); const header = document.createElement('tr');
    for (const label of headings) {
      const th = document.createElement('th'); th.scope = 'col';
      if (label) th.textContent = label;
      else { const accessibleLabel = document.createElement('span'); accessibleLabel.className = 'sr-only'; accessibleLabel.textContent = 'Actions'; th.append(accessibleLabel); }
      header.append(th);
    }
    thead.append(header); table.append(thead); const body = document.createElement('tbody'); table.append(body); container.append(table); return body;
  };
  const runBody = makeTable(runList, ['Workflow', 'Run details', 'Started', 'Status'], 'workflow-history-table');
  if (!runs.length) { const row = document.createElement('tr'); row.className = 'workflow-empty-row'; const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'Workflow executions will appear here.'; row.append(cell); runBody.append(row); }
  for (const run of runs) {
    const row = document.createElement('tr'); row.className = 'workflow-run-row';
    const title = document.createElement('th'); title.scope = 'row'; title.textContent = run.workflow_name;
    const execution = document.createElement('td'); execution.className = 'workflow-run-details'; execution.textContent = run.error_text || (run.result?.stage ? `Finance import · ${run.result.stage.replaceAll('_', ' ')}${run.result.filename ? ` · ${run.result.filename}` : ''}${run.result.importedCount !== undefined ? ` · ${run.result.importedCount} rows` : ''}` : (run.result?.recordCount !== undefined ? `${run.result.recordCount} records` : '—'));
    const started = document.createElement('td'); started.textContent = new Date(`${run.started_at}Z`).toLocaleString();
    const result = document.createElement('td'); const status = document.createElement('span'); status.className = `workflow-run-status is-${run.status}`; status.textContent = run.status; result.append(status);
    row.append(title, execution, started, result); runBody.append(row);
  }

  const workflowBody = makeTable(list, ['Automation', 'Trigger', 'Recent activity', 'State', ''], 'workflow-config-table');
  if (!scheduled.length) { const row = document.createElement('tr'); row.className = 'workflow-empty-row'; const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = 'Scheduled and event-driven automations will appear here.'; row.append(cell); workflowBody.append(row); }
  for (const workflow of scheduled) {
    const isEvent = workflow.trigger_type === 'event';
    const row = document.createElement('tr'); row.className = 'workflow-config-row';
    const copyCell = document.createElement('th'); copyCell.scope = 'row';
    const copy = document.createElement('div'); copy.className = 'workflow-copy';
    const title = document.createElement('strong'); title.textContent = workflow.name;
    const description = document.createElement('small'); description.textContent = workflow.integration_name || workflow.plugin_name || 'Plugin workflow';
    copy.append(title, description); copyCell.append(copy);
    const trigger = document.createElement('td'); trigger.className = 'workflow-trigger';
    const cadence = document.createElement('strong'); cadence.textContent = isEvent ? (workflow.definition.eventName || workflow.definition.event || 'When triggered by an event') : `Every ${Math.round((workflow.definition.intervalMinutes || 0) / 60)} hours`;
    const triggerDetail = document.createElement('small'); triggerDetail.textContent = isEvent ? (workflow.definition.eventDescription || 'Event-driven') : 'While the dashboard is open'; trigger.append(cadence, triggerDetail);
    const activity = document.createElement('td'); activity.className = 'workflow-activity';
    const timing = document.createElement('small'); timing.textContent = workflow.last_run_at ? `Last run ${new Date(`${workflow.last_run_at}Z`).toLocaleString()}${!isEvent ? ` · next ${workflow.next_run_at ? new Date(workflow.next_run_at).toLocaleString() : 'paused'}` : ''}` : `No runs yet${!isEvent && workflow.next_run_at ? ` · next ${new Date(workflow.next_run_at).toLocaleString()}` : ''}`; activity.append(timing);
    const statusCell = document.createElement('td'); statusCell.className = 'workflow-state-cell';
    const status = document.createElement('span'); status.className = `workflow-state${workflow.enabled ? ' is-enabled' : ''}`; status.textContent = workflow.enabled ? 'Active' : 'Paused'; statusCell.append(status);
    const actions = document.createElement('td'); const actionGroup = document.createElement('div'); actionGroup.className = 'workflow-actions';
    const run = document.createElement('button'); run.type = 'button'; run.className = 'workflow-action-link'; run.textContent = 'Run now';
    run.disabled = !workflow.integration_id || !['connected', 'error'].includes(workflow.integration_status);
    run.addEventListener('click', async () => { run.disabled = true; run.textContent = 'Running…'; try { await window.dashboard.runWorkflow(workflow.id); } catch (error) { window.alert(error.message); } finally { await reloadWorkflows(); } });
    if (!isEvent) {
      const configure = document.createElement('button'); configure.type = 'button'; configure.className = 'workflow-action-link is-muted'; configure.textContent = 'Configure';
      configure.addEventListener('click', () => showWorkflowScheduleForm(workflow)); actionGroup.append(configure);
    }
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'workflow-action-link is-muted'; toggle.textContent = workflow.enabled ? 'Pause' : 'Resume';
    toggle.addEventListener('click', async () => { await window.dashboard.setWorkflowEnabled(workflow.id, !workflow.enabled); await reloadWorkflows(); });
    actionGroup.append(run, toggle); actions.append(actionGroup); row.append(copyCell, trigger, activity, statusCell, actions); workflowBody.append(row);
  }

  if (!actions.length) { const empty = document.createElement('p'); empty.className = 'workflow-action-empty'; empty.textContent = 'Installed plugins can register on-demand tasks here.'; actionList.append(empty); }
  const categories = new Map();
  for (const workflow of actions) {
    const category = workflow.definition.category || workflow.plugin_name || 'Other';
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(workflow);
  }
  for (const [category, categoryActions] of categories) {
    const group = document.createElement('section'); group.className = 'workflow-action-category';
    const heading = document.createElement('h3'); heading.textContent = category; group.append(heading);
    for (const workflow of categoryActions) {
      const row = document.createElement('div'); row.className = 'workflow-action-definition';
      const copy = document.createElement('div'); copy.className = 'workflow-action-definition-copy';
      const title = document.createElement('strong'); title.textContent = workflow.name;
      const detail = document.createElement('small'); detail.textContent = workflow.definition.summary || (workflow.definition.jobType === 'local_data_pipeline' ? 'Import a statement into the local Finance ledger.' : 'On-demand plugin task.'); copy.append(title, detail);
      const metadata = document.createElement('dl'); metadata.className = 'workflow-task-metadata';
      const financeStages = {
        select_file: 'Choose a statement file', parse_csv: 'Read the CSV', map_columns: 'Map transaction columns', preview_rows: 'Review rows',
        normalize: 'Normalize transactions', deduplicate: 'Check for duplicates', commit_records: 'Save to the local ledger',
      };
      const metadataEntries = [
        ['Plugin', workflow.plugin_name || category],
        ['Trigger', workflow.definition.jobType === 'local_data_pipeline' ? 'Manual · requires a local CSV' : 'Manual request'],
        ['Steps', workflow.definition.stages?.map((stage) => financeStages[stage] || stage.replaceAll('_', ' ')).join(' · ') || 'Defined by plugin'],
        ['Data', workflow.definition.output || (workflow.plugin_id === 'finance' ? 'Personal Finance · local SQLite' : 'Stored by the plugin on this device')],
      ];
      for (const [term, value] of metadataEntries) { const entry = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); dd.textContent = value; entry.append(dt, dd); metadata.append(entry); }
      const details = document.createElement('details'); details.className = 'workflow-task-details'; const summary = document.createElement('summary'); summary.textContent = 'Task details'; details.append(summary, metadata); copy.append(details);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'workflow-action-link workflow-run-task'; button.textContent = 'Run task';
      button.disabled = !workflow.enabled;
      button.addEventListener('click', async () => {
        if (workflow.definition.jobType === 'local_data_pipeline' && workflow.plugin_id === 'finance') { showFinanceStatementImport(); return; }
        button.disabled = true; button.textContent = 'Running…'; try { await window.dashboard.runWorkflow(workflow.id); } catch (error) { window.alert(error.message); } finally { await reloadWorkflows(); }
      });
      row.append(copy, button); group.append(row);
    }
    actionList.append(group);
  }
  renderIcons(list); renderIcons(runList); renderIcons(actionList);
}

async function reloadWorkflows() {
  const data = await window.dashboard.getPageData('workflows'); renderWorkflows(data.workflows || [], data.runs || []);
}

function showWorkflowScheduleForm(workflow) {
  const form = document.createElement('form'); form.className = 'dialog-form workflow-schedule-form';
  const intro = document.createElement('p'); intro.className = 'dialog-copy field-wide'; intro.textContent = `Set how often ${workflow.name} runs while Local Dashboard is open.`;
  const label = document.createElement('label'); label.className = 'field field-wide'; label.textContent = 'Run every';
  const select = document.createElement('select');
  const intervals = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']];
  for (const [minutes, name] of intervals) { const option = document.createElement('option'); option.value = String(minutes); option.textContent = name; select.append(option); }
  select.value = String(workflow.definition.intervalMinutes || 360); label.append(select); form.append(intro, label);
  const error = document.createElement('p'); error.className = 'form-error field-wide'; error.hidden = true; form.append(error);
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'button'; save.textContent = 'Save schedule';
  const dialog = openDialog('Configure schedule', form, [cancel, save]);
  cancel.addEventListener('click', () => dialog.close());
  save.addEventListener('click', async () => {
    save.disabled = true; error.hidden = true;
    try { await window.dashboard.updateWorkflowSchedule(workflow.id, Number(select.value)); dialog.close(); await reloadWorkflows(); }
    catch (cause) { error.textContent = cause.message; error.hidden = false; save.disabled = false; }
  });
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

const financePlans = { Groceries: 620, Dining: 360, Transport: 180, Bills: 430, Home: 310, Subscriptions: 95, Health: 140, Shopping: 240, Leisure: 180, Gifts: 110, Other: 100 };

function financeCurrency(amount, currency = 'CAD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
}

function renderFinance(allRecords, lastImportRun = financeLastImportRun) {
  const currencies = [...new Set(allRecords.map((record) => record.currency || 'CAD'))].sort();
  if (!currencies.length) currencies.push('CAD');
  if (!currencies.includes(financeCurrencyCode)) financeCurrencyCode = currencies.includes('CAD') ? 'CAD' : currencies[0];
  const currencySelect = pageRoot.querySelector('#finance-currency');
  currencySelect.replaceChildren();
  for (const code of currencies) { const option = document.createElement('option'); option.value = code; option.textContent = code; currencySelect.append(option); }
  currencySelect.value = financeCurrencyCode;
  const records = allRecords.filter((record) => (record.currency || 'CAD') === financeCurrencyCode);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthRecords = records.filter((record) => new Date(record.occurred_at) >= monthStart && new Date(record.occurred_at) <= now);
  const currency = financeCurrencyCode;
  const income = monthRecords.filter((record) => record.direction === 'income').reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const expenses = monthRecords.filter((record) => record.direction !== 'income');
  const spending = expenses.reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const hasPlan = currency === 'CAD';
  const planTotal = hasPlan ? Object.values(financePlans).reduce((sum, amount) => sum + amount, 0) : 0;
  const left = planTotal - spending;
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(now);
  const dateRange = `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(monthStart)} – ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(now)}`;
  pageRoot.querySelector('#finance-period-title').textContent = monthName;
  pageRoot.querySelector('#finance-period-dates').textContent = dateRange;
  pageRoot.querySelector('#finance-income').textContent = financeCurrency(income, currency);
  pageRoot.querySelector('#finance-spending').textContent = financeCurrency(spending, currency);
  pageRoot.querySelector('#finance-left').textContent = hasPlan ? financeCurrency(Math.abs(left), currency) : '—';
  pageRoot.querySelector('#finance-left').classList.toggle('is-over-plan', hasPlan && left < 0);
  pageRoot.querySelector('#finance-left-note').textContent = hasPlan ? (left < 0 ? `over your ${financeCurrency(planTotal, currency)} sample plan` : `of your ${financeCurrency(planTotal, currency)} sample plan`) : 'No plan is configured for this currency';
  pageRoot.querySelector('#finance-plan-summary').textContent = hasPlan ? `${financeCurrency(spending, currency)} of ${financeCurrency(planTotal, currency)}` : `${financeCurrency(spending, currency)} · no plan configured`;
  const hasSamples = allRecords.some((record) => record.sourceName === 'Local sample');
  pageRoot.querySelector('#finance-ledger-badge').hidden = !hasSamples;
  pageRoot.querySelector('[data-action="clear-finance-samples"]').hidden = !hasSamples;
  pageRoot.querySelector('[data-action="import-finance-statement"]').disabled = !financeImportWorkflowEnabled;
  pageRoot.querySelector('#finance-import-last-run').textContent = !financeImportWorkflowEnabled
    ? 'Statement import is paused. Resume the Finance workflow from Workflows to continue.'
    : lastImportRun?.status === 'succeeded'
    ? `Last import: ${lastImportRun.result?.importedCount ?? 0} rows added from ${lastImportRun.result?.filename || 'a CSV statement'}.`
    : lastImportRun?.status === 'running' ? `Import in progress · ${lastImportRun.result?.stage?.replaceAll('_', ' ') || 'preparing file'}.`
      : lastImportRun?.status === 'failed' ? `Last import needs attention: ${lastImportRun.error_text || 'the file could not be processed'}`
        : lastImportRun?.status === 'cancelled' ? 'The previous import was cancelled. No staged rows were written to your ledger.'
          : 'Choose a CSV to map its columns and review rows before anything reaches your ledger.';

  const categoryTotals = new Map();
  for (const record of expenses) categoryTotals.set(record.category || 'Other', (categoryTotals.get(record.category || 'Other') || 0) + Number(record.amount || 0));
  const categoryRoot = pageRoot.querySelector('#finance-category-list');
  categoryRoot.replaceChildren();
  const categoryNames = hasPlan ? [...new Set([...Object.keys(financePlans), ...categoryTotals.keys()])] : [...categoryTotals.keys()];
  for (const name of categoryNames.sort((a, b) => (categoryTotals.get(b) || 0) - (categoryTotals.get(a) || 0))) {
    const budget = hasPlan ? (financePlans[name] ?? null) : null;
    const amount = categoryTotals.get(name) || 0;
    const row = document.createElement('div'); row.className = 'finance-category-row';
    const top = document.createElement('div'); top.className = 'finance-category-top';
    const label = document.createElement('span'); label.textContent = name;
    const value = document.createElement('strong'); value.textContent = budget === null ? `${financeCurrency(amount, currency)}${hasPlan ? ' · no plan' : ''}` : `${financeCurrency(amount, currency)} of ${financeCurrency(budget, currency)}`;
    top.append(label, value);
    if (budget !== null) {
      const track = document.createElement('div'); track.className = 'finance-progress-track'; track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', `${name} plan used`); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(budget)); track.setAttribute('aria-valuenow', String(Math.min(amount, budget)));
      const fill = document.createElement('span'); fill.style.width = `${Math.min(100, amount / budget * 100)}%`; if (amount > budget) fill.classList.add('is-over-plan'); track.append(fill);
      row.append(top, track);
    } else row.append(top);
    categoryRoot.append(row);
  }

  const transactionRoot = pageRoot.querySelector('#finance-transactions'); transactionRoot.replaceChildren();
  const latest = [...records].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at)).slice(0, 8);
  pageRoot.querySelector('#finance-transaction-count').textContent = `${records.length} entries`;
  pageRoot.querySelector('#finance-empty-state').hidden = records.length > 0;
  pageRoot.querySelector('.finance-table-scroll').hidden = records.length === 0;
  for (const record of latest) {
    const row = document.createElement('tr'); const merchantCell = document.createElement('td');
    const merchant = document.createElement('strong'); merchant.textContent = record.merchant || 'Transaction';
    const source = document.createElement('small'); source.textContent = record.sourceName === 'Local sample' ? 'Sample entry' : record.importBatchId ? `Statement · ${record.sourceFileName || 'CSV'}` : 'On this device'; merchantCell.append(merchant, source);
    const category = document.createElement('td'); category.textContent = record.category || 'Other';
    const date = document.createElement('td'); date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(record.occurred_at));
    const amount = document.createElement('td'); amount.className = `finance-amount${record.direction === 'income' ? ' is-income' : ''}`; amount.textContent = `${record.direction === 'income' ? '+' : '−'}${financeCurrency(Number(record.amount || 0), record.currency || currency)}`;
    row.append(merchantCell, category, date, amount); transactionRoot.append(row);
  }
  renderFinanceChart(records, currency);
}

function renderFinanceChart(records, currency) {
  const canvas = pageRoot.querySelector('#finance-cashflow-chart'); if (!canvas) return;
  const months = []; const current = new Date(); current.setDate(1); current.setHours(0, 0, 0, 0);
  for (let offset = 5; offset >= 0; offset -= 1) { const date = new Date(current.getFullYear(), current.getMonth() - offset, 1); months.push({ date, label: new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date), income: 0, spending: 0 }); }
  for (const record of records) {
    const date = new Date(record.occurred_at); const month = months.find((item) => item.date.getFullYear() === date.getFullYear() && item.date.getMonth() === date.getMonth()); if (!month) continue;
    if (record.direction === 'income') month.income += Number(record.amount || 0); else month.spending += Number(record.amount || 0);
  }
  const chart = new Chart(canvas, { type: 'line', data: { labels: months.map((item) => item.label), datasets: [
    { label: 'Income', data: months.map((item) => item.income), borderColor: '#39755a', backgroundColor: 'rgba(57,117,90,.08)', pointBackgroundColor: '#39755a', pointRadius: 3, borderWidth: 2, tension: .28, fill: true },
    { label: 'Spending', data: months.map((item) => item.spending), borderColor: '#536fa1', backgroundColor: 'rgba(83,111,161,.06)', pointBackgroundColor: '#536fa1', pointRadius: 3, borderWidth: 2, tension: .28, fill: true },
  ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${financeCurrency(context.parsed.y, currency)}` } } }, scales: { x: { grid: { display: false }, ticks: { color: '#89918b', maxRotation: 0 } }, y: { beginAtZero: true, grid: { color: '#edf0ed' }, ticks: { color: '#89918b', callback: (value) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value) } } } } });
  activeCharts.push(chart);
}

function showFinanceStatementImport() {
  const state = { importId: null, file: null, preview: null, mapping: null, fallbackCurrency: 'CAD', accountLabel: '', keepPossibleDuplicates: false, rowOverrides: {}, rowPossibleDuplicates: {}, reviewedPages: new Set(), completed: false };
  const content = document.createElement('div'); content.className = 'finance-import-dialog-content';
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const primary = document.createElement('button'); primary.className = 'button button-primary'; primary.type = 'button'; primary.textContent = 'Choose CSV';
  const dialog = openDialog('Import bank statement', content, [cancel, primary]);
  dialog.classList.add('finance-import-dialog');
  const footer = dialog.querySelector('.dialog-actions');
  const chooseView = () => {
    content.replaceChildren();
    const intro = document.createElement('p'); intro.className = 'dialog-copy'; intro.textContent = 'Select a CSV statement saved on this device. The file is read by the desktop app and is not uploaded or copied to a server.';
    const privacy = document.createElement('div'); privacy.className = 'finance-import-privacy';
    privacy.innerHTML = '<i data-lucide="shield-check" class="icon" aria-hidden="true"></i><span><strong>Private by design</strong><small>Nothing is written to your ledger until you confirm the reviewed rows.</small></span>';
    const example = document.createElement('div'); example.className = 'finance-import-example';
    const exampleLabel = document.createElement('small'); exampleLabel.textContent = 'Example mapping · your bank may use different column names';
    const exampleFlow = document.createElement('p'); exampleFlow.textContent = 'Match the date, description, and amount columns to the corresponding fields.';
    example.append(exampleLabel, exampleFlow);
    const status = document.createElement('p'); status.className = 'finance-import-status'; status.setAttribute('aria-live', 'polite');
    content.append(intro, privacy, example, status); renderIcons(content);
    setFooter([cancel, primary]); primary.textContent = 'Choose CSV'; primary.disabled = false;
    primary.onclick = async () => {
      primary.disabled = true; primary.textContent = 'Reading locally…'; status.textContent = 'Opening the file on this device.';
      try {
        const selected = await window.dashboard.chooseFinanceStatement();
        if (!selected || selected.cancelled) { primary.disabled = false; primary.textContent = 'Choose CSV'; status.textContent = ''; return; }
        state.importId = selected.importId; state.file = selected; renderMappingView();
      } catch (error) { status.textContent = error.message; primary.disabled = false; primary.textContent = 'Try again'; }
    };
  };
  const setFooter = (buttons) => { footer.replaceChildren(...buttons); };
  const closeAndCancel = async () => {
    if (state.importId && !state.completed) await window.dashboard.cancelFinanceStatement(state.importId).catch(() => {});
    state.importId = null; dialog.close();
  };
  cancel.onclick = () => { void closeAndCancel(); };
  dialog.addEventListener('close', () => {
    if (state.importId && !state.completed) void window.dashboard.cancelFinanceStatement(state.importId).catch(() => {});
  }, { once: true });

  function mappingSelect(field, required = false) {
    const label = document.createElement('label'); label.className = 'field finance-mapping-field';
    const title = document.createElement('span'); title.textContent = `${field.label}${required ? ' · required' : ''}`; label.append(title);
    const select = document.createElement('select'); select.name = field.key;
    const none = document.createElement('option'); none.value = ''; none.textContent = 'Not mapped'; select.append(none);
    state.file.headers.forEach((header, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = header; select.append(option); });
    const suggested = state.mapping && Object.hasOwn(state.mapping, field.key) ? state.mapping[field.key] : state.file.suggestions[field.key]; if (suggested !== null && suggested !== undefined) select.value = String(suggested);
    label.append(select); return label;
  }

  function renderMappingView() {
    dialog.classList.add('is-wide');
    content.replaceChildren(); content.classList.add('is-mapping');
    const fileHeading = document.createElement('div'); fileHeading.className = 'finance-import-file-heading';
    const fileTitle = document.createElement('strong'); fileTitle.textContent = state.file.filename;
    const fileMeta = document.createElement('small'); fileMeta.textContent = `${state.file.rowCount.toLocaleString()} rows · ${state.file.delimiter === 'tab' ? 'tab-separated' : `“${state.file.delimiter}” separated`}`;
    fileHeading.append(fileTitle, fileMeta);
    const form = document.createElement('form'); form.className = 'finance-import-mapping-form';
    const delimiterField = document.createElement('label'); delimiterField.className = 'field'; delimiterField.innerHTML = '<span>Separator</span><select name="delimiter"></select>';
    const delimiterSelect = delimiterField.querySelector('select');
    for (const optionData of state.file.delimiterOptions || []) { const option = document.createElement('option'); option.value = optionData.value; option.textContent = `${optionData.label || (optionData.value === 'tab' ? 'Tab' : optionData.value[0].toUpperCase() + optionData.value.slice(1))} · ${optionData.columnCount} columns`; delimiterSelect.append(option); }
    delimiterSelect.value = state.file.delimiter;
    delimiterSelect.addEventListener('change', async () => {
      delimiterSelect.disabled = true; error.textContent = 'Re-reading the selected file locally…';
      try { const parsed = await window.dashboard.selectFinanceStatementDelimiter({ importId: state.importId, delimiter: delimiterSelect.value }); state.file = { ...state.file, ...parsed }; state.mapping = null; state.keepPossibleDuplicates = false; error.textContent = ''; renderMappingView(); }
      catch (delimiterError) { error.textContent = delimiterError.message; delimiterSelect.disabled = false; }
    });
    const mappingGrid = document.createElement('div'); mappingGrid.className = 'finance-mapping-grid';
    for (const field of [
      { key: 'date', label: 'Transaction date', required: true }, { key: 'description', label: 'Description / payee', required: true },
      { key: 'amount', label: 'Signed or single amount' }, { key: 'debit', label: 'Debit / money out' }, { key: 'credit', label: 'Credit / money in' },
      { key: 'currency', label: 'Currency' }, { key: 'category', label: 'Category' },
    ]) mappingGrid.append(mappingSelect(field, field.required));
    const formatField = document.createElement('label'); formatField.className = 'field'; formatField.innerHTML = '<span>Date format</span><select name="dateFormat"><option value="auto">Detect when unambiguous</option><option value="dmy">Day / month / year</option><option value="mdy">Month / day / year</option></select>';
    const amountModeField = document.createElement('label'); amountModeField.className = 'field'; amountModeField.innerHTML = '<span>Single amount sign</span><select name="amountMode"><option value="signed">Negative is expense, positive is income</option><option value="positive-expense">Positive is expense</option><option value="positive-income">Positive is income</option></select>';
    const currencyField = document.createElement('label'); currencyField.className = 'field'; currencyField.innerHTML = '<span>Fallback currency</span><input name="fallbackCurrency" value="CAD" maxlength="3" pattern="[A-Za-z]{3}" required>';
    const accountField = document.createElement('label'); accountField.className = 'field'; accountField.innerHTML = '<span>Account label <small>(optional)</small></span><input name="accountLabel" maxlength="80" placeholder="e.g. Daily chequing">';
    formatField.querySelector('select').value = state.mapping?.dateFormat || 'auto';
    amountModeField.querySelector('select').value = state.mapping?.amountMode || 'signed';
    currencyField.querySelector('input').value = state.fallbackCurrency || 'CAD';
    accountField.querySelector('input').value = state.accountLabel || '';
    const extraGrid = document.createElement('div'); extraGrid.className = 'finance-mapping-extras'; extraGrid.append(formatField, amountModeField, currencyField, accountField);
    const sampleTitle = document.createElement('p'); sampleTitle.className = 'finance-preview-label'; sampleTitle.textContent = 'First rows from the selected file';
    const sampleTable = document.createElement('div'); sampleTable.className = 'finance-raw-sample';
    const table = document.createElement('table'); const head = document.createElement('thead'); const headRow = document.createElement('tr');
    state.file.headers.forEach((header) => { const th = document.createElement('th'); th.textContent = header; headRow.append(th); }); head.append(headRow); table.append(head);
    const body = document.createElement('tbody'); state.file.sampleRows.forEach((row) => { const tr = document.createElement('tr'); row.cells.forEach((cell) => { const td = document.createElement('td'); td.textContent = cell; tr.append(td); }); body.append(tr); }); table.append(body); sampleTable.append(table);
    const error = document.createElement('p'); error.className = 'finance-import-status'; error.setAttribute('aria-live', 'polite');
    form.append(delimiterField, mappingGrid, extraGrid, sampleTitle, sampleTable, error); content.append(fileHeading, form);
    const amountSelect = form.elements.amount; const debitSelect = form.elements.debit; const creditSelect = form.elements.credit;
    amountSelect.addEventListener('change', () => { if (amountSelect.value !== '') { debitSelect.value = ''; creditSelect.value = ''; } });
    for (const splitSelect of [debitSelect, creditSelect]) splitSelect.addEventListener('change', () => { if (splitSelect.value !== '') amountSelect.value = ''; });
    renderIcons(content);
    const back = document.createElement('button'); back.className = 'button button-secondary'; back.type = 'button'; back.textContent = 'Choose another file';
    const previewButton = document.createElement('button'); previewButton.className = 'button button-primary'; previewButton.type = 'button'; previewButton.textContent = 'Preview rows';
    setFooter([cancel, back, previewButton]);
    back.onclick = async () => { await closeAndCancel(); showFinanceStatementImport(); };
    previewButton.onclick = async () => {
      if (!form.reportValidity()) return;
      const mapping = {};
      for (const key of ['date', 'description', 'amount', 'debit', 'credit', 'currency', 'category']) mapping[key] = form.elements[key].value === '' ? null : Number(form.elements[key].value);
      mapping.dateFormat = form.elements.dateFormat.value; mapping.amountMode = form.elements.amountMode.value;
      const fallbackCurrency = form.elements.fallbackCurrency.value.trim().toUpperCase(); state.fallbackCurrency = fallbackCurrency; state.accountLabel = form.elements.accountLabel.value.trim(); state.mapping = mapping;
      previewButton.disabled = true; previewButton.textContent = 'Checking rows…'; error.textContent = '';
      try { state.preview = await window.dashboard.previewFinanceStatement({ importId: state.importId, mapping, fallbackCurrency, accountLabel: state.accountLabel }); state.rowOverrides = {}; state.rowPossibleDuplicates = {}; state.reviewedPages = new Set(); state.keepPossibleDuplicates = false; renderPreviewView(); }
      catch (previewError) { error.textContent = previewError.message; previewButton.disabled = false; previewButton.textContent = 'Preview rows'; }
    };
  }

  function renderPreviewView() {
    dialog.classList.add('is-wide');
    content.replaceChildren(); content.classList.remove('is-mapping'); content.classList.add('is-preview');
    const heading = document.createElement('div'); heading.className = 'finance-import-file-heading';
    const title = document.createElement('strong'); title.textContent = 'Review before importing';
    const subtitle = document.createElement('small'); subtitle.textContent = `${state.file.filename} · mapped as ${state.mapping.dateFormat === 'auto' ? 'unambiguous date format' : state.mapping.dateFormat.toUpperCase()}`; heading.append(title, subtitle);
    const counts = document.createElement('div'); counts.className = 'finance-import-counts';
    for (const [label, count, tone] of [['Ready', state.preview.validCount, 'success'], ['Possible duplicates', state.preview.duplicateCount, 'warning'], ['Need attention', state.preview.invalidCount, 'danger']]) {
      const card = document.createElement('div'); card.className = `finance-import-count ${tone}`; const number = document.createElement('strong'); number.textContent = count.toLocaleString(); const text = document.createElement('span'); text.textContent = label; card.append(number, text); counts.append(card);
    }
    const settings = document.createElement('div'); settings.className = 'finance-import-review-options';
    const duplicateLabel = document.createElement('label'); duplicateLabel.className = 'finance-review-checkbox';
    const duplicateToggle = document.createElement('input'); duplicateToggle.type = 'checkbox'; duplicateToggle.checked = state.keepPossibleDuplicates;
    const duplicateCopy = document.createElement('span'); duplicateCopy.textContent = 'Keep possible duplicates'; duplicateLabel.append(duplicateToggle, duplicateCopy);
    duplicateToggle.addEventListener('change', async () => {
      state.keepPossibleDuplicates = duplicateToggle.checked; state.reviewedPages.clear(); pageReview.checked = false;
      await window.dashboard.reviewFinanceStatementPage({ importId: state.importId, offset: state.preview.previewOffset, acknowledged: false, keepPossibleDuplicates: state.keepPossibleDuplicates }).catch((error) => { hint.textContent = error.message; });
      pageLabel.textContent = pageSummary();
      renderPreviewTable(); updateImportAction();
    });
    const accountNote = document.createElement('span'); accountNote.textContent = `${state.accountLabel ? `Account label: ${state.accountLabel} · ` : ''}${state.mapping.currency === null ? `${state.fallbackCurrency || 'CAD'} fallback` : 'Currency from file'}`;
    settings.append(duplicateLabel, accountNote);
    const tableWrap = document.createElement('div'); tableWrap.className = 'finance-import-preview-table';
    const pageControls = document.createElement('div'); pageControls.className = 'finance-import-page-controls';
    const previousPage = document.createElement('button'); previousPage.type = 'button'; previousPage.className = 'button button-quiet button-small'; previousPage.textContent = 'Previous 100';
    const pageLabel = document.createElement('span');
    const nextPage = document.createElement('button'); nextPage.type = 'button'; nextPage.className = 'button button-quiet button-small'; nextPage.textContent = 'Next 100';
    const pageCount = Math.ceil(state.preview.rowCount / 100);
    const startRow = state.preview.previewRows[0]?.rowNumber || 0;
    const endRow = state.preview.previewRows.at(-1)?.rowNumber || 0;
    const recordStart = state.preview.previewOffset + 1;
    const recordEnd = state.preview.previewOffset + state.preview.previewRows.length;
    const pageSummary = (reviewed = state.reviewedPages.size) => `Records ${recordStart}–${recordEnd} of ${state.preview.rowCount.toLocaleString()} · source lines ${startRow}–${endRow} · reviewed ${reviewed}/${pageCount} pages`;
    pageLabel.textContent = pageSummary();
    previousPage.disabled = !state.preview.hasPreviousPreviewRows; nextPage.disabled = !state.preview.hasMorePreviewRows;
    const loadPreviewPage = async (offset) => {
      previousPage.disabled = true; nextPage.disabled = true;
      try { state.preview = await window.dashboard.previewFinanceStatement({ importId: state.importId, mapping: state.mapping, fallbackCurrency: state.fallbackCurrency, accountLabel: state.accountLabel, offset }); renderPreviewView(); }
      catch (error) { hint.textContent = error.message; previousPage.disabled = false; nextPage.disabled = false; }
    };
    previousPage.addEventListener('click', () => loadPreviewPage(Math.max(0, state.preview.previewOffset - 100)));
    nextPage.addEventListener('click', () => loadPreviewPage(state.preview.previewOffset + 100));
    pageControls.append(previousPage, pageLabel, nextPage);
    const renderPreviewTable = () => {
      tableWrap.replaceChildren(); const table = document.createElement('table');
      const thead = document.createElement('thead'); const headRow = document.createElement('tr');
      for (const titleText of ['Import', 'Row', 'Date', 'Description', 'Category', 'Amount', 'Review']) { const th = document.createElement('th'); th.textContent = titleText; headRow.append(th); }
      thead.append(headRow); table.append(thead); const tbody = document.createElement('tbody');
      for (const row of state.preview.previewRows) {
        const tr = document.createElement('tr');
        const selection = document.createElement('td'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        const defaultIncluded = row.valid && (state.keepPossibleDuplicates || !row.possibleDuplicate);
        if (row.valid) state.rowPossibleDuplicates[row.rowNumber] = row.possibleDuplicate;
        checkbox.checked = Object.hasOwn(state.rowOverrides, row.rowNumber) ? state.rowOverrides[row.rowNumber] : defaultIncluded;
        checkbox.disabled = !row.valid;
        checkbox.addEventListener('change', () => { state.rowOverrides[row.rowNumber] = checkbox.checked; state.reviewedPages.delete(state.preview.previewOffset); pageReview.checked = false; void window.dashboard.reviewFinanceStatementPage({ importId: state.importId, offset: state.preview.previewOffset, acknowledged: false, keepPossibleDuplicates: state.keepPossibleDuplicates }); updateImportAction(); }); selection.append(checkbox); tr.append(selection);
        for (const cellValue of [row.rowNumber, row.date || '—', row.description || (row.raw || []).join(' · '), row.category || '—', row.valid ? `${row.direction === 'income' ? '+' : '−'}${financeCurrency(row.amount, row.currency)}` : '—']) {
          const td = document.createElement('td'); td.textContent = String(cellValue); tr.append(td);
        }
        const stateCell = document.createElement('td'); stateCell.textContent = !row.valid ? row.reason : row.possibleDuplicate ? 'Possible match in this ledger or this file' : 'Ready'; tr.append(stateCell); tbody.append(tr);
      }
      table.append(tbody); tableWrap.append(table);
    };
    const pageReviewLabel = document.createElement('label'); pageReviewLabel.className = 'finance-review-checkbox';
    const pageReview = document.createElement('input'); pageReview.type = 'checkbox'; pageReview.checked = state.reviewedPages.has(state.preview.previewOffset);
    const pageReviewCopy = document.createElement('span'); pageReviewCopy.textContent = 'I reviewed this page, including rows that need attention'; pageReviewLabel.append(pageReview, pageReviewCopy);
    pageReview.addEventListener('change', async () => {
      pageReview.disabled = true;
      try {
        const rowOverrides = Object.fromEntries(state.preview.previewRows.filter((row) => row.valid && Object.hasOwn(state.rowOverrides, row.rowNumber)).map((row) => [row.rowNumber, state.rowOverrides[row.rowNumber]]));
        const result = await window.dashboard.reviewFinanceStatementPage({ importId: state.importId, offset: state.preview.previewOffset, acknowledged: pageReview.checked, keepPossibleDuplicates: state.keepPossibleDuplicates, rowOverrides });
        if (pageReview.checked) state.reviewedPages.add(state.preview.previewOffset); else state.reviewedPages.delete(state.preview.previewOffset);
        pageLabel.textContent = pageSummary(result.reviewedPages);
      } catch (error) { pageReview.checked = false; hint.textContent = error.message; }
      pageReview.disabled = false; updateImportAction();
    });
    const updateImportAction = () => {
      const baseline = state.preview.validCount - (state.keepPossibleDuplicates ? 0 : state.preview.duplicateCount);
      const delta = Object.entries(state.rowOverrides).reduce((sum, [rowNumber, included]) => {
        const isDuplicate = state.rowPossibleDuplicates[rowNumber];
        if (isDuplicate === undefined) return sum;
        const defaultIncluded = state.keepPossibleDuplicates || !isDuplicate;
        return sum + (Number(included) - Number(defaultIncluded));
      }, 0);
      const included = Math.max(0, Math.min(state.preview.validCount, baseline + delta));
      const reviewedAllPages = state.reviewedPages.size >= pageCount;
      nextPage.disabled = !state.preview.hasMorePreviewRows || !state.reviewedPages.has(state.preview.previewOffset);
      importButton.textContent = reviewedAllPages ? `Import ${included} rows` : `Review all pages (${state.reviewedPages.size}/${pageCount})`;
      importButton.disabled = included === 0 || !reviewedAllPages;
    };
    const errorRows = state.preview.previewRows.filter((row) => !row.valid);
    const moreInvalid = state.preview.invalidCount > errorRows.length;
    const hint = document.createElement('p'); hint.className = 'finance-import-review-hint'; hint.textContent = `Possible duplicates start unchecked. Invalid rows are excluded; ${state.preview.invalidCount} row${state.preview.invalidCount === 1 ? '' : 's'} need attention.`;
    content.append(heading, counts, settings, hint, pageControls, tableWrap, pageReviewLabel); renderPreviewTable();
    if (moreInvalid) { const note = document.createElement('p'); note.className = 'finance-import-more-note'; note.textContent = 'Some invalid rows are listed on other pages. Review every page before importing.'; content.append(note); }
    const back = document.createElement('button'); back.className = 'button button-secondary'; back.type = 'button'; back.textContent = 'Change mapping'; back.onclick = renderMappingView;
    const importButton = document.createElement('button'); importButton.className = 'button button-primary'; importButton.type = 'button'; importButton.textContent = 'Import rows';
    setFooter([cancel, back, importButton]); updateImportAction();
    importButton.onclick = async () => {
      importButton.disabled = true; importButton.textContent = 'Saving locally…';
      try {
        const receipt = await window.dashboard.importFinanceStatement({ importId: state.importId, keepPossibleDuplicates: state.keepPossibleDuplicates, rowOverrides: state.rowOverrides, accountLabel: state.accountLabel });
        state.completed = true; state.importId = null; renderReceipt(receipt);
      } catch (error) { importButton.disabled = false; importButton.textContent = 'Try import again'; hint.textContent = error.message; }
    };
  }

  function renderReceipt(receipt) {
    dialog.classList.remove('is-wide');
    content.replaceChildren(); content.className = 'finance-import-dialog-content is-receipt';
    const mark = document.createElement('div'); mark.className = 'finance-import-receipt-mark'; mark.innerHTML = '<i data-lucide="check" class="icon" aria-hidden="true"></i>'; renderIcons(mark);
    const title = document.createElement('h3'); title.textContent = 'Statement imported';
    const summary = document.createElement('p'); summary.textContent = `${receipt.importedCount} transaction${receipt.importedCount === 1 ? '' : 's'} added to your local ledger.`;
    const detail = document.createElement('p'); detail.className = 'dialog-copy'; detail.textContent = `${receipt.skippedDuplicateCount} possible duplicates skipped · ${receipt.excludedCount || 0} rows unchecked · ${receipt.invalidCount} invalid rows left out. Source: ${receipt.filename}.`;
    content.append(mark, title, summary, detail);
    const done = document.createElement('button'); done.className = 'button button-primary'; done.type = 'button'; done.textContent = 'Done'; setFooter([done]);
    done.onclick = async () => {
      if (receipt.currencyCodes?.length && !receipt.currencyCodes.includes(financeCurrencyCode)) { financeCurrencyCode = receipt.currencyCodes[0]; localStorage.setItem('local-dashboard-finance-currency', financeCurrencyCode); }
      const data = await window.dashboard.getPageData('finance'); financeTransactions = data.transactions || []; financeLastImportRun = data.lastImportRun; financeImportWorkflowEnabled = data.importWorkflowEnabled !== false;
      if (currentPage === 'finance') renderFinance(financeTransactions, financeLastImportRun);
      dialog.close();
      if (currentPage === 'workflows') await reloadWorkflows();
    };
  }

  chooseView();
}

function showFinanceTransactionForm() {
  const form = document.createElement('form'); form.className = 'dialog-form';
  form.innerHTML = `<label class="field field-wide">Description<input name="merchant" required maxlength="100" placeholder="e.g. Grocery store"></label>
    <label class="field">Amount<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></label>
    <label class="field">Type<select name="direction"><option value="expense">Expense</option><option value="income">Income</option></select></label>
    <label class="field">Category<select name="category"><option>Groceries</option><option>Dining</option><option>Transport</option><option>Bills</option><option>Home</option><option>Subscriptions</option><option>Health</option><option>Shopping</option><option>Leisure</option><option>Gifts</option><option>Income</option><option>Other</option></select></label>
    <label class="field">Date<input name="occurredAt" type="date" required></label>
    <p class="dialog-copy field-wide">Saved to this device in ${financeCurrencyCode}. This entry is not sent to an online service.</p>`;
  form.elements.occurredAt.value = localDateKey(new Date());
  const cancel = document.createElement('button'); cancel.className = 'button button-secondary'; cancel.type = 'button'; cancel.textContent = 'Cancel';
  const save = document.createElement('button'); save.className = 'button button-primary'; save.type = 'submit'; save.textContent = 'Add transaction';
  const dialog = openDialog('New transaction', form, [cancel, save]); cancel.addEventListener('click', () => dialog.close()); save.addEventListener('click', () => form.requestSubmit());
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); save.disabled = true;
    try { await window.dashboard.createFinanceTransaction({ merchant: form.elements.merchant.value, amount: form.elements.amount.value, direction: form.elements.direction.value, category: form.elements.category.value, occurredAt: form.elements.occurredAt.value, currency: financeCurrencyCode }); dialog.close(); const data = await window.dashboard.getPageData('finance'); financeTransactions = data.transactions || []; financeLastImportRun = data.lastImportRun; renderFinance(financeTransactions, financeLastImportRun); }
    catch (error) { window.alert(error.message); save.disabled = false; }
  });
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeHealthSettings(settings = {}) {
  settings ||= {};
  return {
    weightUnit: settings.weightUnit === 'kg' ? 'kg' : 'lb',
    dateRange: ['3m', '6m', '18m', 'all'].includes(settings.dateRange) ? settings.dateRange : '18m',
  };
}

function bindHealthSettingsForm(form) {
  const status = pageRoot.querySelector('#health-settings-status');
  const weightUnit = form.elements.weightUnit;
  const dateRange = form.elements.dateRange;
  void window.dashboard.getPluginSetting('health', 'dashboard').then((saved) => {
    if (currentPage !== 'plugins/health/settings') return;
    const settings = normalizeHealthSettings(saved);
    weightUnit.value = settings.weightUnit;
    dateRange.value = settings.dateRange;
  }).catch((error) => { if (status) status.textContent = `Could not load settings: ${error.message}`; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const settings = normalizeHealthSettings({ weightUnit: weightUnit.value, dateRange: dateRange.value });
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await window.dashboard.setPluginSetting('health', 'dashboard', settings);
      healthSettings = settings;
      if (status) status.textContent = 'Settings saved on this device.';
    } catch (error) { if (status) status.textContent = `Could not save settings: ${error.message}`; }
    finally { button.disabled = false; }
  });
}

function metricDate(record) {
  const date = new Date(record.occurred_at);
  return Number.isNaN(date.getTime()) ? null : date;
}

function healthNumber(value) {
  if (value == null || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function sortedMetrics(records = []) {
  return records.map((record) => ({ ...record, _date: metricDate(record) }))
    .filter((record) => record._date)
    .sort((a, b) => a._date - b._date);
}

function healthDateLabel(date, includeYear = false) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(includeYear ? { year: '2-digit' } : {}) }).format(date);
}

function healthRangeStart(range, newestDate = new Date()) {
  if (range === 'all') return null;
  const date = new Date(newestDate);
  date.setMonth(date.getMonth() - ({ '3m': 3, '6m': 6, '18m': 18 }[range] || 18));
  return date;
}

function inHealthRange(records, range, anchorDate) {
  if (!records.length) return [];
  const from = healthRangeStart(range, anchorDate || records.at(-1)._date);
  return from ? records.filter((record) => record._date >= from) : records;
}

function rollingAverage(records, readValue, dayWindow = 28, minimumSamples = 2) {
  return records.map((record, index) => {
    const from = record._date.getTime() - dayWindow * 86400000;
    const values = records.slice(0, index + 1)
      .filter((item) => item._date.getTime() >= from)
      .map(readValue).filter(Number.isFinite);
    return values.length >= minimumSamples ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  });
}

function clockHour(date) { return date.getHours() + date.getMinutes() / 60; }
function overnightClockHour(hour) { return hour < 12 ? hour + 24 : hour; }
function formatHealthClock(value) {
  const hour = ((Math.round(value) % 24) + 24) % 24;
  return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
}
function formatHealthDuration(value) {
  if (!Number.isFinite(value)) return '—';
  const minutes = Math.round(value * 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function healthChartBase() {
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return {
    token,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onResize(chart, size) {
        const compact = size.width < 260;
        chart.options.plugins.legend.labels.padding = compact ? 8 : 14;
        for (const axis of Object.values(chart.options.scales)) {
          if (!axis.title) continue;
          axis.title.display = !compact && (axis === chart.options.scales.y1 ? axis.display : true);
          if (axis.ticks) axis.ticks.padding = compact ? 3 : 7;
        }
      },
      interaction: { intersect: false, mode: 'index', axis: 'x' },
      plugins: {
        legend: { display: true, position: 'top', align: 'start', labels: { color: token('--chart-tick'), usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 14, font: { family: 'Inter, system-ui, sans-serif', size: 11 } } },
        tooltip: { backgroundColor: token('--chart-tooltip'), padding: 10, cornerRadius: 7, titleFont: { family: 'Inter, system-ui, sans-serif', size: 11, weight: '600' }, bodyFont: { family: 'Inter, system-ui, sans-serif', size: 10 } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, afterBuildTicks(axis) { const ticks = axis.ticks; const limit = axis.chart.width < 260 ? 3 : axis.chart.width < 600 ? 5 : 7; if (ticks.length <= limit) return; const selected = new Set([0, ticks.length - 1]); for (let index = 1; index < limit - 1; index += 1) selected.add(Math.round(index * (ticks.length - 1) / (limit - 1))); axis.ticks = [...selected].sort((a, b) => a - b).map((index) => ticks[index]); }, ticks: { color: token('--chart-tick'), maxTicksLimit: 7, maxRotation: 0, autoSkip: true, includeBounds: true, font: { family: 'Inter, system-ui, sans-serif', size: 10 }, callback(value) { const label = this.getLabelForValue(value); return this.chart.width < 600 ? label.replace(/, \d{2}$/, '') : label; } } },
        y: { grid: { color: token('--chart-grid') }, border: { display: false }, ticks: { color: token('--chart-tick'), padding: 7, font: { family: 'Inter, system-ui, sans-serif', size: 10 } } },
      },
    },
  };
}

function renderHealth(data) {
  const sleepAll = sortedMetrics(data.sleep || []);
  const weightAll = sortedMetrics(data.weight || []).filter((record) => Number.isFinite(healthNumber(record.kilograms)));
  const rangeAnchor = [...sleepAll, ...weightAll].sort((a, b) => a._date - b._date).at(-1)?._date || new Date();
  const sleep = inHealthRange(sleepAll, healthSettings.dateRange, rangeAnchor);
  const weight = inHealthRange(weightAll, healthSettings.dateRange, rangeAnchor);
  const unit = healthSettings.weightUnit;
  const toDisplayWeight = (kilograms) => unit === 'lb' ? kilograms * 2.2046226218 : kilograms;
  const latestWeight = weightAll.at(-1);
  const previousWeight = weightAll[0];
  const latestBodyFat = [...weightAll].reverse().find((record) => Number.isFinite(healthNumber(record.bodyFatPercent)));
  const sleepWithDuration = sleepAll.filter((record) => Number.isFinite(healthNumber(record.durationHours)));
  const recentSleep = sleepWithDuration.slice(-7);
  const averageSleep = recentSleep.length ? recentSleep.reduce((sum, record) => sum + healthNumber(record.durationHours), 0) / recentSleep.length : null;
  const efficiencies = recentSleep.map((record) => healthNumber(record.efficiency ?? record.sleepEfficiency)).filter(Number.isFinite);
  const averageEfficiency = efficiencies.length ? efficiencies.reduce((sum, value) => sum + value, 0) / efficiencies.length : null;
  const weightValue = pageRoot.querySelector('#health-weight-value');
  const fatValue = pageRoot.querySelector('#health-fat-value');
  if (weightValue) weightValue.textContent = latestWeight ? `${toDisplayWeight(Number(latestWeight.kilograms)).toFixed(1)} ${unit}` : '—';
  if (fatValue) fatValue.textContent = latestBodyFat ? `${Number(latestBodyFat.bodyFatPercent).toFixed(1)}%` : '—';
  const weightDelta = latestWeight && previousWeight ? toDisplayWeight(Number(latestWeight.kilograms) - Number(previousWeight.kilograms)) : null;
  pageRoot.querySelector('#health-weight-note').textContent = latestWeight
    ? `${healthDateLabel(latestWeight._date)} · ${weightAll.length} readings · ${weightDelta == null ? 'baseline' : `${weightDelta > 0 ? '+' : ''}${weightDelta.toFixed(1)} ${unit} since ${healthDateLabel(previousWeight._date)}`}`
    : 'No weight measurements yet';
  pageRoot.querySelector('#health-fat-note').textContent = latestBodyFat ? `Latest body-fat reading · ${healthDateLabel(latestBodyFat._date)}` : 'No body-fat readings yet';
  pageRoot.querySelector('#health-sleep-value').textContent = formatHealthDuration(averageSleep);
  pageRoot.querySelector('#health-sleep-note').textContent = recentSleep.length ? `Average of last ${recentSleep.length} recorded nights` : 'No sleep records yet';
  pageRoot.querySelector('#health-efficiency-value').textContent = averageEfficiency == null ? '—' : `${averageEfficiency.toFixed(1)}%`;
  pageRoot.querySelector('#health-efficiency-note').textContent = efficiencies.length ? `Average of ${efficiencies.length} recent efficiency readings` : 'No efficiency data in this source';
  const rangeCaption = pageRoot.querySelector('#health-range-caption');
  if (rangeCaption) {
    const from = healthRangeStart(healthSettings.dateRange, rangeAnchor);
    rangeCaption.textContent = from ? `${healthDateLabel(from)} – ${healthDateLabel(rangeAnchor, true)}` : 'All recorded history';
  }
  const selectedRange = healthSettings.dateRange;
  pageRoot.querySelectorAll('[data-health-range]').forEach((button) => {
    const active = button.dataset.healthRange === selectedRange;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const weightCount = pageRoot.querySelector('.health-story-weight .health-chart-source');
  const sleepCount = pageRoot.querySelector('#sleep-timing-chart')?.closest('.health-story')?.querySelector('.health-chart-source');
  const sleepQualityCount = pageRoot.querySelector('#sleep-quality-chart')?.closest('.health-story')?.querySelector('.health-chart-source');
  if (weightCount) weightCount.textContent = `${weight.length} measurements${weight.length ? ` · ${healthDateLabel(weight[0]._date, true)} – ${healthDateLabel(weight.at(-1)._date, true)}` : ''}`;
  const sleepSource = `${sleep.length} logged nights${sleep.length ? ` · ${healthDateLabel(sleep[0]._date, true)} – ${healthDateLabel(sleep.at(-1)._date, true)}` : ''}`;
  if (sleepCount) sleepCount.textContent = sleepSource;
  if (sleepQualityCount) sleepQualityCount.textContent = sleepSource;
  renderHealthCharts(sleep, weight, toDisplayWeight, unit);
}

function renderHealthCharts(sleepRecords, weightRecords, toDisplayWeight, unit) {
  pageRoot.querySelectorAll('.health-chart-container canvas').forEach((canvas) => { canvas.hidden = false; canvas.parentElement.querySelector('.health-chart-empty')?.remove(); });
  const { options, token } = healthChartBase();
  const grid = token('--chart-grid');
  const tick = token('--chart-tick');
  const surface = token('--color-surface');
  const green = token('--color-primary');
  const blue = token('--chart-weight');
  const red = '#df6d58';
  const orange = '#d38b39';
  const dateLabels = (records) => records.map((record) => healthDateLabel(record._date, true));
  const sleepTimeline = (records, values) => {
    if (!records.length) return { labels: [], data: [] };
    const first = new Date(records[0]._date);
    const last = new Date(records.at(-1)._date);
    first.setHours(0, 0, 0, 0);
    last.setHours(0, 0, 0, 0);
    const byDay = new Map(records.map((record, index) => [localDateKey(record._date), values[index]]));
    const labels = [];
    const data = [];
    for (const day = new Date(first); day <= last; day.setDate(day.getDate() + 1)) {
      labels.push(healthDateLabel(day));
      data.push(byDay.has(localDateKey(day)) ? byDay.get(localDateKey(day)) : null);
    }
    return { labels, data };
  };
  const weightCanvas = pageRoot.querySelector('#weight-chart');
  const weightModeSwitch = pageRoot.querySelector('.health-mobile-metric-switch');
  if (weightModeSwitch) weightModeSwitch.hidden = !weightRecords.length;
  if (weightCanvas && weightRecords.length) {
    const labels = dateLabels(weightRecords);
    const kilograms = (record) => healthNumber(record.kilograms);
    const bodyFat = (record) => healthNumber(record.bodyFatPercent);
    const weightData = weightRecords.map(kilograms);
    const fatData = weightRecords.map((record) => {
      const value = bodyFat(record);
      return Number.isFinite(value) ? value : null;
    });
    const avgWeight = rollingAverage(weightRecords, (record) => toDisplayWeight(kilograms(record)));
    const avgFat = rollingAverage(weightRecords, bodyFat);
    const datasets = [
      { label: `Weight (${unit})`, data: weightData.map(toDisplayWeight), yAxisID: 'y', showLine: false, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: blue, pointBorderColor: surface, pointBorderWidth: 1.25 },
      { label: '28-day weight trend', data: avgWeight, yAxisID: 'y', borderColor: blue, borderWidth: 2.2, pointRadius: 0, tension: 0.28, spanGaps: false },
      { label: 'Body fat (%)', data: fatData, yAxisID: 'y1', showLine: false, pointStyle: 'triangle', pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: 'transparent', pointBorderColor: red, pointBorderWidth: 1.75 },
      { label: '28-day body-fat trend', data: avgFat, yAxisID: 'y1', borderColor: red, borderWidth: 2.2, borderDash: [5, 4], pointRadius: 0, tension: 0.28, spanGaps: false },
    ];
    const weightChart = new Chart(weightCanvas, {
      type: 'line', data: { labels, datasets },
      options: { ...options, plugins: { ...options.plugins, legend: { ...options.plugins.legend, labels: { ...options.plugins.legend.labels, filter: (item) => !item.hidden } }, tooltip: { ...options.plugins.tooltip, callbacks: {
        label(context) { const value = context.parsed.y; return ` ${context.dataset.label.startsWith('Weight') ? `${value.toFixed(1)} ${unit}` : `${value.toFixed(1)}%`}`; },
      } } }, scales: {
        ...options.scales,
        y: { ...options.scales.y, title: { display: true, text: `Weight (${unit})`, color: blue, font: { size: 10, weight: '600' } }, ticks: { ...options.scales.y.ticks, color: blue } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, border: { display: false }, title: { display: true, text: 'Body fat (%)', color: red, font: { size: 10, weight: '600' } }, ticks: { color: red, padding: 7, font: { size: 9 }, callback: (value) => `${value}%` } },
      } },
    });
    activeCharts.push(weightChart);
    const weightModeButtons = pageRoot.querySelectorAll('[data-health-weight-mode]');
    const setWeightMode = (mode) => {
      const bodyFatOnly = mode === 'body-fat';
      const both = mode === 'both';
      weightChart.data.datasets.forEach((dataset, index) => {
        const isWeight = index < 2;
        weightChart.setDatasetVisibility(index, bodyFatOnly ? !isWeight : both || isWeight);
        dataset.yAxisID = !isWeight && bodyFatOnly ? 'y' : isWeight ? 'y' : 'y1';
      });
      const leftAxis = weightChart.options.scales.y;
      const rightAxis = weightChart.options.scales.y1;
      const compactChart = weightCanvas.parentElement.getBoundingClientRect().width < 260;
      leftAxis.title.text = bodyFatOnly ? 'Body fat (%)' : `Weight (${unit})`;
      leftAxis.title.display = !compactChart;
      leftAxis.title.color = bodyFatOnly ? red : blue;
      leftAxis.ticks.color = bodyFatOnly ? red : blue;
      leftAxis.ticks.callback = bodyFatOnly ? (value) => `${value}%` : undefined;
      rightAxis.display = both;
      rightAxis.title.display = both && !compactChart;
      rightAxis.ticks.display = both;
      weightCanvas.setAttribute('aria-label', bodyFatOnly
        ? 'Body fat percentage measurements and 28-day trend over time'
        : both
          ? 'Weight and body fat measurements over time, with 28-day rolling trends'
          : `Weight measurements in ${unit} and 28-day trend over time`);
      weightModeButtons.forEach((button) => {
        const active = button.dataset.healthWeightMode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      weightChart.update();
    };
    const chartDensityObserver = new ResizeObserver(() => {
      const compactChart = weightCanvas.parentElement.getBoundingClientRect().width < 260;
      const both = weightChart.data.datasets.some((dataset, index) => index >= 2 && weightChart.isDatasetVisible(index));
      weightChart.options.scales.y.title.display = !compactChart;
      weightChart.options.scales.y1.title.display = both && !compactChart;
      weightChart.options.plugins.legend.labels.padding = compactChart ? 8 : 14;
      weightChart.update('none');
    });
    chartDensityObserver.observe(weightCanvas.parentElement);
    const modeButtonHandlers = [];
    weightModeButtons.forEach((button) => {
      const handler = () => setWeightMode(button.dataset.healthWeightMode);
      button.addEventListener('click', handler);
      modeButtonHandlers.push([button, handler]);
    });
    const compactWeightView = window.matchMedia('(max-width: 520px)');
    const updateCompactWeightView = (event) => setWeightMode(event.matches ? 'weight' : 'both');
    updateCompactWeightView(compactWeightView);
    compactWeightView.addEventListener('change', updateCompactWeightView);
    healthWeightModeCleanup = () => {
      chartDensityObserver.disconnect();
      compactWeightView.removeEventListener('change', updateCompactWeightView);
      modeButtonHandlers.forEach(([button, handler]) => button.removeEventListener('click', handler));
    };
  } else if (weightCanvas) {
    showHealthChartEmpty(weightCanvas, 'No weight readings in this date range.');
  }

  const compositionCanvas = pageRoot.querySelector('#composition-chart');
  if (compositionCanvas && weightRecords.length > 1) {
    const baseline = weightRecords.find((record) => Number.isFinite(healthNumber(record.kilograms)) && healthNumber(record.kilograms) > 0 && Number.isFinite(healthNumber(record.bodyFatPercent)) && healthNumber(record.bodyFatPercent) > 0 && healthNumber(record.bodyFatPercent) < 100);
    if (baseline) {
      const baseWeight = Number(baseline.kilograms);
      const baseFatMass = baseWeight * Number(baseline.bodyFatPercent) / 100;
      const baseLeanMass = baseWeight - baseFatMass;
      const fatChange = weightRecords.map((record) => {
        if (!Number.isFinite(healthNumber(record.bodyFatPercent)) || !Number.isFinite(healthNumber(record.kilograms))) return null;
        const mass = healthNumber(record.kilograms) * healthNumber(record.bodyFatPercent) / 100;
        return ((mass - baseFatMass) / baseFatMass) * 100;
      });
      const leanChange = weightRecords.map((record) => {
        if (!Number.isFinite(healthNumber(record.bodyFatPercent)) || !Number.isFinite(healthNumber(record.kilograms))) return null;
        const mass = healthNumber(record.kilograms) * (1 - healthNumber(record.bodyFatPercent) / 100);
        return ((mass - baseLeanMass) / baseLeanMass) * 100;
      });
      const compositionSource = pageRoot.querySelector('#composition-chart')?.closest('.health-story')?.querySelector('.health-chart-source');
      if (compositionSource) compositionSource.textContent = `Estimated · baseline ${healthDateLabel(baseline._date, true)}`;
      activeCharts.push(new Chart(compositionCanvas, {
        type: 'line', data: { labels: dateLabels(weightRecords), datasets: [
          { label: 'Estimated fat mass change', data: fatChange, borderColor: red, backgroundColor: 'rgba(223,109,88,.09)', fill: false, borderWidth: 1.8, pointRadius: 1.8, pointHoverRadius: 4, tension: 0.24, spanGaps: false },
          { label: 'Estimated lean mass change', data: leanChange, borderColor: green, backgroundColor: 'rgba(57,117,90,.08)', fill: false, borderWidth: 1.8, pointRadius: 1.8, pointHoverRadius: 4, tension: 0.24, spanGaps: false },
        ] },
        options: { ...options, plugins: { ...options.plugins, tooltip: { ...options.plugins.tooltip, callbacks: { label: (context) => ` ${context.dataset.label}: ${context.parsed.y.toFixed(1)}%` } } }, scales: { ...options.scales, y: { ...options.scales.y, ticks: { ...options.scales.y.ticks, callback: (value) => `${value}%` } } } },
      }));
    } else showHealthChartEmpty(compositionCanvas, 'Body-fat measurements are needed to estimate fat and lean mass.');
  } else if (compositionCanvas) showHealthChartEmpty(compositionCanvas, 'Add at least two weight and body-fat readings to see composition change.');

  const timingCanvas = pageRoot.querySelector('#sleep-timing-chart');
  if (timingCanvas && sleepRecords.length) {
    const bedtime = [];
    const wake = [];
    for (const record of sleepRecords) {
      const start = metricDate(record);
      const duration = healthNumber(record.durationHours);
      if (Number.isFinite(healthNumber(record.bedtimeHour))) {
        const value = healthNumber(record.bedtimeHour);
        bedtime.push(overnightClockHour(value));
        const wakeHour = healthNumber(record.wakeHour);
        wake.push(Number.isFinite(wakeHour) ? overnightClockHour(wakeHour < value ? wakeHour + 24 : wakeHour) : Number.isFinite(duration) && duration > 0 ? overnightClockHour(value) + duration : null);
      } else if (start && Number.isFinite(duration) && duration > 0) {
        const startHour = clockHour(start);
        bedtime.push(overnightClockHour(startHour));
        wake.push(overnightClockHour(startHour) + duration);
      } else { bedtime.push(null); wake.push(null); }
    }
    const bedtimeSeries = sleepTimeline(sleepRecords, bedtime);
    const wakeSeries = sleepTimeline(sleepRecords, wake);
    activeCharts.push(new Chart(timingCanvas, {
      type: 'line', data: { labels: bedtimeSeries.labels, datasets: [
        { label: 'Bedtime', data: bedtimeSeries.data, borderColor: blue, backgroundColor: 'rgba(83,111,161,.16)', borderWidth: 2, pointRadius: 3, pointHoverRadius: 4, tension: 0.18, spanGaps: false, fill: { target: '+1' } },
        { label: 'Wake time', data: wakeSeries.data, borderColor: orange, backgroundColor: 'rgba(211,139,57,.14)', borderWidth: 2, pointRadius: 3, pointHoverRadius: 4, tension: 0.18, spanGaps: false },
      ] },
      options: { ...options, scales: { ...options.scales, y: { min: 21, max: 34, grid: { color: grid }, ticks: { color: tick, stepSize: 2, callback: formatHealthClock } } }, plugins: { ...options.plugins, tooltip: { ...options.plugins.tooltip, callbacks: { label: (context) => ` ${context.dataset.label}: ${formatHealthClock(context.parsed.y)}` } } } },
    }));
  } else if (timingCanvas) showHealthChartEmpty(timingCanvas, 'No sleep timing data in this date range.');

  const qualityCanvas = pageRoot.querySelector('#sleep-quality-chart');
  if (qualityCanvas && sleepRecords.length) {
    const duration = sleepRecords.map((record) => {
      const value = healthNumber(record.durationHours);
      return Number.isFinite(value) ? value : null;
    });
    const efficiency = sleepRecords.map((record) => {
      const value = healthNumber(record.efficiency ?? record.sleepEfficiency);
      return Number.isFinite(value) ? value : null;
    });
    const avgDuration = rollingAverage(sleepRecords, (record) => healthNumber(record.durationHours), 7, 2);
    const avgEfficiency = rollingAverage(sleepRecords, (record) => healthNumber(record.efficiency ?? record.sleepEfficiency), 7, 2);
    const durationSeries = sleepTimeline(sleepRecords, duration);
    const avgDurationSeries = sleepTimeline(sleepRecords, avgDuration);
    const efficiencySeries = sleepTimeline(sleepRecords, efficiency);
    const avgEfficiencySeries = sleepTimeline(sleepRecords, avgEfficiency);
    const referenceSeries = sleepTimeline(sleepRecords, sleepRecords.map(() => 7));
    const efficiencyReferenceSeries = sleepTimeline(sleepRecords, sleepRecords.map(() => 95));
    activeCharts.push(new Chart(qualityCanvas, {
      type: 'line', data: { labels: durationSeries.labels, datasets: [
        { label: 'Nightly duration', data: durationSeries.data, yAxisID: 'y', showLine: false, pointRadius: 3.2, pointHoverRadius: 4, pointBackgroundColor: blue, pointBorderColor: surface, pointBorderWidth: 1 },
        { label: '7-night duration average', data: avgDurationSeries.data, yAxisID: 'y', borderColor: blue, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: .25, spanGaps: false },
        { label: 'Nightly efficiency', data: efficiencySeries.data, yAxisID: 'y1', showLine: false, pointRadius: 3.2, pointHoverRadius: 4, pointBackgroundColor: green, pointBorderColor: surface, pointBorderWidth: 1 },
        { label: '7-night efficiency average', data: avgEfficiencySeries.data, yAxisID: 'y1', borderColor: green, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: .25, spanGaps: false },
        { label: '7 h reference', data: referenceSeries.data.map((value) => value == null ? null : 7), yAxisID: 'y', borderColor: blue, borderDash: [2, 5], borderWidth: 1.1, pointRadius: 0, spanGaps: true },
        { label: '95% reference', data: efficiencyReferenceSeries.data.map((value) => value == null ? null : 95), yAxisID: 'y1', borderColor: green, borderDash: [2, 5], borderWidth: 1.1, pointRadius: 0, spanGaps: true },
      ] },
      options: { ...options, scales: {
        ...options.scales,
        y: { ...options.scales.y, min: 3, max: 10, ticks: { ...options.scales.y.ticks, stepSize: 1, callback: (value) => `${value} h` } },
        y1: { position: 'right', min: 70, max: 100, grid: { drawOnChartArea: false }, border: { display: false }, ticks: { color: green, font: { size: 9 }, callback: (value) => `${value}%` } },
      }, plugins: { ...options.plugins, tooltip: { ...options.plugins.tooltip, callbacks: { label(context) { return ` ${context.dataset.label}: ${context.dataset.label.toLowerCase().includes('efficiency') ? `${context.parsed.y.toFixed(1)}%` : `${context.parsed.y.toFixed(1)} h`}`; } } } } },
    }));
  } else if (qualityCanvas) showHealthChartEmpty(qualityCanvas, 'No sleep duration data in this date range.');
}

function showHealthChartEmpty(canvas, message) {
  const container = canvas.parentElement;
  canvas.hidden = true;
  let empty = container.querySelector('.health-chart-empty');
  if (!empty) { empty = document.createElement('p'); empty.className = 'health-chart-empty'; container.append(empty); }
  empty.textContent = message;
}

renderIcons(document.querySelector('.sidebar'));
void loadPluginNavigation();

function routeFromHash() {
  const [requestedPage, queryString = ''] = (window.location.hash.slice(1) || 'overview').split('?');
  if (!Object.hasOwn(pageTemplates, requestedPage)) {
    window.history.replaceState(null, '', '#overview');
    renderPage('overview');
    return;
  }
  if (requestedPage === 'integrations') {
    const params = new URLSearchParams(queryString);
    integrationCategory = params.get('category') || '';
    integrationSearch = params.get('q') || '';
  } else {
    integrationCategory = '';
    integrationSearch = '';
  }
  if (currentPage === requestedPage) {
    if (requestedPage === 'integrations') void hydratePage('integrations');
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
