// ==UserScript==
// @name         Shopcity Facebook 广告自动控制器
// @namespace    xh-shopcity
// @version      1.8.14
// @description  新增账户时区0点自动开启零花费暂停广告；保留保护、复核和同步能力。
// @match        https://*.shopcity.vip/admin/conversion*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @connect      open.feishu.cn
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  const API_BASE = 'https://api.shopcity.vip/plugins/ads/api.php?r=facebook-ads/';
  const PLUGIN_API_BASE = 'https://api.shopcity.vip/plugins/ads/api.php?r=';
  const STORAGE_KEY = 'xh_shopcity_fb_controller_v1';
  const LOG_KEY = 'xh_shopcity_fb_controller_logs_v1';
  const MANAGED_KEY = 'xh_shopcity_fb_controller_managed_v1';
  const ZERO_REOPEN_KEY = 'xh_shopcity_fb_controller_zero_reopen_v1';
  const PANEL_POSITION_KEY = 'xh_shopcity_fb_controller_panel_position_v1';
  const FEISHU_SECRET_KEY = 'xh_shopcity_fb_controller_feishu_secret_v1';
  const FEISHU_RECORD_CACHE_KEY = 'xh_shopcity_fb_controller_feishu_records_v1';
  const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
  const CURRENT_VERSION = '1.8.14';
  const SHOP_ID_CHECK_URL = 'https://api.shopcity.vip/sail/seller/check-user';
  const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/harmony-s/sc-fb-auto-controller/master/versions.json';
  const UPDATE_LAST_CHECK_KEY = 'xh_shopcity_fb_controller_update_last_check_v1';
  const UPDATE_MANIFEST_CACHE_KEY = 'xh_shopcity_fb_controller_update_manifest_v1';
  const UPDATE_CHECK_INTERVAL = 12 * 60 * 60 * 1000;
  const MAX_LOGS = 3000;
  const PROTECTION_METRICS = [
    { id: 'fb_purchase_num', label: 'FB成效', keys: ['fb_purchase_num'] },
    { id: 'fb_initiate_checkout', label: 'FB发起结账', keys: ['fb_initiate_checkout', 'fb_initiate_checkout_num', 'fb_checkout_num'] },
    { id: 'fb_add_to_cart', label: 'FB加购', keys: ['fb_add_to_cart'] },
    { id: 'total_order_num', label: '店铺订单数', keys: ['total_order_num'] },
    { id: 'initiate_checkout_uv_num', label: '店铺发起结账数', keys: ['initiate_checkout_uv_num'] },
    { id: 'add_to_cart_uv_num', label: '店铺加购数', keys: ['add_to_cart_uv_num'] },
    { id: 'view_content_uv_num', label: '店铺商详访客数', keys: ['view_content_uv_num', 'product_detail_uv_num', 'detail_uv_num'] },
  ];

  const DEFAULT_CONFIG = {
    accountIds: [],
    accountCandidates: [],
    shopId: '',
    intervalMinutes: 20,
    mode: 'observe',
    whitelist: [],
    feishu: {
      enabled: false,
      appId: '',
      appToken: '',
      adDetailsTableId: '',
      accountSummaryTableId: '',
      operationLogTableId: '',
      systemConfigTableId: '',
    },
    update: {
      channel: 'stable',
      autoCheck: true,
    },
    review: {
      enabled: true,
      delayMinutes: 40,
      maxReviews: 3,
    },
    zeroReopen: {
      enabled: false,
      windowMinutes: 20,
      retryMinutes: 2,
    },
    policy: {
      protectionRules: [
        { metric: 'fb_purchase_num', minCount: 1, maxSpend: 6 },
        { metric: 'fb_add_to_cart', minCount: 1, maxSpend: 3 },
      ],
      stages: {
        1: { minFbClicks: 1, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minViewContent: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
        2: { minFbClicks: 2, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minViewContent: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
        3: { minFbClicks: 3, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minViewContent: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
        5: { minFbClicks: 4, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minViewContent: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
      },
    },
  };

  let config = normalizeConfig(loadJson(STORAGE_KEY, DEFAULT_CONFIG));
  let running = false;
  let executing = false;
  let timerId = null;
  let nextRunAt = null;
  let countdownId = null;
  let reviewTimerId = null;
  let reviewExecuting = false;
  let zeroReopenTimerId = null;
  let zeroReopenExecuting = false;
  let feishuTokenCache = null;
  let updateManifestCache = null;
  const feishuFieldCache = new Map();
  let feishuSyncQueue = Promise.resolve();

  function loadJson(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return value && typeof value === 'object' ? { ...fallback, ...value } : { ...fallback };
    } catch (_) {
      return { ...fallback };
    }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function protectionMetricOption(metric) {
    return PROTECTION_METRICS.find((option) => option.id === metric);
  }

  function normalizeProtectionRule(rule) {
    const metric = String(rule?.metric || '').trim();
    if (!protectionMetricOption(metric)) return null;
    return {
      metric,
      minCount: numberValue(rule?.minCount),
      maxSpend: numberValue(rule?.maxSpend),
    };
  }

  function normalizeProtectionRules(policy) {
    const source = Array.isArray(policy?.protectionRules)
      ? policy.protectionRules
      : [
        {
          metric: 'fb_purchase_num',
          minCount: policy?.effectProtectionCount ?? DEFAULT_CONFIG.policy.protectionRules[0].minCount,
          maxSpend: policy?.effectProtectionSpend ?? DEFAULT_CONFIG.policy.protectionRules[0].maxSpend,
        },
        {
          metric: 'fb_add_to_cart',
          minCount: policy?.cartProtectionCount ?? DEFAULT_CONFIG.policy.protectionRules[1].minCount,
          maxSpend: policy?.cartProtectionSpend ?? DEFAULT_CONFIG.policy.protectionRules[1].maxSpend,
        },
      ];
    return source.map(normalizeProtectionRule).filter(Boolean);
  }

  function protectionMetricValue(ad, metric) {
    const option = protectionMetricOption(metric);
    return option ? numberFrom(ad, option.keys) : 0;
  }

  function protectionMetricOptions(selectedMetric) {
    return PROTECTION_METRICS.map((option) => (
      `<option value="${html(option.id)}" ${option.id === selectedMetric ? 'selected' : ''}>${html(option.label)}</option>`
    )).join('');
  }

  function normalizeAdAccountId(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/(?:act_)?(\d{8,25})/i);
    return match ? match[1] : '';
  }

  function parseAdAccountIds(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\s,，;；]+/);
    return [...new Set(source.map(normalizeAdAccountId).filter(Boolean))];
  }

  function firstText(value, keys) {
    for (const key of keys) {
      const text = String(value?.[key] ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function normalizeFbUserId(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/\d{5,30}/);
    return match ? match[0] : '';
  }

  function normalizeTimeZone(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: text }).format(new Date());
      return text;
    } catch (_) {
      return '';
    }
  }

  function fbUserFields(value) {
    if (!value || typeof value !== 'object') return { fbUserId: '', fbUserName: '', fbUserEmail: '' };
    const fbUserId = normalizeFbUserId(firstText(value, [
      'fb_user_id', 'fbUserId', 'facebook_user_id', 'facebookUserId',
      'oauth_fb_user_id', 'oauthFbUserId', 'oauth_user_id', 'oauthUserId',
      'user_id', 'userId', 'fb_uid', 'fbUid',
    ]));
    const fbUserName = firstText(value, [
      'fb_user_name', 'fbUserName', 'facebook_user_name', 'facebookUserName',
      'fb_name', 'fbName', 'fb_nickname', 'fbNickname', 'user_name',
      'userName', 'username', 'nick_name', 'nickname',
    ]);
    const fbUserEmail = firstText(value, [
      'fb_user_email', 'fbUserEmail', 'facebook_user_email', 'facebookUserEmail',
      'user_email', 'userEmail', 'email',
    ]);
    return { fbUserId, fbUserName, fbUserEmail };
  }

  function normalizeAdAccountCandidate(value, source = '', { allowGenericId = false } = {}) {
    if (!value || typeof value !== 'object') {
      const id = normalizeAdAccountId(value);
      return id ? { id, name: '', currency: '', status: '', timeZone: '', fbUserId: '', fbUserName: '', fbUserEmail: '', source } : null;
    }

    const idKeys = [
      'account_id', 'accountId', 'accountID', 'ad_account_id', 'adAccountId',
      'adAccountID', 'fb_account_id', 'fbAccountId', 'facebook_account_id',
      'facebookAccountId', 'business_account_id', 'businessAccountId',
    ];
    if (allowGenericId) idKeys.push('id', 'value');
    let id = '';
    for (const key of idKeys) {
      id = normalizeAdAccountId(value[key]);
      if (id) break;
    }
    if (!id && (
      allowGenericId || value.source || value.account_name || value.accountName ||
      value.ad_account_name || value.adAccountName || value.facebook_account_name ||
      value.facebookAccountName
    )) {
      id = normalizeAdAccountId(value.id ?? value.value);
    }
    if (!id) {
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
        if (!normalizedKey.includes('account') || !normalizedKey.endsWith('id')) continue;
        id = normalizeAdAccountId(child);
        if (id) break;
      }
    }
    if (!id) return null;

    const name = String(
      value.account_name ?? value.accountName ?? value.ad_account_name ?? value.adAccountName ??
      value.facebook_account_name ?? value.facebookAccountName ?? value.name ?? value.label ?? ''
    ).trim();
    return {
      id,
      name,
      currency: String(value.currency ?? value.account_currency ?? value.accountCurrency ?? '').trim(),
      status: String(value.status ?? value.account_status ?? value.accountStatus ?? '').trim(),
      timeZone: normalizeTimeZone(value.time_zone ?? value.timeZone ?? value.account_time_zone ?? value.accountTimeZone),
      ...fbUserFields(value),
      enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
      source,
    };
  }

  function normalizeAdAccountCandidates(value) {
    if (!Array.isArray(value)) return [];
    return mergeAdAccountLists(value.map((item) => normalizeAdAccountCandidate(item, item?.source || '已保存账户')).filter(Boolean));
  }

  function mergeAdAccountLists(...lists) {
    const merged = new Map();
    for (const list of lists.flat()) {
      const account = normalizeAdAccountCandidate(list, list?.source || '');
      if (!account) continue;
      const previous = merged.get(account.id) || { id: account.id, name: '', currency: '', status: '', timeZone: '', fbUserId: '', fbUserName: '', fbUserEmail: '', source: '' };
      merged.set(account.id, {
        id: account.id,
        name: previous.name || account.name,
        currency: previous.currency || account.currency,
        status: previous.status || account.status,
        timeZone: previous.timeZone || account.timeZone,
        fbUserId: previous.fbUserId || account.fbUserId,
        fbUserName: previous.fbUserName || account.fbUserName,
        fbUserEmail: previous.fbUserEmail || account.fbUserEmail,
        enabled: previous.enabled ?? account.enabled,
        source: previous.source || account.source,
      });
    }
    return [...merged.values()];
  }

  function configAccountIds(value) {
    if (Array.isArray(value?.accountIds)) return parseAdAccountIds(value.accountIds);
    if (value?.accountId) return parseAdAccountIds([value.accountId]);
    return parseAdAccountIds(DEFAULT_CONFIG.accountIds);
  }

  function selectedAccountIdsFromCandidates(candidates) {
    return candidates
      .filter((account) => account && account.enabled)
      .map((account) => account.id)
      .filter(Boolean);
  }

  function isDetectedAdAccountCandidate(account) {
    const source = String(account?.source || '');
    return account && account.id && !/^手动/.test(source);
  }

  function renderProtectionRule(rule = DEFAULT_CONFIG.policy.protectionRules[0]) {
    const normalized = normalizeProtectionRule(rule) || DEFAULT_CONFIG.policy.protectionRules[0];
    return `<div class="protection-row protection-rule-row">
      <select class="protection-metric">${protectionMetricOptions(normalized.metric)}</select>
      <input class="protection-min-count" type="number" min="1" step="1" value="${html(normalized.minCount)}">
      <input class="protection-max-spend" type="number" min="0" step="0.01" value="${html(normalized.maxSpend)}">
      <button type="button" class="protection-delete" title="删除保护规则">删除</button>
    </div>`;
  }

  function normalizeConfig(value) {
    const policy = value?.policy || {};
    const stages = policy.stages || {};
    const review = value?.review || {};
    const zeroReopen = value?.zeroReopen || {};
    const feishu = value?.feishu || {};
    const update = value?.update || {};
    const accountCandidates = normalizeAdAccountCandidates(value?.accountCandidates)
      .filter(isDetectedAdAccountCandidate);
    const savedAccountIds = configAccountIds(value);
    const candidateIds = new Set(accountCandidates.map((account) => account.id));
    const accountIds = (savedAccountIds.length ? savedAccountIds : selectedAccountIdsFromCandidates(accountCandidates))
      .filter((id) => candidateIds.has(id));
    return {
      ...DEFAULT_CONFIG,
      ...value,
      accountIds,
      accountCandidates,
      whitelist: Array.isArray(value?.whitelist) ? value.whitelist.map(String) : [],
      feishu: { ...DEFAULT_CONFIG.feishu, ...feishu },
      update: { ...DEFAULT_CONFIG.update, ...update },
      review: {
        enabled: typeof review.enabled === 'boolean' ? review.enabled : DEFAULT_CONFIG.review.enabled,
        delayMinutes: numberValue(review.delayMinutes ?? DEFAULT_CONFIG.review.delayMinutes),
        maxReviews: numberValue(review.maxReviews ?? review.maxReopensPerDay ?? DEFAULT_CONFIG.review.maxReviews),
      },
      zeroReopen: {
        enabled: typeof zeroReopen.enabled === 'boolean' ? zeroReopen.enabled : DEFAULT_CONFIG.zeroReopen.enabled,
        windowMinutes: numberValue(zeroReopen.windowMinutes ?? DEFAULT_CONFIG.zeroReopen.windowMinutes),
        retryMinutes: numberValue(zeroReopen.retryMinutes ?? DEFAULT_CONFIG.zeroReopen.retryMinutes),
      },
      policy: {
        ...DEFAULT_CONFIG.policy,
        ...policy,
        protectionRules: normalizeProtectionRules(policy),
        stages: Object.fromEntries(
          Object.entries(Object.keys(stages).length ? stages : DEFAULT_CONFIG.policy.stages)
            .map(([spend, stage]) => [String(numberValue(spend)), {
              minFbClicks: numberValue(stage?.minFbClicks ?? stage?.minClicks),
              minFbAddToCart: numberValue(stage?.minFbAddToCart ?? stage?.minAddToCart),
              minFbPurchases: numberValue(stage?.minFbPurchases),
              minVisitors: numberValue(stage?.minVisitors),
              minViewContent: numberValue(stage?.minViewContent ?? stage?.minProductDetailVisitors),
              minAddToCart: numberValue(stage?.minFbAddToCart == null ? 0 : stage?.minAddToCart),
              minInitiateCheckout: numberValue(stage?.minInitiateCheckout),
              minOrders: numberValue(stage?.minOrders),
            }])
            .filter(([spend]) => numberValue(spend) > 0)
        ),
      },
    };
  }

  function numberValue(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function escapeCsv(value) {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function getLogs() {
    try {
      const value = JSON.parse(localStorage.getItem(LOG_KEY));
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function getManagedAds() {
    try {
      const value = JSON.parse(localStorage.getItem(MANAGED_KEY));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  }

  function saveManagedAds(value) {
    localStorage.setItem(MANAGED_KEY, JSON.stringify(value));
  }

  function getZeroReopenState() {
    try {
      const value = JSON.parse(localStorage.getItem(ZERO_REOPEN_KEY));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  }

  function saveZeroReopenState(value) {
    localStorage.setItem(ZERO_REOPEN_KEY, JSON.stringify(value));
  }

  function timeZoneParts(timeZone, date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      date: `${map.year}/${map.month}/${map.day}`,
      hour: numberValue(map.hour),
      minute: numberValue(map.minute),
      second: numberValue(map.second),
    };
  }

  function zeroReopenTiming(timeZone, date = new Date()) {
    const parts = timeZoneParts(timeZone, date);
    const minutesSinceMidnight = parts.hour * 60 + parts.minute + parts.second / 60;
    const windowMinutes = Math.max(1, numberValue(config.zeroReopen.windowMinutes));
    return {
      ...parts,
      inWindow: minutesSinceMidnight >= 0 && minutesSinceMidnight < windowMinutes,
      minutesSinceMidnight,
    };
  }

  function zeroReopenRunKey(accountId, timeZone, date) {
    return `${accountId}|${timeZone}|${date}`;
  }

  function selectedAccountCandidate(accountId) {
    return mergeAdAccountLists(config.accountCandidates)
      .find((account) => account.id === String(accountId));
  }

  function loadPanelPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY));
      return value && Number.isFinite(value.left) && Number.isFinite(value.top) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function savePanelPosition(panel) {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
  }

  function clampPanelPosition(panel, persist = false) {
    if (!panel.style.left || !panel.style.top) return;
    const rect = panel.getBoundingClientRect();
    const margin = 6;
    const maxLeft = Math.max(margin, window.innerWidth - Math.min(rect.width, window.innerWidth) - margin);
    const maxTop = Math.max(margin, window.innerHeight - Math.min(rect.height, window.innerHeight) - margin);
    panel.style.left = `${Math.min(Math.max(margin, rect.left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(margin, rect.top), maxTop)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    if (persist) savePanelPosition(panel);
  }

  function applyPanelPosition(panel) {
    const position = loadPanelPosition();
    if (!position) return;
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    requestAnimationFrame(() => clampPanelPosition(panel, true));
  }

  function makePanelDraggable(panel) {
    const header = panel.querySelector('header');
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const move = (event) => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      const margin = 6;
      const maxLeft = Math.max(margin, window.innerWidth - Math.min(rect.width, window.innerWidth) - margin);
      const maxTop = Math.max(margin, window.innerHeight - Math.min(rect.height, window.innerHeight) - margin);
      panel.style.left = `${Math.min(Math.max(margin, event.clientX - offsetX), maxLeft)}px`;
      panel.style.top = `${Math.min(Math.max(margin, event.clientY - offsetY), maxTop)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dragging');
      savePanelPosition(panel);
    };

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      dragging = true;
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.classList.add('dragging');
      event.preventDefault();
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => clampPanelPosition(panel, true));
    header.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      localStorage.removeItem(PANEL_POSITION_KEY);
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
    });
  }

  function managedKey(accountId, adId) {
    return `${accountId}:${adId}`;
  }

  function addLog(entry) {
    const logs = getLogs();
    const log = {
      time: new Date().toISOString(),
      ...entry,
    };
    logs.unshift(log);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    localStorage.setItem(LOG_KEY, JSON.stringify(logs));
    renderSummaries();
    renderLogs();
    if (config.feishu.enabled && isAdOperation(log.action)) {
      enqueueFeishuTask('操作日志', () => syncFeishuOperationLog(log));
    }
  }

  function pacificDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}/${map.month}/${map.day}`;
  }

  async function apiPost(route, body) {
    return apiPostUrl(`${API_BASE}${route}`, body);
  }

  async function pluginApiPost(route, body) {
    return apiPostUrl(`${PLUGIN_API_BASE}${route}`, body);
  }

  async function apiPostUrl(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        'shopid': String(config.shopId).trim(),
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    if (result.code !== 0) {
      throw new Error(result.msg || `接口错误 code=${result.code}`);
    }
    return result;
  }

  function normalizeShopIdCandidate(value) {
    const text = String(value ?? '').trim();
    return /^\d{1,20}$/.test(text) && Number(text) > 0 ? text : '';
  }

  function valueAtPath(value, path) {
    return path.reduce((current, key) => (
      current && typeof current === 'object' ? current[key] : undefined
    ), value);
  }

  function extractShopIdFromObject(value) {
    if (!value || typeof value !== 'object') return '';
    const preferredPaths = [
      ['data', 'current_shop_id'], ['data', 'currentShopId'],
      ['data', 'shop_id'], ['data', 'shopId'], ['data', 'shopid'],
      ['data', 'id'], ['data', 'uid'],
      ['data', 'current_shop', 'id'], ['data', 'currentShop', 'id'],
      ['data', 'shop', 'id'], ['data', 'shopInfo', 'id'],
      ['data', 'user', 'shop_id'], ['data', 'user', 'shopId'],
      ['current_shop_id'], ['currentShopId'], ['shop_id'], ['shopId'], ['shopid'],
      ['current_shop', 'id'], ['currentShop', 'id'], ['shop', 'id'], ['shopInfo', 'id'],
    ];
    for (const path of preferredPaths) {
      const candidate = normalizeShopIdCandidate(valueAtPath(value, path));
      if (candidate) return candidate;
    }

    const candidates = new Set();
    const queue = [{ value, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 2000) {
      const item = queue.shift();
      visited += 1;
      if (!item.value || typeof item.value !== 'object' || item.depth > 7) continue;
      for (const [key, child] of Object.entries(item.value)) {
        const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
        if (normalizedKey === 'shopid' || normalizedKey === 'currentshopid') {
          const candidate = normalizeShopIdCandidate(child);
          if (candidate) candidates.add(candidate);
        }
        if (child && typeof child === 'object') queue.push({ value: child, depth: item.depth + 1 });
      }
    }
    return candidates.size === 1 ? [...candidates][0] : '';
  }

  function extractShopIdFromText(value) {
    const text = String(value || '');
    const patterns = [
      /[?&#](?:shopid|shop_id|shopId)=(\d{1,20})(?:[&#]|$)/,
      /["'](?:current_shop_id|currentShopId|shop_id|shopId|shopid)["']\s*:\s*["']?(\d{1,20})/,
    ];
    for (const pattern of patterns) {
      const candidate = normalizeShopIdCandidate(text.match(pattern)?.[1]);
      if (candidate) return candidate;
    }
    return '';
  }

  async function detectShopIdFromLogin() {
    try {
      const response = await fetch(SHOP_ID_CHECK_URL, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'content-type': 'application/json;charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: '{}',
      });
      if (!response.ok) return null;
      const result = await response.json();
      const shopId = extractShopIdFromObject(result);
      return shopId ? { shopId, source: 'ShopCity登录状态接口' } : null;
    } catch (_) {
      return null;
    }
  }

  function detectShopIdFromLocation() {
    const sources = [location.search, location.hash];
    for (const source of sources) {
      const shopId = extractShopIdFromText(source);
      if (shopId) return { shopId, source: '当前页面网址' };
    }
    return null;
  }

  function detectShopIdFromDocument() {
    const selectors = [
      '[data-shop-id]', '[data-shopid]',
      'input[name="shop_id"]', 'input[name="shopId"]', 'input[name="shopid"]',
      'select[name="shop_id"]', 'select[name="shopId"]', 'select[name="shopid"]',
    ];
    for (const element of document.querySelectorAll(selectors.join(','))) {
      const shopId = normalizeShopIdCandidate(
        element.dataset?.shopId || element.getAttribute('data-shop-id') ||
        element.getAttribute('data-shopid') || element.value
      );
      if (shopId) return { shopId, source: '当前页面元素' };
    }
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        const shopId = extractShopIdFromObject(JSON.parse(script.textContent || ''));
        if (shopId) return { shopId, source: '当前页面数据' };
      } catch (_) { /* ignore non-JSON script */ }
    }
    return null;
  }

  function detectShopIdFromCookie() {
    for (const part of String(document.cookie || '').split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      const key = decodeURIComponent(part.slice(0, separator).trim());
      if (!/^(?:current_?)?shop_?id$/i.test(key)) continue;
      const shopId = normalizeShopIdCandidate(decodeURIComponent(part.slice(separator + 1).trim()));
      if (shopId) return { shopId, source: 'ShopCity Cookie' };
    }
    return null;
  }

  function detectShopIdFromStorage() {
    for (const [storage, label] of [[localStorage, '本地存储'], [sessionStorage, '会话存储']]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || '';
          if (key.startsWith('xh_shopcity_fb_controller_')) continue;
          const raw = storage.getItem(key) || '';
          if (/^(?:current_?)?shop_?id$/i.test(key)) {
            const shopId = normalizeShopIdCandidate(raw);
            if (shopId) return { shopId, source: `ShopCity${label}` };
          }
          try {
            const shopId = extractShopIdFromObject(JSON.parse(raw));
            if (shopId) return { shopId, source: `ShopCity${label}` };
          } catch (_) {
            const shopId = extractShopIdFromText(raw);
            if (shopId) return { shopId, source: `ShopCity${label}` };
          }
        }
      } catch (_) { /* ignore inaccessible storage */ }
    }
    return null;
  }

  async function detectShopId() {
    const loginResult = await detectShopIdFromLogin();
    if (loginResult) return loginResult;
    return detectShopIdFromLocation()
      || detectShopIdFromDocument()
      || detectShopIdFromCookie()
      || detectShopIdFromStorage();
  }

  function setShopIdStatus(text, kind = 'idle') {
    const element = document.querySelector('#xh-shop-id-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
  }

  async function autoFillShopId({ force = false, silent = false } = {}) {
    const input = document.querySelector('#xh-shop-id');
    const button = document.querySelector('#xh-shop-id-detect');
    if (!input) return null;
    if (button) button.disabled = true;
    if (!silent) setShopIdStatus('正在识别当前店铺…', 'working');
    try {
      const result = await detectShopId();
      const current = normalizeShopIdCandidate(input.value);
      if (!result) {
        setShopIdStatus(current ? '未自动识别，继续使用当前手动值' : '未识别到，请手动填写', current ? 'idle' : 'error');
        return null;
      }
      if (current && current !== result.shopId && !force) {
        setShopIdStatus(`检测到 ${result.shopId}（${result.source}），未覆盖当前值 ${current}`, 'working');
        return result;
      }
      input.value = result.shopId;
      config.shopId = result.shopId;
      saveConfig();
      setShopIdStatus(`已自动获取 ${result.shopId}（${result.source}）`, 'ok');
      return result;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function collectAdAccountsFromObject(value, source, { allowGenericId = false } = {}) {
    const accounts = [];
    const queue = [{ value, depth: 0, fbUser: { fbUserId: '', fbUserName: '', fbUserEmail: '' } }];
    let visited = 0;
    while (queue.length && visited < 3000) {
      const item = queue.shift();
      visited += 1;
      if (!item.value || typeof item.value !== 'object' || item.depth > 8) continue;
      const currentFbUser = fbUserFields(item.value);
      const inheritedFbUser = {
        fbUserId: currentFbUser.fbUserId || item.fbUser.fbUserId,
        fbUserName: currentFbUser.fbUserName || item.fbUser.fbUserName,
        fbUserEmail: currentFbUser.fbUserEmail || item.fbUser.fbUserEmail,
      };
      const account = normalizeAdAccountCandidate(item.value, source, { allowGenericId });
      if (account) {
        const linkedFbUser = firstLinkedFbUser(item.value);
        account.fbUserId = account.fbUserId || linkedFbUser.fbUserId || inheritedFbUser.fbUserId;
        account.fbUserName = account.fbUserName || linkedFbUser.fbUserName || inheritedFbUser.fbUserName;
        account.fbUserEmail = account.fbUserEmail || linkedFbUser.fbUserEmail || inheritedFbUser.fbUserEmail;
      }
      if (account) accounts.push(account);
      for (const child of Object.values(item.value)) {
        if (child && typeof child === 'object') queue.push({ value: child, depth: item.depth + 1, fbUser: inheritedFbUser });
      }
    }
    return mergeAdAccountLists(accounts);
  }

  function normalizeFbUserCandidate(value) {
    if (!value || typeof value !== 'object') return null;
    const fields = fbUserFields(value);
    const fallbackId = normalizeFbUserId(value.id ?? value.value);
    const fbUserId = fields.fbUserId || fallbackId;
    const fbUserName = fields.fbUserName || firstText(value, ['name', 'label', 'real_name', 'realName']);
    const fbUserEmail = fields.fbUserEmail;
    if (!fbUserId && !fbUserName && !fbUserEmail) return null;
    return { fbUserId, fbUserName, fbUserEmail };
  }

  function mergeFbUsers(users) {
    const merged = new Map();
    for (const user of users) {
      const key = user.fbUserId || user.fbUserEmail || user.fbUserName;
      const previous = merged.get(key) || { fbUserId: '', fbUserName: '', fbUserEmail: '' };
      merged.set(key, {
        fbUserId: previous.fbUserId || user.fbUserId,
        fbUserName: previous.fbUserName || user.fbUserName,
        fbUserEmail: previous.fbUserEmail || user.fbUserEmail,
      });
    }
    return [...merged.values()];
  }

  function collectFbUsersFromObject(value) {
    const users = [];
    const queue = [{ value, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 3000) {
      const item = queue.shift();
      visited += 1;
      if (!item.value || typeof item.value !== 'object' || item.depth > 8) continue;
      const user = normalizeFbUserCandidate(item.value);
      if (user) users.push(user);
      for (const child of Object.values(item.value)) {
        if (child && typeof child === 'object') queue.push({ value: child, depth: item.depth + 1 });
      }
    }
    return mergeFbUsers(users);
  }

  function firstLinkedFbUser(value) {
    const users = [];
    for (const key of ['fb_accounts', 'fbAccounts', 'facebook_accounts', 'facebookAccounts', 'fb_users', 'fbUsers']) {
      if (value?.[key] && typeof value[key] === 'object') users.push(...collectFbUsersFromObject(value[key]));
    }
    return mergeFbUsers(users)[0] || { fbUserId: '', fbUserName: '', fbUserEmail: '' };
  }

  function attachFbUsersToAdAccounts(accounts, fbUsers) {
    if (!fbUsers.length) return accounts;
    const byId = new Map(fbUsers.filter((user) => user.fbUserId).map((user) => [user.fbUserId, user]));
    if (fbUsers.length === 1) {
      const onlyUser = fbUsers[0];
      return accounts.map((account) => ({
        ...account,
        fbUserId: account.fbUserId || onlyUser.fbUserId,
        fbUserName: account.fbUserName || onlyUser.fbUserName,
        fbUserEmail: account.fbUserEmail || onlyUser.fbUserEmail,
      }));
    }
    return accounts.map((account) => {
      const user = account.fbUserId ? byId.get(account.fbUserId) : null;
      return user ? { ...account, fbUserName: account.fbUserName || user.fbUserName, fbUserEmail: account.fbUserEmail || user.fbUserEmail } : account;
    });
  }

  function detectAdAccountsFromDocument() {
    const accounts = [];
    const attributeSelectors = [
      '[data-account-id]', '[data-accountid]', '[data-ad-account-id]',
      '[data-ad-accountid]', '[data-facebook-account-id]', '[data-fb-account-id]',
    ];
    for (const element of document.querySelectorAll(attributeSelectors.join(','))) {
      const id = normalizeAdAccountId(
        element.dataset?.accountId || element.dataset?.accountid ||
        element.dataset?.adAccountId || element.dataset?.adAccountid ||
        element.dataset?.facebookAccountId || element.dataset?.fbAccountId ||
        element.getAttribute('data-account-id') || element.getAttribute('data-accountid') ||
        element.getAttribute('data-ad-account-id') || element.getAttribute('data-ad-accountid') ||
        element.getAttribute('data-facebook-account-id') || element.getAttribute('data-fb-account-id')
      );
      if (!id) continue;
      accounts.push({ id, name: element.textContent.trim(), source: '当前页面元素' });
    }

    for (const select of document.querySelectorAll('select')) {
      const context = [
        select.id, select.name, select.className, select.getAttribute('aria-label'),
        select.closest('label')?.textContent,
      ].join(' ');
      if (!/(?:account|账户)/i.test(context)) continue;
      for (const option of select.options) {
        const id = normalizeAdAccountId(option.value) || normalizeAdAccountId(option.textContent);
        if (!id) continue;
        accounts.push({ id, name: option.textContent.replace(id, '').replace(/act_/i, '').trim(), source: '当前页面选择器' });
      }
    }

    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      try {
        accounts.push(...collectAdAccountsFromObject(JSON.parse(script.textContent || ''), '当前页面数据'));
      } catch (_) { /* ignore non-JSON script */ }
    }
    return mergeAdAccountLists(accounts);
  }

  function detectAdAccountsFromStorage() {
    const accounts = [];
    for (const [storage, label] of [[localStorage, '本地存储'], [sessionStorage, '会话存储']]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index) || '';
          if (key.startsWith('xh_shopcity_fb_controller_')) continue;
          if (!/(?:facebook|fb|ads?|ad|account|账户|广告)/i.test(key)) continue;
          const raw = storage.getItem(key) || '';
          try {
            accounts.push(...collectAdAccountsFromObject(JSON.parse(raw), `ShopCity${label}`));
          } catch (_) {
            const id = normalizeAdAccountId(raw);
            if (id) accounts.push({ id, name: '', source: `ShopCity${label}` });
          }
        }
      } catch (_) { /* ignore inaccessible storage */ }
    }
    return mergeAdAccountLists(accounts);
  }

  async function detectAdAccountsFromApi() {
    let fbUsers = [];
    try {
      const oauthResult = await pluginApiPost('facebook-oauth/list', { page: 1, limit: 50, fb_user_id: '' });
      fbUsers = collectFbUsersFromObject(oauthResult);
    } catch (_) { /* ad-account detection can continue without FB user names */ }

    try {
      const adsResult = await pluginApiPost('facebook-ads/list', { page: 1, limit: 10000 });
      const accounts = collectAdAccountsFromObject(adsResult, 'ShopCity广告账户接口', { allowGenericId: true });
      return mergeAdAccountLists(attachFbUsersToAdAccounts(accounts, fbUsers));
    } catch (_) {
      return [];
    }
  }

  async function detectAdAccounts() {
    const fromDocument = detectAdAccountsFromDocument();
    const fromStorage = detectAdAccountsFromStorage();
    const fromApi = await detectAdAccountsFromApi();
    return mergeAdAccountLists(fromDocument, fromStorage, fromApi);
  }

  function renderAdAccountOption(account, selectedIds = config.accountIds) {
    const selected = new Set(selectedIds.map(String));
    const meta = [account.name, account.currency, account.status, account.timeZone].filter(Boolean).join(' / ');
    const fbText = [account.fbUserName, account.fbUserEmail, account.fbUserId ? `FB账号 ${account.fbUserId}` : ''].filter(Boolean).join(' / ');
    const searchText = [account.id, account.name, account.fbUserName, account.fbUserEmail, account.fbUserId].filter(Boolean).join(' ').toLowerCase();
    return `<label class="account-option" data-id="${html(account.id)}" data-name="${html(account.name || '')}" data-currency="${html(account.currency || '')}" data-status="${html(account.status || '')}" data-time-zone="${html(account.timeZone || '')}" data-fb-user-id="${html(account.fbUserId || '')}" data-fb-user-name="${html(account.fbUserName || '')}" data-fb-user-email="${html(account.fbUserEmail || '')}" data-source="${html(account.source || '')}" data-search="${html(searchText)}">
      <input type="checkbox" class="account-check" value="${html(account.id)}" ${selected.has(String(account.id)) ? 'checked' : ''}>
      <span class="account-main">
        <span class="account-line"><strong>${html(account.id)}</strong>${meta ? `<em>${html(meta)}</em>` : ''}</span>
        ${fbText ? `<span class="account-fb">${html(fbText)}</span>` : '<span class="account-fb">未识别FB授权账号</span>'}
      </span>
      <span class="account-source">${html(account.source || '已保存账户')}</span>
    </label>`;
  }

  function renderAdAccountOptions(accounts = config.accountCandidates, selectedIds = config.accountIds) {
    const normalized = mergeAdAccountLists(accounts).filter(isDetectedAdAccountCandidate);
    if (!normalized.length) {
      return '<div class="account-empty">尚未检测到账户；请点击自动检测当前店铺账户。</div>';
    }
    return normalized.map((account) => renderAdAccountOption(account, selectedIds)).join('');
  }

  function updateAdAccountOptions() {
    const element = document.querySelector('#xh-account-options');
    if (!element) return;
    element.innerHTML = renderAdAccountOptions();
    applyAdAccountFilter();
  }

  function setAccountStatus(text, kind = 'idle') {
    const element = document.querySelector('#xh-account-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
  }

  function readSelectedAdAccountIds() {
    return [...document.querySelectorAll('#xh-account-options .account-check:checked')]
      .map((input) => normalizeAdAccountId(input.value))
      .filter(Boolean);
  }

  function readRenderedAdAccountCandidates() {
    return [...document.querySelectorAll('#xh-account-options .account-option')].map((row) => ({
      id: row.dataset.id || '',
      name: row.dataset.name || '',
      currency: row.dataset.currency || '',
      status: row.dataset.status || '',
      timeZone: row.dataset.timeZone || '',
      fbUserId: row.dataset.fbUserId || '',
      fbUserName: row.dataset.fbUserName || '',
      fbUserEmail: row.dataset.fbUserEmail || '',
      source: row.dataset.source || '已保存账户',
    }));
  }

  function updateAccountStatusFromSelection() {
    const rows = [...document.querySelectorAll('#xh-account-options .account-option')];
    const total = rows.length;
    const visible = rows.filter((row) => !row.hidden).length;
    const selected = readSelectedAdAccountIds().length;
    const keyword = document.querySelector('#xh-account-search')?.value.trim();
    setAccountStatus(
      total ? `已选择 ${selected}/${total} 个店铺绑定账户执行任务${keyword ? `，当前显示 ${visible} 个` : ''}` : '尚未检测到账户',
      selected ? 'ok' : 'idle'
    );
  }

  function applyAdAccountFilter() {
    const keyword = String(document.querySelector('#xh-account-search')?.value || '').trim().toLowerCase();
    for (const row of document.querySelectorAll('#xh-account-options .account-option')) {
      const shouldHide = Boolean(keyword) && !String(row.dataset.search || '').includes(keyword);
      row.hidden = shouldHide;
      row.style.display = shouldHide ? 'none' : '';
    }
    updateAccountStatusFromSelection();
  }

  function visibleAdAccountChecks(panel) {
    return [...panel.querySelectorAll('#xh-account-options .account-option')]
      .filter((row) => !row.hidden)
      .map((row) => row.querySelector('.account-check'))
      .filter(Boolean);
  }

  function persistAccountSelectionFromPanel() {
    const candidateIds = new Set(readRenderedAdAccountCandidates().map((account) => account.id));
    config.accountIds = readSelectedAdAccountIds().filter((id) => candidateIds.has(id));
    config.accountCandidates = mergeAdAccountLists(readRenderedAdAccountCandidates()).filter(isDetectedAdAccountCandidate);
    saveConfig();
    updateAccountStatusFromSelection();
  }

  async function detectAndRenderAdAccounts() {
    const button = document.querySelector('#xh-account-detect');
    const shopInput = document.querySelector('#xh-shop-id');
    if (button) button.disabled = true;
    try {
      const shopId = normalizeShopIdCandidate(shopInput?.value);
      if (shopId) {
        config.shopId = shopId;
      } else {
        await autoFillShopId({ force: false });
      }
      if (!normalizeShopIdCandidate(config.shopId)) {
        throw new Error('请先填写或自动获取 Shop ID');
      }
      setAccountStatus('正在检测当前店铺绑定的广告账户…', 'working');
      const detected = await detectAdAccounts();
      if (!detected.length) {
        setAccountStatus('未检测到账户；请确认当前店铺已绑定Facebook广告账户', 'error');
        return;
      }

      const existingCandidates = mergeAdAccountLists(config.accountCandidates, readRenderedAdAccountCandidates())
        .filter(isDetectedAdAccountCandidate);
      const existingCandidateIds = new Set(existingCandidates.map((account) => account.id));
      const selectedIds = new Set(readSelectedAdAccountIds().length ? readSelectedAdAccountIds() : config.accountIds);
      for (const account of detected) {
        if (!existingCandidateIds.has(account.id)) selectedIds.add(account.id);
      }
      config.accountCandidates = mergeAdAccountLists(existingCandidates, detected);
      config.accountIds = [...selectedIds].filter((id) => config.accountCandidates.some((account) => account.id === id));
      saveConfig();
      updateAdAccountOptions();
      setAccountStatus(`检测到 ${detected.length} 个账户，当前选择 ${config.accountIds.length} 个执行任务`, 'ok');
    } catch (error) {
      setAccountStatus(`自动检测失败：${error.message}`, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function getFeishuSecret() {
    try {
      return String(GM_getValue(FEISHU_SECRET_KEY, '') || '').trim();
    } catch (_) {
      return '';
    }
  }

  function saveFeishuSecret(value) {
    GM_setValue(FEISHU_SECRET_KEY, String(value || '').trim());
    feishuTokenCache = null;
  }

  function getFeishuRecordCache() {
    try {
      const value = GM_getValue(FEISHU_RECORD_CACHE_KEY, {});
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  }

  function setFeishuRecordCache(value) {
    GM_setValue(FEISHU_RECORD_CACHE_KEY, value);
  }

  function gmRequest({ method = 'GET', url, headers = {}, body }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body == null ? undefined : JSON.stringify(body),
        timeout: 30000,
        onload: (response) => {
          let data;
          try {
            data = response.responseText ? JSON.parse(response.responseText) : {};
          } catch (_) {
            reject(new Error(`飞书返回非JSON内容（HTTP ${response.status}）`));
            return;
          }
          if (response.status < 200 || response.status >= 300 || numberValue(data.code) !== 0) {
            reject(new Error(data.msg || data.message || `飞书HTTP ${response.status}`));
            return;
          }
          resolve(data);
        },
        onerror: () => reject(new Error('飞书网络请求失败')),
        ontimeout: () => reject(new Error('飞书请求超时')),
      });
    });
  }

  function gmTextRequest(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 30000,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`GitHub HTTP ${response.status}`));
            return;
          }
          resolve(String(response.responseText || ''));
        },
        onerror: () => reject(new Error('GitHub网络请求失败')),
        ontimeout: () => reject(new Error('GitHub请求超时')),
      });
    });
  }

  function normalizeVersion(value) {
    return String(value || '').trim().replace(/^v/i, '').split('-')[0]
      .split('.').map((part) => Number(part) || 0).slice(0, 3);
  }

  function compareVersions(left, right) {
    const a = normalizeVersion(left);
    const b = normalizeVersion(right);
    for (let index = 0; index < 3; index += 1) {
      const difference = (a[index] || 0) - (b[index] || 0);
      if (difference) return difference > 0 ? 1 : -1;
    }
    return 0;
  }

  function releaseChannels(release) {
    const value = release?.channels ?? release?.channel ?? [];
    return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
  }

  function validateUpdateManifest(manifest) {
    if (!manifest || numberValue(manifest.schema_version) !== 1 || !Array.isArray(manifest.versions)) {
      throw new Error('版本清单格式不正确');
    }
    const versions = manifest.versions.filter((release) => (
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(release?.version || ''))
      && /^https:\/\/raw\.githubusercontent\.com\/harmony-s\/sc-fb-auto-controller\//.test(String(release?.script_url || ''))
      && /^[a-f0-9]{64}$/i.test(String(release?.sha256 || ''))
      && releaseChannels(release).length > 0
    ));
    if (!versions.length) throw new Error('版本清单中没有可用版本');
    return { ...manifest, versions };
  }

  async function fetchUpdateManifest(force = false) {
    if (!force && updateManifestCache) return updateManifestCache;
    if (!force) {
      try {
        const cached = GM_getValue(UPDATE_MANIFEST_CACHE_KEY, null);
        if (cached) {
          updateManifestCache = validateUpdateManifest(cached);
          return updateManifestCache;
        }
      } catch (_) { /* ignore invalid cache */ }
    }
    const separator = UPDATE_MANIFEST_URL.includes('?') ? '&' : '?';
    const raw = await gmTextRequest(`${UPDATE_MANIFEST_URL}${separator}_=${Date.now()}`);
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (_) {
      throw new Error('版本清单不是有效JSON');
    }
    updateManifestCache = validateUpdateManifest(manifest);
    try {
      GM_setValue(UPDATE_LAST_CHECK_KEY, Date.now());
      GM_setValue(UPDATE_MANIFEST_CACHE_KEY, updateManifestCache);
    } catch (_) { /* ignore */ }
    return updateManifestCache;
  }

  function channelLabel(channel) {
    return ({ stable: '稳定版', beta: '测试版', dev: '开发版', all: '全部版本' })[channel] || channel;
  }

  function setUpdateStatus(text, kind = 'idle') {
    const element = document.querySelector('#xh-update-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
  }

  function selectedRelease() {
    const select = document.querySelector('#xh-update-version');
    if (!select || !updateManifestCache) return null;
    return updateManifestCache.versions.find((release) => String(release.version) === select.value) || null;
  }

  function renderReleaseDetails() {
    const release = selectedRelease();
    const target = document.querySelector('#xh-update-details');
    const installButton = document.querySelector('#xh-update-install');
    if (!target || !installButton) return;
    if (!release) {
      target.textContent = '点击“检查更新”后载入可用版本。';
      installButton.disabled = true;
      return;
    }
    const relation = compareVersions(release.version, CURRENT_VERSION);
    const action = relation > 0 ? '升级' : relation < 0 ? '回退' : '重新安装';
    const notes = Array.isArray(release.changelog) ? release.changelog.join('；') : String(release.changelog || '无');
    target.textContent = `${action}到 v${release.version} · 发布者 ${release.developer || '未知'} · ${release.published_at || '日期未知'}\n${notes}\nSHA-256: ${release.sha256}`;
    installButton.textContent = `${action}所选版本`;
    installButton.disabled = false;
  }

  function populateReleaseOptions(manifest) {
    const channelSelect = document.querySelector('#xh-update-channel');
    const versionSelect = document.querySelector('#xh-update-version');
    if (!channelSelect || !versionSelect) return;
    const channel = channelSelect.value || 'stable';
    const releases = manifest.versions
      .filter((release) => channel === 'all' || releaseChannels(release).includes(channel))
      .sort((a, b) => compareVersions(b.version, a.version));
    versionSelect.disabled = releases.length === 0;
    versionSelect.replaceChildren(...releases.map((release) => {
      const option = document.createElement('option');
      option.value = String(release.version);
      option.textContent = `v${release.version} · ${release.developer || '未知'} · ${releaseChannels(release).map(channelLabel).join('/')}`;
      return option;
    }));
    const latest = releases[0];
    if (latest) versionSelect.value = String(latest.version);
    renderReleaseDetails();
  }

  async function checkForUpdates({ force = true, silent = false } = {}) {
    const button = document.querySelector('#xh-update-check');
    if (button) button.disabled = true;
    if (!silent) setUpdateStatus('正在从GitHub读取版本清单…', 'working');
    try {
      const manifest = await fetchUpdateManifest(force);
      populateReleaseOptions(manifest);
      const channel = document.querySelector('#xh-update-channel')?.value || 'stable';
      const latest = manifest.versions
        .filter((release) => channel === 'all' || releaseChannels(release).includes(channel))
        .sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!latest) throw new Error(`没有${channelLabel(channel)}可用`);
      const comparison = compareVersions(latest.version, CURRENT_VERSION);
      setUpdateStatus(
        comparison > 0 ? `发现新版本 v${latest.version}` : comparison < 0 ? `当前 v${CURRENT_VERSION}高于该通道最新版本` : `当前已是${channelLabel(channel)} v${CURRENT_VERSION}`,
        comparison > 0 ? 'working' : 'ok'
      );
    } catch (error) {
      setUpdateStatus(`检查失败：${error.message}`, 'error');
      if (!silent) throw error;
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function sha256Text(text) {
    if (!window.crypto?.subtle) throw new Error('当前浏览器不支持SHA-256校验');
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function installSelectedRelease() {
    const release = selectedRelease();
    if (!release) throw new Error('请先检查更新并选择版本');
    const button = document.querySelector('#xh-update-install');
    if (button) button.disabled = true;
    try {
      setUpdateStatus(`正在校验 v${release.version}…`, 'working');
      const script = await gmTextRequest(`${release.script_url}${release.script_url.includes('?') ? '&' : '?'}_=${Date.now()}`);
      const actualHash = await sha256Text(script);
      if (actualHash.toLowerCase() !== String(release.sha256).toLowerCase()) {
        throw new Error(`SHA-256不一致，已阻止安装`);
      }
      if (!script.includes(`// @version      ${release.version}`) || !script.includes('// @namespace    xh-shopcity')) {
        throw new Error('脚本元数据与所选版本不匹配');
      }
      setUpdateStatus('校验通过，已打开Tampermonkey安装确认页。', 'ok');
      if (typeof GM_openInTab === 'function') {
        GM_openInTab(release.script_url, { active: true, insert: true, setParent: true });
      } else {
        window.open(release.script_url, '_blank', 'noopener,noreferrer');
      }
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function getFeishuToken(force = false) {
    if (!force && feishuTokenCache && feishuTokenCache.expiresAt > Date.now() + 60000) {
      return feishuTokenCache.token;
    }
    const secret = getFeishuSecret();
    if (!config.feishu.appId || !secret) throw new Error('请填写飞书 App ID 和 App Secret');
    const result = await gmRequest({
      method: 'POST',
      url: `${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: { app_id: config.feishu.appId, app_secret: secret },
    });
    const token = String(result.tenant_access_token || '');
    if (!token) throw new Error('飞书未返回 tenant_access_token');
    feishuTokenCache = {
      token,
      expiresAt: Date.now() + Math.max(300, numberValue(result.expire) - 60) * 1000,
    };
    return token;
  }

  async function feishuApi(path, { method = 'GET', body } = {}) {
    const token = await getFeishuToken();
    return gmRequest({
      method,
      url: `${FEISHU_API_BASE}${path}`,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body,
    });
  }

  function enqueueFeishuTask(label, task) {
    setFeishuStatus(`${label}已进入后台队列`, 'working');
    feishuSyncQueue = feishuSyncQueue
      .then(task)
      .catch((error) => {
        setFeishuStatus(`${label}同步失败：${error.message}`, 'error');
      });
    return feishuSyncQueue;
  }

  function chunks(items, size = 500) {
    const result = [];
    for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
    return result;
  }

  async function getFeishuTableFields(tableId, force = false) {
    if (!force && feishuFieldCache.has(tableId)) return feishuFieldCache.get(tableId);
    const result = await feishuApi(`/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/fields?page_size=100`);
    const fields = new Set((result.data?.items || []).map((item) => String(item.field_name)));
    feishuFieldCache.set(tableId, fields);
    return fields;
  }

  async function filterFeishuFields(tableId, fields) {
    const allowed = await getFeishuTableFields(tableId);
    return Object.fromEntries(Object.entries(fields).filter(([name, value]) =>
      allowed.has(name) && value !== undefined && value !== null && value !== ''
    ));
  }

  function filterFieldsWithSet(allowed, fields) {
    return Object.fromEntries(Object.entries(fields).filter(([name, value]) =>
      allowed.has(name) && value !== undefined && value !== null && value !== ''
    ));
  }

  async function findFeishuRecordsByPrefix(tableId, uniqueField, prefix) {
    const items = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ page_size: '500' });
      if (pageToken) query.set('page_token', pageToken);
      const result = await feishuApi(
        `/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records/search?${query}`,
        {
          method: 'POST',
          body: {
            filter: {
              conjunction: 'and',
              conditions: [{ field_name: uniqueField, operator: 'contains', value: [String(prefix)] }],
            },
          },
        }
      );
      items.push(...(result.data?.items || []));
      pageToken = result.data?.has_more ? String(result.data?.page_token || '') : '';
    } while (pageToken);
    return items;
  }

  async function batchCreateFeishuRecords(tableId, records) {
    const created = [];
    for (const batch of chunks(records)) {
      const result = await feishuApi(`/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create`, {
        method: 'POST', body: { records: batch },
      });
      created.push(...(result.data?.records || []));
    }
    return created;
  }

  async function batchUpdateFeishuRecords(tableId, records) {
    for (const batch of chunks(records)) {
      await feishuApi(`/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_update`, {
        method: 'POST', body: { records: batch },
      });
    }
  }

  async function findFeishuRecord(tableId, uniqueField, uniqueValue) {
    const result = await feishuApi(
      `/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records/search?page_size=20`,
      {
        method: 'POST',
        body: {
          filter: {
            conjunction: 'and',
            conditions: [{ field_name: uniqueField, operator: 'is', value: [String(uniqueValue)] }],
          },
        },
      }
    );
    return result.data?.items?.[0] || null;
  }

  async function upsertFeishuRecord(tableId, uniqueField, uniqueValue, fields, createOnlyFields = []) {
    const filtered = await filterFeishuFields(tableId, fields);
    const cache = getFeishuRecordCache();
    const cacheKey = `${tableId}:${uniqueValue}`;
    let recordId = cache[cacheKey] || '';
    if (!recordId) {
      const found = await findFeishuRecord(tableId, uniqueField, uniqueValue);
      recordId = String(found?.record_id || '');
    }

    if (recordId) {
      for (const field of createOnlyFields) delete filtered[field];
      try {
        await feishuApi(`/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`, {
          method: 'PUT', body: { fields: filtered },
        });
      } catch (error) {
        delete cache[cacheKey];
        setFeishuRecordCache(cache);
        throw error;
      }
    } else {
      const result = await feishuApi(`/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records`, {
        method: 'POST', body: { fields: filtered },
      });
      recordId = String(result.data?.record?.record_id || '');
    }
    if (recordId) {
      cache[cacheKey] = recordId;
      setFeishuRecordCache(cache);
    }
    return recordId;
  }

  async function createFeishuRecord(tableId, fields) {
    const filtered = await filterFeishuFields(tableId, fields);
    return feishuApi(`/bitable/v1/apps/${encodeURIComponent(config.feishu.appToken)}/tables/${encodeURIComponent(tableId)}/records`, {
      method: 'POST', body: { fields: filtered },
    });
  }

  function dateTimestamp(date = pacificDate()) {
    const [year, month, day] = String(date).split('/').map(Number);
    return Date.UTC(year, month - 1, day);
  }

  function firstValue(object, keys, fallback = '') {
    for (const key of keys) {
      if (object?.[key] !== undefined && object?.[key] !== null && object?.[key] !== '') return object[key];
    }
    return fallback;
  }

  function numberFrom(object, keys) {
    return numberValue(firstValue(object, keys, 0));
  }

  function percentageFrom(object, keys) {
    const raw = firstValue(object, keys, 0);
    const value = numberValue(String(raw).replace('%', ''));
    return String(raw).includes('%') || value > 1 ? value / 100 : value;
  }

  function adDetailFields(ad, accountId, executionId, now, date) {
    const normalizedDate = date.replaceAll('/', '-');
    const adId = String(ad.ad_id || '');
    return {
      '唯一键': `${normalizedDate}_${accountId}_${adId}`,
      '数据日期': dateTimestamp(date),
      '首次同步时间': now,
      '最后同步时间': now,
      '最近同步批次ID': executionId,
      '数据时区': 'America/Los_Angeles',
      'Shop ID': String(config.shopId),
      '接口字段版本': 'shopcity-v1',
      '接口原始数据': JSON.stringify(ad),
      '广告账户ID': String(firstValue(ad, ['account_id'], accountId)),
      '广告账户名称': String(firstValue(ad, ['account_name'])),
      '广告账户币种': String(firstValue(ad, ['currency', 'account_currency'], 'USD')),
      '广告系列ID': String(firstValue(ad, ['campaign_id'])),
      '广告系列名称': String(firstValue(ad, ['campaign_name'])),
      '广告系列状态': String(firstValue(ad, ['campaign_status'])),
      '广告组ID': String(firstValue(ad, ['adset_id'])),
      '广告组名称': String(firstValue(ad, ['adset_name'])),
      '广告组状态': String(firstValue(ad, ['adset_status'])),
      '广告ID': adId,
      '广告名称': String(firstValue(ad, ['ad_name'])),
      '广告状态': String(firstValue(ad, ['status', 'ad_status'], 'UNKNOWN')).toUpperCase(),
      '预算': numberFrom(ad, ['budget_usd', 'budget', 'daily_budget', 'lifetime_budget']),
      '预算类型': String(firstValue(ad, ['budget_type', 'budget_mode'])),
      '广告花费': numberFrom(ad, ['spend_usd']),
      'CPM': numberFrom(ad, ['cpm_usd', 'cpm']),
      'CPC': numberFrom(ad, ['cpc_usd', 'cpc']),
      '独立链接点击数': numberFrom(ad, ['unique_link_click']),
      '单次独立链接点击成本': numberFrom(ad, ['cost_per_unique_link_click_usd']),
      '独立CTR': percentageFrom(ad, ['unique_ctr', 'unique_ctr_rate']),
      '展示次数': numberFrom(ad, ['impressions', 'impression']),
      '覆盖人数': numberFrom(ad, ['reach']),
      'FB加购数': numberFrom(ad, ['fb_add_to_cart']),
      'FB成效数': numberFrom(ad, ['fb_purchase_num']),
      'FB单次成效费用': numberFrom(ad, ['fb_cpa']),
      'SC访客数': numberFrom(ad, ['total_uv_num']),
      'SC商详页访客数': numberFrom(ad, ['view_content_uv_num', 'product_detail_uv_num', 'detail_uv_num']),
      'SC页面浏览次数': numberFrom(ad, ['page_view_num', 'pv_num']),
      'SC加购人数': numberFrom(ad, ['add_to_cart_uv_num']),
      'SC发起结账人数': numberFrom(ad, ['initiate_checkout_uv_num']),
      'SC订单数': numberFrom(ad, ['total_order_num']),
      'SC转化率': percentageFrom(ad, ['conversion_rate']),
      'SC销售额': numberFrom(ad, ['sales_amount', 'total_sales_amount', 'gmv']),
      '店铺币种': String(firstValue(ad, ['shop_currency'], 'HUF')),
      'ROAS': numberFrom(ad, ['roas']),
    };
  }

  async function syncFeishuAdDetails(ads, accountId, executionId, date = pacificDate()) {
    if (!config.feishu.enabled) return { success: 0, failed: 0 };
    const now = Date.now();
    const tableId = config.feishu.adDetailsTableId;
    const allowed = await getFeishuTableFields(tableId);
    const rows = ads.map((ad) => adDetailFields(ad, accountId, executionId, now, date));
    const cache = getFeishuRecordCache();
    const recordIds = new Map();
    const missingKeys = rows
      .map((fields) => fields['唯一键'])
      .filter((uniqueKey) => {
        const recordId = cache[`${tableId}:${uniqueKey}`];
        if (recordId) recordIds.set(uniqueKey, recordId);
        return !recordId;
      });

    if (missingKeys.length) {
      const prefix = `${date.replaceAll('/', '-')}_${accountId}_`;
      const existing = await findFeishuRecordsByPrefix(tableId, '唯一键', prefix);
      for (const item of existing) {
        const uniqueKey = String(item.fields?.['唯一键'] || '');
        const recordId = String(item.record_id || '');
        if (uniqueKey && recordId) {
          recordIds.set(uniqueKey, recordId);
          cache[`${tableId}:${uniqueKey}`] = recordId;
        }
      }
    }

    const creates = [];
    const createKeys = [];
    const updates = [];
    for (const fields of rows) {
      const uniqueKey = fields['唯一键'];
      const recordId = recordIds.get(uniqueKey);
      const filtered = filterFieldsWithSet(allowed, fields);
      if (recordId) {
        delete filtered['首次同步时间'];
        updates.push({ record_id: recordId, fields: filtered });
      } else {
        creates.push({ fields: filtered });
        createKeys.push(uniqueKey);
      }
    }

    await batchUpdateFeishuRecords(tableId, updates);
    const created = await batchCreateFeishuRecords(tableId, creates);
    created.forEach((record, index) => {
      const recordId = String(record.record_id || '');
      const uniqueKey = createKeys[index];
      if (recordId && uniqueKey) cache[`${tableId}:${uniqueKey}`] = recordId;
    });
    setFeishuRecordCache(cache);
    return { success: rows.length, failed: 0, created: creates.length, updated: updates.length };
  }

  function accountSummaryFields(ads, accountId, executionId, date = pacificDate()) {
    const now = Date.now();
    const metrics = sumMetrics(ads);
    const activeCount = ads.filter((ad) => String(ad.status).toUpperCase() === 'ACTIVE').length;
    const pausedCount = ads.filter((ad) => String(ad.status).toUpperCase() === 'PAUSED').length;
    const campaignIds = new Set(ads.map((ad) => String(ad.campaign_id || '')).filter(Boolean));
    const adsetIds = new Set(ads.map((ad) => String(ad.adset_id || '')).filter(Boolean));
    const normalizedDate = date.replaceAll('/', '-');
    return {
      '唯一键': `${normalizedDate}_${accountId}`,
      '数据日期': dateTimestamp(date),
      '首次同步时间': now,
      '最后同步时间': now,
      '最近同步批次ID': executionId,
      '数据时区': 'America/Los_Angeles',
      'Shop ID': String(config.shopId),
      '广告账户ID': String(accountId),
      '广告账户名称': String(firstValue(ads[0], ['account_name'])),
      '广告账户币种': String(firstValue(ads[0], ['currency', 'account_currency'], 'USD')),
      '店铺币种': String(firstValue(ads[0], ['shop_currency'], 'HUF')),
      '接口字段版本': 'shopcity-v1',
      '接口原始数据': JSON.stringify({ account_id: accountId, metrics, ad_count: ads.length }),
      '广告总数': ads.length,
      '投放中广告数': activeCount,
      '已暂停广告数': pausedCount,
      '广告系列总数': campaignIds.size,
      '广告组总数': adsetIds.size,
      '总花费': metrics.spend_usd,
      '总展示次数': metrics.impressions,
      '总覆盖人数': metrics.reach,
      '总独立链接点击数': metrics.unique_link_click,
      '平均独立链接点击成本': metrics.cost_per_unique_link_click_usd,
      '账户CPM': metrics.cpm,
      '账户CPC': metrics.cost_per_unique_link_click_usd,
      '账户独立CTR': metrics.unique_ctr,
      'FB加购总数': metrics.fb_add_to_cart,
      'FB成效总数': metrics.fb_purchase_num,
      'FB平均成效费用': metrics.fb_cpa,
      'SC访客总数': metrics.total_uv_num,
      'SC商详页访客总数': metrics.view_content_uv_num,
      'SC页面浏览总数': metrics.page_view_num,
      'SC加购总人数': metrics.add_to_cart_uv_num,
      'SC发起结账总人数': metrics.initiate_checkout_uv_num,
      'SC订单总数': metrics.total_order_num,
      'SC账户转化率': metrics.conversion_rate,
      'SC销售总额': metrics.sales_amount,
      '账户ROAS': metrics.roas,
    };
  }

  async function syncFeishuAccountSummary(ads, accountId, executionId, date = pacificDate()) {
    if (!config.feishu.enabled) return;
    const fields = accountSummaryFields(ads, accountId, executionId, date);
    await upsertFeishuRecord(config.feishu.accountSummaryTableId, '唯一键', fields['唯一键'], fields, ['首次同步时间']);
  }

  function queueFeishuAccountSync(ads, accountId, executionId, date = pacificDate()) {
    if (!config.feishu.enabled) return;
    enqueueFeishuTask(`账户 ${accountId}`, async () => {
      const detailResult = await syncFeishuAdDetails(ads, accountId, executionId, date);
      await syncFeishuAccountSummary(ads, accountId, executionId, date);
      setFeishuStatus(
        `账户 ${accountId} 后台同步完成：明细${detailResult.success}条（新增${detailResult.created}，更新${detailResult.updated}），账户汇总已更新`,
        'ok'
      );
    });
  }

  function operationName(action) {
    return ({
      WOULD_PAUSE: '准备暂停', PAUSE: '已暂停', WHITELIST_SKIP: '白名单跳过',
      WOULD_REOPEN: '准备恢复', REOPEN: '已恢复', REVIEW_KEEP_PAUSED: '复核保持暂停',
      REVIEW_REOPEN_LIMIT: '复核次数超限', REVIEW_NOT_FOUND: '复核未找到广告',
      REVIEW_WHITELIST_SKIP: '白名单跳过',
      WOULD_REOPEN_ZERO_SPEND: '准备0点开启', REOPEN_ZERO_SPEND: '0点已开启',
    })[action] || '执行失败';
  }

  function isAdOperation(action) {
    return !['ACCOUNT_SUMMARY', 'ACCOUNT_ERROR', 'ROUND_SUMMARY', 'ROUND_ERROR', 'ZERO_REOPEN_ACCOUNT_SUMMARY'].includes(action);
  }

  async function syncFeishuOperationLog(log) {
    if (!config.feishu.enabled || !isAdOperation(log.action)) return;
    const metrics = log.metrics || {};
    const managed = getManagedAds()[managedKey(log.account_id, log.ad_id)] || {};
    const actual = ['PAUSE', 'REOPEN', 'REOPEN_ZERO_SPEND'].includes(log.action);
    const beforeStatus = ['REOPEN', 'WOULD_REOPEN', 'REOPEN_ZERO_SPEND', 'WOULD_REOPEN_ZERO_SPEND', 'REVIEW_KEEP_PAUSED', 'REVIEW_REOPEN_LIMIT'].includes(log.action) ? 'PAUSED' : 'ACTIVE';
    const plannedStatus = ['PAUSE', 'WOULD_PAUSE'].includes(log.action) ? 'PAUSED'
      : ['REOPEN', 'WOULD_REOPEN', 'REOPEN_ZERO_SPEND', 'WOULD_REOPEN_ZERO_SPEND'].includes(log.action) ? 'ACTIVE' : '不变';
    const afterStatus = actual && log.success ? plannedStatus : beforeStatus;
    const logId = `${Date.parse(log.time) || Date.now()}_${log.execution_id || 'noexec'}_${log.account_id || 'noaccount'}_${log.ad_id || 'noad'}_${log.action}_${Math.random().toString(36).slice(2, 6)}`;
    const checkpoint = Number(String(log.matched_rule || '').match(/^STAGE_([\d.]+)/)?.[1] || 0);
    const dataDate = String(log.data_date || pacificDate(new Date(log.time)));
    await createFeishuRecord(config.feishu.operationLogTableId, {
      '日志ID': logId,
      '操作时间': Date.parse(log.time) || Date.now(),
      '数据日期': dateTimestamp(dataDate),
      '执行批次ID': String(log.execution_id || ''),
      '执行来源': ({ auto: '自动执行', start: '启动执行', manual: '手动执行', review_timer: '独立复核', zero_reopen_timer: '0点自动开广告' })[log.source] || String(log.source || ''),
      '运行模式': log.mode === 'live' ? '正式模式' : '观察模式',
      '数据时区': String(log.time_zone || 'America/Los_Angeles'),
      'Shop ID': String(config.shopId),
      '日志原始数据': JSON.stringify(log),
      '广告账户ID': String(log.account_id || ''),
      '广告系列ID': String(log.campaign_id || ''),
      '广告组ID': String(log.adset_id || ''),
      '广告ID': String(log.ad_id || ''),
      '广告名称': String(log.ad_name || ''),
      '操作类型': String(log.action || ''),
      '操作类型中文': operationName(log.action),
      '命中规则ID': String(log.matched_rule || ''),
      '规则分类': log.category === 'ineffective' ? '无效' : String(log.category || ''),
      '检测点花费': checkpoint,
      '触发原因': String(log.reason || ''),
      '操作前状态': beforeStatus,
      '计划操作状态': plannedStatus,
      '操作后状态': afterStatus,
      '是否实际执行': actual,
      '执行成功': Boolean(log.success),
      '执行结果说明': String(log.message || ''),
      '错误信息': log.success ? '' : String(log.message || ''),
      '操作时广告花费': numberValue(metrics.spend_usd),
      '操作时独立链接点击数': numberValue(metrics.unique_link_click),
      '操作时独立链接点击成本': numberValue(metrics.cost_per_unique_link_click_usd),
      '操作时FB加购数': numberValue(metrics.fb_add_to_cart),
      '操作时FB成效数': numberValue(metrics.fb_purchase_num),
      '操作时FB单次成效费用': numberValue(metrics.fb_cpa),
      '操作时SC访客数': numberValue(metrics.total_uv_num),
      '操作时SC商详页访客数': numberValue(metrics.view_content_uv_num),
      '操作时SC加购人数': numberValue(metrics.add_to_cart_uv_num),
      '操作时SC发起结账人数': numberValue(metrics.initiate_checkout_uv_num),
      '操作时SC订单数': numberValue(metrics.total_order_num),
      '首次暂停时间': managed.closed_at || undefined,
      '计划复核时间': managed.review_due_at || undefined,
      '实际复核时间': log.action?.startsWith('REVIEW_') ? Date.parse(log.time) : undefined,
      '已复核次数': numberValue(managed.review_count),
      '暂停规则ID': String(managed.close_rule || ''),
      '复核规则ID': String(managed.review_rule || ''),
    });
  }

  async function testFeishuConnection() {
    readFormConfig();
    validateFeishuConfig();
    saveConfig();
    setFeishuStatus('正在测试飞书连接…', 'working');
    await getFeishuToken(true);
    const tableIds = [
      config.feishu.adDetailsTableId,
      config.feishu.accountSummaryTableId,
      config.feishu.operationLogTableId,
      config.feishu.systemConfigTableId,
    ];
    const counts = [];
    for (const tableId of tableIds) {
      const fields = await getFeishuTableFields(tableId, true);
      counts.push(fields.size);
    }
    setFeishuStatus(`连接成功；四张表字段数：${counts.join(' / ')}`, 'ok');
  }

  async function fetchAllAds(accountId, status = 'ACTIVE', date = pacificDate(), timeZone = 'America/Los_Angeles') {
    const ads = [];
    const limit = 50;
    let page = 1;
    let expectedCount = Infinity;

    while (ads.length < expectedCount) {
      const result = await apiPost('ads-data-report', {
        type: '3',
        account_id: String(accountId).trim(),
        status,
        start_date: date,
        end_date: date,
        search: '',
        sortName: '',
        sortVal: '',
        page,
        limit,
        time_zone: timeZone,
        checked_campaign_id: '',
        checked_adset_id: '',
      });

      const list = Array.isArray(result.data?.list) ? result.data.list : [];
      expectedCount = numberValue(result.data?.count);
      ads.push(...list);
      if (list.length < limit || list.length === 0) break;
      page += 1;
      if (page > 200) throw new Error('分页超过安全上限');
    }

    return ads;
  }

  function matchRule(ad) {
    const spend = numberValue(ad.spend_usd);
    const uniqueClicks = numberValue(ad.unique_link_click);
    const fbAddToCart = numberValue(ad.fb_add_to_cart);
    const visitors = numberValue(ad.total_uv_num);
    const viewContent = numberFrom(ad, ['view_content_uv_num', 'product_detail_uv_num', 'detail_uv_num']);
    const purchases = numberValue(ad.fb_purchase_num);
    const addToCart = numberValue(ad.add_to_cart_uv_num);
    const initiateCheckout = numberValue(ad.initiate_checkout_uv_num);
    const orders = numberValue(ad.total_order_num);
    const policy = config.policy;

    const protectedRule = policy.protectionRules.find((rule) => (
      spend <= numberValue(rule.maxSpend) &&
      protectionMetricValue(ad, rule.metric) >= numberValue(rule.minCount)
    ));
    if (protectedRule) return null;

    const reachedStage = Object.keys(policy.stages)
      .map(numberValue)
      .filter((checkpoint) => checkpoint > 0 && spend >= checkpoint)
      .sort((a, b) => b - a)[0];
    if (reachedStage) {
      const stage = policy.stages[reachedStage];
      const minFbClicks = numberValue(stage.minFbClicks);
      const minFbAddToCart = numberValue(stage.minFbAddToCart);
      const minFbPurchases = numberValue(stage.minFbPurchases);
      const minVisitors = numberValue(stage.minVisitors);
      const minViewContent = numberValue(stage.minViewContent);
      const minAddToCart = numberValue(stage.minAddToCart);
      const minInitiateCheckout = numberValue(stage.minInitiateCheckout);
      const minOrders = numberValue(stage.minOrders);
      if (uniqueClicks < minFbClicks) {
        return {
          id: `STAGE_${reachedStage}_CLICKS`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，FB单次链接点击 ${uniqueClicks} < 目标 ${minFbClicks}`,
        };
      }
      if (fbAddToCart < minFbAddToCart) {
        return {
          id: `STAGE_${reachedStage}_FB_ADD_TO_CART`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，FB加购 ${fbAddToCart} < 目标 ${minFbAddToCart}`,
        };
      }
      if (purchases < minFbPurchases) {
        return {
          id: `STAGE_${reachedStage}_FB_PURCHASES`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，FB成效 ${purchases} < 目标 ${minFbPurchases}`,
        };
      }
      if (visitors < minVisitors) {
        return {
          id: `STAGE_${reachedStage}_VISITORS`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，Shopcity访客 ${visitors} < 目标 ${minVisitors}`,
        };
      }
      if (viewContent < minViewContent) {
        return {
          id: `STAGE_${reachedStage}_VIEW_CONTENT`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，Shopcity商详页访客 ${viewContent} < 目标 ${minViewContent}`,
        };
      }
      if (addToCart < minAddToCart) {
        return {
          id: `STAGE_${reachedStage}_ADD_TO_CART`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，Shopcity加购 ${addToCart} < 目标 ${minAddToCart}`,
        };
      }
      if (initiateCheckout < minInitiateCheckout) {
        return {
          id: `STAGE_${reachedStage}_INITIATE_CHECKOUT`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，Shopcity发起结账 ${initiateCheckout} < 目标 ${minInitiateCheckout}`,
        };
      }
      if (orders < minOrders) {
        return {
          id: `STAGE_${reachedStage}_ORDERS`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，Shopcity订单 ${orders} < 目标 ${minOrders}`,
        };
      }
    }
    return null;
  }

  function metricsOf(ad) {
    return {
      fb_cpa: numberValue(ad.fb_cpa),
      fb_purchase_num: numberValue(ad.fb_purchase_num),
      fb_add_to_cart: numberValue(ad.fb_add_to_cart),
      total_uv_num: numberValue(ad.total_uv_num),
      view_content_uv_num: numberFrom(ad, ['view_content_uv_num', 'product_detail_uv_num', 'detail_uv_num']),
      add_to_cart_uv_num: numberValue(ad.add_to_cart_uv_num),
      initiate_checkout_uv_num: numberValue(ad.initiate_checkout_uv_num),
      total_order_num: numberValue(ad.total_order_num),
      spend_usd: numberValue(ad.spend_usd),
      unique_link_click: numberValue(ad.unique_link_click),
      cost_per_unique_link_click_usd: numberValue(ad.cost_per_unique_link_click_usd),
    };
  }

  function sumMetrics(ads) {
    const keys = [
      'spend_usd', 'unique_link_click', 'fb_add_to_cart', 'fb_purchase_num',
      'total_uv_num', 'view_content_uv_num', 'add_to_cart_uv_num', 'initiate_checkout_uv_num', 'total_order_num',
      'impressions', 'reach', 'page_view_num', 'sales_amount',
    ];
    const totals = Object.fromEntries(keys.map((key) => [key, 0]));
    for (const ad of ads) {
      for (const key of keys) {
        if (key === 'view_content_uv_num') totals[key] += numberFrom(ad, ['view_content_uv_num', 'product_detail_uv_num', 'detail_uv_num']);
        else if (key === 'page_view_num') totals[key] += numberFrom(ad, ['page_view_num', 'pv_num']);
        else if (key === 'sales_amount') totals[key] += numberFrom(ad, ['sales_amount', 'total_sales_amount', 'gmv']);
        else totals[key] += numberValue(ad[key]);
      }
    }
    totals.cost_per_unique_link_click_usd = totals.unique_link_click > 0
      ? totals.spend_usd / totals.unique_link_click
      : 0;
    totals.fb_cpa = totals.fb_purchase_num > 0
      ? totals.spend_usd / totals.fb_purchase_num
      : 0;
    totals.cpm = totals.impressions > 0 ? totals.spend_usd / totals.impressions * 1000 : 0;
    totals.unique_ctr = totals.reach > 0 ? totals.unique_link_click / totals.reach : 0;
    totals.conversion_rate = totals.total_uv_num > 0 ? totals.total_order_num / totals.total_uv_num : 0;
    const weightedRoas = ads.reduce((sum, ad) => sum + numberFrom(ad, ['roas']) * numberValue(ad.spend_usd), 0);
    totals.roas = totals.spend_usd > 0 ? weightedRoas / totals.spend_usd : 0;
    return totals;
  }

  async function pauseAd(ad, accountId) {
    return apiPost('mod-status', {
      mod_id: String(ad.ad_id),
      status: 'PAUSED',
      account_id: String(accountId).trim(),
    });
  }

  async function activateAd(adId, accountId) {
    return apiPost('mod-status', {
      mod_id: String(adId),
      status: 'ACTIVE',
      account_id: String(accountId).trim(),
    });
  }

  function registerScriptPause(ad, accountId, rule) {
    const managed = getManagedAds();
    const key = managedKey(accountId, ad.ad_id);
    const previous = managed[key] || {};
    const closedAt = Date.now();
    managed[key] = {
      ...previous,
      account_id: String(accountId),
      ad_id: String(ad.ad_id),
      ad_name: String(ad.ad_name || ''),
      state: 'paused_by_script',
      closed_at: closedAt,
      stats_date: pacificDate(new Date(closedAt)),
      review_due_at: closedAt + numberValue(config.review.delayMinutes) * 60000,
      review_count: 0,
      review_done: false,
      close_rule: rule.id,
    };
    saveManagedAds(managed);
  }

  async function reviewPausedAds(accountId, executionId, source) {
    const result = { reviewed: 0, reopened: 0, kept: 0, failed: 0 };
    if (!config.review.enabled) return result;

    const managed = getManagedAds();
    const dueRecords = Object.values(managed).filter((record) =>
      record.account_id === String(accountId) &&
      record.state === 'paused_by_script' &&
      !record.review_done &&
      numberValue(record.review_due_at) <= Date.now()
    );
    if (dueRecords.length === 0) return result;

    const recordsByDate = dueRecords.reduce((groups, record) => {
      const date = record.stats_date || pacificDate();
      (groups[date] ||= []).push(record);
      return groups;
    }, {});

    for (const [date, records] of Object.entries(recordsByDate)) {
      const pausedAds = await fetchAllAds(accountId, 'PAUSED', date);
      const adMap = new Map(pausedAds.map((ad) => [String(ad.ad_id), ad]));

      for (const record of records) {
        const key = managedKey(accountId, record.ad_id);
        const current = managed[key];
        result.reviewed += 1;

        if (config.whitelist.includes(String(record.ad_id))) {
          current.review_done = true;
          current.state = 'review_skipped_whitelist';
          addLog({
            execution_id: executionId, source, mode: config.mode, account_id: accountId,
            ad_id: record.ad_id, ad_name: record.ad_name, action: 'REVIEW_WHITELIST_SKIP',
            success: true, message: '复核时已在白名单，保持关闭且不自动恢复',
          });
          saveManagedAds(managed);
          continue;
        }

        const ad = adMap.get(String(record.ad_id));
        if (!ad) {
          current.review_done = true;
          current.state = 'review_not_paused';
          addLog({
            execution_id: executionId, source, mode: config.mode, account_id: accountId,
            ad_id: record.ad_id, ad_name: record.ad_name, action: 'REVIEW_NOT_FOUND',
            success: true, message: '暂停列表中未找到该广告，未执行自动恢复',
          });
          saveManagedAds(managed);
          continue;
        }

        const latestRule = matchRule(ad);
        const baseLog = {
          execution_id: executionId,
          source,
          mode: config.mode,
          account_id: accountId,
          campaign_id: String(ad.campaign_id || ''),
          adset_id: String(ad.adset_id || ''),
          ad_id: String(ad.ad_id),
          ad_name: String(ad.ad_name || record.ad_name || ''),
          metrics: metricsOf(ad),
        };

        current.review_count = numberValue(current.review_count) + 1;

        if (latestRule) {
          current.review_rule = latestRule.id;
          result.kept += 1;
          if (current.review_count >= numberValue(config.review.maxReviews)) {
            current.review_done = true;
            current.state = 'review_limit_reached';
          } else {
            current.review_done = false;
            current.state = 'paused_by_script';
            current.review_due_at = Date.now() + numberValue(config.review.delayMinutes) * 60000;
          }
          addLog({
            ...baseLog,
            action: 'REVIEW_KEEP_PAUSED',
            matched_rule: latestRule.id,
            category: latestRule.category,
            reason: latestRule.reason,
            success: true,
            message: current.review_done
              ? `复核后仍命中关闭规则；已完成 ${current.review_count}/${config.review.maxReviews} 次复核，保持暂停并结束复核`
              : `复核后仍命中关闭规则；已完成 ${current.review_count}/${config.review.maxReviews} 次复核，保持暂停并等待下次复核`,
          });
          saveManagedAds(managed);
          continue;
        }

        if (config.mode === 'observe') {
          if (current.review_count >= numberValue(config.review.maxReviews)) {
            current.review_done = true;
            current.state = 'review_limit_reached';
          } else {
            current.review_due_at = Date.now() + numberValue(config.review.delayMinutes) * 60000;
          }
          addLog({
            ...baseLog, action: 'WOULD_REOPEN', success: true,
            message: `复核后已不再命中关闭规则；观察模式未执行恢复（${current.review_count}/${config.review.maxReviews} 次）`,
          });
          saveManagedAds(managed);
          continue;
        }

        try {
          const activation = await activateAd(record.ad_id, accountId);
          current.review_done = true;
          current.state = 'reopened';
          current.reopened_at = Date.now();
          result.reopened += 1;
          addLog({
            ...baseLog, action: 'REOPEN', success: true,
            message: activation.msg || 'success',
          });
          saveManagedAds(managed);
        } catch (error) {
          result.failed += 1;
          if (current.review_count >= numberValue(config.review.maxReviews)) {
            current.review_done = true;
            current.state = 'review_failed_limit';
          } else {
            current.review_done = false;
            current.state = 'paused_by_script';
            current.review_due_at = Date.now() + numberValue(config.review.delayMinutes) * 60000;
          }
          addLog({ ...baseLog, action: 'REOPEN', success: false, message: error.message });
          saveManagedAds(managed);
        }
      }
    }

    saveManagedAds(managed);
    return result;
  }

  async function reopenZeroSpendAdsForAccount(accountId, account, timing, executionId, source) {
    const result = { checked: 0, zeroSpend: 0, reopened: 0, wouldReopen: 0, skipped: 0, failed: 0 };
    const pausedAds = await fetchAllAds(accountId, 'PAUSED', timing.date, account.timeZone);
    result.checked = pausedAds.length;

    for (const ad of pausedAds) {
      const adId = String(ad.ad_id || '');
      if (!adId) {
        result.skipped += 1;
        continue;
      }
      const spend = numberFrom(ad, ['spend_usd', 'spend', 'amount_spent']);
      if (Math.abs(spend) > 0.000001) {
        result.skipped += 1;
        continue;
      }

      result.zeroSpend += 1;
      const baseLog = {
        execution_id: executionId,
        source,
        mode: config.mode,
        account_id: String(ad.account_id || accountId),
        campaign_id: String(ad.campaign_id || ''),
        adset_id: String(ad.adset_id || ''),
        ad_id: adId,
        ad_name: String(ad.ad_name || ''),
        metrics: metricsOf(ad),
        data_date: timing.date,
        time_zone: account.timeZone,
        reason: `广告账户时区 ${account.timeZone} 已进入新一天，暂停广告当日花费为0`,
      };

      if (config.mode === 'observe') {
        result.wouldReopen += 1;
        addLog({
          ...baseLog,
          action: 'WOULD_REOPEN_ZERO_SPEND',
          success: true,
          message: '观察模式，未执行0点自动开启',
        });
        continue;
      }

      try {
        const activation = await activateAd(adId, accountId);
        result.reopened += 1;
        addLog({
          ...baseLog,
          action: 'REOPEN_ZERO_SPEND',
          success: true,
          message: activation.msg || 'success',
        });
      } catch (error) {
        result.failed += 1;
        addLog({
          ...baseLog,
          action: 'REOPEN_ZERO_SPEND',
          success: false,
          message: error.message,
        });
      }
    }

    return result;
  }

  function clearScheduledZeroReopen() {
    if (zeroReopenTimerId) window.clearTimeout(zeroReopenTimerId);
    zeroReopenTimerId = null;
  }

  function scheduleNextZeroReopen(delayMs = 60000) {
    clearScheduledZeroReopen();
    if (!running || !config.zeroReopen.enabled) return;
    zeroReopenTimerId = window.setTimeout(runZeroReopenChecks, Math.max(1000, delayMs));
  }

  async function runZeroReopenChecks() {
    zeroReopenTimerId = null;
    if (!running || !config.zeroReopen.enabled) return;
    if (zeroReopenExecuting) {
      scheduleNextZeroReopen();
      return;
    }
    if (executing || reviewExecuting) {
      scheduleNextZeroReopen(Math.max(1, numberValue(config.zeroReopen.retryMinutes)) * 60000);
      return;
    }

    zeroReopenExecuting = true;
    const executionId = `${Date.now()}-zero-reopen-${Math.random().toString(36).slice(2, 8)}`;
    const state = getZeroReopenState();
    let ranAccounts = 0;
    let reopened = 0;
    let failed = 0;

    try {
      for (const accountId of config.accountIds) {
        const account = selectedAccountCandidate(accountId);
        const timeZone = normalizeTimeZone(account?.timeZone);
        if (!timeZone) continue;

        const timing = zeroReopenTiming(timeZone);
        if (!timing.inWindow) continue;

        const runKey = zeroReopenRunKey(accountId, timeZone, timing.date);
        if (state[runKey]?.done) continue;

        ranAccounts += 1;
        setStatus(`0点自动开广告：正在处理账户 ${accountId}（${timeZone}）…`, 'working');

        try {
          const result = await reopenZeroSpendAdsForAccount(accountId, { ...account, timeZone }, timing, executionId, 'zero_reopen_timer');
          reopened += result.reopened;
          failed += result.failed;
          if (result.failed === 0) {
            state[runKey] = {
              done: true,
              done_at: Date.now(),
              account_id: String(accountId),
              date: timing.date,
              time_zone: timeZone,
              checked: result.checked,
              zero_spend: result.zeroSpend,
              reopened: result.reopened,
              would_reopen: result.wouldReopen,
              skipped: result.skipped,
            };
            saveZeroReopenState(state);
          }
          addLog({
            execution_id: executionId,
            source: 'zero_reopen_timer',
            mode: config.mode,
            account_id: String(accountId),
            action: 'ZERO_REOPEN_ACCOUNT_SUMMARY',
            success: result.failed === 0,
            data_date: timing.date,
            time_zone: timeZone,
            message: `0点自动开广告：暂停${result.checked}条，0花费${result.zeroSpend}条，恢复${result.reopened}条，观察${result.wouldReopen}条，跳过${result.skipped}条，失败${result.failed}条`,
          });
        } catch (error) {
          failed += 1;
          addLog({
            execution_id: executionId,
            source: 'zero_reopen_timer',
            mode: config.mode,
            account_id: String(accountId),
            action: 'ACCOUNT_ERROR',
            success: false,
            data_date: timing.date,
            time_zone: timeZone,
            message: `0点自动开广告失败：${error.message}`,
          });
        }
      }

      if (ranAccounts) {
        setStatus(`0点自动开广告完成：处理账户${ranAccounts}个，恢复${reopened}条，失败${failed}条`, failed ? 'error' : 'ok');
        renderSummaries();
        renderLogs();
      }
    } finally {
      zeroReopenExecuting = false;
      scheduleNextZeroReopen();
    }
  }

  function clearScheduledReview() {
    if (reviewTimerId) window.clearTimeout(reviewTimerId);
    reviewTimerId = null;
  }

  function scheduleNextReview() {
    clearScheduledReview();
    if (!running || !config.review.enabled) return;
    const activeAccountIds = new Set(config.accountIds.map(String));
    const dueTimes = Object.values(getManagedAds())
      .filter((record) => record.state === 'paused_by_script' && !record.review_done && activeAccountIds.has(String(record.account_id)))
      .map((record) => numberValue(record.review_due_at))
      .filter((value) => value > 0);
    if (!dueTimes.length) return;
    reviewTimerId = window.setTimeout(runDueReviews, Math.max(0, Math.min(...dueTimes) - Date.now()));
  }

  async function runDueReviews() {
    reviewTimerId = null;
    if (!running || reviewExecuting) return;
    if (executing) {
      reviewTimerId = window.setTimeout(runDueReviews, 5000);
      return;
    }
    reviewExecuting = true;
    const executionId = `${Date.now()}-review-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const accountIds = [...new Set(Object.values(getManagedAds())
        .filter((record) => record.state === 'paused_by_script' && !record.review_done && numberValue(record.review_due_at) <= Date.now())
        .map((record) => String(record.account_id))
        .filter((accountId) => accountId && config.accountIds.map(String).includes(accountId)))];
      for (const accountId of accountIds) {
        try {
          await reviewPausedAds(accountId, executionId, 'review_timer');
        } catch (error) {
          const managed = getManagedAds();
          for (const record of Object.values(managed)) {
            if (record.account_id === accountId && record.state === 'paused_by_script' && !record.review_done && numberValue(record.review_due_at) <= Date.now()) {
              record.review_due_at = Date.now() + Math.max(1, numberValue(config.review.delayMinutes)) * 60000;
            }
          }
          saveManagedAds(managed);
          addLog({ execution_id: executionId, source: 'review_timer', mode: config.mode, account_id: accountId, action: 'ACCOUNT_ERROR', success: false, message: `独立复核失败：${error.message}` });
        }
      }
      renderSummaries();
      renderLogs();
    } finally {
      reviewExecuting = false;
      scheduleNextReview();
    }
  }

  async function executeRound(source = 'auto') {
    if (executing) return;
    executing = true;
    clearScheduledRun();
    setStatus('正在读取广告数据…', 'working');
    const executionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let checked = 0;
    let matched = 0;
    let paused = 0;
    let failed = 0;
    let accountsCompleted = 0;
    let reviewed = 0;
    let reopened = 0;
    let keptPaused = 0;

    try {
      validateConfig();
      for (const accountId of config.accountIds) {
        try {
          setStatus(`正在处理账户 ${accountId}…`, 'working');
          // 空状态读取账户当日全部广告，汇总不会遗漏本轮开始前已暂停的广告。
          const allAds = await fetchAllAds(accountId, '');
          const ads = allAds.filter((ad) => String(ad.status).toUpperCase() === 'ACTIVE');
          const accountMetrics = sumMetrics(allAds);
          let accountChecked = 0;
          let accountMatched = 0;
          let accountPaused = 0;

          for (const ad of ads) {
            checked += 1;
            accountChecked += 1;
            const adId = String(ad.ad_id || '');
            const rule = matchRule(ad);
            if (!rule) continue;
            matched += 1;
            accountMatched += 1;

            const baseLog = {
              execution_id: executionId,
              source,
              mode: config.mode,
              account_id: String(ad.account_id || accountId),
              campaign_id: String(ad.campaign_id || ''),
              adset_id: String(ad.adset_id || ''),
              ad_id: adId,
              ad_name: String(ad.ad_name || ''),
              matched_rule: rule.id,
              category: rule.category,
              reason: rule.reason,
              metrics: metricsOf(ad),
            };

            if (config.whitelist.includes(adId)) {
              addLog({ ...baseLog, action: 'WHITELIST_SKIP', success: true, message: '白名单跳过' });
              continue;
            }

            if (config.mode === 'observe') {
              addLog({ ...baseLog, action: 'WOULD_PAUSE', success: true, message: '观察模式，未执行暂停' });
              continue;
            }

            try {
              const result = await pauseAd(ad, accountId);
              paused += 1;
              accountPaused += 1;
              registerScriptPause(ad, accountId, rule);
              addLog({ ...baseLog, action: 'PAUSE', success: true, message: result.msg || 'success' });
            } catch (error) {
              failed += 1;
              addLog({ ...baseLog, action: 'PAUSE', success: false, message: error.message });
            }
          }
          const reviewResult = await reviewPausedAds(accountId, executionId, source);
          reviewed += reviewResult.reviewed;
          reopened += reviewResult.reopened;
          keptPaused += reviewResult.kept;
          failed += reviewResult.failed;
          accountsCompleted += 1;
          addLog({
            execution_id: executionId,
            source,
            mode: config.mode,
            account_id: String(accountId),
            action: 'ACCOUNT_SUMMARY',
            success: reviewResult.failed === 0,
            metrics: accountMetrics,
            message: `当日全部广告${allAds.length}条，活动${ads.length}条，检查${accountChecked}条，命中${accountMatched}条，暂停${accountPaused}条，复核${reviewResult.reviewed}条，恢复${reviewResult.reopened}条，保持暂停${reviewResult.kept}条，失败${reviewResult.failed}条`,
          });
          queueFeishuAccountSync(allAds, accountId, executionId);
        } catch (error) {
          failed += 1;
          addLog({
            execution_id: executionId,
            source,
            mode: config.mode,
            account_id: accountId,
            action: 'ACCOUNT_ERROR',
            success: false,
            message: error.message,
          });
        }
      }

      addLog({
        execution_id: executionId,
        source,
        mode: config.mode,
        action: 'ROUND_SUMMARY',
        success: failed === 0,
        message: `账户${accountsCompleted}/${config.accountIds.length}，检查${checked}条，命中${matched}条，暂停${paused}条，复核${reviewed}条，恢复${reopened}条，保持暂停${keptPaused}条，失败${failed}条`,
      });
      setStatus(`完成：账户${accountsCompleted}/${config.accountIds.length}，检查${checked}，暂停${paused}，复核${reviewed}，恢复${reopened}，失败${failed}`, failed ? 'error' : 'ok');
    } catch (error) {
      failed += 1;
      addLog({
        execution_id: executionId,
        source,
        mode: config.mode,
        action: 'ROUND_ERROR',
        success: false,
        message: error.message,
      });
      setStatus(`执行失败：${error.message}`, 'error');
    } finally {
      executing = false;
      scheduleNextReview();
      scheduleNextZeroReopen();
      if (running) scheduleNextRun();
      updateButtons();
    }
  }

  function validateConfig() {
    if (!Array.isArray(config.accountIds) || config.accountIds.length === 0) {
      throw new Error('请先自动检测当前店铺账户，并至少勾选一个Facebook广告账户');
    }
    const invalidAccount = config.accountIds.find((id) => !/^\d{8,25}$/.test(String(id).trim()));
    if (invalidAccount) {
      throw new Error(`广告账户ID格式错误：${invalidAccount}`);
    }
    if (!/^\d+$/.test(String(config.shopId).trim())) {
      throw new Error('请填写正确的Shop ID');
    }
    if (config.feishu.enabled) validateFeishuConfig();
    const numericFields = [
      ['复核间隔分钟', config.review.delayMinutes],
      ['最多复核次数', config.review.maxReviews],
      ['0点自动开广告执行窗口', config.zeroReopen.windowMinutes],
      ['0点自动开广告重试间隔', config.zeroReopen.retryMinutes],
      ['任务执行间隔', config.intervalMinutes],
      ...Object.keys(config.policy.stages).flatMap((spend) => [
        [`$${spend}阶段FB最少单次链接点击`, config.policy.stages[spend].minFbClicks],
        [`$${spend}阶段FB最少加购`, config.policy.stages[spend].minFbAddToCart],
        [`$${spend}阶段FB最少成效`, config.policy.stages[spend].minFbPurchases],
        [`$${spend}阶段最少访客`, config.policy.stages[spend].minVisitors],
        [`$${spend}阶段最少商详页访客`, config.policy.stages[spend].minViewContent],
        [`$${spend}阶段最少加购`, config.policy.stages[spend].minAddToCart],
        [`$${spend}阶段最少发起结账`, config.policy.stages[spend].minInitiateCheckout],
        [`$${spend}阶段最少订单`, config.policy.stages[spend].minOrders],
      ]),
    ];
    for (const [name, value] of numericFields) {
      if (!Number.isFinite(Number(value)) || Number(value) < 0) {
        throw new Error(`${name}必须是大于等于0的数字`);
      }
    }
    const stageSpends = Object.keys(config.policy.stages).map(Number);
    if (!stageSpends.length) throw new Error('至少保留一个检测点');
    if (new Set(stageSpends).size !== stageSpends.length) throw new Error('检测点花费不能重复');
    for (const spend of stageSpends) {
      if (!Number.isFinite(spend) || spend <= 0) throw new Error('检测点花费必须是大于0的数字');
      if (!Number.isInteger(Number(config.policy.stages[spend].minFbClicks))) {
        throw new Error(`$${spend}阶段FB最少单次链接点击必须是整数`);
      }
      if (!Number.isInteger(Number(config.policy.stages[spend].minFbAddToCart))) throw new Error(`$${spend}阶段FB最少加购必须是整数`);
      if (!Number.isInteger(Number(config.policy.stages[spend].minFbPurchases))) throw new Error(`$${spend}阶段FB最少成效必须是整数`);
      if (!Number.isInteger(Number(config.policy.stages[spend].minAddToCart))) {
        throw new Error(`$${spend}阶段最少加购必须是整数`);
      }
      if (!Number.isInteger(Number(config.policy.stages[spend].minVisitors))) {
        throw new Error(`$${spend}阶段最少访客必须是整数`);
      }
      if (!Number.isInteger(Number(config.policy.stages[spend].minViewContent))) {
        throw new Error(`$${spend}阶段最少商详页访客必须是整数`);
      }
      if (!Number.isInteger(Number(config.policy.stages[spend].minInitiateCheckout))) throw new Error(`$${spend}阶段最少发起结账必须是整数`);
      if (!Number.isInteger(Number(config.policy.stages[spend].minOrders))) throw new Error(`$${spend}阶段最少订单必须是整数`);
    }
    for (const [index, rule] of config.policy.protectionRules.entries()) {
      const label = `第${index + 1}条广告保护规则`;
      if (!protectionMetricOption(rule.metric)) throw new Error(`${label}请选择正确的保护指标`);
      if (!Number.isFinite(Number(rule.maxSpend)) || Number(rule.maxSpend) < 0) {
        throw new Error(`${label}的花费上限必须是大于等于0的数字`);
      }
      if (!Number.isInteger(Number(rule.minCount)) || Number(rule.minCount) < 1) {
        throw new Error(`${label}的达到数量必须是大于等于1的整数`);
      }
    }
    if (!Number.isInteger(Number(config.review.maxReviews)) || Number(config.review.maxReviews) < 1) {
      throw new Error('最多复核次数必须是大于等于1的整数');
    }
    if (!Number.isInteger(Number(config.review.delayMinutes)) || Number(config.review.delayMinutes) < 1) {
      throw new Error('复核间隔必须是大于等于1的整数分钟');
    }
    if (!Number.isInteger(Number(config.zeroReopen.windowMinutes)) || Number(config.zeroReopen.windowMinutes) < 1) {
      throw new Error('0点自动开广告执行窗口必须是大于等于1的整数分钟');
    }
    if (!Number.isInteger(Number(config.zeroReopen.retryMinutes)) || Number(config.zeroReopen.retryMinutes) < 1) {
      throw new Error('0点自动开广告重试间隔必须是大于等于1的整数分钟');
    }
    if (!Number.isInteger(Number(config.intervalMinutes)) || Number(config.intervalMinutes) < 1) {
      throw new Error('任务执行间隔必须是大于等于1的整数分钟');
    }
  }

  function validateFeishuConfig() {
    const required = [
      ['App ID', config.feishu.appId],
      ['App Token', config.feishu.appToken],
      ['广告明细 Table ID', config.feishu.adDetailsTableId],
      ['账户汇总 Table ID', config.feishu.accountSummaryTableId],
      ['广告操作日志 Table ID', config.feishu.operationLogTableId],
      ['系统配置 Table ID', config.feishu.systemConfigTableId],
    ];
    const missing = required.find(([, value]) => !String(value || '').trim());
    if (missing) throw new Error(`请填写飞书 ${missing[0]}`);
    if (!getFeishuSecret()) throw new Error('请填写飞书 App Secret');
  }

  function scheduleNextRun() {
    clearScheduledRun();
    const intervalMs = numberValue(config.intervalMinutes) * 60 * 1000;
    nextRunAt = Date.now() + intervalMs;
    timerId = window.setTimeout(() => executeRound('auto'), intervalMs);
    updateCountdown();
  }

  function clearScheduledRun() {
    if (timerId) window.clearTimeout(timerId);
    timerId = null;
    nextRunAt = null;
  }

  function start() {
    if (running) return;
    try {
      readFormConfig();
      validateConfig();
      saveConfig();
    } catch (error) {
      setStatus(error.message, 'error');
      return;
    }
    running = true;
    updateButtons();
    scheduleNextReview();
    scheduleNextZeroReopen(1000);
    executeRound('start');
  }

  function stop() {
    running = false;
    clearScheduledRun();
    clearScheduledReview();
    clearScheduledZeroReopen();
    updateButtons();
    setStatus(executing ? '已停止后续循环；本轮仍在执行' : '已停止', 'idle');
  }

  function readFormConfig() {
    const accountCandidates = mergeAdAccountLists(readRenderedAdAccountCandidates()).filter(isDetectedAdAccountCandidate);
    const candidateIds = new Set(accountCandidates.map((account) => account.id));
    const accountIds = readSelectedAdAccountIds().filter((id) => candidateIds.has(id));
    const shopId = document.querySelector('#xh-shop-id').value.trim();
    const intervalMinutes = Number(document.querySelector('#xh-interval-minutes').value);
    const mode = document.querySelector('#xh-mode').value;
    const whitelist = document.querySelector('#xh-whitelist').value
      .split(/[\s,，;；]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const fieldNumber = (selector, root = document) => Number(root.querySelector(selector).value);
    const protectionRows = [...document.querySelectorAll('#xh-protection-list .protection-rule-row')];
    const protectionRules = protectionRows.map((row) => ({
      metric: row.querySelector('.protection-metric')?.value || '',
      minCount: fieldNumber('.protection-min-count', row),
      maxSpend: fieldNumber('.protection-max-spend', row),
    }));
    const stageRows = [...document.querySelectorAll('#xh-stage-list .stage-policy-row')];
    if (!stageRows.length) throw new Error('至少保留一个检测点');
    const stageEntries = stageRows.map((row) => {
      const spend = fieldNumber('.stage-spend', row);
      return [String(spend), {
        minFbClicks: fieldNumber('.stage-fb-clicks', row),
        minFbAddToCart: fieldNumber('.stage-fb-cart', row),
        minFbPurchases: fieldNumber('.stage-fb-purchases', row),
        minVisitors: fieldNumber('.stage-visitors', row),
        minViewContent: fieldNumber('.stage-view-content', row),
        minAddToCart: fieldNumber('.stage-cart', row),
        minInitiateCheckout: fieldNumber('.stage-checkout', row),
        minOrders: fieldNumber('.stage-orders', row),
      }];
    });
    if (new Set(stageEntries.map(([spend]) => spend)).size !== stageEntries.length) {
      throw new Error('检测点花费不能重复');
    }
    const feishuSecretInput = document.querySelector('#xh-feishu-app-secret').value.trim();
    if (feishuSecretInput) saveFeishuSecret(feishuSecretInput);
    config = normalizeConfig({
      accountIds: [...new Set(accountIds)],
      accountCandidates,
      shopId,
      intervalMinutes,
      mode,
      whitelist: [...new Set(whitelist)],
      feishu: {
        enabled: document.querySelector('#xh-feishu-enabled').checked,
        appId: document.querySelector('#xh-feishu-app-id').value.trim(),
        appToken: document.querySelector('#xh-feishu-app-token').value.trim(),
        adDetailsTableId: document.querySelector('#xh-feishu-ad-table').value.trim(),
        accountSummaryTableId: document.querySelector('#xh-feishu-account-table').value.trim(),
        operationLogTableId: document.querySelector('#xh-feishu-log-table').value.trim(),
        systemConfigTableId: document.querySelector('#xh-feishu-config-table').value.trim(),
      },
      update: {
        channel: document.querySelector('#xh-update-channel')?.value || config.update.channel,
        autoCheck: document.querySelector('#xh-update-auto')?.checked ?? config.update.autoCheck,
      },
      review: {
        enabled: document.querySelector('#xh-review-enabled').checked,
        delayMinutes: fieldNumber('#xh-review-delay'),
        maxReviews: fieldNumber('#xh-review-max'),
      },
      zeroReopen: {
        enabled: document.querySelector('#xh-zero-reopen-enabled').checked,
        windowMinutes: fieldNumber('#xh-zero-reopen-window'),
        retryMinutes: fieldNumber('#xh-zero-reopen-retry'),
      },
      policy: {
        protectionRules,
        stages: Object.fromEntries(stageEntries),
      },
    });
  }

  function updateButtons() {
    const startButton = document.querySelector('#xh-start');
    const stopButton = document.querySelector('#xh-stop');
    const runButton = document.querySelector('#xh-run-once');
    if (!startButton) return;
    startButton.disabled = running || executing;
    stopButton.disabled = !running;
    runButton.disabled = executing;
  }

  function setStatus(text, kind) {
    const element = document.querySelector('#xh-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
  }

  function setFeishuStatus(text, kind) {
    const element = document.querySelector('#xh-feishu-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
  }

  function updateCountdown() {
    const element = document.querySelector('#xh-countdown');
    if (!element) return;
    if (!running) {
      element.textContent = '未启动';
      return;
    }
    if (executing) {
      element.textContent = '本轮执行中';
      return;
    }
    if (!nextRunAt) {
      element.textContent = '等待调度';
      return;
    }
    const remaining = Math.max(0, nextRunAt - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    element.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function renderLogs() {
    const body = document.querySelector('#xh-log-body');
    if (!body) return;
    const accountFilter = document.querySelector('#xh-log-filter-account')?.value.trim();
    const adFilter = document.querySelector('#xh-log-filter-ad')?.value.trim();
    const logs = getLogs()
      .filter((log) => !['ACCOUNT_SUMMARY', 'ROUND_SUMMARY', 'REVIEW_KEEP_PAUSED', 'ZERO_REOPEN_ACCOUNT_SUMMARY'].includes(log.action))
      .filter((log) => {
        const accountId = String(log.account_id || '');
        const adId = String(log.ad_id || '');
        return (!accountFilter || accountId.includes(accountFilter))
          && (!adFilter || adId.includes(adFilter));
      })
      .slice(0, 60);
    body.innerHTML = logs.map((log) => {
      const time = log.time ? new Date(log.time).toLocaleString() : '';
      const resultClass = log.success ? 'success' : 'failure';
      return `<tr>
        <td>${html(time)}</td>
        <td class="id-cell" title="${html(log.account_id || '')}">${html(log.account_id || '-')}</td>
        <td class="id-cell" title="${html(log.ad_id || '')}">${html(log.ad_id || '-')}</td>
        <td title="${html(log.ad_name || '')}">${html(log.ad_name || '-')}</td>
        <td class="metric-cell">${html(formatMetric(log, 'spend_usd', 2))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'unique_link_click', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'cost_per_unique_link_click_usd', 2))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'fb_add_to_cart', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'total_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'view_content_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'fb_purchase_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'add_to_cart_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'initiate_checkout_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'total_order_num', 0))}</td>
        <td>${html(log.action || '')}</td>
        <td>${html(log.matched_rule || '-')}</td>
        <td class="${resultClass}" title="${html(log.reason || '')}">${html(log.message || '')}</td>
      </tr>`;
    }).join('');
  }

  function renderSummaries() {
    const body = document.querySelector('#xh-summary-body');
    if (!body) return;
    const summaries = getLogs()
      .filter((log) => log.action === 'ACCOUNT_SUMMARY')
      .slice(0, 60);
    body.innerHTML = summaries.map((log) => {
      const time = log.time ? new Date(log.time).toLocaleString() : '';
      const resultClass = log.success ? 'success' : 'failure';
      return `<tr>
        <td>${html(time)}</td>
        <td class="id-cell" title="${html(log.account_id || '')}">${html(log.account_id || '-')}</td>
        <td class="metric-cell">${html(formatMetric(log, 'spend_usd', 2))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'unique_link_click', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'cost_per_unique_link_click_usd', 2))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'fb_add_to_cart', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'fb_purchase_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'total_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'view_content_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'add_to_cart_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'initiate_checkout_uv_num', 0))}</td>
        <td class="metric-cell">${html(formatMetric(log, 'total_order_num', 0))}</td>
        <td class="${resultClass}" title="${html(log.message || '')}">${html(log.message || '')}</td>
      </tr>`;
    }).join('');
  }

  function html(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMetric(log, key, digits) {
    if (!log.metrics || !(key in log.metrics)) return '-';
    return numberValue(log.metrics[key]).toFixed(digits);
  }

  function exportCsv() {
    const logs = getLogs();
    const headers = [
      'time', 'execution_id', 'source', 'mode', 'action', 'success', 'account_id',
      'campaign_id', 'adset_id', 'ad_id', 'ad_name', 'matched_rule', 'reason',
      'category', 'fb_purchase_num', 'fb_add_to_cart', 'total_uv_num', 'view_content_uv_num', 'add_to_cart_uv_num',
      'initiate_checkout_uv_num', 'total_order_num', 'fb_cpa', 'spend_usd', 'unique_link_click',
      'cost_per_unique_link_click_usd', 'message',
    ];
    const lines = [headers.join(',')];
    for (const log of logs) {
      const row = { ...log, ...(log.metrics || {}) };
      lines.push(headers.map((key) => escapeCsv(row[key])).join(','));
    }
    const blob = new Blob(['\ufeff', lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `shopcity-fb-log-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clearLogs() {
    if (!window.confirm('确定清空全部本地操作记录吗？此操作不可恢复。')) return;
    localStorage.removeItem(LOG_KEY);
    renderSummaries();
    renderLogs();
  }

  function createPanel() {
    const style = document.createElement('style');
    style.textContent = `
      #xh-fb-controller{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:1400px;max-width:calc(100vw - 36px);max-height:82vh;background:#fff;border:1px solid #d8def0;border-radius:12px;box-shadow:0 12px 38px rgba(20,35,80,.24);font:13px/1.45 Arial,"Microsoft YaHei",sans-serif;color:#20263a;overflow:hidden}
      #xh-fb-controller *{box-sizing:border-box}
      #xh-fb-controller header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#334269;color:#fff;font-weight:700;cursor:move;touch-action:none;user-select:none}
      #xh-fb-controller.dragging header{cursor:grabbing}
      #xh-fb-controller .body{padding:12px;overflow:auto;max-height:calc(82vh - 45px)}
      #xh-fb-controller .grid{display:grid;grid-template-columns:1fr 90px;gap:8px}
      #xh-fb-controller label{display:block;margin:7px 0 3px;color:#596078}
      #xh-fb-controller input,#xh-fb-controller select,#xh-fb-controller textarea{width:100%;border:1px solid #cfd5e6;border-radius:6px;padding:7px 8px;background:#fff;color:#20263a}
      #xh-fb-controller input[type="checkbox"]{width:auto;margin-right:6px;vertical-align:middle}
      #xh-fb-controller textarea{height:55px;resize:vertical}
      #xh-fb-controller textarea.account-list{height:72px}
      #xh-fb-controller .actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
      #xh-fb-controller button{border:0;border-radius:6px;padding:7px 11px;background:#e8ecf7;color:#263250;cursor:pointer}
      #xh-fb-controller button.primary{background:#246cff;color:#fff}
      #xh-fb-controller button.danger{background:#e14c4c;color:#fff}
      #xh-fb-controller button:disabled{opacity:.45;cursor:not-allowed}
      #xh-fb-controller .info{display:flex;justify-content:space-between;gap:10px;padding:8px;border-radius:6px;background:#f4f6fb}
      #xh-status[data-kind="error"],#xh-feishu-status[data-kind="error"],#xh-update-status[data-kind="error"],#xh-shop-id-status[data-kind="error"],#xh-account-status[data-kind="error"]{color:#c42d2d} #xh-status[data-kind="ok"],#xh-feishu-status[data-kind="ok"],#xh-update-status[data-kind="ok"],#xh-shop-id-status[data-kind="ok"],#xh-account-status[data-kind="ok"]{color:#118146} #xh-status[data-kind="working"],#xh-feishu-status[data-kind="working"],#xh-update-status[data-kind="working"],#xh-shop-id-status[data-kind="working"],#xh-account-status[data-kind="working"]{color:#245bd7}
      #xh-fb-controller .rules{margin:8px 0;padding:8px 8px 8px 26px;background:#fff8df;border-radius:6px;color:#554b2c}
      #xh-fb-controller .rules li{margin:2px 0}
      #xh-fb-controller .policy{margin-top:10px;padding:10px;background:#f7f8fc;border:1px solid #e2e6f1;border-radius:8px}
      #xh-fb-controller .policy-title{font-weight:700;color:#334269;margin:0 0 5px}
      #xh-fb-controller .policy-note{font-size:11px;color:#737b91;margin-bottom:6px}
      #xh-fb-controller .checkpoint-help{margin:10px 0 8px;padding:9px 11px;background:#eef5ff;border:1px solid #cfe0ff;border-radius:7px;color:#405172;font-size:12px;line-height:1.65}
      #xh-fb-controller .checkpoint-help strong{color:#245bd7}
      #xh-fb-controller .update-details{white-space:pre-wrap;margin-top:8px;padding:9px 11px;background:#eef5ff;border:1px solid #cfe0ff;border-radius:7px;color:#405172;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
      #xh-fb-controller .two-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #xh-fb-controller .input-action{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center}
      #xh-fb-controller .input-action button{padding:7px 9px;white-space:nowrap}
      #xh-fb-controller .field-status{display:block;min-height:16px;margin-top:3px;font-size:11px;line-height:1.35;color:#66718a}
      #xh-fb-controller .account-top{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-top:7px}
      #xh-fb-controller .account-top label{margin:0;color:#596078}
      #xh-fb-controller .account-tools{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      #xh-fb-controller .account-search{margin-top:7px}
      #xh-fb-controller .account-options{margin-top:7px;border:1px solid #e2e6f1;border-radius:8px;max-height:150px;overflow:auto;background:#fff}
      #xh-fb-controller .account-option{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;margin:0;padding:7px 9px;border-bottom:1px solid #edf0f7;color:#20263a}
      #xh-fb-controller .account-option[hidden]{display:none!important}
      #xh-fb-controller .account-option:last-child{border-bottom:0}
      #xh-fb-controller .account-option input{margin:0}
      #xh-fb-controller .account-main{min-width:0;display:flex;flex-direction:column;gap:2px;overflow:hidden}
      #xh-fb-controller .account-line{min-width:0;display:flex;gap:8px;align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller .account-main strong{font-weight:700;color:#263250}
      #xh-fb-controller .account-main em{font-style:normal;color:#66718a;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller .account-fb{font-size:11px;color:#405172;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller .account-source{max-width:180px;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:#7b8398;white-space:nowrap}
      #xh-fb-controller .account-empty{padding:10px;color:#737b91}
      #xh-fb-controller .protection-head,#xh-fb-controller .protection-row{display:grid;grid-template-columns:minmax(180px,1fr) 135px 135px 44px;gap:6px;align-items:center}
      #xh-fb-controller .protection-head{font-size:11px;color:#737b91;margin-top:8px;text-align:center}
      #xh-fb-controller .protection-row{margin-top:5px}
      #xh-fb-controller .protection-delete{padding:7px 5px;background:#ffe9e9;color:#b72f2f}
      #xh-fb-controller .stage-head,#xh-fb-controller .stage-row{display:grid;grid-template-columns:65px 1fr 1fr;gap:6px;align-items:center}
      #xh-fb-controller .stage-head.stage-four,#xh-fb-controller .stage-row.stage-four{grid-template-columns:65px 1fr 1fr 1fr}
      #xh-fb-controller .stage-table{overflow-x:auto;padding-bottom:3px}
      #xh-fb-controller .stage-head.stage-ten,#xh-fb-controller .stage-row.stage-ten{grid-template-columns:90px repeat(8,135px) 44px;min-width:1260px}
      #xh-fb-controller .stage-head{font-size:11px;color:#737b91;margin-top:8px;text-align:center}
      #xh-fb-controller .stage-row{margin-top:5px}
      #xh-fb-controller .stage-row strong{text-align:center;color:#334269}
      #xh-fb-controller .stage-delete{padding:7px 5px;background:#ffe9e9;color:#b72f2f}
      #xh-fb-controller .stage-tools{display:flex;justify-content:flex-end;margin-top:7px}
      #xh-fb-controller .logs{margin-top:9px;max-height:210px;overflow:auto;border:1px solid #e1e5f0}
      #xh-fb-controller .log-title{margin-top:12px;font-weight:700;color:#334269}
      #xh-fb-controller .log-filters{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
      #xh-fb-controller table{width:100%;border-collapse:collapse;font-size:11px}
      #xh-fb-controller th,#xh-fb-controller td{padding:5px;border-bottom:1px solid #edf0f7;text-align:left;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller th.id-cell,#xh-fb-controller td.id-cell{min-width:155px;max-width:none;overflow:visible;text-overflow:clip}
      #xh-fb-controller th.metric-cell,#xh-fb-controller td.metric-cell{min-width:70px;text-align:right}
      #xh-fb-controller th{position:sticky;top:0;background:#f4f6fb}
      #xh-fb-controller .success{color:#118146}.failure{color:#c42d2d}
      #xh-collapse{background:transparent!important;color:#fff!important;padding:0!important;font-size:18px}
      #xh-fb-controller.collapsed .body{display:none}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('section');
    panel.id = 'xh-fb-controller';
    panel.innerHTML = `
      <header title="按住标题栏拖动；双击恢复默认位置"><span>Shopcity FB 自动控制器 v${CURRENT_VERSION}</span><button id="xh-collapse">−</button></header>
      <div class="body">
        <div class="account-top">
          <label>Facebook广告账户</label>
          <div class="account-tools">
            <button type="button" id="xh-account-detect">自动检测当前店铺账户</button>
            <button type="button" id="xh-account-select-all">全选</button>
            <button type="button" id="xh-account-select-none">全不选</button>
          </div>
        </div>
        <span id="xh-account-status" class="field-status" data-kind="idle">可自动检测当前店铺绑定账户，并勾选需要执行任务的账户</span>
        <input class="account-search" id="xh-account-search" placeholder="搜索FB账号、授权邮箱、广告账户名称或广告账户ID">
        <div id="xh-account-options" class="account-options">${renderAdAccountOptions()}</div>
        <div class="two-cols">
          <div><label>Shop ID</label><div class="input-action"><input id="xh-shop-id" value="${html(config.shopId)}"><button type="button" id="xh-shop-id-detect">自动获取</button></div><span id="xh-shop-id-status" class="field-status" data-kind="idle">将从当前登录店铺自动识别</span></div>
          <div><label>任务执行间隔（分钟）</label><input type="number" min="1" step="1" id="xh-interval-minutes" value="${html(config.intervalMinutes)}"></div>
        </div>
        <label>运行模式</label>
        <select id="xh-mode">
          <option value="observe" ${config.mode === 'observe' ? 'selected' : ''}>观察模式：只记录，不暂停</option>
          <option value="live" ${config.mode === 'live' ? 'selected' : ''}>正式模式：命中后暂停，0点可开启</option>
        </select>
        <label>白名单广告ID（逗号、空格或换行分隔）</label>
        <textarea id="xh-whitelist" placeholder="每行一个ad_id">${html(config.whitelist.join('\n'))}</textarea>
        <div class="policy">
          <div class="policy-title">广告保护与检测点</div>
          <div class="protection-head"><span>保护指标</span><span>达到数量</span><span>花费上限</span><span>操作</span></div>
          <div id="xh-protection-list">
            ${config.policy.protectionRules.map((rule) => renderProtectionRule(rule)).join('')}
          </div>
          <div class="stage-tools"><button type="button" id="xh-protection-add">＋ 新增保护规则</button></div>
          <div class="policy-note">例如选择 FB成效，达到数量填 1，花费上限填 30，表示广告已有 1 个 FB成效时，在花费不超过 30 前直接保留广告，不执行检测点；超过 30 后继续按检测点判断。</div>
          <div class="checkpoint-help">
            <div><strong>花费检查点怎么生效：</strong>广告累计花费达到某个检查点后，脚本才会检查该行条件。</div>
            <div><strong>只执行最高档：</strong>例如花费为 $1.80，存在 $0.35 和 $1.60 两档时，只执行 $1.60 这一行。</div>
            <div><strong>数字 0 的含义：</strong>填写 0 代表该项不参与检查；填写大于 0 才表示需要达到的最低数量。</div>
            <div><strong>判定规则：</strong>任一广告保护规则命中后会直接保留；未命中保护时，当前检查点行所有启用条件中，任意一项低于最低数量，就判定命中关闭规则；观察模式只记录，正式模式才暂停。</div>
          </div>
          <div class="stage-table">
            <div class="stage-head stage-ten"><span>花费检查点</span><span>FB最少单次链接点击数</span><span>FB最少加购数</span><span>FB最少成效数</span><span>最少访客数</span><span>最少商详页访客数</span><span>最少加购数</span><span>最少发起结账数</span><span>最少订单数</span><span>操作</span></div>
            <div id="xh-stage-list">
              ${Object.entries(config.policy.stages).sort(([a], [b]) => Number(a) - Number(b)).map(([spend, stage]) => `<div class="stage-row stage-ten stage-policy-row">
                <input class="stage-spend" type="number" min="0.01" step="0.01" value="${html(spend)}" title="花费检查点（USD）">
                <input class="stage-fb-clicks" type="number" min="0" step="1" value="${html(stage.minFbClicks)}">
                <input class="stage-fb-cart" type="number" min="0" step="1" value="${html(stage.minFbAddToCart)}">
                <input class="stage-fb-purchases" type="number" min="0" step="1" value="${html(stage.minFbPurchases)}">
                <input class="stage-visitors" type="number" min="0" step="1" value="${html(stage.minVisitors)}">
                <input class="stage-view-content" type="number" min="0" step="1" value="${html(stage.minViewContent)}">
                <input class="stage-cart" type="number" min="0" step="1" value="${html(stage.minAddToCart)}">
                <input class="stage-checkout" type="number" min="0" step="1" value="${html(stage.minInitiateCheckout)}">
                <input class="stage-orders" type="number" min="0" step="1" value="${html(stage.minOrders)}">
                <button type="button" class="stage-delete" title="删除检测点">删除</button>
              </div>`).join('')}
            </div>
          </div>
          <div class="stage-tools"><button type="button" id="xh-stage-add">＋ 新增检测点</button></div>
          <div class="policy-note">执行顺序：广告保护规则 → 花费检查点。任一保护规则命中后，不再执行检测点判断。</div>
        </div>
        <div class="policy">
          <div class="policy-title">关闭后复核</div>
          <label><input type="checkbox" id="xh-review-enabled" ${config.review.enabled ? 'checked' : ''}>启用脚本关闭广告复核</label>
          <div class="stage-head"><span></span><span>数值</span><span>单位</span></div>
          <div class="stage-row"><strong>间隔</strong><input type="number" min="1" step="1" id="xh-review-delay" value="${html(config.review.delayMinutes)}"><span>分钟</span></div>
          <div class="stage-row"><strong>次数</strong><input type="number" min="1" step="1" id="xh-review-max" value="${html(config.review.maxReviews)}"><span>次/广告</span></div>
          <div class="policy-note">只复核本脚本正式模式关闭的广告；未达标时按间隔继续复核，达到次数后结束；任意一次达标都会立即恢复。恢复后立即回到正常检测流程；人工暂停广告不会通过复核自动开启。</div>
        </div>
        <div class="policy">
          <div class="policy-title">账户0点自动开广告</div>
          <label><input type="checkbox" id="xh-zero-reopen-enabled" ${config.zeroReopen.enabled ? 'checked' : ''}>启用账户时区0点自动开广告</label>
          <div class="stage-head"><span></span><span>数值</span><span>单位</span></div>
          <div class="stage-row"><strong>执行窗口</strong><input type="number" min="1" step="1" id="xh-zero-reopen-window" value="${html(config.zeroReopen.windowMinutes)}"><span>分钟</span></div>
          <div class="stage-row"><strong>失败重试</strong><input type="number" min="1" step="1" id="xh-zero-reopen-retry" value="${html(config.zeroReopen.retryMinutes)}"><span>分钟</span></div>
          <div class="policy-note">按每个已勾选广告账户的时区进入新一天后执行；会打开所有已暂停且当日花费为0的广告，包括人工暂停广告。观察模式只记录，正式模式才开启；每个账户每天成功检查一次。</div>
        </div>
        <div class="policy" id="xh-feishu-panel">
          <div class="policy-title">飞书多维表格同步</div>
          <label><input type="checkbox" id="xh-feishu-enabled" ${config.feishu.enabled ? 'checked' : ''}>启用飞书自动同步</label>
          <div class="two-cols">
            <div><label>App ID</label><input id="xh-feishu-app-id" value="${html(config.feishu.appId)}"></div>
            <div><label>App Secret</label><input id="xh-feishu-app-secret" type="password" placeholder="${getFeishuSecret() ? '已安全保存；留空表示不修改' : '请填写 App Secret'}" autocomplete="off"></div>
          </div>
          <label>App Token</label><input id="xh-feishu-app-token" value="${html(config.feishu.appToken)}">
          <div class="two-cols">
            <div><label>广告明细 Table ID</label><input id="xh-feishu-ad-table" value="${html(config.feishu.adDetailsTableId)}"></div>
            <div><label>账户汇总 Table ID</label><input id="xh-feishu-account-table" value="${html(config.feishu.accountSummaryTableId)}"></div>
          </div>
          <div class="two-cols">
            <div><label>广告操作日志 Table ID</label><input id="xh-feishu-log-table" value="${html(config.feishu.operationLogTableId)}"></div>
            <div><label>系统配置 Table ID</label><input id="xh-feishu-config-table" value="${html(config.feishu.systemConfigTableId)}"></div>
          </div>
          <div class="actions"><button type="button" id="xh-feishu-test">测试飞书连接</button></div>
          <div class="info"><span id="xh-feishu-status" data-kind="idle">尚未测试连接</span><span>Secret仅保存在脚本管理器独立存储</span></div>
        </div>
        <div class="policy" id="xh-update-panel">
          <div class="policy-title">GitHub 版本中心</div>
          <div class="info"><span>当前版本：v${CURRENT_VERSION}</span><span>仓库：harmony-s/sc-fb-auto-controller</span></div>
          <label><input type="checkbox" id="xh-update-auto" ${config.update.autoCheck ? 'checked' : ''}>每12小时自动检查一次（不会自动安装）</label>
          <div class="two-cols">
            <div><label>版本通道</label><select id="xh-update-channel">
              <option value="stable" ${config.update.channel === 'stable' ? 'selected' : ''}>稳定版</option>
              <option value="beta" ${config.update.channel === 'beta' ? 'selected' : ''}>测试版</option>
              <option value="dev" ${config.update.channel === 'dev' ? 'selected' : ''}>开发版</option>
              <option value="all" ${config.update.channel === 'all' ? 'selected' : ''}>全部历史版本</option>
            </select></div>
            <div><label>选择版本</label><select id="xh-update-version" disabled><option>请先检查更新</option></select></div>
          </div>
          <div id="xh-update-details" class="update-details">点击“检查更新”后载入可用版本。</div>
          <div class="actions">
            <button type="button" id="xh-update-check">检查更新</button>
            <button type="button" class="primary" id="xh-update-install" disabled>安装所选版本</button>
          </div>
          <div class="info"><span id="xh-update-status" data-kind="idle">尚未检查</span><span>校验通过后由Tampermonkey确认更新</span></div>
          <div class="policy-note">更新或回退保持相同脚本标识，现有广告参数、面板位置与飞书 Secret 会保留。</div>
        </div>
        <div class="actions">
          <button class="primary" id="xh-start">启动循环</button>
          <button class="danger" id="xh-stop" disabled>停止</button>
          <button id="xh-run-once">手动执行一次</button>
          <button id="xh-save">保存配置</button>
        </div>
        <div class="info"><span id="xh-status" data-kind="idle">未启动</span><span>下次：<b id="xh-countdown">未启动</b></span></div>
        <div class="actions">
          <button id="xh-export">导出CSV</button>
          <button id="xh-clear-logs">清空日志</button>
        </div>
        <div class="log-title">广告操作日志</div>
        <div class="log-filters">
          <div><label>筛选广告账户ID</label><input id="xh-log-filter-account" placeholder="输入广告账户ID"></div>
          <div><label>筛选广告ID</label><input id="xh-log-filter-ad" placeholder="输入广告ID"></div>
        </div>
        <div class="logs"><table><thead><tr><th>时间</th><th class="id-cell">广告账户ID</th><th class="id-cell">广告ID</th><th>广告名称</th><th class="metric-cell">花费</th><th class="metric-cell">FB单点</th><th class="metric-cell">CPC</th><th class="metric-cell">FB加购</th><th class="metric-cell">访客</th><th class="metric-cell">商详页访客</th><th class="metric-cell">FB成效</th><th class="metric-cell">站内加购</th><th class="metric-cell">发起结账</th><th class="metric-cell">订单</th><th>动作</th><th>规则</th><th>结果</th></tr></thead><tbody id="xh-log-body"></tbody></table></div>
        <div class="log-title">广告账户汇总统计</div>
        <div class="logs"><table><thead><tr><th>执行时间</th><th class="id-cell">广告账户ID</th><th class="metric-cell">总花费</th><th class="metric-cell">FB单点</th><th class="metric-cell">平均CPC</th><th class="metric-cell">FB加购</th><th class="metric-cell">FB成效</th><th class="metric-cell">访客</th><th class="metric-cell">商详页访客</th><th class="metric-cell">站内加购</th><th class="metric-cell">发起结账</th><th class="metric-cell">订单</th><th>本轮处理情况</th></tr></thead><tbody id="xh-summary-body"></tbody></table></div>
      </div>`;
    const panelBody = panel.querySelector('.body');
    panelBody.prepend(panel.querySelector('#xh-feishu-panel'));
    panelBody.prepend(panel.querySelector('#xh-update-panel'));
    document.body.appendChild(panel);
    applyPanelPosition(panel);
    makePanelDraggable(panel);

    panel.querySelector('#xh-protection-add').addEventListener('click', () => {
      panel.querySelector('#xh-protection-list').insertAdjacentHTML('beforeend', renderProtectionRule({
        metric: 'fb_purchase_num',
        minCount: 1,
        maxSpend: 30,
      }));
    });
    panel.querySelector('#xh-protection-list').addEventListener('click', (event) => {
      const button = event.target.closest('.protection-delete');
      if (!button) return;
      button.closest('.protection-rule-row').remove();
    });

    panel.querySelector('#xh-stage-add').addEventListener('click', () => {
      const rows = [...panel.querySelectorAll('#xh-stage-list .stage-policy-row')];
      const highest = Math.max(0, ...rows.map((row) => numberValue(row.querySelector('.stage-spend').value)));
      panel.querySelector('#xh-stage-list').insertAdjacentHTML('beforeend', `<div class="stage-row stage-ten stage-policy-row">
        <input class="stage-spend" type="number" min="0.01" step="0.01" value="${highest + 1}" title="花费检查点（USD）">
        <input class="stage-fb-clicks" type="number" min="0" step="1" value="0">
        <input class="stage-fb-cart" type="number" min="0" step="1" value="0">
        <input class="stage-fb-purchases" type="number" min="0" step="1" value="0">
        <input class="stage-visitors" type="number" min="0" step="1" value="0">
        <input class="stage-view-content" type="number" min="0" step="1" value="0">
        <input class="stage-cart" type="number" min="0" step="1" value="0">
        <input class="stage-checkout" type="number" min="0" step="1" value="0">
        <input class="stage-orders" type="number" min="0" step="1" value="0">
        <button type="button" class="stage-delete" title="删除检测点">删除</button>
      </div>`);
    });
    panel.querySelector('#xh-stage-list').addEventListener('click', (event) => {
      const button = event.target.closest('.stage-delete');
      if (!button) return;
      const rows = panel.querySelectorAll('#xh-stage-list .stage-policy-row');
      if (rows.length <= 1) {
        setStatus('至少保留一个检测点', 'error');
        return;
      }
      button.closest('.stage-policy-row').remove();
    });

    panel.querySelector('#xh-shop-id-detect').addEventListener('click', () => {
      autoFillShopId({ force: true }).catch((error) => setShopIdStatus(`自动获取失败：${error.message}`, 'error'));
    });
    panel.querySelector('#xh-account-detect').addEventListener('click', detectAndRenderAdAccounts);
    panel.querySelector('#xh-account-search').addEventListener('input', applyAdAccountFilter);
    panel.querySelector('#xh-account-select-all').addEventListener('click', () => {
      visibleAdAccountChecks(panel).forEach((input) => { input.checked = true; });
      persistAccountSelectionFromPanel();
    });
    panel.querySelector('#xh-account-select-none').addEventListener('click', () => {
      visibleAdAccountChecks(panel).forEach((input) => { input.checked = false; });
      persistAccountSelectionFromPanel();
    });
    panel.querySelector('#xh-account-options').addEventListener('change', (event) => {
      if (!event.target.matches('.account-check')) return;
      persistAccountSelectionFromPanel();
    });
    panel.querySelector('#xh-start').addEventListener('click', start);
    panel.querySelector('#xh-stop').addEventListener('click', stop);
    panel.querySelector('#xh-run-once').addEventListener('click', () => {
      try {
        readFormConfig();
        validateConfig();
        saveConfig();
        executeRound('manual');
      } catch (error) {
        setStatus(error.message, 'error');
      }
    });
    panel.querySelector('#xh-save').addEventListener('click', () => {
      try {
        readFormConfig();
        validateConfig();
        saveConfig();
        setStatus('配置已保存', 'ok');
      } catch (error) {
        setStatus(`配置错误：${error.message}`, 'error');
      }
    });
    panel.querySelector('#xh-feishu-test').addEventListener('click', async () => {
      const button = panel.querySelector('#xh-feishu-test');
      button.disabled = true;
      try {
        await testFeishuConnection();
      } catch (error) {
        setFeishuStatus(`连接失败：${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
    panel.querySelector('#xh-update-check').addEventListener('click', () => {
      checkForUpdates({ force: true }).catch(() => {});
    });
    panel.querySelector('#xh-update-channel').addEventListener('change', (event) => {
      config.update.channel = event.target.value;
      saveConfig();
      if (updateManifestCache) {
        populateReleaseOptions(updateManifestCache);
        checkForUpdates({ force: false, silent: true }).catch(() => {});
      }
    });
    panel.querySelector('#xh-update-auto').addEventListener('change', (event) => {
      config.update.autoCheck = event.target.checked;
      saveConfig();
    });
    panel.querySelector('#xh-update-version').addEventListener('change', renderReleaseDetails);
    panel.querySelector('#xh-update-install').addEventListener('click', () => {
      installSelectedRelease().catch((error) => setUpdateStatus(`安装已阻止：${error.message}`, 'error'));
    });
    panel.querySelector('#xh-log-filter-account').addEventListener('input', renderLogs);
    panel.querySelector('#xh-log-filter-ad').addEventListener('input', renderLogs);
    panel.querySelector('#xh-export').addEventListener('click', exportCsv);
    panel.querySelector('#xh-clear-logs').addEventListener('click', clearLogs);
    panel.querySelector('#xh-collapse').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      panel.querySelector('#xh-collapse').textContent = panel.classList.contains('collapsed') ? '+' : '−';
      requestAnimationFrame(() => clampPanelPosition(panel, true));
    });

    countdownId = window.setInterval(updateCountdown, 1000);
    window.addEventListener('beforeunload', () => {
      if (countdownId) window.clearInterval(countdownId);
      if (timerId) window.clearTimeout(timerId);
      if (reviewTimerId) window.clearTimeout(reviewTimerId);
      if (zeroReopenTimerId) window.clearTimeout(zeroReopenTimerId);
    });
    renderSummaries();
    renderLogs();
    updateButtons();
    updateAccountStatusFromSelection();
    window.setTimeout(() => {
      autoFillShopId({ force: false, silent: Boolean(normalizeShopIdCandidate(config.shopId)) })
        .catch((error) => setShopIdStatus(`自动获取失败：${error.message}`, 'error'));
    }, 300);
    if (config.update.autoCheck) {
      let lastCheck = 0;
      try { lastCheck = numberValue(GM_getValue(UPDATE_LAST_CHECK_KEY, 0)); } catch (_) { /* ignore */ }
      if (Date.now() - lastCheck >= UPDATE_CHECK_INTERVAL) {
        window.setTimeout(() => checkForUpdates({ force: true, silent: true }).catch(() => {}), 1200);
      } else {
        window.setTimeout(() => checkForUpdates({ force: false, silent: true }).catch(() => {}), 1200);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel, { once: true });
  } else {
    createPanel();
  }
})();
