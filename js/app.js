// app.js
// Главный модуль SPA для графика смен L1/L2
// Чистый vanilla JS.

import { config, getConfigValue } from "./config.js";
import { createGraphClient } from "./api/graphClient.js";
import { createPyrusClient } from "./api/pyrusClient.js";
import { createMembersService } from "./services/membersService.js";
import { createCatalogsService } from "./services/catalogsService.js";
import { createVacationsService } from "./services/vacationsService.js";
import { createScheduleService } from "./services/scheduleService.js";
import { createProdCalendarService } from "./services/prodCalendarService.js";


/**
 * Основные сущности:
 * - Авторизация через n8n /graph (type: "auth")
 * - Pyrus API через n8n /graph (type: "pyrus_api")
 * - Кеширование данных смен в памяти
 * - UI: таблица, ховер строки, анимация ячеек, компактный поповер смены
 * - Система прав доступа: edit/view для L1 и L2
 */
// Единый источник истины — нормализованный config.
// window.APP_CONFIG оставляем только как отладочный дамп в config.js, без чтения здесь.

const GRAPH_HOOK_URL = getConfigValue("graphHookUrl", { required: true });

const MAX_DAYS_IN_MONTH = 31;

// Бизнес-часовой пояс (по умолчанию GMT+4)
const TIMEZONE_OFFSET_MIN = getConfigValue("timezone.localOffsetMin", {
  defaultValue: 4 * 60,
  required: true,
}); // GMT+4



// -----------------------------
// Конфиг вкладок (линий)
// -----------------------------
const LINE_KEYS_IN_UI_ORDER = config.ui.lines.order;

const LINE_LABELS = config.ui.lines.labels;

// Жёсткая привязка department_id -> вкладка
const LINE_DEPT_IDS = config.departments.byLine;

// Руководители/учредители (всегда сверху во "ВСЕ")
const TOP_MANAGEMENT_IDS = config.management.topManagementIds; // Лузин, Сухачев

// Pyrus: значение каталога "Линия/Отдел" (field id=1) в форме явок
const PYRUS_LINE_ITEM_ID = config.pyrusLineItemIdByLine;


function resolvePyrusLineItemIdByDepartmentId(deptId) {
  if (deptId == null) return null;
  if (LINE_DEPT_IDS.L2.includes(deptId)) return PYRUS_LINE_ITEM_ID.L2;
  if (LINE_DEPT_IDS.L1.includes(deptId)) return PYRUS_LINE_ITEM_ID.L1;
  if (LINE_DEPT_IDS.OV.includes(deptId)) return PYRUS_LINE_ITEM_ID.OV;
  if (LINE_DEPT_IDS.OU.includes(deptId)) return PYRUS_LINE_ITEM_ID.OU;
  if (LINE_DEPT_IDS.AI.includes(deptId)) return PYRUS_LINE_ITEM_ID.AI;
  if (LINE_DEPT_IDS.OP.includes(deptId)) return PYRUS_LINE_ITEM_ID.OP;
  return null;
}

// Порядок групп (department_id) для сортировки внутри вкладок
const DEPT_ORDER_BY_LINE = {
  L2: config.departments.orderByLine.L2,
  OP: config.departments.orderByLine.OP,
};

const PYRUS_CATALOG_IDS = config.pyrus.catalogs;

const PYRUS_FORM_IDS = config.pyrus.forms;

const PYRUS_FIELD_IDS = config.pyrus.fields;

const LINE_PERMISSION_KEYS = ["ALL", "OP", "OV", "OU", "AI", "L1", "L2"];

const graphClient = createGraphClient({ graphHookUrl: GRAPH_HOOK_URL });
const pyrusClient = createPyrusClient({ graphClient });
const membersService = createMembersService({ pyrusClient });
const catalogsService = createCatalogsService({ pyrusClient });
const vacationsService = createVacationsService({
  pyrusClient,
  formId: PYRUS_FORM_IDS.otpusk,
  fieldIds: PYRUS_FIELD_IDS.otpusk,
  timezoneOffsetMin: TIMEZONE_OFFSET_MIN,
});
const scheduleService = createScheduleService({
  pyrusClient,
  formId: PYRUS_FORM_IDS.smeni,
});
const prodCalendarService = createProdCalendarService({ config });

const ROLE_MATRIX_BY_LINE = config.auth?.rolePermissions || null;

function buildDefaultPermissions() {
  const permissions = {};
  for (const key of LINE_PERMISSION_KEYS) {
    permissions[key] = "view";
  }
  return permissions;
}

function normalizePermissions(rawPermissions) {
  const permissions = buildDefaultPermissions();
  if (!rawPermissions || typeof rawPermissions !== "object") return permissions;

  for (const key of LINE_PERMISSION_KEYS) {
    const fallback = rawPermissions.ALL || "view";
    const value = rawPermissions[key] || fallback;
    permissions[key] = value === "edit" ? "edit" : "view";
  }

  return permissions;
}

function resolvePermissionsFromRoles(roles, configMatrix) {
  const permissions = buildDefaultPermissions();
  const matrix = configMatrix && typeof configMatrix === "object" ? configMatrix : null;
  const normalizedRoles = Array.isArray(roles)
    ? roles.map((role) => String(role).trim()).filter(Boolean)
    : [];

  if (!matrix || normalizedRoles.length === 0) return permissions;

  for (const key of LINE_PERMISSION_KEYS) {
    const allowedRoles = Array.isArray(matrix[key]) ? matrix[key] : [];
    const hasRole = allowedRoles.some((role) => normalizedRoles.includes(String(role)));
    if (hasRole) permissions[key] = "edit";
  }

  return permissions;
}


// -----------------------------
// Глобальное состояние
// -----------------------------

const state = {
  auth: {
    user: null,
    roles: null,
    memberId: null,
    permissions: {
      ALL: "view",
      OP: "view",
      OV: "view",
      OU: "view",
      AI: "view",
      L1: "view",
      L2: "view",
    },
  },
  ui: {
    currentLine: "ALL",
    theme: "dark",
    isScheduleCached: false,
    quickPanelBound: false,
  },
  quickMode: {
    enabled: false,
    templateId: null,
    timeFrom: "",
    timeTo: "",
    amount: "",
  },
  employeesByLine: {
    ALL: [],
    OP: [],
    OV: [],
    L1: [],
    L2: [],
    AI: [],
    OU: [],
  },
  shiftTemplatesByLine: {
    ALL: [],
    OP: [],
    OV: [],
    L1: [],
    L2: [],
    AI: [],
    OU: [],
  },
  scheduleByLine: {
    ALL: { monthKey: null, days: [], rows: [] },
    OP: { monthKey: null, days: [], rows: [] },
    OV: { monthKey: null, days: [], rows: [] },
    L1: { monthKey: null, days: [], rows: [] },
    L2: { monthKey: null, days: [], rows: [] },
    AI: { monthKey: null, days: [], rows: [] },
    OU: { monthKey: null, days: [], rows: [] },
  },
  originalScheduleByLine: {
    L1: { monthKey: null, days: [], rows: [] },
    L2: { monthKey: null, days: [], rows: [] },
  },
  localChanges: {},
  changeHistory: [],
  monthMeta: {
    year: null,
    monthIndex: null,
  },
  vacationsByEmployee: {},
  employeeFiltersByLine: {
    ALL: [],
    OP: [],
    OV: [],
    L1: [],
    L2: [],
    AI: [],
    OU: [],
  },
};

const scheduleCacheByLine = {
  L1: Object.create(null),
  L2: Object.create(null),
};

const DEFAULT_AUTH_PERMISSIONS = {
  ALL: "view",
  OP: "view",
  OV: "view",
  OU: "view",
  AI: "view",
  L1: "view",
  L2: "view",
};

const AUTH_PERMISSION_KEYS = Object.keys(DEFAULT_AUTH_PERMISSIONS);

const membersByEmail = new Map();

const STORAGE_KEYS = config.storage.keys;

const CALENDAR_THEME_VAR_MAP = {
  tableHeaderDayoffBg: "--table-header-dayoff-bg",
  tableHeaderPreholidayBg: "--table-header-preholiday-bg",
  calendarHolidayBg: "--calendar-holiday-bg",
  calendarHolidayBorder: "--calendar-holiday-border",
  calendarWeekendBg: "--calendar-weekend-bg",
  calendarPreholidayBg: "--calendar-preholiday-bg",
  calendarPreholidayDash: "--calendar-preholiday-dash",
  weekendBg: "--weekend-bg",
  weekendStrong: "--weekend-strong",
};

const CALENDAR_INDICATOR_VAR_MAP = {
  birthdayBg: "--indicator-birthday-bg",
  birthdayText: "--indicator-birthday-text",
};

function applyThemeConfigVariables() {
  const indicators = config.calendar?.indicators ?? {};
  const rootStyle = document.documentElement.style;

  for (const [key, cssVar] of Object.entries(CALENDAR_INDICATOR_VAR_MAP)) {
    const value = indicators[key];
    if (typeof value === "string") {
      rootStyle.setProperty(cssVar, value);
    }
  }
}


function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function updateCurrentUserLabel(login) {
  if (!currentUserLabelEl) return;
  const name = state.auth.user?.name || "";
  currentUserLabelEl.textContent = name || (login || state.auth.user?.login || "").trim();
}

function normalizeAuthUser(rawUser, overrides = {}) {
  if (!rawUser && !overrides.login && !overrides.name && overrides.id == null && !overrides.roles) {
    return null;
  }
  const source = rawUser || {};
  const id = source.id ?? overrides.id ?? null;
  const login = String(source.login ?? overrides.login ?? "").trim();
  let name = String(source.name ?? overrides.name ?? "").trim();
  if (!name) {
    const firstName = source.first_name ?? source.firstName ?? overrides.first_name ?? overrides.firstName ?? "";
    const lastName = source.last_name ?? source.lastName ?? overrides.last_name ?? overrides.lastName ?? "";
    name = `${lastName} ${firstName}`.trim();
  }
  let rolesRaw = source.roles ?? overrides.roles ?? [];
  if (!Array.isArray(rolesRaw)) rolesRaw = [];
  const roles = rolesRaw.map((role) => String(role)).filter(Boolean);
  return {
    id,
    login,
    name,
    roles,
  };
}

function normalizeAuthPermissions(permissions) {
  const normalized = { ...DEFAULT_AUTH_PERMISSIONS };
  if (permissions && typeof permissions === "object") {
    for (const [key, value] of Object.entries(permissions)) {
      if (value) normalized[key] = value;
    }
  }
  const fallback = normalized.ALL || DEFAULT_AUTH_PERMISSIONS.ALL;
  for (const key of AUTH_PERMISSION_KEYS) {
    if (!permissions || !Object.prototype.hasOwnProperty.call(permissions, key)) {
      normalized[key] = fallback;
    }
  }
  return normalized;
}

function applyAuthState({ user, permissions, login, name, id, roles } = {}) {
  state.auth.user = normalizeAuthUser(user, {
    login,
    name,
    id,
    roles,
  });
  state.auth.permissions = normalizeAuthPermissions(permissions);
  return state.auth.user;
}

// -----------------------------
// Проверка прав доступа
// -----------------------------

function canEditLine(line) {
  if (state.ui.isScheduleCached) return false;
  const permission = state.auth.permissions[line] || state.auth.permissions.ALL;
  return permission === "edit";
}

function canViewLine(line) {
  const permission = state.auth.permissions[line] || state.auth.permissions.ALL;
  return permission === "view" || permission === "edit";
}


// -----------------------------
// Персистентная авторизация (localStorage + cookie)
// -----------------------------

const AUTH_STORAGE_KEY = config.storage.auth.key;
const AUTH_TTL_MS =
  Number(config.storage.auth.sessionTtlMs ?? config.storage.auth.ttlMs) || 0; // 7 дней
const AUTH_COOKIE_DAYS = config.storage.auth.cookieDays;
const AUTH_EMAIL_CHECK_KEY = "sm_auth_email_last_check";

const AUTH_METHOD_EMAIL = "email";


function setCookie(name, value, days) {
  try {
    const expires = new Date(Date.now() + days * 86400000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  } catch (_) {}
}

function getCookie(name) {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()\[\]\\\/\+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch (_) {
    return null;
  }
}

function clearCookie(name) {
  try {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  } catch (_) {}
}

function clearAllCookies() {
  try {
    const cookies = document.cookie.split(";").map((cookie) => cookie.trim()).filter(Boolean);
    cookies.forEach((cookie) => {
      const name = cookie.split("=")[0];
      if (name) clearCookie(name);
    });
  } catch (_) {}
}

function clearAllAppStorage() {
  try {
    localStorage.clear();
  } catch (_) {}
  try {
    sessionStorage.clear();
  } catch (_) {}
}

function clearAllCacheAndCookies() {
  clearAllAppStorage();
  clearAllCookies();
}

function saveAuthCache(login) {
  // пароль не сохраняем
  const payload = {
    savedAt: Date.now(),
    authMethod: AUTH_METHOD_EMAIL,
    login: login || "",
    user: state.auth.user || null,
    roles: state.auth.roles || null,
    memberId: state.auth.memberId || null,

    permissions: state.auth.permissions || null,
  };
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {}
  // Дублируем в cookie (минимальный объём) — на случай очистки localStorage
  setCookie(AUTH_STORAGE_KEY, JSON.stringify(payload), AUTH_COOKIE_DAYS);
}

function loadAuthCache() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTH_STORAGE_KEY);
  } catch (_) {}
  if (!raw) raw = getCookie(AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!data || !data.savedAt) return null;
    if (Date.now() - data.savedAt > AUTH_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function readRawAuthCache() {
  let raw = null;
  try {
    raw = localStorage.getItem(AUTH_STORAGE_KEY);
  } catch (_) {}
  if (!raw) raw = getCookie(AUTH_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function clearAuthCache() {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (_) {}
  clearCookie(AUTH_STORAGE_KEY);
}

function getTodayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shouldCheckEmailToday() {
  let lastCheck = null;
  try {
    lastCheck = localStorage.getItem(AUTH_EMAIL_CHECK_KEY);
  } catch (_) {
    return true;
  }
  return !lastCheck || lastCheck !== getTodayDateString();
}

function markEmailCheckedToday() {
  try {
    localStorage.setItem(AUTH_EMAIL_CHECK_KEY, getTodayDateString());
  } catch (_) {}
}

function applyAuthCache(data) {
  if (!data) return false;
state.auth.user = data.user || null;
state.auth.roles = data.roles || state.auth.roles || null;
state.auth.memberId = data.memberId || state.auth.memberId || null;
state.auth.login = data.login || state.auth.login || null;

if (state.auth.roles) {
  state.auth.permissions = resolvePermissionsFromRoles(
    state.auth.roles,
    ROLE_MATRIX_BY_LINE
  );
} else {
  state.auth.permissions = normalizePermissions(
    data.permissions || state.auth.permissions
  );
}

// гарантируем ключи вкладок
for (const k of ["ALL", "OP", "OV", "OU", "AI", "L1", "L2"]) {
  if (!Object.prototype.hasOwnProperty.call(state.auth.permissions, k)) {
    state.auth.permissions[k] = state.auth.permissions.ALL || "view";
  }
}

  const login = (data.login || state.auth.user?.login || "").trim();
  updateCurrentUserLabel(login);
  // сохраняем сессию независимо от наличия UI-элементов
  if (login || state.auth.user?.login) saveAuthCache(login);

  return true;
}

function getCurrentLinePermission() {
  return state.auth.permissions[state.ui.currentLine];
}

// -----------------------------
// Утилиты времени
// -----------------------------

// Нормализация времени к формату HH:MM.
// Принимает также "2:00", "2", "02", "14.30" и т.п.
function normalizeTimeHHMM(raw) {
  if (raw == null) return "";
  const s = String(raw).trim().replace(".", ":");
  if (!s) return "";

  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return s;

  const hh = String(parseInt(m[1], 10)).padStart(2, "0");
  const mm = String(parseInt(m[2] || "0", 10)).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parseShiftTimeRangeString(raw) {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/\s+/g, "");
  const [startRaw, endRaw] = cleaned.split("-");
  if (!startRaw || !endRaw) return null;

  const norm = (part) => {
    const withColon = part.replace(".", ":");
    const [hStr, mStr = "00"] = withColon.split(":");
    const h = String(parseInt(hStr, 10)).padStart(2, "0");
    const m = String(parseInt(mStr, 10)).padStart(2, "0");
    return `${h}:${m}`;
  };

  return { start: norm(startRaw), end: norm(endRaw) };
}

function addMinutesLocal(baseMinutes, delta) {
  let total = baseMinutes + delta;
  let dayShift = 0;
  while (total < 0) {
    total += 24 * 60;
    dayShift -= 1;
  }
  while (total >= 24 * 60) {
    total -= 24 * 60;
    dayShift += 1;
  }
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return { time: `${hh}:${mm}`, dayShift };
}

function convertUtcStartToLocalRange(utcIsoString, durationMinutes) {
  if (!utcIsoString || typeof utcIsoString !== "string") return null;
  const startUtc = new Date(utcIsoString);
  if (Number.isNaN(startUtc.getTime())) return null;

  const startLocalMs = startUtc.getTime() + TIMEZONE_OFFSET_MIN * 60 * 1000;
  const startLocalDate = new Date(startLocalMs);

  const startHH = String(startLocalDate.getUTCHours()).padStart(2, "0");
  const startMM = String(startLocalDate.getUTCMinutes()).padStart(2, "0");
  const startLocal = `${startHH}:${startMM}`;

  const startMinutes =
    startLocalDate.getUTCHours() * 60 + startLocalDate.getUTCMinutes();
  const { time: endLocal } = addMinutesLocal(
    startMinutes,
    durationMinutes || 0
  );

  const y = startLocalDate.getUTCFullYear();
  const m = String(startLocalDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(startLocalDate.getUTCDate()).padStart(2, "0");

  return {
    localDateKey: `${y}-${m}-${d}`,
    startLocal,
    endLocal,
  };
}

function formatShiftTimeForCell(startLocal, endLocal) {
  return { start: startLocal, end: endLocal };
}

function parseTimeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const [hh, mm] = hhmm.split(":").map((p) => Number(p));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return hh * 60 + mm;
}

function computeDurationMinutes(startLocal, endLocal) {
  const start = parseTimeToMinutes(startLocal);
  const end = parseTimeToMinutes(endLocal);
  if (start == null || end == null) return null;
  let diff = end - start;
  if (diff <= 0) diff += 24 * 60;
  return diff;
}

function convertLocalRangeToUtcWithMeta(year, monthIndex, day, startLocal, endLocal) {
  try {
    const durationMinutes = computeDurationMinutes(startLocal, endLocal);
    if (durationMinutes == null) return null;

    const y = Number(year);
    const m = Number(monthIndex);
    const d = Number(day);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;

    // Стартовое локальное время (HH:MM)
    const startMin = parseTimeToMinutes(startLocal);
    if (startMin == null) return null;
    const hhNum = Math.floor(startMin / 60);
    const mmNum = startMin % 60;
    const offsetMs = TIMEZONE_OFFSET_MIN * 60 * 1000;
    const baseUtcMs = Date.UTC(y, m, d, hhNum, mmNum);
    if (!Number.isFinite(baseUtcMs)) return null;

    const startUtcMs = baseUtcMs - offsetMs;
    const endUtcMs = startUtcMs + durationMinutes * 60 * 1000;

    const startDate = new Date(startUtcMs);
    const endDate = new Date(endUtcMs);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
      return null;
    }

    return {
      durationMinutes,
      startUtcIso: startDate.toISOString(),
      endUtcIso: endDate.toISOString(),
    };
  } catch (e) {
    console.warn("convertLocalRangeToUtcWithMeta: invalid time value", {
      year,
      monthIndex,
      day,
      startLocal,
      endLocal,
      error: String(e && e.message ? e.message : e),
    });
    return null;
  }
}

// Backwards-compatible wrapper.
function convertLocalRangeToUtc(day, startLocal, endLocal) {
  let { year, monthIndex } = state.monthMeta || {};
  if (!Number.isFinite(Number(year)) || !Number.isFinite(Number(monthIndex))) {
    const now = new Date();
    year = now.getFullYear();
    monthIndex = now.getMonth();
  }
  return convertLocalRangeToUtcWithMeta(year, monthIndex, day, startLocal, endLocal);
}

// -----------------------------
// DOM-ссылки
// -----------------------------

const $ = (sel) => document.querySelector(sel);

const loginScreenEl = $("#login-screen");
const mainScreenEl = $("#main-screen");

const emailInputEl = $("#email-input");
const emailSendButtonEl = $("#email-send-button");
const emailStepRequestEl = $("#email-step-request");
const emailStepCodeEl = $("#email-step-code");
const emailTargetLabelEl = $("#email-target-label");
const emailChangeButtonEl = $("#email-change-button");
const otpGroupEl = $("#otp-group");
const otpInputs = otpGroupEl ? Array.from(otpGroupEl.querySelectorAll(".otp-input")) : [];
const emailVerifyButtonEl = $("#email-verify-button");
const emailResendButtonEl = $("#email-resend-button");
const emailRequestErrorEl = $("#email-request-error");
const emailCodeErrorEl = $("#email-code-error");
const currentUserLabelEl = $("#current-user-label");
const currentMonthLabelEl = $("#current-month-label");

const lineTabsEl = $("#line-tabs");
const btnPrevMonthEl = $("#btn-prev-month");
const btnNextMonthEl = $("#btn-next-month");
const btnThemeToggleEl = $("#btn-theme-toggle");
const btnLogoutEl = $("#btn-logout");
const btnSavePyrusEl = $("#btn-save-pyrus");
const btnMobileToolbarEl = $("#btn-mobile-toolbar");
const btnMobileToolbarCloseEl = $("#btn-mobile-toolbar-close");
const btnLineTabsEl = $("#btn-line-tabs");
const btnLegendToggleEl = $("#btn-legend-toggle");
const shiftLegendEl = $("#shift-legend");
const shiftLegendBackdropEl = $("#shift-legend-backdrop");

const scheduleRootEl = $("#schedule-root");
const quickTemplateSelectEl = $("#quick-template-select");
const quickTimeFromInputEl = $("#quick-time-from");
const quickTimeToInputEl = $("#quick-time-to");
const quickAmountInputEl = $("#quick-amount");
const quickModeToggleEl = $("#quick-mode-toggle");
const changeLogListEl = $("#change-log-list");
const btnClearHistoryEl = $("#btn-clear-history");
let appToastTimer = null;

function showAppToast(message) {
  const text = String(message || "").trim() || "Сохранено.";
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.className = "app-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("show");
  if (appToastTimer) clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2400);
}

function syncLoginBodyState() {
  if (!loginScreenEl) return;
  document.body.classList.toggle(
    "login-active",
    !loginScreenEl.classList.contains("hidden")
  );
}

function showLoginScreen() {
  mainScreenEl?.classList.add("hidden");
  loginScreenEl?.classList.remove("hidden");
  syncLoginBodyState();
}

function showMainScreen() {
  loginScreenEl?.classList.add("hidden");
  mainScreenEl?.classList.remove("hidden");
  syncLoginBodyState();
}

// поповер смены
let shiftPopoverEl = null;
let shiftPopoverBackdropEl = null;
let shiftPopoverKeydownHandler = null;
let employeeFilterPopoverEl = null;
let employeeFilterPopoverBackdropEl = null;
let employeeFilterPopoverKeydownHandler = null;
let employeeFilterPopoverTitleEl = null;
let employeeFilterPopoverMetaEl = null;
let employeeFilterPopoverListEl = null;
let employeeFilterPopoverControlsEl = null;
let legendKeydownHandler = null;
let lineTabsPopoverBackdropEl = null;
let lineTabsPopoverEl = null;
let lineTabsPopoverListEl = null;
let lineTabsPopoverKeydownHandler = null;
let monthPickerBackdropEl = null;
let monthPickerEl = null;
let monthPickerYearLabelEl = null;
let monthPickerGridEl = null;
let monthPickerKeydownHandler = null;

// -----------------------------
// Инициализация
// -----------------------------

async function init() {
  resetLocalEditingState();
  initTheme();
  loadCurrentLinePreference();
  loadEmployeeFilters();
  initMonthMetaToToday();
  bindEmailAuth();
  loadEmailAuthMembers();

  // Автовосстановление сессии (без повторного ввода пароля)
  const rawAuth = readRawAuthCache();
  if (rawAuth && rawAuth.authMethod !== AUTH_METHOD_EMAIL) {
    clearAllCacheAndCookies();
    clearAuthCache();
    state.auth.user = null;
    state.auth.roles = null;
    state.auth.memberId = null;
    state.auth.permissions = buildDefaultPermissions();
    showLoginScreen();
  } else {
    const cachedAuth = loadAuthCache();
    if (cachedAuth && applyAuthCache(cachedAuth)) {
      showMainScreen();
      if (shouldCheckEmailToday()) {
        const userEmail = normalizeEmail(state.auth.user?.login);
        if (userEmail) {
          try {
            const data = await membersService.getMembers();
            const members = membersService.extractMembersFromPyrusData(data);
            const isKnownEmail = members.some(
              (member) => normalizeEmail(member?.email) === userEmail
            );
            if (!isKnownEmail) {
              clearAuthCache();
              state.auth.user = null;
              state.auth.roles = null;
              state.auth.memberId = null;
              state.auth.permissions = buildDefaultPermissions();
              showLoginScreen();
            } else {
              markEmailCheckedToday();
            }
          } catch (err) {
            console.error("Email check failed:", err);
          }
        }
      }
    }
  }

  syncLoginBodyState();
  bindTopBarButtons();
  bindHistoryControls();
  createShiftPopover();
  createEmployeeFilterPopover();
  createMonthPickerPopover();
  renderChangeLog();

  // Если восстановили сессию — загружаем данные как после логина
  if (state.auth.user && mainScreenEl && !mainScreenEl.classList.contains("hidden")) {
    loadInitialData().catch((err) => {
      console.error("Auto-login loadInitialData error:", err);
      clearAuthCache();
      showLoginScreen();
      if (emailRequestErrorEl) {
        emailRequestErrorEl.textContent = "Сессия истекла — войдите снова";
      }
    });
  }
}

function getCurrentLineTemplates() {
  return state.shiftTemplatesByLine[state.ui.currentLine] || [];
}

function initMonthMetaToToday() {
  const now = new Date();
  state.monthMeta.year = now.getFullYear();
  state.monthMeta.monthIndex = now.getMonth();
  updateMonthLabel();
}

function updateMonthLabel() {
  const { year, monthIndex } = state.monthMeta;
  const monthNames = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];
  currentMonthLabelEl.textContent = `${monthNames[monthIndex]} ${year}`;
}

function createMonthPickerPopover() {
  if (monthPickerBackdropEl) return;
  monthPickerBackdropEl = document.createElement("div");
  monthPickerBackdropEl.className = "month-picker-backdrop hidden";

  monthPickerEl = document.createElement("div");
  monthPickerEl.className = "month-picker hidden";

  const header = document.createElement("div");
  header.className = "month-picker-header";

  const prevYearBtn = document.createElement("button");
  prevYearBtn.type = "button";
  prevYearBtn.className = "btn toggle";
  prevYearBtn.textContent = "‹";
  prevYearBtn.setAttribute("aria-label", "Предыдущий год");

  monthPickerYearLabelEl = document.createElement("div");
  monthPickerYearLabelEl.className = "month-picker-year";

  const nextYearBtn = document.createElement("button");
  nextYearBtn.type = "button";
  nextYearBtn.className = "btn toggle";
  nextYearBtn.textContent = "›";
  nextYearBtn.setAttribute("aria-label", "Следующий год");

  header.appendChild(prevYearBtn);
  header.appendChild(monthPickerYearLabelEl);
  header.appendChild(nextYearBtn);

  monthPickerGridEl = document.createElement("div");
  monthPickerGridEl.className = "month-picker-grid";

  monthPickerEl.appendChild(header);
  monthPickerEl.appendChild(monthPickerGridEl);
  monthPickerBackdropEl.appendChild(monthPickerEl);
  document.body.appendChild(monthPickerBackdropEl);

  const closeHandler = () => closeMonthPickerPopover();
  monthPickerBackdropEl.addEventListener("click", (event) => {
    if (event.target === monthPickerBackdropEl) closeHandler();
  });

  prevYearBtn.addEventListener("click", () => {
    state.monthMeta.year -= 1;
    renderMonthPicker();
  });
  nextYearBtn.addEventListener("click", () => {
    state.monthMeta.year += 1;
    renderMonthPicker();
  });
}

function renderMonthPicker() {
  if (!monthPickerGridEl || !monthPickerYearLabelEl) return;
  const { year, monthIndex } = state.monthMeta;
  monthPickerYearLabelEl.textContent = String(year);
  monthPickerGridEl.innerHTML = "";

  const monthLabels = [
    "Янв",
    "Фев",
    "Мар",
    "Апр",
    "Май",
    "Июн",
    "Июл",
    "Авг",
    "Сен",
    "Окт",
    "Ноя",
    "Дек",
  ];

  monthLabels.forEach((label, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "month-picker-month";
    btn.textContent = label;
    btn.setAttribute("aria-label", `${label} ${year}`);
    if (index === monthIndex) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.monthMeta.monthIndex = index;
      updateMonthLabel();
      closeMonthPickerPopover();
      reloadScheduleForCurrentMonth();
    });
    monthPickerGridEl.appendChild(btn);
  });
}

function openMonthPickerPopover() {
  if (!monthPickerBackdropEl || !monthPickerEl) return;
  renderMonthPicker();
  monthPickerBackdropEl.classList.remove("hidden");
  monthPickerEl.classList.remove("hidden");
  if (!monthPickerKeydownHandler) {
    monthPickerKeydownHandler = (event) => {
      if (event.key === "Escape") closeMonthPickerPopover();
    };
  }
  document.addEventListener("keydown", monthPickerKeydownHandler);
}

function closeMonthPickerPopover() {
  if (!monthPickerBackdropEl || !monthPickerEl) return;
  monthPickerBackdropEl.classList.add("hidden");
  monthPickerEl.classList.add("hidden");
  if (monthPickerKeydownHandler) {
    document.removeEventListener("keydown", monthPickerKeydownHandler);
    monthPickerKeydownHandler = null;
  }
}

function resetLocalEditingState() {
  state.localChanges = {};
  state.changeHistory = [];

  try {
    localStorage.removeItem(STORAGE_KEYS.localChanges);
    localStorage.removeItem(STORAGE_KEYS.changeHistory);
  } catch (err) {
    console.warn("Не удалось сбросить локальные данные", err);
  }
}

function persistLocalChanges() {
  try {
    localStorage.setItem(STORAGE_KEYS.localChanges, JSON.stringify(state.localChanges));
  } catch (err) {
    console.warn("Не удалось сохранить локальные смены", err);
  }
}

function persistChangeHistory() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.changeHistory,
      JSON.stringify(state.changeHistory.slice(0, 300))
    );
  } catch (err) {
    console.warn("Не удалось сохранить историю", err);
  }
}

// -----------------------------
// Авторизация: вкладки и OTP
// -----------------------------

const emailAuthState = {
  step: "request",
  targetEmail: "",
  resendRemaining: 0,
  timerId: null,
  currentCode: "",
  member: null,

};

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function setMembersByEmail(members) {
  membersByEmail.clear();
  if (!Array.isArray(members)) return;
  members.forEach((member) => {
    const email = normalizeEmail(member?.email);
    if (!email) return;
    const firstName = member.first_name ?? member.firstName ?? "";
    const lastName = member.last_name ?? member.lastName ?? "";
    membersByEmail.set(email, {
      ...member,
      first_name: firstName,
      last_name: lastName,
      email: member.email || "",
    });
  });
}

function generateEmailAuthCode(length) {
  const size = Math.max(1, Number(length) || 6);
  const values = new Uint32Array(size);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => String(value % 10)).join("");
}

async function sendEmailAuthCode(payload) {
  return graphClient.callGraphApi("email", payload);
}

function clearAuthErrors() {
  if (emailRequestErrorEl) emailRequestErrorEl.textContent = "";
  if (emailCodeErrorEl) emailCodeErrorEl.textContent = "";
  otpGroupEl?.classList.remove("error");
}

function resetEmailAuthState(keepEmail = true) {
  clearResendTimer();
  emailAuthState.step = "request";
  emailAuthState.resendRemaining = 0;
  emailAuthState.currentCode = "";
  emailAuthState.member = null;
  if (!keepEmail && emailInputEl) emailInputEl.value = "";
  if (emailTargetLabelEl) emailTargetLabelEl.textContent = "—";
  otpInputs.forEach((input) => {
    input.value = "";
  });
  updateResendButton();
  setEmailAuthStep("request");
}

function setEmailAuthStep(step) {
  emailAuthState.step = step;
  emailStepRequestEl?.classList.toggle("hidden", step !== "request");
  emailStepCodeEl?.classList.toggle("hidden", step !== "code");
  document.body.classList.toggle("auth-code-step", step === "code");
  clearAuthErrors();
  if (step === "request") {
    emailInputEl?.focus();
  } else {
    otpInputs[0]?.focus();
  }
}

function normalizeOtpValue(value) {
  return value.replace(/\D/g, "");
}

function setOtpError(message) {
  if (emailCodeErrorEl) emailCodeErrorEl.textContent = message || "";
  otpGroupEl?.classList.toggle("error", Boolean(message));
}

function getOtpValue() {
  return otpInputs.map((input) => input.value).join("");
}

function fillOtpFromString(value) {
  const digits = normalizeOtpValue(value).slice(0, otpInputs.length).split("");
  otpInputs.forEach((input, index) => {
    input.value = digits[index] || "";
  });
  const nextIndex = Math.min(digits.length, otpInputs.length - 1);
  otpInputs[nextIndex]?.focus();
}

function handleOtpInput(event) {
  const input = event.target;
  const index = otpInputs.indexOf(input);
  const clean = normalizeOtpValue(input.value);
  input.value = clean.slice(-1);
  setOtpError("");
  if (input.value && index < otpInputs.length - 1) {
    otpInputs[index + 1].focus();
  }
}

function handleOtpKeydown(event) {
  const input = event.target;
  const index = otpInputs.indexOf(input);
  if (event.key === "Backspace" && !input.value && index > 0) {
    otpInputs[index - 1].value = "";
    otpInputs[index - 1].focus();
    event.preventDefault();
  }
  if (event.key === "ArrowLeft" && index > 0) {
    otpInputs[index - 1].focus();
    event.preventDefault();
  }
  if (event.key === "ArrowRight" && index < otpInputs.length - 1) {
    otpInputs[index + 1].focus();
    event.preventDefault();
  }
}

function handleOtpPaste(event) {
  const data = event.clipboardData?.getData("text");
  if (!data) return;
  event.preventDefault();
  fillOtpFromString(data);
}

function updateResendButton() {
  if (!emailResendButtonEl) return;
  if (emailAuthState.resendRemaining > 0) {
    emailResendButtonEl.disabled = true;
    emailResendButtonEl.textContent = `Повторная отправка (${emailAuthState.resendRemaining}с)`;
  } else {
    emailResendButtonEl.disabled = false;
    emailResendButtonEl.textContent = "Повторная отправка";
  }
}

function clearResendTimer() {
  if (emailAuthState.timerId) {
    clearInterval(emailAuthState.timerId);
    emailAuthState.timerId = null;
  }
}

function startResendTimer() {
  clearResendTimer();
  emailAuthState.resendRemaining = 60;
  updateResendButton();
  emailAuthState.timerId = setInterval(() => {
    emailAuthState.resendRemaining -= 1;
    if (emailAuthState.resendRemaining <= 0) {
      emailAuthState.resendRemaining = 0;
      clearResendTimer();
    }
    updateResendButton();
  }, 1000);
}

async function loadEmailAuthMembers() {
  if (emailAuthState.membersLoaded || emailAuthState.membersLoading) return;
  emailAuthState.membersLoading = true;
  emailAuthState.membersLoadError = "";
  try {
    const { membersByEmail } = await membersService.getMembersIndex();
    const normalizedMap = new Map();
    for (const [email, member] of membersByEmail.entries()) {
      normalizedMap.set(email, {
        id: member.id,
        first_name: member.first_name || "",
        last_name: member.last_name || "",
        email: member.email || "",
      });
    }
    emailAuthState.membersByEmail = normalizedMap;
    emailAuthState.membersLoaded = true;
  } catch (err) {
    console.error("Не удалось загрузить сотрудников для email-авторизации:", err);
    emailAuthState.membersByEmail = new Map();
    emailAuthState.membersLoaded = false;
    emailAuthState.membersLoadError = "Не удалось проверить email, попробуйте позже";
    if (emailRequestErrorEl) {
      emailRequestErrorEl.textContent = emailAuthState.membersLoadError;
    }
  } finally {
    emailAuthState.membersLoading = false;
  }
}

function bindEmailAuth() {
  if (!emailInputEl) return;
  otpInputs.forEach((input) => {
    input.addEventListener("input", handleOtpInput);
    input.addEventListener("keydown", handleOtpKeydown);
  });
  otpGroupEl?.addEventListener("paste", handleOtpPaste);

  emailSendButtonEl?.addEventListener("click", async () => {
    clearAuthErrors();
    const email = emailInputEl.value.trim();
    const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isValid) {
      if (emailRequestErrorEl) emailRequestErrorEl.textContent = "Введите корректный email";
      emailInputEl.focus();
      return;
    }
    if (!emailAuthState.membersLoaded) {
      if (emailRequestErrorEl) {
        emailRequestErrorEl.textContent =
          emailAuthState.membersLoadError || "Не удалось проверить email, попробуйте позже";
      }
      return;
    }

    const normalizedEmail = normalizeEmail ? normalizeEmail(email) : String(email).trim().toLowerCase();

    if (!emailAuthState.membersByEmail.has(normalizedEmail)) {
      if (emailRequestErrorEl) {
        emailRequestErrorEl.textContent =
          "Email не найден — укажите почту которую используете для работы в Pyrus";
      }
      return;
    }

    const member = emailAuthState.membersByEmail.get(normalizedEmail);
    const code = generateEmailAuthCode(config.auth.codeLength);
    emailAuthState.currentCode = code;
    emailAuthState.member = member;

    emailAuthState.targetEmail = email;
    if (emailTargetLabelEl) emailTargetLabelEl.textContent = email;
    otpInputs.forEach((input) => {
      input.value = "";
    });
    try {
      await sendEmailAuthCode({
        type: "email",
        email,
        code,
        first_name: member.first_name || "",
        last_name: member.last_name || "",
      });
    } catch (err) {
      if (emailRequestErrorEl) {
        emailRequestErrorEl.textContent = err?.message || "Не удалось отправить код";
      }
      return;
    }
    setEmailAuthStep("code");
    startResendTimer();
  });

  emailChangeButtonEl?.addEventListener("click", () => {
    setEmailAuthStep("request");
  });

  emailVerifyButtonEl?.addEventListener("click", async () => {
    clearAuthErrors();
    const code = getOtpValue();
    if (code.length < otpInputs.length) {
      setOtpError("Введите 6-значный код");
      return;
    }
    if (code !== emailAuthState.currentCode) {
      setOtpError("Неверный код. Попробуйте ещё раз");
      return;
    }
    const member = emailAuthState.member;
    const email = emailAuthState.targetEmail || "";
if (!member?.id) {
  setOtpError("Не удалось определить пользователя. Повторите вход.");
  return;
}

let roles = null;
try {
  const data = await membersService.getMemberDetails({ id: member.id });
  roles = data?.roles || null;
} catch (err) {
  setOtpError(err?.message || "Не удалось загрузить роли пользователя");
  return;
}

state.auth.user = {
  name: `${member?.last_name || ""} ${member?.first_name || ""}`.trim(),
  login: email,
};

state.auth.roles = roles || null;
state.auth.memberId = member.id;

if (state.auth.roles) {
  state.auth.permissions = resolvePermissionsFromRoles(
    state.auth.roles,
    ROLE_MATRIX_BY_LINE
  );
} else {
  state.auth.permissions = buildDefaultPermissions();
}

    updateCurrentUserLabel(email);
    saveAuthCache(email);
    showMainScreen();
    renderLineTabs();
    updateLineToggleUI();
    persistCurrentLinePreference();
    loadInitialData();
  });

  emailResendButtonEl?.addEventListener("click", async () => {
    if (emailAuthState.resendRemaining > 0) return;
    clearAuthErrors();
    const email = emailAuthState.targetEmail;
    const normalizedEmail = normalizeEmail(email);
    const member = emailAuthState.member || membersByEmail.get(normalizedEmail);
    if (!member || !email) {
      if (emailCodeErrorEl) {
        emailCodeErrorEl.textContent = "Сначала запросите код по email";
      }
      return;
    }
    const code = generateEmailAuthCode(config.auth.codeLength);
    emailAuthState.currentCode = code;
    emailAuthState.member = member;
    try {
      await sendEmailAuthCode({
        type: "email",
        email,
        code,
        first_name: member.first_name || "",
        last_name: member.last_name || "",
      });
    } catch (err) {
      if (emailCodeErrorEl) {
        emailCodeErrorEl.textContent = err?.message || "Не удалось отправить код";
      }
      return;
    }
    startResendTimer();
  });
}

function initTheme() {
  applyThemeConfigVariables();

  const storedTheme = localStorage.getItem(STORAGE_KEYS.theme);
  const preferredTheme = storedTheme === "light" ? "light" : "dark";
  applyTheme(preferredTheme);

  if (btnThemeToggleEl) {
    btnThemeToggleEl.addEventListener("click", () => {
      const next = state.ui.theme === "dark" ? "light" : "dark";
      applyTheme(next);
    });
  }
}

function applyTheme(theme) {
  state.ui.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
  updateThemeToggleUI();
  applyCalendarUiTheme(theme);

  // Обновление цветов при смене темы
  if (typeof ShiftColors !== 'undefined' && ShiftColors.applyTheme) {
    ShiftColors.applyTheme(theme);
  }
}

function applyCalendarUiTheme(theme) {
  const calendarUi = config.calendar?.ui ?? {};
  const themeKey = theme === "light" ? "light" : "dark";
  const themeConfig = calendarUi[themeKey] ?? calendarUi.light ?? {};
  const rootStyle = document.documentElement.style;

  const setVar = (name, value) => {
    if (typeof value === "string") rootStyle.setProperty(name, value);
  };

  const applyDayVars = (type, values) => {
    if (!values) return;
    setVar(`--calendar-${type}-bg`, values.background);
    setVar(`--calendar-${type}-border`, values.border);
    setVar(`--calendar-${type}-dash`, values.dash);
  };

  applyDayVars("workday", themeConfig.workday);
  applyDayVars("weekend", themeConfig.weekend);
  applyDayVars("holiday", themeConfig.holiday);
  applyDayVars("preholiday", themeConfig.preholiday);

  const micro = themeConfig.microIndicators ?? {};
  setVar("--calendar-micro-weekend", micro.weekend);
  setVar("--calendar-micro-holiday", micro.holiday);
  setVar("--calendar-micro-preholiday", micro.preholiday);
}

function updateThemeToggleUI() {
  if (!btnThemeToggleEl) return;
  const isDark = state.ui.theme === "dark";
  btnThemeToggleEl.textContent = isDark ? "🌙 Тема" : "☀️ Тема";
  btnThemeToggleEl.setAttribute(
    "aria-label",
    isDark ? "Включена тёмная тема" : "Включена светлая тема"
  );
}

function loadCurrentLinePreference() {
  try {
    const storedLine = localStorage.getItem(STORAGE_KEYS.currentLine);
    if (storedLine && LINE_KEYS_IN_UI_ORDER.includes(storedLine)) {
      state.ui.currentLine = storedLine;
    }
  } catch (_) {
    // ignore storage quota / privacy mode
  }
}

function persistCurrentLinePreference() {
  try {
    localStorage.setItem(STORAGE_KEYS.currentLine, state.ui.currentLine);
  } catch (_) {
    // ignore storage quota / privacy mode
  }
}

function getMonthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
}

function loadCachedEmployees() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.cachedEmployees);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;

    const employeesByLine = cached.employeesByLine;
    if (!employeesByLine || typeof employeesByLine !== "object") return false;

    for (const key of Object.keys(state.employeesByLine)) {
      const list = employeesByLine[key];
      state.employeesByLine[key] = Array.isArray(list) ? list : [];
    }
    return true;
  } catch (err) {
    console.warn("Не удалось загрузить кэш сотрудников", err);
    return false;
  }
}

function persistCachedEmployees() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.cachedEmployees,
      JSON.stringify({
        fetchedAt: Date.now(),
        employeesByLine: state.employeesByLine,
      })
    );
  } catch (err) {
    console.warn("Не удалось сохранить кэш сотрудников", err);
  }
}

function loadCachedShiftTemplates() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.cachedShiftTemplates);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;

    const templatesByLine = cached.shiftTemplatesByLine;
    if (!templatesByLine || typeof templatesByLine !== "object") return false;

    for (const key of Object.keys(state.shiftTemplatesByLine)) {
      const list = templatesByLine[key];
      state.shiftTemplatesByLine[key] = Array.isArray(list) ? list : [];
    }

    if (typeof ShiftColors !== "undefined" && ShiftColors.initialize) {
      ShiftColors.initialize(state.shiftTemplatesByLine, state.ui.theme);
    }
    return true;
  } catch (err) {
    console.warn("Не удалось загрузить кэш шаблонов смен", err);
    return false;
  }
}

function persistCachedShiftTemplates() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.cachedShiftTemplates,
      JSON.stringify({
        fetchedAt: Date.now(),
        shiftTemplatesByLine: state.shiftTemplatesByLine,
      })
    );
  } catch (err) {
    console.warn("Не удалось сохранить кэш шаблонов смен", err);
  }
}

function loadCachedScheduleForMonth(year, monthIndex) {
  try {
    const monthKey = getMonthKey(year, monthIndex);
    const raw = localStorage.getItem(`${STORAGE_KEYS.cachedSchedulePrefix}${monthKey}`);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return false;
    if (!cached.scheduleByLine || typeof cached.scheduleByLine !== "object") return false;

    state.scheduleByLine = cached.scheduleByLine;
    state.originalScheduleByLine = deepClone(cached.scheduleByLine);
    state.vacationsByEmployee = cached.vacationsByEmployee || {};
    state.ui.isScheduleCached = true;

    applyLocalChangesToSchedule();
    renderScheduleCurrentLine();
    return true;
  } catch (err) {
    console.warn("Не удалось загрузить кэш графика", err);
    return false;
  }
}

function persistCachedScheduleForMonth(year, monthIndex) {
  try {
    const monthKey = getMonthKey(year, monthIndex);
    localStorage.setItem(
      `${STORAGE_KEYS.cachedSchedulePrefix}${monthKey}`,
      JSON.stringify({
        fetchedAt: Date.now(),
        scheduleByLine: state.scheduleByLine,
        vacationsByEmployee: state.vacationsByEmployee,
      })
    );
  } catch (err) {
    console.warn("Не удалось сохранить кэш графика", err);
  }
}

function loadEmployeeFilters() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.employeeFilters);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    for (const key of Object.keys(state.employeeFiltersByLine)) {
      const list = parsed[key];
      if (Array.isArray(list)) {
        state.employeeFiltersByLine[key] = list
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id));
      }
    }
  } catch (err) {
    console.warn("Не удалось загрузить фильтры сотрудников", err);
  }
}

function persistEmployeeFilters() {
  try {
    localStorage.setItem(
      STORAGE_KEYS.employeeFilters,
      JSON.stringify(state.employeeFiltersByLine)
    );
  } catch (err) {
    console.warn("Не удалось сохранить фильтры сотрудников", err);
  }
}

function normalizeHiddenEmployeeIds(line, rows) {
  const validIds = new Set(rows.map((row) => row.employeeId));
  const current = state.employeeFiltersByLine[line] || [];
  const next = current.filter((id) => validIds.has(id));
  if (next.length !== current.length) {
    state.employeeFiltersByLine[line] = next;
    persistEmployeeFilters();
  }
  return new Set(next);
}

function setHiddenEmployeeIds(line, ids) {
  state.employeeFiltersByLine[line] = Array.from(ids);
  persistEmployeeFilters();
}

function createEmployeeFilterPopover() {
  if (employeeFilterPopoverEl) return;

  employeeFilterPopoverBackdropEl = document.createElement("div");
  employeeFilterPopoverBackdropEl.className = "employee-filter-popover-backdrop hidden";

  employeeFilterPopoverEl = document.createElement("div");
  employeeFilterPopoverEl.className = "employee-filter-popover hidden";

  const header = document.createElement("div");
  header.className = "employee-filter-popover-header";

  employeeFilterPopoverTitleEl = document.createElement("div");
  employeeFilterPopoverTitleEl.className = "employee-filter-header";
  employeeFilterPopoverTitleEl.textContent = "Фильтр сотрудников";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "employee-filter-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Закрыть фильтр сотрудников");

  header.appendChild(employeeFilterPopoverTitleEl);
  header.appendChild(closeBtn);

  employeeFilterPopoverMetaEl = document.createElement("div");
  employeeFilterPopoverMetaEl.className = "employee-filter-meta";

  employeeFilterPopoverListEl = document.createElement("div");
  employeeFilterPopoverListEl.className = "employee-filter-list";

  employeeFilterPopoverControlsEl = document.createElement("div");
  employeeFilterPopoverControlsEl.className = "employee-filter-controls";

  employeeFilterPopoverEl.appendChild(header);
  employeeFilterPopoverEl.appendChild(employeeFilterPopoverMetaEl);
  employeeFilterPopoverEl.appendChild(employeeFilterPopoverListEl);
  employeeFilterPopoverEl.appendChild(employeeFilterPopoverControlsEl);

  employeeFilterPopoverBackdropEl.appendChild(employeeFilterPopoverEl);
  document.body.appendChild(employeeFilterPopoverBackdropEl);

  const closeHandler = () => closeEmployeeFilterPopover();
  employeeFilterPopoverBackdropEl.addEventListener("click", (event) => {
    if (event.target === employeeFilterPopoverBackdropEl) {
      closeHandler();
    }
  });
  closeBtn.addEventListener("click", closeHandler);
}

function closeEmployeeFilterPopover() {
  if (!employeeFilterPopoverEl || !employeeFilterPopoverBackdropEl) return;
  employeeFilterPopoverBackdropEl.classList.add("hidden");
  employeeFilterPopoverEl.classList.add("hidden");
  if (employeeFilterPopoverKeydownHandler) {
    document.removeEventListener("keydown", employeeFilterPopoverKeydownHandler);
    employeeFilterPopoverKeydownHandler = null;
  }
}

function createLineTabsPopover() {
  if (lineTabsPopoverEl) return;

  lineTabsPopoverBackdropEl = document.createElement("div");
  lineTabsPopoverBackdropEl.className = "line-tabs-popover-backdrop hidden";

  lineTabsPopoverEl = document.createElement("div");
  lineTabsPopoverEl.className = "line-tabs-popover hidden";

  const header = document.createElement("div");
  header.className = "line-tabs-popover-header";

  const title = document.createElement("div");
  title.className = "line-tabs-popover-title";
  title.textContent = "Отделы";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "line-tabs-popover-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Закрыть список отделов");

  lineTabsPopoverListEl = document.createElement("div");
  lineTabsPopoverListEl.className = "line-tabs-popover-list";

  header.appendChild(title);
  header.appendChild(closeBtn);
  lineTabsPopoverEl.appendChild(header);
  lineTabsPopoverEl.appendChild(lineTabsPopoverListEl);
  lineTabsPopoverBackdropEl.appendChild(lineTabsPopoverEl);
  document.body.appendChild(lineTabsPopoverBackdropEl);

  const closeHandler = () => closeLineTabsPopover();
  closeBtn.addEventListener("click", closeHandler);
  lineTabsPopoverBackdropEl.addEventListener("click", (event) => {
    if (event.target === lineTabsPopoverBackdropEl) {
      closeHandler();
    }
  });
}

function openLineTabsPopover() {
  if (!lineTabsPopoverBackdropEl || !lineTabsPopoverEl) return;
  lineTabsPopoverBackdropEl.classList.remove("hidden");
  lineTabsPopoverEl.classList.remove("hidden");
  document.body.classList.add("line-tabs-open");
  if (!lineTabsPopoverKeydownHandler) {
    lineTabsPopoverKeydownHandler = (event) => {
      if (event.key === "Escape") {
        closeLineTabsPopover();
      }
    };
  }
  document.addEventListener("keydown", lineTabsPopoverKeydownHandler);
}

function closeLineTabsPopover() {
  if (!lineTabsPopoverBackdropEl || !lineTabsPopoverEl) return;
  lineTabsPopoverBackdropEl.classList.add("hidden");
  lineTabsPopoverEl.classList.add("hidden");
  document.body.classList.remove("line-tabs-open");
  if (lineTabsPopoverKeydownHandler) {
    document.removeEventListener("keydown", lineTabsPopoverKeydownHandler);
    lineTabsPopoverKeydownHandler = null;
  }
}

function openEmployeeFilterPopover({
  line,
  rows,
  hiddenEmployeeIds,
  table,
  emptyRow,
  onUpdateButton,
}) {
  if (!employeeFilterPopoverEl || !employeeFilterPopoverBackdropEl) return;

  employeeFilterPopoverListEl.innerHTML = "";
  employeeFilterPopoverControlsEl.innerHTML = "";

  const masterLabel = document.createElement("label");
  masterLabel.className = "employee-filter-item employee-filter-master";
  const masterCheckbox = document.createElement("input");
  masterCheckbox.type = "checkbox";
  const masterText = document.createElement("span");
  masterText.textContent = "Все сотрудники";
  masterLabel.appendChild(masterCheckbox);
  masterLabel.appendChild(masterText);
  employeeFilterPopoverListEl.appendChild(masterLabel);

  const itemCheckboxes = [];

  for (const row of rows) {
    const itemLabel = document.createElement("label");
    itemLabel.className = "employee-filter-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !hiddenEmployeeIds.has(row.employeeId);
    checkbox.dataset.employeeId = String(row.employeeId);

    const name = document.createElement("span");
    name.textContent = row.employeeName;

    itemLabel.appendChild(checkbox);
    itemLabel.appendChild(name);
    employeeFilterPopoverListEl.appendChild(itemLabel);
    itemCheckboxes.push(checkbox);
  }

  const updateFilterUI = () => {
    const total = rows.length;
    const hiddenCount = hiddenEmployeeIds.size;
    const visibleCount = total - hiddenCount;
    masterCheckbox.checked = hiddenCount === 0;
    masterCheckbox.indeterminate = hiddenCount > 0 && hiddenCount < total;
    employeeFilterPopoverMetaEl.textContent = `Показано: ${visibleCount} из ${total}`;
    if (onUpdateButton) onUpdateButton();
  };

  masterCheckbox.addEventListener("change", () => {
    if (masterCheckbox.checked) {
      hiddenEmployeeIds.clear();
    } else {
      for (const row of rows) {
        hiddenEmployeeIds.add(row.employeeId);
      }
    }
    for (const checkbox of itemCheckboxes) {
      const id = Number(checkbox.dataset.employeeId);
      checkbox.checked = !hiddenEmployeeIds.has(id);
    }
    setHiddenEmployeeIds(line, hiddenEmployeeIds);
    updateFilterUI();
    applyEmployeeFilterToTable(table, hiddenEmployeeIds, emptyRow);
  });

  for (const checkbox of itemCheckboxes) {
    checkbox.addEventListener("change", () => {
      const id = Number(checkbox.dataset.employeeId);
      if (checkbox.checked) {
        hiddenEmployeeIds.delete(id);
      } else {
        hiddenEmployeeIds.add(id);
      }
      setHiddenEmployeeIds(line, hiddenEmployeeIds);
      updateFilterUI();
      applyEmployeeFilterToTable(table, hiddenEmployeeIds, emptyRow);
    });
  }

  const closeControl = document.createElement("button");
  closeControl.type = "button";
  closeControl.className = "employee-filter-close-action";
  closeControl.textContent = "Закрыть";
  closeControl.addEventListener("click", closeEmployeeFilterPopover);
  employeeFilterPopoverControlsEl.appendChild(closeControl);

  updateFilterUI();

  employeeFilterPopoverBackdropEl.classList.remove("hidden");
  employeeFilterPopoverEl.classList.remove("hidden");
  employeeFilterPopoverKeydownHandler = (event) => {
    if (event.key === "Escape") {
      closeEmployeeFilterPopover();
    }
  };
  document.addEventListener("keydown", employeeFilterPopoverKeydownHandler);
}

// -----------------------------
// События
// -----------------------------

function setCurrentLine(lineKey) {
  if (!canViewLine(lineKey)) return;
  state.ui.currentLine = lineKey;
  persistCurrentLinePreference();
  updateLineToggleUI();
  updateSaveButtonState();
  updateQuickModeForLine();
  renderQuickTemplateOptions();
  renderScheduleCurrentLine();
  if (typeof ShiftColors !== 'undefined' && ShiftColors.renderColorLegend) {
    ShiftColors.renderColorLegend(state.ui.currentLine);
  }
}

function renderLineTabs() {
  if (!lineTabsEl) return;
  lineTabsEl.innerHTML = "";
  createLineTabsPopover();
  if (lineTabsPopoverListEl) lineTabsPopoverListEl.innerHTML = "";
  for (const key of LINE_KEYS_IN_UI_ORDER) {
    if (!canViewLine(key)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn toggle";
    btn.dataset.line = key;
    btn.textContent = LINE_LABELS[key] || key;
    btn.addEventListener("click", () => {
      document.body.classList.remove("mobile-toolbar-open");
      setCurrentLine(key);
    });
    lineTabsEl.appendChild(btn);

    if (lineTabsPopoverListEl) {
      const popoverBtn = document.createElement("button");
      popoverBtn.type = "button";
      popoverBtn.className = "btn toggle";
      popoverBtn.dataset.line = key;
      popoverBtn.textContent = LINE_LABELS[key] || key;
      popoverBtn.addEventListener("click", () => {
        setCurrentLine(key);
        closeLineTabsPopover();
      });
      lineTabsPopoverListEl.appendChild(popoverBtn);
    }
  }
  updateLineToggleUI();
}

function setLegendOpen(isOpen) {
  if (!shiftLegendEl) return;
  if (window.innerWidth > 768) {
    shiftLegendEl.classList.remove("shift-legend-hidden", "shift-legend-modal");
    document.body.classList.remove("legend-open");
    btnLegendToggleEl?.setAttribute("aria-expanded", "true");
    shiftLegendBackdropEl?.setAttribute("aria-hidden", "true");
    if (legendKeydownHandler) {
      document.removeEventListener("keydown", legendKeydownHandler);
      legendKeydownHandler = null;
    }
    return;
  }
  shiftLegendEl.classList.toggle("shift-legend-hidden", !isOpen);
  shiftLegendEl.classList.toggle("shift-legend-modal", isOpen);
  document.body.classList.toggle("legend-open", isOpen);
  btnLegendToggleEl?.setAttribute("aria-expanded", String(isOpen));
  shiftLegendBackdropEl?.setAttribute("aria-hidden", String(!isOpen));

  if (isOpen) {
    if (!legendKeydownHandler) {
      legendKeydownHandler = (event) => {
        if (event.key === "Escape") {
          setLegendOpen(false);
        }
      };
    }
    document.addEventListener("keydown", legendKeydownHandler);
  } else if (legendKeydownHandler) {
    document.removeEventListener("keydown", legendKeydownHandler);
  }
}

function bindTopBarButtons() {
  renderLineTabs();
  setLegendOpen(window.innerWidth <= 768 ? false : true);

  // Mobile bottom-sheet controls
  btnMobileToolbarEl?.addEventListener("click", () => {
    document.body.classList.toggle("mobile-toolbar-open");
  });
  btnMobileToolbarCloseEl?.addEventListener("click", () => {
    document.body.classList.remove("mobile-toolbar-open");
  });
  btnLineTabsEl?.addEventListener("click", () => {
    const isOpen = !document.body.classList.contains("line-tabs-open");
    if (isOpen) openLineTabsPopover();
    else closeLineTabsPopover();
  });
  btnLegendToggleEl?.addEventListener("click", () => {
    const isOpen = !document.body.classList.contains("legend-open");
    setLegendOpen(isOpen);
  });
  shiftLegendBackdropEl?.addEventListener("click", () => {
    setLegendOpen(false);
  });
  currentMonthLabelEl?.addEventListener("click", () => {
    openMonthPickerPopover();
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) {
      closeLineTabsPopover();
      setLegendOpen(true);
    } else {
      setLegendOpen(false);
    }
  });

  btnLogoutEl?.addEventListener("click", () => {
    clearAuthCache();
    state.auth.user = null;
    state.auth.roles = null;
    state.auth.memberId = null;
    state.auth.permissions = buildDefaultPermissions();

    showLoginScreen();
    clearAuthErrors();
    updateLineToggleUI();
  });
btnPrevMonthEl.addEventListener("click", () => {
    const { year, monthIndex } = state.monthMeta;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    date.setMonth(monthIndex - 1);
    state.monthMeta.year = date.getUTCFullYear();
    state.monthMeta.monthIndex = date.getUTCMonth();
    updateMonthLabel();
    reloadScheduleForCurrentMonth();
  });

  btnNextMonthEl.addEventListener("click", () => {
    const { year, monthIndex } = state.monthMeta;
    const date = new Date(Date.UTC(year, monthIndex, 1));
    date.setMonth(monthIndex + 1);
    state.monthMeta.year = date.getUTCFullYear();
    state.monthMeta.monthIndex = date.getUTCMonth();
    updateMonthLabel();
    reloadScheduleForCurrentMonth();
  });

  updateLineToggleUI();

  // Отображение легенды цветов при переключении линии
  if (typeof ShiftColors !== 'undefined' && ShiftColors.renderColorLegend) {
    ShiftColors.renderColorLegend(state.ui.currentLine);
  }

}

function updateLineToggleUI() {
  const line = state.ui.currentLine;
  if (!lineTabsEl) return;
  const buttons = lineTabsEl.querySelectorAll('button[data-line]');
  buttons.forEach((b) => {
    if (b.dataset.line === line) b.classList.add("active");
    else b.classList.remove("active");
  });
  const popoverButtons = lineTabsPopoverListEl?.querySelectorAll('button[data-line]') || [];
  popoverButtons.forEach((b) => {
    if (b.dataset.line === line) b.classList.add("active");
    else b.classList.remove("active");
  });
}


function bindHistoryControls() {
  if (btnClearHistoryEl) {
    btnClearHistoryEl.addEventListener("click", () => {
      state.changeHistory = [];
      persistChangeHistory();
      renderChangeLog();
    });
  }

  if (btnSavePyrusEl) {
    btnSavePyrusEl.addEventListener("click", handleSaveToPyrus);
  }
}

function initQuickAssignPanel() {
  renderQuickTemplateOptions();
  syncQuickPanelInputs();
  updateQuickModeToggleUI();

  if (state.ui.quickPanelBound) return;

  quickTemplateSelectEl?.addEventListener("change", () => {
    const val = quickTemplateSelectEl.value;
    state.quickMode.templateId = val ? Number(val) : null;

    const tmpl = getCurrentLineTemplates().find(
      (t) => t.id === state.quickMode.templateId
    );
    if (tmpl?.timeRange) {
      state.quickMode.timeFrom = tmpl.timeRange.start;
      state.quickMode.timeTo = tmpl.timeRange.end;
      syncQuickPanelInputs();
    }
    if (tmpl && typeof tmpl.amount === "number") {
      state.quickMode.amount = tmpl.amount;
      syncQuickPanelInputs();
    }
  });

  quickTimeFromInputEl?.addEventListener("input", (e) => {
    state.quickMode.timeFrom = e.target.value;
  });

  quickTimeToInputEl?.addEventListener("input", (e) => {
    state.quickMode.timeTo = e.target.value;
  });

  quickAmountInputEl?.addEventListener("input", (e) => {
    state.quickMode.amount = e.target.value;
  });

  quickModeToggleEl?.addEventListener("click", () => {
    const currentLine = state.ui.currentLine;
    
    if (state.ui.isScheduleCached) {
      alert("Данные загружаются, редактирование временно недоступно.");
      return;
    }

    if (!canEditLine(currentLine)) {
      alert(`У вас нет прав на редактирование линии ${currentLine}`);
      return;
    }
    
    state.quickMode.enabled = !state.quickMode.enabled;
    updateQuickModeToggleUI();
  });

  state.ui.quickPanelBound = true;
}

function renderQuickTemplateOptions() {
  if (!quickTemplateSelectEl) return;

  const currentLineTemplates = getCurrentLineTemplates();
  const prevSelected = state.quickMode.templateId;

  quickTemplateSelectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Шаблон не выбран";
  quickTemplateSelectEl.appendChild(placeholder);

  currentLineTemplates.forEach((tmpl) => {
    const option = document.createElement("option");
    option.value = String(tmpl.id);
    const timeLabel = tmpl.timeRange
      ? ` (${tmpl.timeRange.start}–${tmpl.timeRange.end})`
      : "";
    option.textContent = `${tmpl.name}${timeLabel}`;
    quickTemplateSelectEl.appendChild(option);
  });

  const hasPrev = currentLineTemplates.some((t) => t.id === prevSelected);
  quickTemplateSelectEl.value = hasPrev ? String(prevSelected) : "";
  state.quickMode.templateId = hasPrev ? prevSelected : null;
}

function syncQuickPanelInputs() {
  if (quickTimeFromInputEl) {
    quickTimeFromInputEl.value = state.quickMode.timeFrom || "";
  }
  if (quickTimeToInputEl) {
    quickTimeToInputEl.value = state.quickMode.timeTo || "";
  }
  if (quickAmountInputEl) {
    quickAmountInputEl.value =
      state.quickMode.amount !== undefined && state.quickMode.amount !== null
        ? state.quickMode.amount
        : "";
  }
}

function updateQuickModeToggleUI() {
  if (!quickModeToggleEl) return;
  quickModeToggleEl.classList.toggle("active", state.quickMode.enabled);
  quickModeToggleEl.textContent = state.quickMode.enabled
    ? "Быстрое назначение: Вкл"
    : "Быстрое назначение";
}

function updateQuickModeForLine() {
  const currentLine = state.ui.currentLine;
  const canEdit = canEditLine(currentLine);
  const isCached = state.ui.isScheduleCached;
  
  if (!canEdit && state.quickMode.enabled) {
    state.quickMode.enabled = false;
    updateQuickModeToggleUI();
  }
  
  if (quickModeToggleEl) {
    quickModeToggleEl.disabled = !canEdit;
    quickModeToggleEl.title = canEdit 
      ? "Включить быстрое назначение смен"
      : isCached
      ? "Данные загружаются, редактирование временно недоступно"
      : `Нет прав на редактирование ${currentLine}`;
  }
  
  if (quickTemplateSelectEl) {
    quickTemplateSelectEl.disabled = !canEdit;
  }
  
  if (quickTimeFromInputEl) {
    quickTimeFromInputEl.disabled = !canEdit;
  }
  
  if (quickTimeToInputEl) {
    quickTimeToInputEl.disabled = !canEdit;
  }
  
  if (quickAmountInputEl) {
    quickAmountInputEl.disabled = !canEdit;
  }
}

function countChangesForLine(line) {
  const { year, monthIndex } = state.monthMeta;
  let count = 0;
  
  const prefix = `${line}-${year}-${monthIndex + 1}-`;
  for (const key in state.localChanges) {
    if (key.startsWith(prefix)) {
      count++;
    }
  }
  
  return count;
}

function updateSaveButtonState() {
  if (!btnSavePyrusEl) return;
  
  const currentLine = state.ui.currentLine;
  const canEdit = canEditLine(currentLine);
  const changesCount = countChangesForLine(currentLine);
  const isCached = state.ui.isScheduleCached;
  
  if (!canEdit) {
    btnSavePyrusEl.textContent = isCached
      ? `Данные загружаются (${currentLine})`
      : `Нет прав на ${currentLine}`;
    btnSavePyrusEl.disabled = true;
    btnSavePyrusEl.title = isCached
      ? "Сейчас отображается кэш, редактирование временно отключено."
      : `У вас только просмотр для линии ${currentLine}`;
  } else if (changesCount === 0) {
    btnSavePyrusEl.textContent = `Нет изменений (${currentLine})`;
    btnSavePyrusEl.disabled = true;
    btnSavePyrusEl.title = `Нет несохранённых изменений для линии ${currentLine}`;
  } else {
    btnSavePyrusEl.textContent = `Сохранить ${currentLine} (${changesCount})`;
    btnSavePyrusEl.disabled = false;
    btnSavePyrusEl.title = `Сохранить ${changesCount} изменений для линии ${currentLine}`;
  }
}

function getQuickModeShift(line) {
  const templates = state.shiftTemplatesByLine[line] || [];
  const tmpl = templates.find((t) => t.id === state.quickMode.templateId);

  let startLocal = state.quickMode.timeFrom;
  let endLocal = state.quickMode.timeTo;

  if ((!startLocal || !endLocal) && tmpl?.timeRange) {
    startLocal = tmpl.timeRange.start;
    endLocal = tmpl.timeRange.end;
  }

  let amount = state.quickMode.amount;
  if (amount === "" || amount === undefined || amount === null) {
    amount = tmpl?.amount ?? 0;
  }

  return {
    startLocal,
    endLocal,
    amount: Number(amount || 0),
    templateId: tmpl?.id ?? null,
    specialShortLabel: tmpl?.specialShortLabel || null,
  };
}

function resolveSpecialShortLabel(line, templateId) {
  if (!line || templateId == null) return null;
  const templates = state.shiftTemplatesByLine[line] || [];
  const tmpl = templates.find((t) => t.id === templateId);
  return tmpl?.specialShortLabel || null;
}

function logChange({
  action,
  line,
  employeeId,
  employeeName,
  day,
  previousShift,
  nextShift,
}) {
  const { year, monthIndex } = state.monthMeta;
  const date = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(
    2,
    "0"
  )}`;
  const entry = {
    id: `${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    action,
    line,
    employeeId,
    employeeName,
    date,
    previousShift: previousShift
      ? {
          startLocal: previousShift.startLocal || "",
          endLocal: previousShift.endLocal || "",
          amount: Number(previousShift.amount || 0),
        }
      : null,
    nextShift: nextShift
      ? {
          startLocal: nextShift.startLocal || "",
          endLocal: nextShift.endLocal || "",
          amount: Number(nextShift.amount || 0),
        }
      : null,
  };

  state.changeHistory.unshift(entry);
  if (state.changeHistory.length > 300) {
    state.changeHistory.length = 300;
  }

  persistChangeHistory();
  renderChangeLog();
  updateSaveButtonState();
}

function shiftsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const normalizeAmount = (val) => Number(val || 0);
  const normalizeTemplate = (val) => (val != null ? Number(val) : null);
  const normalizeIso = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : t;
  };

  const normDuration = (shift) => {
    if (shift?.durationMinutes != null) return Number(shift.durationMinutes);
    const duration = computeDurationMinutes(
      shift?.startLocal,
      shift?.endLocal
    );
    return duration == null ? null : duration;
  };

  return (
    (a.startLocal || "") === (b.startLocal || "") &&
    (a.endLocal || "") === (b.endLocal || "") &&
    normalizeAmount(a.amount) === normalizeAmount(b.amount) &&
    normalizeTemplate(a.templateId) === normalizeTemplate(b.templateId) &&
    normalizeIso(a.startUtcIso) === normalizeIso(b.startUtcIso) &&
    normalizeIso(a.endUtcIso) === normalizeIso(b.endUtcIso) &&
    normDuration(a) === normDuration(b)
  );
}

function buildPyrusChangesPayload(lineToSave = null) {
  const result = {
    create: { task: [] },
    deleted: { task: [] },
    edit: { task: [] },
  };

  const linesToProcess = lineToSave ? [lineToSave] : ["OP", "OV", "L1", "L2", "AI", "OU"];

  for (const line of linesToProcess) {
    const baseSched = state.originalScheduleByLine[line];
    const currentSched = state.scheduleByLine[line];
    if (!currentSched || !currentSched.days || !currentSched.rows) continue;

    const baseRowByEmployee = Object.create(null);
    if (baseSched && Array.isArray(baseSched.rows)) {
      for (const row of baseSched.rows) {
        baseRowByEmployee[row.employeeId] = row;
      }
    }

    currentSched.rows.forEach((row) => {
      const baseRow = baseRowByEmployee[row.employeeId];

      const employee = state.employeesByLine.ALL.find((e) => e.id === row.employeeId) || null;
      const departmentItemId = employee ? resolvePyrusLineItemIdByDepartmentId(employee.departmentId) : null;

      currentSched.days.forEach((day, idx) => {
        const baseShift = baseRow ? baseRow.shiftsByDay[idx] || null : null;
        const currentShift = row.shiftsByDay[idx] || null;

        if (!baseShift && !currentShift) return;

        if (!baseShift && currentShift) {
          const conversion =
            currentShift.startUtcIso && currentShift.durationMinutes != null
              ? {
                  startUtcIso: currentShift.startUtcIso,
                  durationMinutes: Number(currentShift.durationMinutes),
                }
              : convertLocalRangeToUtc(
                  day,
                  currentShift.startLocal,
                  currentShift.endLocal
                );
          if (!conversion) return;

          result.create.task.push({
            employee_id: row.employeeId,
            item_id: currentShift.templateId ?? null,
            start: conversion.startUtcIso,
            duration: conversion.durationMinutes,
            amount: Number(currentShift.amount || 0),
            department_item_id: departmentItemId,
          });
          return;
        }

        if (baseShift && !currentShift) {
          if (baseShift.taskId) {
            result.deleted.task.push({ task_id: baseShift.taskId });
          }
          return;
        }

        if (baseShift && currentShift && !shiftsEqual(baseShift, currentShift)) {
          const conversion =
            currentShift.startUtcIso && currentShift.durationMinutes != null
              ? {
                  startUtcIso: currentShift.startUtcIso,
                  durationMinutes: Number(currentShift.durationMinutes),
                }
              : convertLocalRangeToUtc(
                  day,
                  currentShift.startLocal,
                  currentShift.endLocal
                );
          if (!conversion) return;

          result.edit.task.push({
            task_id: baseShift.taskId,
            employee_id: row.employeeId,
            item_id: currentShift.templateId ?? baseShift.templateId ?? null,
            start: conversion.startUtcIso,
            duration: conversion.durationMinutes,
            amount: Number(currentShift.amount || 0),
            department_item_id: departmentItemId,
          });
        }
      });
    });
  }

  return result;
}

async function handleSaveToPyrus() {
  if (!btnSavePyrusEl) return;

  const currentLine = state.ui.currentLine;
  
  if (!canEditLine(currentLine)) {
    alert(`У вас нет прав на сохранение изменений для линии ${currentLine}`);
    return;
  }

  const payload = buildPyrusChangesPayload(currentLine);
  
  const hasChanges = 
    payload.create.task.length > 0 ||
    payload.deleted.task.length > 0 ||
    payload.edit.task.length > 0;
  
  if (!hasChanges) {
    alert(`Нет изменений для сохранения в линии ${currentLine}`);
    return;
  }
  
  btnSavePyrusEl.disabled = true;
  btnSavePyrusEl.textContent = "Сохранение...";

  try {
    const meta = {
      line: currentLine,
      month: state.monthMeta.monthIndex + 1,
      year: state.monthMeta.year,
    };
    
    await graphClient.callGraphApi("pyrus_save", { changes: payload, meta });
    showAppToast(
      `Pyrus: ${currentLine} ? ??????? ${payload.create.task.length}, ???????? ${payload.edit.task.length}, ??????? ${payload.deleted.task.length}`
    );
    
    state.originalScheduleByLine[currentLine] = deepClone(state.scheduleByLine[currentLine]);
    
    const { year, monthIndex } = state.monthMeta;
    const prefix = `${currentLine}-${year}-${monthIndex + 1}-`;
    for (const key in state.localChanges) {
      if (key.startsWith(prefix)) {
        delete state.localChanges[key];
      }
    }
    persistLocalChanges();
    
    updateSaveButtonState();

    const monthKey = getMonthKey(state.monthMeta.year, state.monthMeta.monthIndex);
    scheduleService.invalidateMonthSchedule(monthKey);
    await reloadScheduleForCurrentMonth();
    
  } catch (err) {
    console.error("handleSaveToPyrus error", err);
    alert(`Не удалось отправить в Pyrus: ${err.message || err}`);
  } finally {
    btnSavePyrusEl.disabled = false;
    btnSavePyrusEl.textContent = "Сохранить в Pyrus";
  }
}

function renderChangeLog() {
  if (!changeLogListEl) return;

  changeLogListEl.innerHTML = "";

  if (!state.changeHistory.length) {
    changeLogListEl.textContent = "Пока нет локальных изменений";
    changeLogListEl.classList.add("change-log-empty");
    return;
  }

  changeLogListEl.classList.remove("change-log-empty");
  const actionLabels = {
    create: "Добавлена смена",
    update: "Изменена смена",
    delete: "Удалена смена",
  };

  const formatShift = (shift) => {
    if (!shift) return "—";
    const amountLabel = shift.amount ? `${shift.amount.toLocaleString("ru-RU")} ₽` : "";
    return `${shift.startLocal}–${shift.endLocal}${amountLabel ? ` · ${amountLabel}` : ""}`;
  };

  state.changeHistory.forEach((entry) => {
    const wrapper = document.createElement("div");
    wrapper.className = "change-log-entry";

    const title = document.createElement("div");
    const actionLabel = actionLabels[entry.action] || "Изменение";
    const time = new Date(entry.timestamp).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
    title.textContent = `${actionLabel} • ${entry.date} • ${time}`;

    const details = document.createElement("div");
    details.textContent = `${entry.employeeName} (${entry.line})`;

    const shiftLine = document.createElement("div");
    shiftLine.textContent = `Было: ${formatShift(entry.previousShift)} → Стало: ${formatShift(
      entry.nextShift
    )}`;

    wrapper.appendChild(title);
    wrapper.appendChild(details);
    wrapper.appendChild(shiftLine);
    changeLogListEl.appendChild(wrapper);
  });
}

function handleShiftCellClick({ line, row, day, dayIndex, shift, cellEl }) {
  if (!canEditLine(line)) {
    openShiftPopoverReadOnly(
      {
        line,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        day,
        shift: shift || null,
      },
      cellEl
    );
    return;
  }

  if (state.quickMode.enabled) {
    const { startLocal, endLocal, amount, templateId, specialShortLabel } =
      getQuickModeShift(line);

    // input[type=time] принимает только HH:MM, поэтому нормализуем,
    // иначе браузер может вернуть пустое значение и дальше сломается конвертация.
    const normStartLocal = normalizeTimeHHMM(startLocal);
    const normEndLocal = normalizeTimeHHMM(endLocal);

    if (!normStartLocal || !normEndLocal) {
      alert(
        "Укажите время начала и конца смены в панели быстрого назначения."
      );
      return;
    }

    const { year, monthIndex } = state.monthMeta;
    const sched = state.scheduleByLine[line];
    const resolvedDayIndex =
      typeof dayIndex === "number" && dayIndex >= 0
        ? dayIndex
        : sched?.days?.indexOf(day);
    const previousShift =
      resolvedDayIndex != null && resolvedDayIndex >= 0
        ? row.shiftsByDay[resolvedDayIndex]
        : null;

    const key = `${line}-${year}-${monthIndex + 1}-${row.employeeId}-${day}`;
	    // Важно: в быстрых кликах используем year/monthIndex из текущего выбранного месяца,
	    // иначе state.monthMeta может быть неинициализирован/рассинхронизирован.
    const conversion = convertLocalRangeToUtcWithMeta(
      year,
      monthIndex,
      day,
      normStartLocal,
      normEndLocal
    );
	    if (!conversion) {
	      alert("Некорректное время смены. Проверьте формат (например 08:00–20:00)." );
	      return;
	    }
    state.localChanges[key] = {
      startLocal: normStartLocal,
      endLocal: normEndLocal,
      amount,
      templateId,
      specialShortLabel,
	      startUtcIso: conversion.startUtcIso,
	      endUtcIso: conversion.endUtcIso,
	      durationMinutes: conversion.durationMinutes,
    };
    persistLocalChanges();

    applyLocalChangesToSchedule();
    renderScheduleCurrentLine();
    logChange({
      action: previousShift ? "update" : "create",
      line,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      day,
      previousShift: previousShift || null,
      nextShift: {
        startLocal: normStartLocal,
        endLocal: normEndLocal,
        amount,
        specialShortLabel,
      },
    });
    return;
  }

  openShiftPopover(
    {
      line,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      day,
      shift: shift || null,
    },
    cellEl
  );
}

// -----------------------------
// Загрузка данных
// -----------------------------

async function loadInitialData() {
  try {
    const { year, monthIndex } = state.monthMeta;
    const hadCachedEmployees = loadCachedEmployees();
    const hadCachedTemplates = loadCachedShiftTemplates();
    const hadCachedSchedule = loadCachedScheduleForMonth(year, monthIndex);

    if (hadCachedTemplates) {
      initQuickAssignPanel();
    }

    if (hadCachedSchedule) {
      updateSaveButtonState();
      updateQuickModeForLine();
      if (typeof ShiftColors !== "undefined" && ShiftColors.renderColorLegend) {
        ShiftColors.renderColorLegend(state.ui.currentLine);
      }
    }

    await loadEmployees();
    await loadShiftsCatalog();
    initQuickAssignPanel();
    await reloadScheduleForCurrentMonth();
    updateSaveButtonState();
    updateQuickModeForLine();

    // Отображение легенды цветов после загрузки данных
    if (typeof ShiftColors !== 'undefined' && ShiftColors.renderColorLegend) {
      ShiftColors.renderColorLegend(state.ui.currentLine);
    }
  } catch (err) {
    console.error("loadInitialData error:", err);
  }
}

async function loadEmployees() {
  const data = await membersService.getMembers();

  if (data.employeesByLine) {
    state.employeesByLine.L1 = data.employeesByLine.L1 || [];
    state.employeesByLine.L2 = data.employeesByLine.L2 || [];
    const membersSource = Object.values(data.employeesByLine || {}).flat();
    setMembersByEmail(membersSource);
    return;
  }

  const members = data.members || [];
  const employeesByLine = { ALL: [], OP: [], OV: [], L1: [], L2: [], AI: [], OU: [] };
  setMembersByEmail(members);

// Жёсткая маршрутизация по department_id (и отдельный TOP для вкладки "ВСЕ")
for (const m of members) {
  if (m.banned) continue;

  const deptIdRaw = m.department_id;
  const deptId = deptIdRaw != null ? Number(deptIdRaw) : null;

  const employee = {
    id: m.id,
    fullName: `${m.last_name || ""} ${m.first_name || ""}`.trim(),
    email: m.email || "",
    departmentName: m.department_name || "",
    departmentId: deptId,
    avatarId: m.avatar_id || null,
    phone: m.phone || "",
    position: m.position || "",
    birthDay:
      m.birth_date && typeof m.birth_date.day === "number"
        ? m.birth_date.day
        : m.birth_date && m.birth_date.day
        ? Number(m.birth_date.day)
        : null,
    birthMonth:
      m.birth_date && typeof m.birth_date.month === "number"
        ? m.birth_date.month
        : m.birth_date && m.birth_date.month
        ? Number(m.birth_date.month)
        : null,
  };

  // ALL: добавляем всех
  employeesByLine.ALL.push(employee);

  // Остальные вкладки: по deptId
  if (deptId != null) {
    if (LINE_DEPT_IDS.L1.includes(deptId)) employeesByLine.L1.push(employee);
    if (LINE_DEPT_IDS.L2.includes(deptId)) employeesByLine.L2.push(employee);
    if (LINE_DEPT_IDS.OV.includes(deptId)) employeesByLine.OV.push(employee);
    if (LINE_DEPT_IDS.OP.includes(deptId)) employeesByLine.OP.push(employee);
    if (LINE_DEPT_IDS.OU.includes(deptId)) employeesByLine.OU.push(employee);
    if (LINE_DEPT_IDS.AI.includes(deptId)) employeesByLine.AI.push(employee);
  }
}

const sortEmployeesByName = (arr) =>
  arr.sort((a, b) => a.fullName.localeCompare(b.fullName, "ru"));

const sortEmployeesByDeptOrder = (arr, deptOrder) => {
  const orderIndex = new Map(deptOrder.map((id, idx) => [Number(id), idx]));
  return arr.sort((a, b) => {
    const ai = orderIndex.has(a.departmentId)
      ? orderIndex.get(a.departmentId)
      : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.departmentId)
      ? orderIndex.get(b.departmentId)
      : Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.fullName.localeCompare(b.fullName, "ru");
  });
};

// "ВСЕ": сначала TOP_MANAGEMENT_IDS, затем отделы в заданном порядке
const ALL_DEPT_ORDER = [
  ...LINE_DEPT_IDS.OP,
  ...LINE_DEPT_IDS.OV,
  ...LINE_DEPT_IDS.L1,
  ...LINE_DEPT_IDS.L2,
  ...LINE_DEPT_IDS.AI,
  ...LINE_DEPT_IDS.OU,
];

const topIndex = new Map(TOP_MANAGEMENT_IDS.map((id, idx) => [Number(id), idx]));
const allDeptIndex = new Map(ALL_DEPT_ORDER.map((id, idx) => [Number(id), idx]));

employeesByLine.ALL.sort((a, b) => {
  const at = topIndex.has(a.id) ? topIndex.get(a.id) : null;
  const bt = topIndex.has(b.id) ? topIndex.get(b.id) : null;
  if (at != null || bt != null) {
    if (at == null) return 1;
    if (bt == null) return -1;
    return at - bt;
  }

  const ai = a.departmentId != null && allDeptIndex.has(a.departmentId) ? allDeptIndex.get(a.departmentId) : Number.MAX_SAFE_INTEGER;
  const bi = b.departmentId != null && allDeptIndex.has(b.departmentId) ? allDeptIndex.get(b.departmentId) : Number.MAX_SAFE_INTEGER;
  if (ai !== bi) return ai - bi;

  // неизвестные dept -> внизу, по имени
  return a.fullName.localeCompare(b.fullName, "ru");
});

state.employeesByLine.ALL = employeesByLine.ALL;
state.employeesByLine.OP = sortEmployeesByDeptOrder(employeesByLine.OP, DEPT_ORDER_BY_LINE.OP);
state.employeesByLine.OV = sortEmployeesByName(employeesByLine.OV);
state.employeesByLine.L1 = sortEmployeesByName(employeesByLine.L1);
state.employeesByLine.L2 = sortEmployeesByDeptOrder(employeesByLine.L2, DEPT_ORDER_BY_LINE.L2);
state.employeesByLine.AI = sortEmployeesByName(employeesByLine.AI);
state.employeesByLine.OU = sortEmployeesByName(employeesByLine.OU);

persistCachedEmployees();
}

async function loadShiftsCatalog() {
  const data = await catalogsService.getShiftsCatalog({ catalogId: PYRUS_CATALOG_IDS.shifts });

  const catalog = Array.isArray(data) ? data[0] : data;
  if (!catalog) return;

  const headers = catalog.catalog_headers || [];
  const items = catalog.items || [];

  const colIndexByName = {};
  headers.forEach((h, idx) => {
    colIndexByName[h.name] = idx;
  });

  const idxName = colIndexByName["Название смены"];
  const idxTime = colIndexByName["время смены"];
  const idxAmount = colIndexByName["Сумма за смену"];
  const idxDept = colIndexByName["Отдел"];

  const templatesByLine = { ALL: [], OP: [], OV: [], L1: [], L2: [], AI: [], OU: [] };

  // "Отдел" в справочнике смен может быть списком: "L1, L2, OP, OV".
  // Поддерживаем также старые форматы (через "/") и русские сокращения (ОВ/ОП/ОУ/ВСЕ).
  function parseDeptTokens(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[,/]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const u = s.toUpperCase();
        if (u === "ОВ") return "OV";
        if (u === "ОП") return "OP";
        if (u === "ОУ") return "OU";
        if (u === "ВСЕ") return "ALL";
        return u;
      });
  }

  for (const item of items) {
    const values = item.values || [];
    const name = idxName != null ? values[idxName] : "";
    const timeRaw = idxTime != null ? values[idxTime] : "";
    const amount = idxAmount != null ? Number(values[idxAmount] || 0) : 0;
    const dept = idxDept != null ? String(values[idxDept] || "") : "";

    const timeRange = parseShiftTimeRangeString(timeRaw);

    const normalizedName = String(name || "").trim().toUpperCase();
    const specialShortLabel = ["ВЫХ", "ОТП", "ДР"].includes(normalizedName)
      ? normalizedName
      : null;

    const template = {
      id: item.item_id,
      name,
      timeRaw,
      amount,
      dept,
      timeRange,
      specialShortLabel,
    };

    const tokens = parseDeptTokens(dept);

    const pushTo = (key) => {
      if (templatesByLine[key]) templatesByLine[key].push(template);
    };

    // ALL = показывать смену во всех вкладках/линиях
    const hasAll = tokens.includes("ALL");
    if (hasAll) {
      for (const key of ["ALL", "OP", "OV", "L1", "L2", "AI", "OU"]) pushTo(key);
      continue;
    }

    // Точный матч токенов (без includes), чтобы избежать ложных совпадений.
    if (tokens.includes("L1")) pushTo("L1");
    if (tokens.includes("L2")) pushTo("L2");
    if (tokens.includes("OV")) pushTo("OV");
    if (tokens.includes("OP")) pushTo("OP");
    if (tokens.includes("OU")) pushTo("OU");
    if (tokens.includes("AI")) pushTo("AI");
    // Если по каким-то причинам в справочнике остался токен ALL только для вкладки ВСЕ
    // (без распределения по линиям), его можно явно указать как "ALL".
    if (tokens.includes("ALL")) pushTo("ALL");
  }

  // записываем в state все линии
  for (const key of ["ALL","OP","OV","L1","L2","AI","OU"]) {
    state.shiftTemplatesByLine[key] = templatesByLine[key] || [];
  }

  // Инициализация цветов смен
  if (typeof ShiftColors !== 'undefined' && ShiftColors.initialize) {
    ShiftColors.initialize(state.shiftTemplatesByLine, state.ui.theme);
  }

  persistCachedShiftTemplates();
}



async function reloadScheduleForCurrentMonth() {
  const { year, monthIndex } = state.monthMeta;
  const monthKey = getMonthKey(year, monthIndex);
  const scheduleResult = await scheduleService.loadMonthSchedule(monthKey);
  if (!scheduleResult.isLatest) return;

  // Отпуска: внешняя система, только отображение
  try {
    state.vacationsByEmployee = await vacationsService.getVacationsForMonth(monthKey);
  } catch (e) {
    console.warn('Не удалось загрузить отпуска', e);
    state.vacationsByEmployee = {};
  }

  // Производственный календарь РФ: помесячно (isdayoff.ru), с кэшем и фолбеком на СБ/ВС
  try {
    state.prodCalendar = await prodCalendarService.getProdCalendarForMonth(year, monthIndex);
  } catch (e) {
    console.warn('Не удалось загрузить производственный календарь РФ, используем фолбек СБ/ВС', e);
    state.prodCalendar = null;
  }

  if (monthKey !== getMonthKey(state.monthMeta.year, state.monthMeta.monthIndex)) {
    return;
  }

  const data = scheduleResult.data;
  const wrapper = Array.isArray(data) ? data[0] : data;
  const tasks = (wrapper && wrapper.tasks) || [];

  const scheduleByLine = {
    ALL: { days: [], rows: [], monthKey: null },
    OP: { days: [], rows: [], monthKey: null },
    OV: { days: [], rows: [], monthKey: null },
    L1: { days: [], rows: [], monthKey: null },
    L2: { days: [], rows: [], monthKey: null },
    AI: { days: [], rows: [], monthKey: null },
    OU: { days: [], rows: [], monthKey: null },
  };
  const shiftMapByLine = { ALL: Object.create(null), OP: Object.create(null), OV: Object.create(null), L1: Object.create(null), L2: Object.create(null), AI: Object.create(null), OU: Object.create(null) };

  // "Отдел" в значении смены из справочника может быть списком токенов
  // (например: "L1, L2, OP" или "L1/L2/OP").
  // Нормализуем токены в ключи вкладок.
  const parseDeptTokens = (raw) => {
    if (!raw) return [];
    return String(raw)
      .split(/[,/]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const u = s.toUpperCase();
        if (u === "ОВ") return "OV";
        if (u === "ОП") return "OP";
        if (u === "ОУ") return "OU";
        if (u === "ВСЕ") return "ALL";
        return u;
      });
  };

  const inferLineFromEmployee = (empId) => {
    for (const k of ["OP","OV","L1","L2","AI","OU"]) {
      const list = state.employeesByLine[k] || [];
      if (list.some((e) => e.id === empId)) return k;
    }
    return null;
  };

  const findField = (fields, id) => fields.find((f) => f.id === id);

  for (const task of tasks) {
    const fields = task.fields || [];
    const dueField = findField(fields, PYRUS_FIELD_IDS.smeni?.due);
    const moneyField = findField(fields, PYRUS_FIELD_IDS.smeni?.amount);
    const personField = findField(fields, PYRUS_FIELD_IDS.smeni?.person);
    const shiftFieldId =
      PYRUS_FIELD_IDS.smeni?.shift ?? PYRUS_FIELD_IDS.smeni?.template;
    const shiftField = findField(fields, shiftFieldId);

    if (!dueField || !personField || !shiftField) continue;

    const rawDuration = Number(dueField.duration || 0);
    const startUtcMs = new Date(dueField.value).getTime();
    if (Number.isNaN(startUtcMs)) continue;

    const startUtcIso = new Date(startUtcMs).toISOString();
    const endUtcMs = startUtcMs + rawDuration * 60 * 1000;
    const endUtcIso = new Date(endUtcMs).toISOString();

    const range = convertUtcStartToLocalRange(startUtcIso, rawDuration);
    if (!range) continue;

    const { localDateKey, startLocal, endLocal } = range;
    const [yStr, mStr, dStr] = localDateKey.split("-");
    const y = Number(yStr);
    const m = Number(mStr) - 1;
    const d = Number(dStr);

    if (y !== year || m !== monthIndex) continue;

    const emp = personField.value || {};
    const empId = emp.id;
    if (!empId) continue;

    const shiftCatalog = shiftField.value || {};
    const deptRaw = (shiftCatalog.values && shiftCatalog.values[4]) || "";
    const tokens = parseDeptTokens(deptRaw);

    // Определяем, в какие вкладки раскладывать смену.
    // - ALL => во все вкладки
    // - список токенов => во все соответствующие вкладки
    // - если токены не распознаны => пытаемся вывести по департаменту сотрудника
    let targetLines = [];
    if (tokens.includes("ALL")) {
      targetLines = ["OP","OV","L1","L2","AI","OU"];
    } else {
      targetLines = tokens.filter((t) => shiftMapByLine[t]);
    }
    if (!targetLines.length) {
      const inferred = inferLineFromEmployee(empId);
      if (inferred) targetLines = [inferred];
    }

    const shiftItemId =
      shiftCatalog.item_id != null ? shiftCatalog.item_id : shiftCatalog.id;

    // specialShortLabel может зависеть от вкладки (шаблонов),
    // но для отображения достаточно любого совпадения.
    let matchingTemplate = null;
    for (const l of targetLines) {
      matchingTemplate =
        shiftItemId != null
          ? (state.shiftTemplatesByLine[l] || []).find((t) => t.id === shiftItemId)
          : null;
      if (matchingTemplate) break;
    }
    const specialShortLabel =
      (matchingTemplate && matchingTemplate.specialShortLabel) || null;

    const amount =
      typeof moneyField.value === "number"
        ? moneyField.value
        : Number(moneyField.value || 0);

    const entry = {
      startLocal,
      endLocal,
      amount,
      templateId: shiftItemId,
      taskId: task.id,
      rawDueValue: dueField.value,
      rawDuration,
      durationMinutes: rawDuration,
      startUtcIso,
      endUtcIso,
      rawShift: shiftCatalog,
      specialShortLabel,
    };

    const putToMap = (key) => {
      const map = shiftMapByLine[key];
      if (!map) return;
      if (!map[empId]) map[empId] = {};
      map[empId][d] = entry;
    };

    for (const l of targetLines) {
      if (l && shiftMapByLine[l]) putToMap(l);
    }
    // "ВСЕ" всегда содержит весь график
    putToMap("ALL");
  }

  const days = [];
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  for (let d = 1; d <= Math.min(daysInMonth, MAX_DAYS_IN_MONTH); d++) {
    days.push(d);
  }

  for (const line of ["ALL","OP","OV","L1","L2","AI","OU"]) {
    const empList = state.employeesByLine[line] || [];
    const map = shiftMapByLine[line];

    const rows = empList.map((emp) => {
      const shiftsByDay = days.map((d) => {
        const shift = map && map[emp.id] && map[emp.id][d];
        return shift || null;
      });
      return {
        employeeId: emp.id,
        employeeName: emp.fullName,
        birthDay: emp.birthDay ?? null,
        birthMonth: emp.birthMonth ?? null,
        shiftsByDay,
      };
    });

    scheduleByLine[line] = { monthKey, days, rows };
  }

  state.originalScheduleByLine = deepClone(scheduleByLine);
  state.scheduleByLine = scheduleByLine;
  state.ui.isScheduleCached = false;
  persistCachedScheduleForMonth(year, monthIndex);
  applyLocalChangesToSchedule();
  renderScheduleCurrentLine();
}

// -----------------------------
// Рендер таблицы
// -----------------------------

function applyEmployeeFilterToTable(table, hiddenIds, emptyRowEl) {
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  const dataRows = Array.from(tbody.querySelectorAll("tr")).filter(
    (row) => !row.classList.contains("employee-filter-empty")
  );
  let visibleCount = 0;
  for (const row of dataRows) {
    const id = Number(row.dataset.employeeId);
    const shouldHide = hiddenIds.has(id);
    row.classList.toggle("employee-row-hidden", shouldHide);
    if (!shouldHide) visibleCount += 1;
  }
  if (emptyRowEl) {
    emptyRowEl.classList.toggle("hidden", visibleCount > 0);
  }
}

function renderScheduleCurrentLine() {
  closeEmployeeFilterPopover();
  const line = state.ui.currentLine;
  const sched = state.scheduleByLine[line];

  if (!sched || !sched.days || sched.days.length === 0) {
    scheduleRootEl.innerHTML =
      '<div style="padding: 12px; font-size: 13px; color: var(--text-muted);">Нет данных по графику за выбранный месяц.</div>';
    return;
  }

  const canEdit = canEditLine(line);
  const { days, rows } = sched;
  const hiddenEmployeeIds = normalizeHiddenEmployeeIds(line, rows);

  const table = document.createElement("table");
  table.className = "schedule-table";
  
  if (!canEdit) {
    table.classList.add("read-only-mode");
  }

  const thead = document.createElement("thead");
  const headRow1 = document.createElement("tr");
  const headRow2 = document.createElement("tr");

  const thName = document.createElement("th");
  thName.className = "sticky-col employee-header-cell";

  const thNameWrap = document.createElement("div");
  thNameWrap.className = "employee-header";

  const thNameLabel = document.createElement("span");
  thNameLabel.className = "header-text";
  thNameLabel.textContent = "Сотрудник";

  const filterBtn = document.createElement("button");
  filterBtn.type = "button";
  filterBtn.className = "employee-filter-btn";
  filterBtn.setAttribute("aria-label", "Фильтр сотрудников");
  filterBtn.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z"></path></svg>';
  if (hiddenEmployeeIds.size > 0) filterBtn.classList.add("active");

  const updateFilterButtonState = () => {
    filterBtn.classList.toggle("active", hiddenEmployeeIds.size > 0);
  };

  let emptyRow = null;

  filterBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openEmployeeFilterPopover({
      line,
      rows,
      hiddenEmployeeIds,
      table,
      emptyRow,
      onUpdateButton: updateFilterButtonState,
    });
  });

  thNameWrap.appendChild(thNameLabel);
  thNameWrap.appendChild(filterBtn);
  thName.appendChild(thNameWrap);
  headRow1.appendChild(thName);

  const thName2 = document.createElement("th");
  thName2.className = "sticky-col";
  thName2.textContent = "";
  headRow2.appendChild(thName2);

  const weekdayNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const { year, monthIndex } = state.monthMeta;
  const monthKey = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  const dayKindByDay = Object.create(null);

  const prod = state.prodCalendar && state.prodCalendar.monthKey === monthKey ? state.prodCalendar : null;

  for (const day of days) {
    const date = new Date(year, monthIndex, day);
    const weekday = weekdayNames[(date.getDay() + 6) % 7];

    const dayType = prod && prod.dayTypeByDay ? prod.dayTypeByDay[day] : null;
    const isFallbackWeekend = weekday === "Сб" || weekday === "Вс";

    const dayKind = dayType === 1
      ? "weekend"
      : dayType === 8
        ? "holiday"
        : dayType === 2
          ? "preholiday"
          : dayType === 0 || dayType === 4
            ? "workday"
            : dayType == null
              ? (isFallbackWeekend ? "weekend" : "workday")
              : null;

    const th1 = document.createElement("th");
const th1Label = document.createElement("span");
th1Label.className = "header-text";
th1Label.textContent = String(day);
th1.appendChild(th1Label);

    if (dayKind) {
      th1.classList.add(`day-${dayKind}`);
      dayKindByDay[day] = dayKind;
    }
    headRow1.appendChild(th1);

    const th2 = document.createElement("th");
    const th2Label = document.createElement("span");
    th2Label.className = "header-text";
    th2Label.textContent = weekday;
    th2.appendChild(th2Label);
    th2.className = "weekday-header";
    if (dayKind) {
      th2.classList.add(`day-${dayKind}`);
    }
    headRow2.appendChild(th2);
  }

  const thCount1 = document.createElement("th");
  const thCount1Label = document.createElement("span");
  thCount1Label.className = "header-text";
  thCount1Label.textContent = "кол-во";
  thCount1.appendChild(thCount1Label);
  thCount1.className = "summary-cell";
  headRow1.appendChild(thCount1);

  const thCount2 = document.createElement("th");
  thCount2.textContent = "";
  thCount2.className = "summary-cell";
  headRow2.appendChild(thCount2);

  const thSum1 = document.createElement("th");
  const thSum1Label = document.createElement("span");
  thSum1Label.className = "header-text";
  thSum1Label.textContent = "Сумма";
  thSum1.appendChild(thSum1Label);
  thSum1.className = "summary-cell";
  headRow1.appendChild(thSum1);

  const thSum2 = document.createElement("th");
  thSum2.textContent = "";
  thSum2.className = "summary-cell";
  headRow2.appendChild(thSum2);

  thead.appendChild(headRow1);
  thead.appendChild(headRow2);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.employeeId = String(row.employeeId);

    const tdName = document.createElement("td");
    tdName.className = "sticky-col employee-name";
    tdName.textContent = row.employeeName;
    tr.appendChild(tdName);

    let totalAmount = 0;
    let totalShifts = 0;

    const vacations = state.vacationsByEmployee[row.employeeId] || [];
    const vacationStarts = Object.create(null);
    for (const v of vacations) {
      if (v && typeof v.startDay === "number") {
        vacationStarts[v.startDay] = v;
      }
    }

    // День рождения (ежегодно): показываем в текущем месяце, если есть day/month.
    const birthdayDayThisMonth =
      row.birthMonth && row.birthDay && row.birthMonth === monthIndex + 1
        ? row.birthDay
        : null;

    let dayIndex = 0;
    while (dayIndex < row.shiftsByDay.length) {
      const dayNumber = sched.days[dayIndex];
      const vac = vacationStarts[dayNumber];

      if (vac) {
        const len = Math.max(1, (vac.endDayExclusive || (vac.startDay + 1)) - vac.startDay);

        const td = document.createElement("td");
        td.className = "shift-cell vacation-cell";
        td.colSpan = len;

        const pill = document.createElement("div");
        pill.className = "vacation-pill";
        // Текст внутри полосы (оставляем как метку, но не мешаем бейджам поверх)
        const vacLabel = document.createElement("span");
        vacLabel.className = "vacation-label";
        vacLabel.textContent = "ОТП";
        pill.title = `Отпуск: с ${vac.startLabel} по ${vac.endLabel}`;

        pill.appendChild(vacLabel);

        // Если день рождения попадает внутрь отпуска (в текущем месяце) —
        // показываем маркер "ДР" поверх отпускной полосы.
        if (
          typeof birthdayDayThisMonth === "number" &&
          birthdayDayThisMonth >= vac.startDay &&
          birthdayDayThisMonth < (vac.endDayExclusive || vac.startDay + 1)
        ) {
          const b = document.createElement("div");
          b.className = "birthday-pill birthday-pill-in-vacation";
          b.textContent = "ДР";
          const leftPercent = ((birthdayDayThisMonth - vac.startDay) + 0.5) / len * 100;
          b.style.left = `${leftPercent}%`;
          b.title = `День рождения: ${formatBirthdayLabel(birthdayDayThisMonth, monthIndex + 1)}`;
          b.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openBirthdayPopover(
              {
                employeeName: row.employeeName,
                dateLabel: formatBirthdayLabel(birthdayDayThisMonth, monthIndex + 1),
              },
              b
            );
          });
          pill.appendChild(b);
        }

        td.appendChild(pill);

        td.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openVacationPopover(
            {
              employeeName: row.employeeName,
              startLabel: vac.startLabel,
              endLabel: vac.endLabel,
            },
            td
          );
        });

        td.addEventListener("mouseenter", () => {
          tr.classList.add("row-hover");
        });
        td.addEventListener("mouseleave", () => {
          tr.classList.remove("row-hover");
        });

        tr.appendChild(td);
        dayIndex += len;
        continue;
      }

      const shift = row.shiftsByDay[dayIndex];

      const td = document.createElement("td");
      td.className = "shift-cell";
      const dayKind = dayKindByDay[dayNumber];
      if (dayKind) {
        td.classList.add(`day-${dayKind}`);
      }

      // Маркер дня рождения (один день). Показываем даже если в этот день есть смена.
      if (typeof birthdayDayThisMonth === "number" && birthdayDayThisMonth === dayNumber) {
        const b = document.createElement("div");
        b.className = "birthday-pill";
        b.textContent = "ДР";
        b.title = `День рождения: ${formatBirthdayLabel(dayNumber, monthIndex + 1)}`;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openBirthdayPopover(
            {
              employeeName: row.employeeName,
              dateLabel: formatBirthdayLabel(dayNumber, monthIndex + 1),
            },
            b
          );
        });
        td.appendChild(b);
      }

      if (shift) {
        td.classList.add("has-shift");
        const pill = document.createElement("div");
        pill.className = "shift-pill";

        // Применение цвета к pill
        if (typeof ShiftColors !== 'undefined' && ShiftColors.applyColorToPill && shift.templateId) {
          ShiftColors.applyColorToPill(pill, shift.templateId, line);
        }

        if (shift.specialShortLabel) {
          pill.classList.add("special");
          const label = document.createElement("div");
          label.className = "shift-special-label";
          label.textContent = shift.specialShortLabel;
          pill.appendChild(label);
        } else {
          const line1 = document.createElement("div");
          line1.className = "shift-time-line start";
          line1.textContent = shift.startLocal;

          const line2 = document.createElement("div");
          line2.className = "shift-time-line end";
          line2.textContent = shift.endLocal;

          pill.appendChild(line1);
          pill.appendChild(line2);
        }
        td.appendChild(pill);

        totalAmount += shift.amount || 0;
        totalShifts += 1;
      } else {
        td.classList.add("empty-shift");
      }

      const clickDay = dayNumber;
      const clickDayIndex = dayIndex;
      td.addEventListener("click", () => {
        handleShiftCellClick({
          line,
          row,
          day: clickDay,
          dayIndex: clickDayIndex,
          shift: shift || null,
          cellEl: td,
        });
      });

      td.addEventListener("mouseenter", () => {
        tr.classList.add("row-hover");
      });
      td.addEventListener("mouseleave", () => {
        tr.classList.remove("row-hover");
      });

      tr.appendChild(td);
      dayIndex += 1;
    }


    const tdCount = document.createElement("td");
    tdCount.className = "summary-cell";
    tdCount.textContent = totalShifts > 0 ? String(totalShifts) : "";
    tr.appendChild(tdCount);

    const tdSum = document.createElement("td");
    tdSum.className = "summary-cell";
    tdSum.textContent =
      totalAmount > 0 ? `${totalAmount.toLocaleString("ru-RU")} ₽` : "";
    tr.appendChild(tdSum);

    tbody.appendChild(tr);
  });

  emptyRow = document.createElement("tr");
  emptyRow.className = "employee-filter-empty hidden";
  const emptyCell = document.createElement("td");
  emptyCell.colSpan = days.length + 3;
  emptyCell.textContent = "Нет сотрудников для отображения по фильтру.";
  emptyRow.appendChild(emptyCell);
  tbody.appendChild(emptyRow);

  table.appendChild(tbody);
  scheduleRootEl.innerHTML = "";
  scheduleRootEl.appendChild(table);
  updateFilterButtonState();
  applyEmployeeFilterToTable(table, hiddenEmployeeIds, emptyRow);
}

// -----------------------------
// Поповер смены
// -----------------------------

function createShiftPopover() {
  shiftPopoverBackdropEl = document.createElement("div");
  shiftPopoverBackdropEl.className = "shift-popover-backdrop hidden";

  shiftPopoverEl = document.createElement("div");
  shiftPopoverEl.className = "shift-popover hidden";

  shiftPopoverBackdropEl.addEventListener("click", () => {
    closeShiftPopover();
  });

  document.body.appendChild(shiftPopoverBackdropEl);
  document.body.appendChild(shiftPopoverEl);
}

function resolveTemplateName(line, templateId) {
  if (!line || templateId == null) return null;
  const templates = state.shiftTemplatesByLine[line] || [];
  const template = templates.find((tmpl) => tmpl.id === templateId);
  return template ? template.name : null;
}

function resolveShiftDisplayName(line, templateId, specialShortLabel) {
  const templateName = resolveTemplateName(line, templateId);
  if (templateName) return templateName;
  if (specialShortLabel) return specialShortLabel;
  if (templateId != null) return `Шаблон #${templateId}`;
  return "Ручная смена";
}

function updateShiftPopoverName(line, templateId, specialShortLabel, showManual = false) {
  const nameEl = shiftPopoverEl?.querySelector("#shift-popover-shift-name");
  if (!nameEl) return;
  if (templateId == null && !specialShortLabel && !showManual) {
    nameEl.textContent = "";
    return;
  }
  nameEl.textContent = resolveShiftDisplayName(line, templateId, specialShortLabel);
}

function positionShiftPopover(anchorEl) {
  if (!shiftPopoverEl || !anchorEl) return;

  const rect = anchorEl.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  shiftPopoverEl.style.left = "0px";
  shiftPopoverEl.style.top = "0px";

  const popoverRect = shiftPopoverEl.getBoundingClientRect();
  const popoverWidth = popoverRect.width || 420;
  const popoverHeight = popoverRect.height || 260;

  let left = rect.left + 8;
  let top = rect.bottom + 8;

  if (left + popoverWidth > viewportWidth - 16) {
    left = viewportWidth - popoverWidth - 16;
  }

  const fitsBelow = top + popoverHeight <= viewportHeight - 16;
  const fitsAbove = rect.top - popoverHeight - 8 >= 16;

  if (!fitsBelow && fitsAbove) {
    top = rect.top - popoverHeight - 8;
  }

  left = Math.max(16, Math.min(left, viewportWidth - popoverWidth - 16));
  top = Math.max(16, Math.min(top, viewportHeight - popoverHeight - 16));

  shiftPopoverEl.style.left = `${left}px`;
  shiftPopoverEl.style.top = `${top}px`;
}

function closeShiftPopover() {
  if (!shiftPopoverEl) return;

  shiftPopoverEl.classList.remove("open");
  shiftPopoverBackdropEl.classList.add("hidden");

  if (shiftPopoverKeydownHandler) {
    document.removeEventListener("keydown", shiftPopoverKeydownHandler);
    shiftPopoverKeydownHandler = null;
  }

  setTimeout(() => {
    shiftPopoverEl.classList.add("hidden");
    shiftPopoverEl.innerHTML = "";
  }, 140);
}

function formatBirthdayLabel(day, month) {
  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${dd}.${mm}`;
}

function openBirthdayPopover(context, anchorEl) {
  const { employeeName, dateLabel } = context;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">День рождения • только просмотр</div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Дата</div>
        <div class="field-row"><label>день:</label><div>${dateLabel}</div></div>
      </div>
      <div class="shift-popover-note">Данные дня рождения загружаются из списка сотрудников и не редактируются здесь.</div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-birthday">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  positionShiftPopover(anchorEl);

  const closeBtn = shiftPopoverEl.querySelector(".shift-popover-close");
  const closeBtn2 = shiftPopoverEl.querySelector("#shift-btn-close-birthday");
  const doClose = () => closeShiftPopover();
  if (closeBtn) closeBtn.addEventListener("click", doClose);
  if (closeBtn2) closeBtn2.addEventListener("click", doClose);

  shiftPopoverKeydownHandler = (ev) => {
    if (ev.key === "Escape") doClose();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });
}



function openVacationPopover(context, anchorEl) {
  const { employeeName, startLabel, endLabel } = context;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">Отпуск • только просмотр</div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Период</div>
        <div class="field-row"><label>с:</label><div>${startLabel}</div></div>
        <div class="field-row"><label>по:</label><div>${endLabel}</div></div>
      </div>
      <div class="shift-popover-note">Отпуск загружается из внешней системы и не редактируется здесь.</div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-vacation">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  positionShiftPopover(anchorEl);

  const closeBtn = shiftPopoverEl.querySelector(".shift-popover-close");
  const closeBtn2 = shiftPopoverEl.querySelector("#shift-btn-close-vacation");

  const doClose = () => closeShiftPopover();
  if (closeBtn) closeBtn.addEventListener("click", doClose);
  if (closeBtn2) closeBtn2.addEventListener("click", doClose);

  shiftPopoverKeydownHandler = (ev) => {
    if (ev.key === "Escape") doClose();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });
}
function openShiftPopoverReadOnly(context, anchorEl) {
  const { line, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  
  const dateLabel = `${String(day).padStart(2, "0")}.${String(
    monthIndex + 1
  ).padStart(2, "0")}.${year}`;

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">${dateLabel} • Линия ${line} (только просмотр)</div>
        <div class="shift-popover-shift-name" id="shift-popover-shift-name"></div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      ${shift ? `
        <div class="shift-popover-section">
          <div class="shift-popover-section-title">Информация о смене</div>
          
          <div class="field-row">
            <label>Начало:</label>
            <div>${shift.startLocal || "—"}</div>
          </div>

          <div class="field-row">
            <label>Окончание:</label>
            <div>${shift.endLocal || "—"}</div>
          </div>

          <div class="field-row">
            <label>Сумма:</label>
            <div>${shift.amount ? shift.amount.toLocaleString('ru-RU') + ' ₽' : "—"}</div>
          </div>
        </div>
      ` : `
        <div class="shift-popover-note">
          Смена не назначена. У вас нет прав на редактирование.
        </div>
      `}
    </div>

    <div class="shift-popover-footer">
      <button class="btn" type="button" id="shift-btn-close-readonly">Закрыть</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  updateShiftPopoverName(
    line,
    shift?.templateId ?? null,
    shift?.specialShortLabel,
    Boolean(shift)
  );
  positionShiftPopover(anchorEl);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-close-readonly")
    .addEventListener("click", closeShiftPopover);

  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

function openShiftPopover(context, anchorEl) {
  const { line, employeeId, employeeName, day, shift } = context;
  const { year, monthIndex } = state.monthMeta;
  const date = new Date(year, monthIndex, day);
  const hasShift = Boolean(shift);
  let selectedTemplateId = shift?.templateId ?? null;

  const dateLabel = `${String(day).padStart(2, "0")}.${String(
    monthIndex + 1
  ).padStart(2, "0")}.${year}`;

  const templates = state.shiftTemplatesByLine[line] || [];

  shiftPopoverEl.innerHTML = `
    <div class="shift-popover-header">
      <div>
        <div class="shift-popover-title">${employeeName}</div>
        <div class="shift-popover-subtitle">${dateLabel} • Линия ${line}</div>
        <div class="shift-popover-shift-name" id="shift-popover-shift-name"></div>
      </div>
      <button class="shift-popover-close" type="button">✕</button>
    </div>

    <div class="shift-popover-body">
      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Шаблоны смен</div>
        <div class="shift-template-list">
          ${templates
            .map(
              (t) => `
            <button class="shift-template-pill" data-template-id="${t.id}">
              <div class="name">${t.name}</div>
              ${
                t.timeRange
                  ? `<div class="time">${t.timeRange.start}–${t.timeRange.end}</div>`
                  : ""
              }
            </button>
          `
            )
            .join("")}
        </div>
      </div>

      <div class="shift-popover-section">
        <div class="shift-popover-section-title">Ручное редактирование</div>

        <div class="field-row">
          <label>Начало</label>
          <input type="time" id="shift-start-input" value="${
            shift?.startLocal || ""
          }">
        </div>

        <div class="field-row">
          <label>Окончание</label>
          <input type="time" id="shift-end-input" value="${
            shift?.endLocal || ""
          }">
        </div>

        <div class="field-row">
          <label>Сумма</label>
          <input type="number" id="shift-amount-input" value="${
            shift?.amount || ""
          }">
        </div>

        <div class="shift-popover-note">
          Изменения сохраняются в локальном кэше в браузере и не отправляются в Pyrus.
        </div>
      </div>
    </div>

    <div class="shift-popover-footer">
      <button class="btn danger" type="button" id="shift-btn-delete" ${
        hasShift ? "" : "disabled"
      }>Удалить</button>
      <button class="btn" type="button" id="shift-btn-cancel">Отмена</button>
      <button class="btn primary" type="button" id="shift-btn-save">Сохранить локально</button>
    </div>
  `;

  shiftPopoverBackdropEl.classList.remove("hidden");
  shiftPopoverEl.classList.remove("hidden");
  updateShiftPopoverName(
    line,
    selectedTemplateId ?? shift?.templateId,
    shift?.specialShortLabel,
    hasShift
  );
  positionShiftPopover(anchorEl);

  requestAnimationFrame(() => {
    shiftPopoverEl.classList.add("open");
  });

  shiftPopoverEl
    .querySelector(".shift-popover-close")
    .addEventListener("click", closeShiftPopover);
  shiftPopoverEl
    .querySelector("#shift-btn-cancel")
    .addEventListener("click", closeShiftPopover);

  const deleteBtn = shiftPopoverEl.querySelector("#shift-btn-delete");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", () => {
      const key = `${line}-${year}-${monthIndex + 1}-${employeeId}-${day}`;
      state.localChanges[key] = { deleted: true };
      persistLocalChanges();

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      logChange({
        action: "delete",
        line,
        employeeId,
        employeeName,
        day,
        previousShift: shift || null,
        nextShift: null,
      });
      closeShiftPopover();
    });
  }

  shiftPopoverEl
    .querySelectorAll(".shift-template-pill")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-template-id"));
        const tmpl = templates.find((t) => t.id === id);
        if (!tmpl) return;

        selectedTemplateId = id;
        updateShiftPopoverName(line, id, tmpl.specialShortLabel);

        if (tmpl.timeRange) {
          const startInput = document.getElementById("shift-start-input");
          const endInput = document.getElementById("shift-end-input");
          if (startInput && endInput) {
	        startInput.value = normalizeTimeHHMM(tmpl.timeRange.start);
	        endInput.value = normalizeTimeHHMM(tmpl.timeRange.end);
          }
        }

        const amountInput = document.getElementById("shift-amount-input");
        if (amountInput && tmpl.amount) {
          amountInput.value = tmpl.amount;
        }
      });
    });

  shiftPopoverEl
    .querySelector("#shift-btn-save")
    .addEventListener("click", () => {
      const startInput = document.getElementById("shift-start-input");
      const endInput = document.getElementById("shift-end-input");
      const amountInput = document.getElementById("shift-amount-input");

	    const start = normalizeTimeHHMM(startInput.value);
	    const end = normalizeTimeHHMM(endInput.value);
      const amount = Number(amountInput.value || 0);

      const key = `${line}-${year}-${monthIndex + 1}-${employeeId}-${day}`;
      const templateId =
        selectedTemplateId != null ? selectedTemplateId : shift?.templateId;
      const specialShortLabel = resolveSpecialShortLabel(line, templateId);
	      // В поповере всегда есть year/monthIndex выбранного месяца — используем их,
	      // чтобы не ловить RangeError на невалидном state.monthMeta.
	      const conversion = convertLocalRangeToUtcWithMeta(year, monthIndex, day, start, end);
	      if (!conversion) {
	        alert("Некорректное время смены. Проверьте формат (например 08:00–20:00)." );
	        return;
	      }
      state.localChanges[key] = {
        startLocal: start,
        endLocal: end,
        amount,
        templateId,
        specialShortLabel,
	        startUtcIso: conversion.startUtcIso,
	        endUtcIso: conversion.endUtcIso,
	        durationMinutes: conversion.durationMinutes,
      };
      persistLocalChanges();

      applyLocalChangesToSchedule();
      renderScheduleCurrentLine();
      logChange({
        action: shift ? "update" : "create",
        line,
        employeeId,
        employeeName,
        day,
        previousShift: shift || null,
        nextShift: { startLocal: start, endLocal: end, amount, specialShortLabel },
      });
      closeShiftPopover();
    });

  shiftPopoverKeydownHandler = (e) => {
    if (e.key === "Escape") closeShiftPopover();
  };
  document.addEventListener("keydown", shiftPopoverKeydownHandler);
}

function applyLocalChangesToSchedule() {
  for (const line of ["ALL","OP","OV","L1","L2","AI","OU"]) {
    const sched = state.scheduleByLine[line];
    if (!sched || !sched.rows) continue;

    const { year, monthIndex } = state.monthMeta;

    for (const row of sched.rows) {
      sched.days.forEach((day, idx) => {
        const key = `${line}-${year}-${
          monthIndex + 1
        }-${row.employeeId}-${day}`;
        const change = state.localChanges[key];
        if (!change || typeof change !== "object") return;

        if (change.deleted) {
          row.shiftsByDay[idx] = null;
          return;
        }

        const enriched = change.startUtcIso
          ? change
          : convertLocalRangeToUtc(day, change.startLocal, change.endLocal) ||
            change;

        const specialShortLabel =
          change.specialShortLabel ??
          resolveSpecialShortLabel(line, change.templateId ?? row.shiftsByDay[idx]?.templateId);

        if (!row.shiftsByDay[idx]) {
          row.shiftsByDay[idx] = {
            startLocal: change.startLocal,
            endLocal: change.endLocal,
            amount: Number(change.amount || 0),
            templateId: change.templateId ?? null,
            specialShortLabel,
            startUtcIso: enriched.startUtcIso || null,
            endUtcIso: enriched.endUtcIso || null,
            durationMinutes: enriched.durationMinutes ?? null,
          };
        } else {
          row.shiftsByDay[idx].startLocal = change.startLocal;
          row.shiftsByDay[idx].endLocal = change.endLocal;
          row.shiftsByDay[idx].amount = Number(change.amount || 0);
          if (change.templateId != null) {
            row.shiftsByDay[idx].templateId = change.templateId;
          }
          row.shiftsByDay[idx].specialShortLabel = specialShortLabel;
          row.shiftsByDay[idx].startUtcIso = enriched.startUtcIso || null;
          row.shiftsByDay[idx].endUtcIso = enriched.endUtcIso || null;
          row.shiftsByDay[idx].durationMinutes =
            enriched.durationMinutes ?? row.shiftsByDay[idx].durationMinutes;
        }
      });
    }
  }
}

const start = async () => {
  try {
    await init();
  } catch (err) {
    console.error("Init error:", err);
  } finally {
    document.body?.classList.remove("booting");
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);

  // Gradient hover animation handled in CSS.
} else {
  start();
}
