// ==UserScript==
// @name         Shopcity Facebook 广告自动控制器
// @namespace    xh-shopcity
// @version      1.8.28
// @description  修复登录恢复桥接并支持刷新后自动恢复运行。
// @match        https://*.shopcity.vip/admin*
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
  const MODULE_TAB_KEY = 'xh_shopcity_fb_controller_module_tab_v1';
  const FEISHU_SECRET_KEY = 'xh_shopcity_fb_controller_feishu_secret_v1';
  const FEISHU_RECORD_CACHE_KEY = 'xh_shopcity_fb_controller_feishu_records_v1';
  const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
  const CURRENT_VERSION = '1.8.28';
  const SHOP_ID_CHECK_URL = 'https://api.shopcity.vip/sail/seller/check-user';
  const LOGIN_PASSWORD_KEY_PREFIX = 'xh_shopcity_fb_controller_login_password_v1_';
  const LOGIN_RETURN_URL_KEY = 'xh_shopcity_fb_controller_login_return_url_v1';
  const LOGIN_RESUME_KEY = 'xh_shopcity_fb_controller_login_resume_v1';
  const LOGIN_ATTEMPT_KEY = 'xh_shopcity_fb_controller_login_attempt_v1';
  const LOGIN_LAST_LOG_KEY = 'xh_shopcity_fb_controller_login_last_log_v1';
  const RUN_INTENT_KEY = 'xh_shopcity_fb_controller_run_intent_v1';
  const CONVERSION_PATH = '/admin/conversion';
  const LOGIN_PATH = '/admin/login';
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
    fbUserCandidates: [],
    accountShowFilter: 'visible',
    shopId: '',
    intervalMinutes: 20,
    mode: 'observe',
    mainDataTimeZone: 'pacific',
    whitelist: {
      accountIds: [],
      campaignIds: [],
      adsetIds: [],
      adIds: [],
    },
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
    loginGuard: {
      enabled: false,
      autoLogin: false,
      username: '',
      checkMinutes: 5,
      failLimit: 2,
      resumeAfterLogin: true,
    },
    review: {
      enabled: true,
      maxReviews: 3,
    },
    zeroReopen: {
      enabled: false,
      hour: 0,
      minute: 0,
      windowMinutes: 20,
      retryMinutes: 2,
      minSpend: 0,
      maxSpend: 0,
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
  let zeroReopenTimerId = null;
  let zeroReopenExecuting = false;
  let loginGuardTimerId = null;
  let loginGuardExecuting = false;
  let loginGuardFailCount = 0;
  let loginExpired = false;
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

  function setRunIntent(enabled) {
    if (enabled) localStorage.setItem(RUN_INTENT_KEY, '1');
    else localStorage.removeItem(RUN_INTENT_KEY);
  }

  function shouldRestoreRun() {
    return localStorage.getItem(RUN_INTENT_KEY) === '1';
  }

  function currentShopHost() {
    return location.hostname.replace(/[^a-z0-9.-]/gi, '_').toLowerCase();
  }

  function loginPasswordKey() {
    return `${LOGIN_PASSWORD_KEY_PREFIX}${currentShopHost()}`;
  }

  function getLoginPassword() {
    try { return String(GM_getValue(loginPasswordKey(), '') || ''); } catch (_) { return ''; }
  }

  function saveLoginPassword(value) {
    const text = String(value || '');
    if (text) GM_setValue(loginPasswordKey(), text);
  }

  function shopLoginUrl() {
    return `${location.origin}${LOGIN_PATH}`;
  }

  function conversionUrl() {
    const saved = String(localStorage.getItem(LOGIN_RETURN_URL_KEY) || '').trim();
    if (saved) {
      try {
        const url = new URL(saved, location.origin);
        if (url.origin === location.origin && url.pathname.startsWith(CONVERSION_PATH)) return url.href;
      } catch (_) { /* ignore invalid saved return URL */ }
    }
    return `${location.origin}${CONVERSION_PATH}`;
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

  function normalizeStageRule(stage) {
    return {
      minFbClicks: numberValue(stage?.minFbClicks ?? stage?.minClicks),
      minFbAddToCart: numberValue(stage?.minFbAddToCart ?? stage?.minAddToCart),
      minFbPurchases: numberValue(stage?.minFbPurchases),
      minVisitors: numberValue(stage?.minVisitors),
      minViewContent: numberValue(stage?.minViewContent ?? stage?.minProductDetailVisitors),
      minAddToCart: numberValue(stage?.minFbAddToCart == null ? 0 : stage?.minAddToCart),
      minInitiateCheckout: numberValue(stage?.minInitiateCheckout),
      minOrders: numberValue(stage?.minOrders),
    };
  }

  function normalizeStageRules(stage) {
    const source = Array.isArray(stage) ? stage : [stage];
    return source.map(normalizeStageRule);
  }

  function normalizeStages(stages) {
    const source = stages && Object.keys(stages).length ? stages : DEFAULT_CONFIG.policy.stages;
    const normalized = {};
    for (const [spend, stage] of Object.entries(source)) {
      const normalizedSpend = String(numberValue(spend));
      if (numberValue(normalizedSpend) <= 0) continue;
      normalized[normalizedSpend] = [
        ...(normalized[normalizedSpend] || []),
        ...normalizeStageRules(stage),
      ];
    }
    return normalized;
  }

  function stageRulesForSpend(stages, spend) {
    const stage = stages?.[String(numberValue(spend))] ?? stages?.[String(spend)];
    return Array.isArray(stage) ? stage : stage ? [stage] : [];
  }

  function stageRuleEntries(stages) {
    return Object.entries(stages || {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .flatMap(([spend]) => stageRulesForSpend(stages, spend).map((stage, index) => ({ spend, stage, index })));
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

  function normalizeShopcityIsShow(value) {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return null;
    if (['1', 'true', 'yes', 'y', 'show', 'shown', 'visible', '显示', '展示'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', 'hide', 'hidden', 'invisible', '隐藏', '不显示'].includes(text)) return false;
    return null;
  }

  function adAccountIsShopcityShown(account) {
    return account?.isShow !== false;
  }

  function normalizeAccountShowFilter(value) {
    const text = String(value || '').trim();
    return ['visible', 'all', 'hidden'].includes(text) ? text : DEFAULT_CONFIG.accountShowFilter;
  }

  function normalizeMainDataTimeZone(value) {
    const text = String(value || '').trim();
    return ['pacific', 'account'].includes(text) ? text : DEFAULT_CONFIG.mainDataTimeZone;
  }

  function normalizeWhitelistId(value) {
    return String(value ?? '').trim().replace(/^act[_-]/i, '');
  }

  function parseWhitelistIds(value) {
    const source = Array.isArray(value) ? value.join('\n') : String(value ?? '');
    return [...new Set(source
      .split(/[\s,，;；、|]+/)
      .map(normalizeWhitelistId)
      .filter(Boolean))];
  }

  function normalizeWhitelist(value) {
    if (Array.isArray(value) || typeof value === 'string') {
      return {
        ...DEFAULT_CONFIG.whitelist,
        adIds: parseWhitelistIds(value),
      };
    }
    const source = value && typeof value === 'object' ? value : {};
    return {
      accountIds: parseWhitelistIds(source.accountIds ?? source.accounts ?? source.account_ids),
      campaignIds: parseWhitelistIds(source.campaignIds ?? source.campaigns ?? source.campaign_ids),
      adsetIds: parseWhitelistIds(source.adsetIds ?? source.adsets ?? source.adset_ids),
      adIds: parseWhitelistIds(source.adIds ?? source.ads ?? source.ad_ids),
    };
  }

  function whitelistMatch(ad, fallbackAccountId = '') {
    const whitelist = normalizeWhitelist(config.whitelist);
    const accountId = normalizeWhitelistId(firstValue(ad, ['account_id', 'accountId'], fallbackAccountId));
    const campaignId = normalizeWhitelistId(firstValue(ad, ['campaign_id', 'campaignId'], ''));
    const adsetId = normalizeWhitelistId(firstValue(ad, ['adset_id', 'adsetId'], ''));
    const adId = normalizeWhitelistId(firstValue(ad, ['ad_id', 'adId'], ''));
    if (accountId && whitelist.accountIds.includes(accountId)) return { level: 'account', label: '广告账户', id: accountId };
    if (campaignId && whitelist.campaignIds.includes(campaignId)) return { level: 'campaign', label: '广告系列', id: campaignId };
    if (adsetId && whitelist.adsetIds.includes(adsetId)) return { level: 'adset', label: '广告组', id: adsetId };
    if (adId && whitelist.adIds.includes(adId)) return { level: 'ad', label: '广告', id: adId };
    return null;
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
      return id ? { id, name: '', currency: '', status: '', timeZone: '', isShow: null, fbUserId: '', fbUserName: '', fbUserEmail: '', source } : null;
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
      isShow: normalizeShopcityIsShow(value.is_show ?? value.isShow ?? value.account_is_show ?? value.accountIsShow),
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
      const previous = merged.get(account.id) || { id: account.id, name: '', currency: '', status: '', timeZone: '', isShow: null, fbUserId: '', fbUserName: '', fbUserEmail: '', source: '' };
      merged.set(account.id, {
        id: account.id,
        name: previous.name || account.name,
        currency: previous.currency || account.currency,
        status: previous.status || account.status,
        timeZone: previous.timeZone || account.timeZone,
        isShow: previous.isShow ?? account.isShow,
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
    const loginGuard = value?.loginGuard || {};
    const accountCandidates = normalizeAdAccountCandidates(value?.accountCandidates)
      .filter(isDetectedAdAccountCandidate);
    const fbUserCandidates = normalizeFbUserCandidates(value?.fbUserCandidates).filter(isOauthFbUserCandidate);
    const savedAccountIds = configAccountIds(value);
    const candidateIds = new Set(accountCandidates.map((account) => account.id));
    const accountIds = (savedAccountIds.length ? savedAccountIds : selectedAccountIdsFromCandidates(accountCandidates))
      .filter((id) => candidateIds.has(id));
    return {
      ...DEFAULT_CONFIG,
      ...value,
      accountIds,
      accountCandidates,
      fbUserCandidates,
      accountShowFilter: normalizeAccountShowFilter(value?.accountShowFilter),
      mainDataTimeZone: normalizeMainDataTimeZone(value?.mainDataTimeZone),
      whitelist: normalizeWhitelist(value?.whitelist),
      feishu: { ...DEFAULT_CONFIG.feishu, ...feishu },
      update: { ...DEFAULT_CONFIG.update, ...update },
      loginGuard: {
        enabled: typeof loginGuard.enabled === 'boolean' ? loginGuard.enabled : DEFAULT_CONFIG.loginGuard.enabled,
        autoLogin: typeof loginGuard.autoLogin === 'boolean' ? loginGuard.autoLogin : DEFAULT_CONFIG.loginGuard.autoLogin,
        username: String(loginGuard.username || '').trim(),
        checkMinutes: numberValue(loginGuard.checkMinutes ?? DEFAULT_CONFIG.loginGuard.checkMinutes),
        failLimit: numberValue(loginGuard.failLimit ?? DEFAULT_CONFIG.loginGuard.failLimit),
        resumeAfterLogin: typeof loginGuard.resumeAfterLogin === 'boolean' ? loginGuard.resumeAfterLogin : DEFAULT_CONFIG.loginGuard.resumeAfterLogin,
      },
      review: {
        enabled: typeof review.enabled === 'boolean' ? review.enabled : DEFAULT_CONFIG.review.enabled,
        maxReviews: numberValue(review.maxReviews ?? review.maxReopensPerDay ?? DEFAULT_CONFIG.review.maxReviews),
      },
      zeroReopen: {
        enabled: typeof zeroReopen.enabled === 'boolean' ? zeroReopen.enabled : DEFAULT_CONFIG.zeroReopen.enabled,
        hour: numberValue(zeroReopen.hour ?? DEFAULT_CONFIG.zeroReopen.hour),
        minute: numberValue(zeroReopen.minute ?? DEFAULT_CONFIG.zeroReopen.minute),
        windowMinutes: numberValue(zeroReopen.windowMinutes ?? DEFAULT_CONFIG.zeroReopen.windowMinutes),
        retryMinutes: numberValue(zeroReopen.retryMinutes ?? DEFAULT_CONFIG.zeroReopen.retryMinutes),
        minSpend: numberValue(zeroReopen.minSpend ?? DEFAULT_CONFIG.zeroReopen.minSpend),
        maxSpend: numberValue(zeroReopen.maxSpend ?? DEFAULT_CONFIG.zeroReopen.maxSpend),
      },
      policy: {
        ...DEFAULT_CONFIG.policy,
        ...policy,
        protectionRules: normalizeProtectionRules(policy),
        stages: normalizeStages(stages),
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

  function dateInTimeZone(timeZone, date = new Date()) {
    return timeZoneParts(timeZone, date).date;
  }

  function mainDataContext(account, date = new Date()) {
    if (config.mainDataTimeZone === 'account') {
      const timeZone = normalizeTimeZone(account?.timeZone) || 'America/Los_Angeles';
      return { date: dateInTimeZone(timeZone, date), timeZone };
    }
    return { date: pacificDate(date), timeZone: 'America/Los_Angeles' };
  }

  function zeroReopenTiming(timeZone, date = new Date()) {
    const parts = timeZoneParts(timeZone, date);
    const minutesSinceMidnight = parts.hour * 60 + parts.minute + parts.second / 60;
    const scheduledMinutes = numberValue(config.zeroReopen.hour) * 60 + numberValue(config.zeroReopen.minute);
    const minutesSinceScheduled = minutesSinceMidnight - scheduledMinutes;
    const windowMinutes = Math.max(1, numberValue(config.zeroReopen.windowMinutes));
    return {
      ...parts,
      inWindow: minutesSinceScheduled >= 0 && minutesSinceScheduled < windowMinutes,
      minutesSinceMidnight,
      minutesSinceScheduled,
      scheduledHour: numberValue(config.zeroReopen.hour),
      scheduledMinute: numberValue(config.zeroReopen.minute),
    };
  }

  function zeroReopenRunKey(accountId, timeZone, date) {
    const hour = String(numberValue(config.zeroReopen.hour)).padStart(2, '0');
    const minute = String(numberValue(config.zeroReopen.minute)).padStart(2, '0');
    const minSpend = numberValue(config.zeroReopen.minSpend).toFixed(2);
    const maxSpend = numberValue(config.zeroReopen.maxSpend).toFixed(2);
    return `${accountId}|${timeZone}|${date}|${hour}:${minute}|${minSpend}-${maxSpend}`;
  }

  function zeroReopenSpendRange() {
    return {
      min: numberValue(config.zeroReopen.minSpend),
      max: numberValue(config.zeroReopen.maxSpend),
    };
  }

  function spendInZeroReopenRange(spend) {
    const range = zeroReopenSpendRange();
    return spend + 0.000001 >= range.min && spend - 0.000001 <= range.max;
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
      const error = new Error(`HTTP ${response.status}`);
      if (isLoginExpiredHttpStatus(response.status)) handleLoginExpired(`接口返回 ${error.message}，可能登录已过期`);
      throw error;
    }

    const result = await response.json();
    if (result.code !== 0) {
      const message = result.msg || `接口错误 code=${result.code}`;
      if (isLoginExpiredResult(result, message)) handleLoginExpired(message);
      throw new Error(message);
    }
    return result;
  }

  function isLoginExpiredHttpStatus(status) {
    return [401, 419, 440].includes(Number(status));
  }

  function isLoginExpiredResult(result, message = '') {
    const code = Number(result?.code);
    const text = `${message} ${result?.msg || ''}`.toLowerCase();
    return [401, 419, 440, 1001, 1002, 10001, 10002].includes(code)
      || /(未登录|请登录|重新登录|登录过期|登录超时|登陆过期|登陆超时|unauthorized|login required|session|token expired)/i.test(text);
  }

  async function checkShopLoginStatus() {
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
      if (!response.ok) {
        return { loggedIn: false, message: `HTTP ${response.status}` };
      }
      const result = await response.json();
      const shopId = extractShopIdFromObject(result);
      if (result.code === 0 || shopId) {
        return { loggedIn: true, shopId, message: result.msg || 'success' };
      }
      return { loggedIn: false, message: result.msg || `接口错误 code=${result.code}` };
    } catch (error) {
      return { loggedIn: false, message: error.message || '登录状态检测失败' };
    }
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
    const status = await checkShopLoginStatus();
    return status.loggedIn && status.shopId ? { shopId: status.shopId, source: 'ShopCity登录状态接口' } : null;
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
    return { fbUserId, fbUserName, fbUserEmail, source: String(value.source || '').trim() };
  }

  function mergeFbUsers(users) {
    const merged = new Map();
    for (const user of users) {
      if (!user) continue;
      const key = user.fbUserId || user.fbUserEmail || user.fbUserName;
      if (!key) continue;
      const previous = merged.get(key) || { fbUserId: '', fbUserName: '', fbUserEmail: '' };
      merged.set(key, {
        fbUserId: previous.fbUserId || user.fbUserId,
        fbUserName: previous.fbUserName || user.fbUserName,
        fbUserEmail: previous.fbUserEmail || user.fbUserEmail,
        source: previous.source || user.source || '',
      });
    }
    return [...merged.values()];
  }

  function normalizeFbUserCandidates(value) {
    if (!Array.isArray(value)) return [];
    return mergeFbUsers(value.map(normalizeFbUserCandidate).filter(Boolean));
  }

  function isOauthFbUserCandidate(user) {
    return String(user?.source || '') === 'facebook-oauth/list';
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
      fbUsers = collectFbUsersFromObject(oauthResult).map((user) => ({ ...user, source: 'facebook-oauth/list' }));
    } catch (_) { /* ad-account detection can continue without FB user names */ }

    try {
      const adsResult = await pluginApiPost('facebook-ads/list', { page: 1, limit: 10000 });
      const accounts = collectAdAccountsFromObject(adsResult, 'ShopCity广告账户接口', { allowGenericId: true });
      const linkedAccounts = mergeAdAccountLists(attachFbUsersToAdAccounts(accounts, fbUsers));
      return {
        accounts: linkedAccounts,
        fbUsers,
      };
    } catch (_) {
      return { accounts: [], fbUsers };
    }
  }

  async function detectAdAccounts() {
    const fromApi = await detectAdAccountsFromApi();
    if (fromApi.accounts.length) {
      return {
        accounts: mergeAdAccountLists(fromApi.accounts),
        fbUsers: fromApi.fbUsers,
      };
    }

    const fromDocument = detectAdAccountsFromDocument();
    const fromStorage = detectAdAccountsFromStorage();
    const accounts = mergeAdAccountLists(fromDocument, fromStorage, fromApi.accounts);
    return {
      accounts,
      fbUsers: fromApi.fbUsers,
    };
  }

  function renderAdAccountOption(account, selectedIds = config.accountIds) {
    const selected = new Set(selectedIds.map(String));
    const showText = account.isShow === false ? 'ShopCity隐藏' : account.isShow === true ? 'ShopCity展示' : '';
    const isShowValue = account.isShow === false ? '0' : account.isShow === true ? '1' : '';
    const fbText = [account.fbUserName, account.fbUserEmail, account.fbUserId ? `FB账号 ${account.fbUserId}` : ''].filter(Boolean).join(' / ');
    const searchText = [account.id, account.name, account.fbUserName, account.fbUserEmail, account.fbUserId].filter(Boolean).join(' ').toLowerCase();
    const showBadge = account.isShow === false
      ? '<span class="badge badge-muted">ShopCity隐藏</span>'
      : '<span class="badge badge-success">ShopCity展示</span>';
    const fbBadge = fbText
      ? `<span class="cell-ellipsis" title="${html(fbText)}">${html(fbText)}</span>`
      : '<span class="badge badge-warning">未识别授权</span>';
    return `<tr class="account-option" data-id="${html(account.id)}" data-name="${html(account.name || '')}" data-currency="${html(account.currency || '')}" data-status="${html(account.status || '')}" data-time-zone="${html(account.timeZone || '')}" data-is-show="${html(isShowValue)}" data-fb-user-id="${html(account.fbUserId || '')}" data-fb-user-name="${html(account.fbUserName || '')}" data-fb-user-email="${html(account.fbUserEmail || '')}" data-source="${html(account.source || '')}" data-search="${html(searchText)}">
      <td><input type="checkbox" class="account-check" value="${html(account.id)}" ${selected.has(String(account.id)) ? 'checked' : ''}></td>
      <td class="id-cell" title="${html(account.id)}">${html(account.id)}</td>
      <td title="${html(account.name || '')}"><span class="cell-ellipsis">${html(account.name || '-')}</span></td>
      <td>${fbBadge}</td>
      <td title="${html(account.timeZone || '')}"><span class="cell-ellipsis">${html(account.timeZone || '-')}</span></td>
      <td>${showBadge}</td>
      <td title="${html(account.source || '已保存账户')}"><span class="cell-ellipsis">${html(account.source || '已保存账户')}</span></td>
    </tr>`;
  }

  function renderAdAccountOptions(accounts = config.accountCandidates, selectedIds = config.accountIds) {
    const normalized = mergeAdAccountLists(accounts).filter(isDetectedAdAccountCandidate);
    if (!normalized.length) {
      return '<div class="account-empty">尚未检测到账户；请点击自动检测当前店铺账户。</div>';
    }
    return `<table class="data-table account-table">
      <thead><tr><th>选择</th><th>广告账户ID</th><th>广告账户名称</th><th>FB授权账号</th><th>时区</th><th>ShopCity状态</th><th>来源</th></tr></thead>
      <tbody>${normalized.map((account) => renderAdAccountOption(account, selectedIds)).join('')}</tbody>
    </table>`;
  }

  function fbUserFilterValue(user) {
    const normalized = normalizeFbUserCandidate(user);
    if (!normalized) return '';
    if (normalized.fbUserId) return `id:${normalized.fbUserId}`;
    if (normalized.fbUserEmail) return `email:${normalized.fbUserEmail.toLowerCase()}`;
    if (normalized.fbUserName) return `name:${normalized.fbUserName.toLowerCase()}`;
    return '';
  }

  function fbUserFilterLabel(user) {
    const normalized = normalizeFbUserCandidate(user);
    if (!normalized) return '';
    return [
      normalized.fbUserName,
      normalized.fbUserEmail,
      normalized.fbUserId ? `FB账号 ${normalized.fbUserId}` : '',
    ].filter(Boolean).join(' / ');
  }

  function renderFbUserFilterOptions(selectedValue = '') {
    const users = normalizeFbUserCandidates(config.fbUserCandidates);
    const options = ['<option value="">全部FB账号</option>'];
    for (const user of users) {
      const value = fbUserFilterValue(user);
      const label = fbUserFilterLabel(user);
      if (!value || !label) continue;
      options.push(`<option value="${html(value)}" ${value === selectedValue ? 'selected' : ''}>${html(label)}</option>`);
    }
    return options.join('');
  }

  function updateFbUserFilterOptions(selectedValue = '') {
    const select = document.querySelector('#xh-fb-user-filter');
    if (!select) return;
    const previous = selectedValue || select.value || '';
    select.innerHTML = renderFbUserFilterOptions(previous);
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  function updateAdAccountOptions() {
    const element = document.querySelector('#xh-account-options');
    if (!element) return;
    updateFbUserFilterOptions();
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
      isShow: row.dataset.isShow === '0' ? false : row.dataset.isShow === '1' ? true : null,
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
    const fbUserFilter = document.querySelector('#xh-fb-user-filter')?.value || '';
    const showFilter = document.querySelector('#xh-account-show-filter')?.value || config.accountShowFilter || DEFAULT_CONFIG.accountShowFilter;
    const hasFilter = Boolean(keyword || fbUserFilter || showFilter !== 'all');
    setAccountStatus(
      total ? `已选择 ${selected}/${total} 个店铺绑定账户执行任务${hasFilter ? `，当前显示 ${visible} 个` : ''}` : '尚未检测到账户',
      selected ? 'ok' : 'idle'
    );
  }

  function adAccountRowMatchesFbUser(row, filterValue) {
    if (!filterValue) return true;
    const [type, ...parts] = String(filterValue).split(':');
    const value = parts.join(':').toLowerCase();
    if (!value) return true;
    if (type === 'id') return String(row.dataset.fbUserId || '').toLowerCase() === value;
    if (type === 'email') return String(row.dataset.fbUserEmail || '').toLowerCase() === value;
    if (type === 'name') return String(row.dataset.fbUserName || '').toLowerCase() === value;
    return true;
  }

  function adAccountRowMatchesShowFilter(row, filterValue) {
    const filter = normalizeAccountShowFilter(filterValue);
    if (filter === 'all') return true;
    if (filter === 'hidden') return row.dataset.isShow === '0';
    return row.dataset.isShow !== '0';
  }

  function parseAdAccountSearch(keyword) {
    const raw = String(keyword || '').trim().toLowerCase();
    const tokens = raw
      .split(/[\s,，;；、|]+/)
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean);
    const idTokens = new Set();
    const accountIds = [...new Set(tokens
      .map((token, index) => {
        const actMatch = token.match(/^act[_-]?(\d{6,})$/i);
        if (actMatch) {
          idTokens.add(index);
          return actMatch[1];
        }
        if (/^\d{6,}$/.test(token)) {
          idTokens.add(index);
          return token;
        }
        return '';
      })
      .filter(Boolean))];
    const textTokens = [...new Set(tokens.filter((_, index) => !idTokens.has(index)))];
    return { raw, accountIds, textTokens };
  }

  function adAccountRowMatchesKeyword(row, search) {
    if (!search.raw) return true;
    const searchText = String(row.dataset.search || '').toLowerCase();
    if (searchText.includes(search.raw)) return true;
    const accountId = String(row.dataset.id || '').toLowerCase();
    if (search.accountIds.some((id) => accountId.includes(id))) return true;
    if (search.textTokens.length > 1 && search.textTokens.every((token) => searchText.includes(token))) return true;
    return false;
  }

  function applyAdAccountFilter() {
    const search = parseAdAccountSearch(document.querySelector('#xh-account-search')?.value || '');
    const fbUserFilter = document.querySelector('#xh-fb-user-filter')?.value || '';
    const showFilter = document.querySelector('#xh-account-show-filter')?.value || config.accountShowFilter || DEFAULT_CONFIG.accountShowFilter;
    config.accountShowFilter = normalizeAccountShowFilter(showFilter);
    for (const row of document.querySelectorAll('#xh-account-options .account-option')) {
      const matchesKeyword = adAccountRowMatchesKeyword(row, search);
      const matchesFbUser = adAccountRowMatchesFbUser(row, fbUserFilter);
      const matchesShowFilter = adAccountRowMatchesShowFilter(row, showFilter);
      const shouldHide = !matchesKeyword || !matchesFbUser || !matchesShowFilter;
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
    const showFilter = normalizeAccountShowFilter(document.querySelector('#xh-account-show-filter')?.value || config.accountShowFilter);
    const accountCandidates = mergeAdAccountLists(readRenderedAdAccountCandidates()).filter(isDetectedAdAccountCandidate);
    const accountById = new Map(accountCandidates.map((account) => [account.id, account]));
    const candidateIds = new Set(accountCandidates.map((account) => account.id));
    config.accountShowFilter = showFilter;
    config.accountIds = readSelectedAdAccountIds()
      .filter((id) => candidateIds.has(id))
      .filter((id) => showFilter !== 'visible' || adAccountIsShopcityShown(accountById.get(id)));
    config.accountCandidates = accountCandidates;
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
      const detectedResult = await detectAdAccounts();
      const detected = detectedResult.accounts;
      if (!detected.length) {
        setAccountStatus('未检测到账户；请确认当前店铺已绑定Facebook广告账户', 'error');
        return;
      }

      const existingCandidates = mergeAdAccountLists(config.accountCandidates, readRenderedAdAccountCandidates())
        .filter(isDetectedAdAccountCandidate);
      const existingCandidateIds = new Set(existingCandidates.map((account) => account.id));
      const renderedSelectedIds = readSelectedAdAccountIds();
      const selectedIds = new Set(renderedSelectedIds.length ? renderedSelectedIds : config.accountIds);
      for (const account of detected) {
        if (!existingCandidateIds.has(account.id) && adAccountIsShopcityShown(account)) selectedIds.add(account.id);
      }
      config.accountCandidates = mergeAdAccountLists(detected);
      const accountById = new Map(config.accountCandidates.map((account) => [account.id, account]));
      const showFilter = normalizeAccountShowFilter(config.accountShowFilter);
      config.accountIds = [...selectedIds]
        .filter((id) => accountById.has(id))
        .filter((id) => showFilter !== 'visible' || adAccountIsShopcityShown(accountById.get(id)));
      config.fbUserCandidates = normalizeFbUserCandidates(detectedResult.fbUsers).filter(isOauthFbUserCandidate);
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

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function adStatus(ad) {
    return String(firstValue(ad, ['status', 'ad_status', 'effective_status', 'configured_status'], 'UNKNOWN')).toUpperCase();
  }

  function numberFrom(object, keys) {
    return numberValue(firstValue(object, keys, 0));
  }

  function percentageFrom(object, keys) {
    const raw = firstValue(object, keys, 0);
    const value = numberValue(String(raw).replace('%', ''));
    return String(raw).includes('%') || value > 1 ? value / 100 : value;
  }

  function adDetailFields(ad, accountId, executionId, now, date, timeZone = 'America/Los_Angeles') {
    const normalizedDate = date.replaceAll('/', '-');
    const adId = String(ad.ad_id || '');
    return {
      '唯一键': `${normalizedDate}_${accountId}_${adId}`,
      '数据日期': dateTimestamp(date),
      '首次同步时间': now,
      '最后同步时间': now,
      '最近同步批次ID': executionId,
      '数据时区': timeZone,
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

  async function syncFeishuAdDetails(ads, accountId, executionId, date = pacificDate(), timeZone = 'America/Los_Angeles') {
    if (!config.feishu.enabled) return { success: 0, failed: 0 };
    const now = Date.now();
    const tableId = config.feishu.adDetailsTableId;
    const allowed = await getFeishuTableFields(tableId);
    const rows = ads.map((ad) => adDetailFields(ad, accountId, executionId, now, date, timeZone));
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

  function accountSummaryFields(ads, accountId, executionId, date = pacificDate(), timeZone = 'America/Los_Angeles') {
    const now = Date.now();
    const metrics = sumMetrics(ads);
    const activeCount = ads.filter((ad) => adStatus(ad) === 'ACTIVE').length;
    const pausedCount = ads.filter((ad) => adStatus(ad) === 'PAUSED').length;
    const campaignIds = new Set(ads.map((ad) => String(ad.campaign_id || '')).filter(Boolean));
    const adsetIds = new Set(ads.map((ad) => String(ad.adset_id || '')).filter(Boolean));
    const normalizedDate = date.replaceAll('/', '-');
    return {
      '唯一键': `${normalizedDate}_${accountId}`,
      '数据日期': dateTimestamp(date),
      '首次同步时间': now,
      '最后同步时间': now,
      '最近同步批次ID': executionId,
      '数据时区': timeZone,
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

  async function syncFeishuAccountSummary(ads, accountId, executionId, date = pacificDate(), timeZone = 'America/Los_Angeles') {
    if (!config.feishu.enabled) return;
    const fields = accountSummaryFields(ads, accountId, executionId, date, timeZone);
    await upsertFeishuRecord(config.feishu.accountSummaryTableId, '唯一键', fields['唯一键'], fields, ['首次同步时间']);
  }

  function queueFeishuAccountSync(ads, accountId, executionId, date = pacificDate(), timeZone = 'America/Los_Angeles') {
    if (!config.feishu.enabled) return;
    enqueueFeishuTask(`账户 ${accountId}`, async () => {
      const detailResult = await syncFeishuAdDetails(ads, accountId, executionId, date, timeZone);
      await syncFeishuAccountSummary(ads, accountId, executionId, date, timeZone);
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
      WOULD_REOPEN_SCHEDULED_SPEND: '准备定时开启', REOPEN_SCHEDULED_SPEND: '定时已开启',
      SCHEDULED_REOPEN_WHITELIST_SKIP: '定时白名单跳过',
    })[action] || '执行失败';
  }

  function isAdOperation(action) {
    return !['ACCOUNT_SUMMARY', 'ACCOUNT_ERROR', 'ROUND_SUMMARY', 'ROUND_ERROR', 'ZERO_REOPEN_ACCOUNT_SUMMARY', 'SCHEDULED_REOPEN_ACCOUNT_SUMMARY'].includes(action);
  }

  async function syncFeishuOperationLog(log) {
    if (!config.feishu.enabled || !isAdOperation(log.action)) return;
    const metrics = log.metrics || {};
    const managed = getManagedAds()[managedKey(log.account_id, log.ad_id)] || {};
    const actual = ['PAUSE', 'REOPEN', 'REOPEN_ZERO_SPEND', 'REOPEN_SCHEDULED_SPEND'].includes(log.action);
    const beforeStatus = ['REOPEN', 'WOULD_REOPEN', 'REOPEN_ZERO_SPEND', 'WOULD_REOPEN_ZERO_SPEND', 'REOPEN_SCHEDULED_SPEND', 'WOULD_REOPEN_SCHEDULED_SPEND', 'REVIEW_KEEP_PAUSED', 'REVIEW_REOPEN_LIMIT', 'REVIEW_WHITELIST_SKIP', 'SCHEDULED_REOPEN_WHITELIST_SKIP'].includes(log.action) ? 'PAUSED' : 'ACTIVE';
    const plannedStatus = ['PAUSE', 'WOULD_PAUSE'].includes(log.action) ? 'PAUSED'
      : ['REOPEN', 'WOULD_REOPEN', 'REOPEN_ZERO_SPEND', 'WOULD_REOPEN_ZERO_SPEND', 'REOPEN_SCHEDULED_SPEND', 'WOULD_REOPEN_SCHEDULED_SPEND'].includes(log.action) ? 'ACTIVE' : '不变';
    const afterStatus = actual && log.success ? plannedStatus : beforeStatus;
    const logId = `${Date.parse(log.time) || Date.now()}_${log.execution_id || 'noexec'}_${log.account_id || 'noaccount'}_${log.ad_id || 'noad'}_${log.action}_${Math.random().toString(36).slice(2, 6)}`;
    const checkpoint = Number(String(log.matched_rule || '').match(/^STAGE_([\d.]+)/)?.[1] || 0);
    const dataDate = String(log.data_date || pacificDate(new Date(log.time)));
    await createFeishuRecord(config.feishu.operationLogTableId, {
      '日志ID': logId,
      '操作时间': Date.parse(log.time) || Date.now(),
      '数据日期': dateTimestamp(dataDate),
      '执行批次ID': String(log.execution_id || ''),
      '执行来源': ({ auto: '自动执行', start: '启动执行', manual: '手动执行', zero_reopen_timer: '定时自动开广告' })[log.source] || String(log.source || ''),
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
      '计划复核时间': undefined,
      '实际复核时间': ['REVIEW_KEEP_PAUSED', 'REVIEW_WHITELIST_SKIP', 'WOULD_REOPEN', 'REOPEN'].includes(log.action) ? Date.parse(log.time) : undefined,
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
      const failures = [];
      const rules = stageRulesForSpend(policy.stages, reachedStage);
      for (const [index, stage] of rules.entries()) {
        const checks = [
          { id: 'CLICKS', label: 'FB单次链接点击', value: uniqueClicks, target: numberValue(stage.minFbClicks) },
          { id: 'FB_ADD_TO_CART', label: 'FB加购', value: fbAddToCart, target: numberValue(stage.minFbAddToCart) },
          { id: 'FB_PURCHASES', label: 'FB成效', value: purchases, target: numberValue(stage.minFbPurchases) },
          { id: 'VISITORS', label: 'Shopcity访客', value: visitors, target: numberValue(stage.minVisitors) },
          { id: 'VIEW_CONTENT', label: 'Shopcity商详页访客', value: viewContent, target: numberValue(stage.minViewContent) },
          { id: 'ADD_TO_CART', label: 'Shopcity加购', value: addToCart, target: numberValue(stage.minAddToCart) },
          { id: 'INITIATE_CHECKOUT', label: 'Shopcity发起结账', value: initiateCheckout, target: numberValue(stage.minInitiateCheckout) },
          { id: 'ORDERS', label: 'Shopcity订单', value: orders, target: numberValue(stage.minOrders) },
        ].filter((check) => check.target > 0);
        const failed = checks.find((check) => check.value < check.target);
        if (!failed) return null;
        failures.push({
          id: `STAGE_${reachedStage}_${failed.id}`,
          detail: `第${index + 1}行 ${failed.label} ${failed.value} < 目标 ${failed.target}`,
          reason: `广告达到$${reachedStage}阶段，${failed.label} ${failed.value} < 目标 ${failed.target}`,
        });
      }
      if (failures.length === 1) {
        return {
          id: failures[0].id,
          category: 'ineffective',
          reason: failures[0].reason,
        };
      }
      if (failures.length > 1) {
        return {
          id: `STAGE_${reachedStage}_GROUP`,
          category: 'ineffective',
          reason: `广告达到$${reachedStage}阶段，所有同花费检查行均未达标：${failures.map((failure) => failure.detail).join('；')}`,
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

  async function verifyAdActivated(accountId, adId, dataDate = pacificDate(), timeZone = 'America/Los_Angeles') {
    await wait(1200);
    const latestAds = await fetchAllAds(accountId, '', dataDate, timeZone);
    const latestAd = latestAds.find((item) => String(item.ad_id || '') === String(adId));
    if (!latestAd) {
      throw new Error('开启接口返回后未在广告列表中找到该广告，未确认恢复成功');
    }
    const status = adStatus(latestAd);
    if (status !== 'ACTIVE') {
      const error = new Error(`开启接口返回后广告状态仍为 ${status || 'UNKNOWN'}，可能被审核驳回或无法投放`);
      error.activationUnconfirmed = true;
      error.latestStatus = status;
      throw error;
    }
    return latestAd;
  }

  function registerScriptPause(ad, accountId, rule, dataDate = pacificDate()) {
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
      stats_date: dataDate,
      review_date: dataDate,
      review_count: 0,
      review_done: false,
      close_rule: rule.id,
    };
    saveManagedAds(managed);
  }

  function updatePausedReviewRecord(managed, accountId, ad, dataDate, updates = {}) {
    const key = managedKey(accountId, ad.ad_id);
    const previous = managed[key] || {};
    const sameDate = previous.review_date === dataDate;
    managed[key] = {
      ...previous,
      account_id: String(accountId),
      ad_id: String(ad.ad_id),
      ad_name: String(ad.ad_name || previous.ad_name || ''),
      state: previous.state || 'paused_review',
      stats_date: dataDate,
      review_date: dataDate,
      review_count: sameDate ? numberValue(previous.review_count) : 0,
      review_done: false,
      ...updates,
    };
    return managed[key];
  }

  async function reviewPausedAds(accountId, pausedAds, executionId, source, dataDate = pacificDate(), timeZone = 'America/Los_Angeles') {
    const result = { reviewed: 0, reopened: 0, kept: 0, skipped: 0, failed: 0 };
    if (!config.review.enabled) return result;

    const managed = getManagedAds();
    const maxReviews = numberValue(config.review.maxReviews);

    for (const ad of pausedAds) {
      const adId = String(ad.ad_id || '');
      const previous = managed[managedKey(accountId, adId)] || {};
      const alreadySkippedWhitelist = previous.review_date === dataDate && previous.state === 'review_skipped_whitelist';
      const current = updatePausedReviewRecord(managed, accountId, ad, dataDate);
      const whitelist = whitelistMatch(ad, accountId);

      const baseLog = {
        execution_id: executionId,
        source,
        mode: config.mode,
        data_date: dataDate,
        time_zone: timeZone,
        account_id: String(ad.account_id || accountId),
        campaign_id: String(ad.campaign_id || ''),
        adset_id: String(ad.adset_id || ''),
        ad_id: adId,
        ad_name: String(ad.ad_name || current.ad_name || ''),
        metrics: metricsOf(ad),
      };

      if (whitelist) {
        result.skipped += 1;
        current.review_done = true;
        current.state = 'review_skipped_whitelist';
        saveManagedAds(managed);
        if (!alreadySkippedWhitelist) {
          addLog({ ...baseLog, action: 'REVIEW_WHITELIST_SKIP', success: true, message: `复核时命中白名单${whitelist.label} ${whitelist.id}，保持关闭且不自动恢复` });
        }
        continue;
      }

      if (numberValue(current.review_count) >= maxReviews) {
        result.skipped += 1;
        current.review_done = true;
        current.state = 'review_limit_reached';
        saveManagedAds(managed);
        continue;
      }

      result.reviewed += 1;
      current.review_count = numberValue(current.review_count) + 1;
      const latestRule = matchRule(ad);

      if (latestRule) {
        current.review_rule = latestRule.id;
        result.kept += 1;
        current.review_done = current.review_count >= maxReviews;
        current.state = current.review_done ? 'review_limit_reached' : 'paused_review';
        addLog({
          ...baseLog,
          action: 'REVIEW_KEEP_PAUSED',
          matched_rule: latestRule.id,
          category: latestRule.category,
          reason: latestRule.reason,
          success: true,
          message: current.review_done
            ? `复核后仍命中关闭规则；已完成 ${current.review_count}/${config.review.maxReviews} 次复核，今日不再复核`
            : `复核后仍命中关闭规则；已完成 ${current.review_count}/${config.review.maxReviews} 次复核，后续随主任务继续复核`,
        });
        saveManagedAds(managed);
        continue;
      }

      current.review_rule = '';
      if (config.mode === 'observe') {
        current.review_done = current.review_count >= maxReviews;
        current.state = current.review_done ? 'review_limit_reached' : 'paused_review';
        addLog({
          ...baseLog, action: 'WOULD_REOPEN', success: true,
          message: `复核后已不再命中关闭规则；观察模式未执行恢复（${current.review_count}/${config.review.maxReviews} 次）`,
        });
        saveManagedAds(managed);
        continue;
      }

      try {
        const activation = await activateAd(adId, accountId);
        const latestAd = await verifyAdActivated(accountId, adId, dataDate, timeZone);
        current.review_done = true;
        current.state = 'reopened';
        current.reopened_at = Date.now();
        result.reopened += 1;
        addLog({
          ...baseLog, action: 'REOPEN', success: true, metrics: metricsOf(latestAd),
          message: activation.msg || 'success',
        });
        saveManagedAds(managed);
      } catch (error) {
        result.failed += 1;
        if (error.activationUnconfirmed) {
          current.review_count = maxReviews;
          current.review_done = true;
          current.state = 'review_activation_unconfirmed';
          addLog({ ...baseLog, action: 'REOPEN', success: false, message: `${error.message}；今日不再重复尝试开启` });
        } else {
          current.review_done = current.review_count >= maxReviews;
          current.state = current.review_done ? 'review_failed_limit' : 'paused_review';
          addLog({ ...baseLog, action: 'REOPEN', success: false, message: error.message });
        }
        saveManagedAds(managed);
      }
    }

    saveManagedAds(managed);
    return result;
  }

  async function reopenScheduledSpendAdsForAccount(accountId, account, timing, executionId, source) {
    const result = { checked: 0, matchedSpend: 0, reopened: 0, wouldReopen: 0, skipped: 0, failed: 0 };
    const pausedAds = await fetchAllAds(accountId, 'PAUSED', timing.date, account.timeZone);
    result.checked = pausedAds.length;
    const spendRange = zeroReopenSpendRange();
    const spendText = `${spendRange.min.toFixed(2)}-${spendRange.max.toFixed(2)}`;

    for (const ad of pausedAds) {
      const adId = String(ad.ad_id || '');
      if (!adId) {
        result.skipped += 1;
        continue;
      }
      const spend = numberFrom(ad, ['spend_usd', 'spend', 'amount_spent']);
      if (!spendInZeroReopenRange(spend)) {
        result.skipped += 1;
        continue;
      }

      result.matchedSpend += 1;
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
        matched_rule: `SCHEDULED_SPEND_${spendText}`,
        reason: `广告账户时区 ${account.timeZone} 到达设定开启时间，暂停广告当日花费 ${spend.toFixed(2)} 位于 ${spendText}`,
      };

      const whitelist = whitelistMatch(ad, accountId);
      if (whitelist) {
        result.skipped += 1;
        addLog({
          ...baseLog,
          action: 'SCHEDULED_REOPEN_WHITELIST_SKIP',
          success: true,
          message: `命中白名单${whitelist.label} ${whitelist.id}，跳过定时自动开启`,
        });
        continue;
      }

      if (config.mode === 'observe') {
        result.wouldReopen += 1;
        addLog({
          ...baseLog,
          action: 'WOULD_REOPEN_SCHEDULED_SPEND',
          success: true,
          message: '观察模式，未执行定时自动开启',
        });
        continue;
      }

      try {
        const activation = await activateAd(adId, accountId);
        const latestAd = await verifyAdActivated(accountId, adId, timing.date, account.timeZone);
        result.reopened += 1;
        addLog({
          ...baseLog,
          action: 'REOPEN_SCHEDULED_SPEND',
          metrics: metricsOf(latestAd),
          success: true,
          message: activation.msg || 'success',
        });
      } catch (error) {
        if (error.activationUnconfirmed) {
          result.skipped += 1;
        } else {
          result.failed += 1;
        }
        addLog({
          ...baseLog,
          action: 'REOPEN_SCHEDULED_SPEND',
          success: false,
          message: error.activationUnconfirmed ? `${error.message}；本次定时开启不再阻塞账户完成` : error.message,
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
    if (executing) {
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
        if (loginExpired) break;
        const account = selectedAccountCandidate(accountId);
        const timeZone = normalizeTimeZone(account?.timeZone);
        if (!timeZone) continue;

        const timing = zeroReopenTiming(timeZone);
        if (!timing.inWindow) continue;

        const runKey = zeroReopenRunKey(accountId, timeZone, timing.date);
        if (state[runKey]?.done) continue;

        ranAccounts += 1;
        const scheduleText = `${String(timing.scheduledHour).padStart(2, '0')}:${String(timing.scheduledMinute).padStart(2, '0')}`;
        setStatus(`定时自动开广告：正在处理账户 ${accountId}（${timeZone} ${scheduleText}）…`, 'working');

        try {
          const result = await reopenScheduledSpendAdsForAccount(accountId, { ...account, timeZone }, timing, executionId, 'zero_reopen_timer');
          reopened += result.reopened;
          failed += result.failed;
          if (result.failed === 0) {
            state[runKey] = {
              done: true,
              done_at: Date.now(),
              account_id: String(accountId),
              date: timing.date,
              time_zone: timeZone,
              scheduled_hour: timing.scheduledHour,
              scheduled_minute: timing.scheduledMinute,
              min_spend: numberValue(config.zeroReopen.minSpend),
              max_spend: numberValue(config.zeroReopen.maxSpend),
              checked: result.checked,
              matched_spend: result.matchedSpend,
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
            action: 'SCHEDULED_REOPEN_ACCOUNT_SUMMARY',
            success: result.failed === 0,
            data_date: timing.date,
            time_zone: timeZone,
            message: `定时自动开广告：暂停${result.checked}条，花费区间内${result.matchedSpend}条，恢复${result.reopened}条，观察${result.wouldReopen}条，跳过${result.skipped}条，失败${result.failed}条`,
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
            message: `定时自动开广告失败：${error.message}`,
          });
          if (loginExpired) break;
        }
      }

      if (ranAccounts) {
        setStatus(`定时自动开广告完成：处理账户${ranAccounts}个，恢复${reopened}条，失败${failed}条`, failed ? 'error' : 'ok');
        renderSummaries();
        renderLogs();
      }
    } finally {
      zeroReopenExecuting = false;
      scheduleNextZeroReopen();
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
        if (loginExpired) break;
        const account = config.accountCandidates.find((item) => item.id === accountId) || { id: accountId, timeZone: '' };
        const dataContext = mainDataContext(account);
        const dataDate = dataContext.date;
        const dataTimeZone = dataContext.timeZone;
        try {
          setStatus(`正在处理账户 ${accountId}…`, 'working');
          // 空状态读取账户当日全部广告，活动广告用于暂停判断，关闭广告用于主任务内复核。
          const allAds = await fetchAllAds(accountId, '', dataDate, dataTimeZone);
          const ads = allAds.filter((ad) => adStatus(ad) === 'ACTIVE');
          const pausedAds = allAds.filter((ad) => adStatus(ad) === 'PAUSED');
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
              data_date: dataDate,
              time_zone: dataTimeZone,
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

            const whitelist = whitelistMatch(ad, accountId);
            if (whitelist) {
              addLog({ ...baseLog, action: 'WHITELIST_SKIP', success: true, message: `命中白名单${whitelist.label} ${whitelist.id}，跳过自动暂停` });
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
              registerScriptPause(ad, accountId, rule, dataDate);
              addLog({ ...baseLog, action: 'PAUSE', success: true, message: result.msg || 'success' });
            } catch (error) {
              failed += 1;
              addLog({ ...baseLog, action: 'PAUSE', success: false, message: error.message });
            }
          }
          const reviewResult = await reviewPausedAds(accountId, pausedAds, executionId, source, dataDate, dataTimeZone);
          reviewed += reviewResult.reviewed;
          checked += reviewResult.reviewed;
          accountChecked += reviewResult.reviewed;
          reopened += reviewResult.reopened;
          keptPaused += reviewResult.kept;
          failed += reviewResult.failed;
          accountsCompleted += 1;
          addLog({
            execution_id: executionId,
            source,
            mode: config.mode,
            data_date: dataDate,
            time_zone: dataTimeZone,
            account_id: String(accountId),
            action: 'ACCOUNT_SUMMARY',
            success: reviewResult.failed === 0,
            metrics: accountMetrics,
            message: `当日全部广告${allAds.length}条，活动${ads.length}条，关闭${pausedAds.length}条，检查${accountChecked}条，命中${accountMatched}条，暂停${accountPaused}条，复核${reviewResult.reviewed}条，恢复${reviewResult.reopened}条，保持暂停${reviewResult.kept}条，跳过复核${reviewResult.skipped}条，失败${reviewResult.failed}条`,
          });
          queueFeishuAccountSync(allAds, accountId, executionId, dataDate, dataTimeZone);
        } catch (error) {
          failed += 1;
          addLog({
            execution_id: executionId,
            source,
            mode: config.mode,
            data_date: dataDate,
            time_zone: dataTimeZone,
            account_id: accountId,
            action: 'ACCOUNT_ERROR',
            success: false,
            message: error.message,
          });
          if (loginExpired) break;
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
    if (!['pacific', 'account'].includes(config.mainDataTimeZone)) {
      throw new Error('主任务数据时区配置无效');
    }
    const numericFields = [
      ['登录状态检测间隔', config.loginGuard.checkMinutes],
      ['登录失败判定次数', config.loginGuard.failLimit],
      ['最多复核次数', config.review.maxReviews],
      ['定时自动开广告小时', config.zeroReopen.hour],
      ['定时自动开广告分钟', config.zeroReopen.minute],
      ['定时自动开广告执行窗口', config.zeroReopen.windowMinutes],
      ['定时自动开广告重试间隔', config.zeroReopen.retryMinutes],
      ['定时自动开广告花费下限', config.zeroReopen.minSpend],
      ['定时自动开广告花费上限', config.zeroReopen.maxSpend],
      ['任务执行间隔', config.intervalMinutes],
      ...stageRuleEntries(config.policy.stages).flatMap(({ spend, stage, index }) => [
        [`$${spend}阶段第${index + 1}行FB最少单次链接点击`, stage.minFbClicks],
        [`$${spend}阶段第${index + 1}行FB最少加购`, stage.minFbAddToCart],
        [`$${spend}阶段第${index + 1}行FB最少成效`, stage.minFbPurchases],
        [`$${spend}阶段第${index + 1}行最少访客`, stage.minVisitors],
        [`$${spend}阶段第${index + 1}行最少商详页访客`, stage.minViewContent],
        [`$${spend}阶段第${index + 1}行最少加购`, stage.minAddToCart],
        [`$${spend}阶段第${index + 1}行最少发起结账`, stage.minInitiateCheckout],
        [`$${spend}阶段第${index + 1}行最少订单`, stage.minOrders],
      ]),
    ];
    for (const [name, value] of numericFields) {
      if (!Number.isFinite(Number(value)) || Number(value) < 0) {
        throw new Error(`${name}必须是大于等于0的数字`);
      }
    }
    const stageRules = stageRuleEntries(config.policy.stages);
    if (!stageRules.length) throw new Error('至少保留一个检测点');
    for (const { spend, stage, index } of stageRules) {
      const rowLabel = `$${spend}阶段第${index + 1}行`;
      if (!Number.isFinite(Number(spend)) || Number(spend) <= 0) throw new Error('检测点花费必须是大于0的数字');
      if (!Number.isInteger(Number(stage.minFbClicks))) {
        throw new Error(`${rowLabel}FB最少单次链接点击必须是整数`);
      }
      if (!Number.isInteger(Number(stage.minFbAddToCart))) throw new Error(`${rowLabel}FB最少加购必须是整数`);
      if (!Number.isInteger(Number(stage.minFbPurchases))) throw new Error(`${rowLabel}FB最少成效必须是整数`);
      if (!Number.isInteger(Number(stage.minAddToCart))) {
        throw new Error(`${rowLabel}最少加购必须是整数`);
      }
      if (!Number.isInteger(Number(stage.minVisitors))) {
        throw new Error(`${rowLabel}最少访客必须是整数`);
      }
      if (!Number.isInteger(Number(stage.minViewContent))) {
        throw new Error(`${rowLabel}最少商详页访客必须是整数`);
      }
      if (!Number.isInteger(Number(stage.minInitiateCheckout))) throw new Error(`${rowLabel}最少发起结账必须是整数`);
      if (!Number.isInteger(Number(stage.minOrders))) throw new Error(`${rowLabel}最少订单必须是整数`);
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
    if (!Number.isInteger(Number(config.zeroReopen.hour)) || Number(config.zeroReopen.hour) < 0 || Number(config.zeroReopen.hour) > 23) {
      throw new Error('定时自动开广告小时必须是0到23的整数');
    }
    if (!Number.isInteger(Number(config.zeroReopen.minute)) || Number(config.zeroReopen.minute) < 0 || Number(config.zeroReopen.minute) > 59) {
      throw new Error('定时自动开广告分钟必须是0到59的整数');
    }
    if (!Number.isInteger(Number(config.zeroReopen.windowMinutes)) || Number(config.zeroReopen.windowMinutes) < 1) {
      throw new Error('定时自动开广告执行窗口必须是大于等于1的整数分钟');
    }
    if (!Number.isInteger(Number(config.zeroReopen.retryMinutes)) || Number(config.zeroReopen.retryMinutes) < 1) {
      throw new Error('定时自动开广告重试间隔必须是大于等于1的整数分钟');
    }
    if (numberValue(config.zeroReopen.minSpend) > numberValue(config.zeroReopen.maxSpend)) {
      throw new Error('定时自动开广告花费下限不能大于花费上限');
    }
    if (!Number.isInteger(Number(config.intervalMinutes)) || Number(config.intervalMinutes) < 1) {
      throw new Error('任务执行间隔必须是大于等于1的整数分钟');
    }
    if (!Number.isInteger(Number(config.loginGuard.checkMinutes)) || Number(config.loginGuard.checkMinutes) < 1) {
      throw new Error('登录状态检测间隔必须是大于等于1的整数分钟');
    }
    if (!Number.isInteger(Number(config.loginGuard.failLimit)) || Number(config.loginGuard.failLimit) < 1) {
      throw new Error('登录失败判定次数必须是大于等于1的整数');
    }
    if (config.loginGuard.autoLogin) {
      if (!config.loginGuard.enabled) throw new Error('自动登录需要先启用登录状态守护');
      if (!config.loginGuard.username) throw new Error('自动登录需要填写店铺账号');
      if (!getLoginPassword()) throw new Error('自动登录需要填写店铺密码');
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
    loginExpired = false;
    setRunIntent(true);
    updateButtons();
    scheduleLoginGuard(1000);
    scheduleNextZeroReopen(1000);
    executeRound('start');
  }

  function stop() {
    running = false;
    loginExpired = false;
    setRunIntent(false);
    localStorage.removeItem(LOGIN_RESUME_KEY);
    clearScheduledRun();
    clearScheduledZeroReopen();
    updateButtons();
    setStatus(executing ? '已停止后续循环；本轮仍在执行' : '已停止', 'idle');
  }

  function isConversionPage() {
    return location.pathname.startsWith(CONVERSION_PATH);
  }

  function isLoginPage() {
    return location.pathname.startsWith(LOGIN_PATH);
  }

  function isAdminHomePage() {
    return /^\/admin\/?$/.test(location.pathname);
  }

  function clearScheduledLoginGuard() {
    if (loginGuardTimerId) window.clearTimeout(loginGuardTimerId);
    loginGuardTimerId = null;
  }

  function addLoginLog(action, success, message) {
    const last = String(localStorage.getItem(LOGIN_LAST_LOG_KEY) || '');
    const signature = `${action}|${success ? '1' : '0'}|${message}`;
    if (last === signature) return;
    localStorage.setItem(LOGIN_LAST_LOG_KEY, signature);
    addLog({
      execution_id: `${Date.now()}-login`,
      source: 'login_guard',
      mode: config.mode,
      action,
      success,
      message,
    });
  }

  function handleLoginExpired(message = '店铺登录状态已过期') {
    const returnUrl = isConversionPage() ? location.href : `${location.origin}${CONVERSION_PATH}`;
    localStorage.setItem(LOGIN_RETURN_URL_KEY, returnUrl);
    if ((running || shouldRestoreRun()) && config.loginGuard.resumeAfterLogin) {
      localStorage.setItem(LOGIN_RESUME_KEY, '1');
      setRunIntent(true);
    }
    running = false;
    loginExpired = true;
    clearScheduledRun();
    clearScheduledZeroReopen();
    updateButtons();
    setStatus(`店铺登录已过期，已暂停广告操作：${message}`, 'error');
    setLoginStatus(`登录已过期：${message}`, 'error');
    addLoginLog('LOGIN_EXPIRED', false, message);
    if (config.loginGuard.enabled && config.loginGuard.autoLogin) {
      requestLoginRedirect();
    }
  }

  function handleLoginRecovered(status = {}) {
    loginGuardFailCount = 0;
    loginExpired = false;
    localStorage.removeItem(LOGIN_ATTEMPT_KEY);
    if (isConversionPage()) localStorage.removeItem(LOGIN_RETURN_URL_KEY);
    const shopText = status.shopId ? `，Shop ID ${status.shopId}` : '';
    setLoginStatus(`登录状态正常${shopText}`, 'ok');
    if ((localStorage.getItem(LOGIN_RESUME_KEY) === '1' || shouldRestoreRun()) && isConversionPage()) {
      localStorage.removeItem(LOGIN_RESUME_KEY);
      addLoginLog('LOGIN_RECOVERED', true, `登录已恢复${shopText}`);
      if ((config.loginGuard.resumeAfterLogin || shouldRestoreRun()) && !running && !executing) {
        setStatus('登录已恢复，自动继续运行', 'ok');
        window.setTimeout(start, 800);
      }
    }
  }

  function requestLoginRedirect() {
    if (isLoginPage()) return;
    if (!config.loginGuard.username || !getLoginPassword()) {
      setLoginStatus('登录已过期，但未保存自动登录账号或密码', 'error');
      return;
    }
    setLoginStatus('登录已过期，准备跳转登录页自动续登', 'working');
    window.setTimeout(() => {
      if (!isLoginPage()) location.href = shopLoginUrl();
    }, 1200);
  }

  function scheduleLoginGuard(delayMs) {
    clearScheduledLoginGuard();
    if (!isConversionPage() || !config.loginGuard.enabled) return;
    const interval = Math.max(1, numberValue(config.loginGuard.checkMinutes)) * 60000;
    loginGuardTimerId = window.setTimeout(runLoginGuardCheck, Math.max(1000, delayMs ?? interval));
  }

  async function runLoginGuardCheck() {
    clearScheduledLoginGuard();
    if (!isConversionPage() || !config.loginGuard.enabled || loginGuardExecuting) return;
    loginGuardExecuting = true;
    try {
      const status = await checkShopLoginStatus();
      if (status.loggedIn) {
        handleLoginRecovered(status);
      } else {
        loginGuardFailCount += 1;
        const limit = Math.max(1, numberValue(config.loginGuard.failLimit));
        if (loginGuardFailCount >= limit) {
          handleLoginExpired(status.message);
        } else {
          setLoginStatus(`登录状态检测失败 ${loginGuardFailCount}/${limit}：${status.message}`, 'working');
        }
      }
    } finally {
      loginGuardExecuting = false;
      scheduleLoginGuard();
    }
  }

  function showLoginAutomationBanner(text, kind = 'working') {
    let banner = document.querySelector('#xh-login-automation-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'xh-login-automation-banner';
      banner.style.cssText = [
        'position:fixed',
        'top:12px',
        'right:12px',
        'z-index:2147483647',
        'max-width:420px',
        'padding:10px 12px',
        'border-radius:8px',
        'font:13px/1.45 Arial,"Microsoft YaHei",sans-serif',
        'box-shadow:0 8px 28px rgba(20,35,80,.18)',
      ].join(';');
      document.body.appendChild(banner);
    }
    const palette = kind === 'error'
      ? ['#fff1f1', '#d63a3a']
      : kind === 'ok'
        ? ['#eefaf3', '#118146']
        : ['#eef5ff', '#245bd7'];
    banner.style.background = palette[0];
    banner.style.color = palette[1];
    banner.textContent = text;
  }

  function hasVerificationChallenge() {
    const text = document.body?.innerText || '';
    const challengeInput = visibleInput('input[name*="captcha" i],input[placeholder*="验证码"],input[placeholder*="校验码"],input[placeholder*="安全码"]');
    return Boolean(challengeInput)
      || /captcha|two[- ]?factor|2fa|安全校验|滑块|人机验证/i.test(text);
  }

  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (descriptor?.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function visibleInput(selector) {
    return [...document.querySelectorAll(selector)]
      .find((input) => input.offsetParent !== null && !input.disabled && !input.readOnly);
  }

  function findLoginUsernameInput() {
    const selectors = [
      'input[name*="account" i]',
      'input[name*="user" i]',
      'input[name*="email" i]',
      'input[name*="login" i]',
      'input[placeholder*="账号"]',
      'input[placeholder*="邮箱"]',
      'input[placeholder*="手机"]',
      'input[placeholder*="用户名"]',
      'input[type="email"]',
      'input[type="text"]',
    ];
    for (const selector of selectors) {
      const input = visibleInput(selector);
      if (input && input.type !== 'password') return input;
    }
    return null;
  }

  function findLoginPasswordInput() {
    return visibleInput('input[type="password"],input[name*="password" i],input[placeholder*="密码"]');
  }

  function findLoginSubmitButton() {
    const buttons = [...document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')]
      .filter((button) => button.offsetParent !== null && !button.disabled);
    return buttons.find((button) => /登录|登陆|login|sign in/i.test(button.textContent || button.value || ''))
      || buttons.find((button) => String(button.type || '').toLowerCase() === 'submit')
      || buttons[0]
      || null;
  }

  function waitForLoginForm(timeoutMs = 20000) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        const usernameInput = findLoginUsernameInput();
        const passwordInput = findLoginPasswordInput();
        const submitButton = findLoginSubmitButton();
        if (usernameInput && passwordInput && submitButton) {
          resolve({ usernameInput, passwordInput, submitButton });
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(null);
          return;
        }
        window.setTimeout(tick, 400);
      };
      tick();
    });
  }

  async function runLoginPageAutomation() {
    if (!config.loginGuard.enabled || !config.loginGuard.autoLogin) return;
    showLoginAutomationBanner('Shopcity FB 自动控制器：正在检查登录状态…');
    const status = await checkShopLoginStatus();
    if (status.loggedIn) {
      showLoginAutomationBanner('已登录，正在返回广告控制页面…', 'ok');
      location.replace(conversionUrl());
      return;
    }
    const password = getLoginPassword();
    if (!config.loginGuard.username || !password) {
      showLoginAutomationBanner('未保存自动登录账号或密码，请回到广告控制页面配置。', 'error');
      return;
    }
    if (hasVerificationChallenge()) {
      showLoginAutomationBanner('检测到验证码或安全校验，已停止自动登录，请人工处理。', 'error');
      return;
    }
    const limit = Math.max(1, numberValue(config.loginGuard.failLimit));
    const attempts = numberValue(localStorage.getItem(LOGIN_ATTEMPT_KEY));
    if (attempts >= limit) {
      showLoginAutomationBanner(`自动登录已连续尝试 ${attempts} 次，已停止以避免触发风控。`, 'error');
      return;
    }
    const form = await waitForLoginForm();
    if (!form) {
      showLoginAutomationBanner('未识别到登录表单，请人工登录。', 'error');
      return;
    }
    if (hasVerificationChallenge()) {
      showLoginAutomationBanner('检测到验证码或安全校验，已停止自动登录，请人工处理。', 'error');
      return;
    }
    setNativeInputValue(form.usernameInput, config.loginGuard.username);
    setNativeInputValue(form.passwordInput, password);
    localStorage.setItem(LOGIN_ATTEMPT_KEY, String(attempts + 1));
    showLoginAutomationBanner(`正在自动登录店铺账号（第 ${attempts + 1}/${limit} 次）…`);
    window.setTimeout(() => form.submitButton.click(), 500);
  }

  async function runAdminBridgePage() {
    if (!config.loginGuard.enabled) return;
    const hasReturn = Boolean(localStorage.getItem(LOGIN_RETURN_URL_KEY) || localStorage.getItem(LOGIN_RESUME_KEY));
    const shouldBridge = hasReturn || shouldRestoreRun() || isAdminHomePage();
    if (!shouldBridge) return;
    showLoginAutomationBanner('Shopcity FB 自动控制器：正在确认登录状态…');
    const status = await checkShopLoginStatus();
    if (status.loggedIn) {
      localStorage.removeItem(LOGIN_ATTEMPT_KEY);
      if (config.loginGuard.resumeAfterLogin && shouldRestoreRun()) localStorage.setItem(LOGIN_RESUME_KEY, '1');
      showLoginAutomationBanner('登录已恢复，正在返回广告控制页面…', 'ok');
      location.replace(conversionUrl());
    } else if (config.loginGuard.autoLogin) {
      showLoginAutomationBanner('登录仍未恢复，正在打开登录页…');
      location.replace(shopLoginUrl());
    }
  }

  async function restoreRunAfterPageLoad() {
    if (!isConversionPage() || !shouldRestoreRun() || running || executing) return;
    if (config.loginGuard.enabled) {
      setStatus('正在确认登录状态，准备恢复循环…', 'working');
      setLoginStatus('正在确认登录状态…', 'working');
      const status = await checkShopLoginStatus();
      if (status.loggedIn) {
        handleLoginRecovered(status);
      } else {
        handleLoginExpired(status.message);
      }
      return;
    }
    setStatus('页面刷新后自动恢复运行', 'ok');
    window.setTimeout(start, 800);
  }

  function readFormConfig() {
    const accountCandidates = mergeAdAccountLists(readRenderedAdAccountCandidates()).filter(isDetectedAdAccountCandidate);
    const candidateIds = new Set(accountCandidates.map((account) => account.id));
    const accountById = new Map(accountCandidates.map((account) => [account.id, account]));
    const accountShowFilter = normalizeAccountShowFilter(document.querySelector('#xh-account-show-filter')?.value || config.accountShowFilter);
    const accountIds = readSelectedAdAccountIds()
      .filter((id) => candidateIds.has(id))
      .filter((id) => accountShowFilter !== 'visible' || adAccountIsShopcityShown(accountById.get(id)));
    const shopId = document.querySelector('#xh-shop-id').value.trim();
    const intervalMinutes = Number(document.querySelector('#xh-interval-minutes').value);
    const mode = document.querySelector('#xh-mode').value;
    const mainDataTimeZone = normalizeMainDataTimeZone(document.querySelector('#xh-main-data-timezone')?.value || config.mainDataTimeZone);
    const whitelist = {
      accountIds: parseWhitelistIds(document.querySelector('#xh-whitelist-accounts')?.value || ''),
      campaignIds: parseWhitelistIds(document.querySelector('#xh-whitelist-campaigns')?.value || ''),
      adsetIds: parseWhitelistIds(document.querySelector('#xh-whitelist-adsets')?.value || ''),
      adIds: parseWhitelistIds(document.querySelector('#xh-whitelist')?.value || ''),
    };
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
    const stageGroups = {};
    for (const [spend, stage] of stageEntries) {
      if (!stageGroups[spend]) stageGroups[spend] = [];
      stageGroups[spend].push(stage);
    }
    const feishuSecretInput = document.querySelector('#xh-feishu-app-secret').value.trim();
    if (feishuSecretInput) saveFeishuSecret(feishuSecretInput);
    const loginPasswordInput = document.querySelector('#xh-login-password')?.value || '';
    if (loginPasswordInput) saveLoginPassword(loginPasswordInput);
    config = normalizeConfig({
      accountIds: [...new Set(accountIds)],
      accountCandidates,
      fbUserCandidates: normalizeFbUserCandidates(config.fbUserCandidates).filter(isOauthFbUserCandidate),
      accountShowFilter,
      shopId,
      intervalMinutes,
      mode,
      mainDataTimeZone,
      whitelist,
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
      loginGuard: {
        enabled: document.querySelector('#xh-login-guard-enabled')?.checked ?? config.loginGuard.enabled,
        autoLogin: document.querySelector('#xh-login-auto-enabled')?.checked ?? config.loginGuard.autoLogin,
        username: document.querySelector('#xh-login-username')?.value.trim() || '',
        checkMinutes: fieldNumber('#xh-login-check-minutes'),
        failLimit: fieldNumber('#xh-login-fail-limit'),
        resumeAfterLogin: document.querySelector('#xh-login-resume')?.checked ?? config.loginGuard.resumeAfterLogin,
      },
      review: {
        enabled: document.querySelector('#xh-review-enabled').checked,
        maxReviews: fieldNumber('#xh-review-max'),
      },
      zeroReopen: {
        enabled: document.querySelector('#xh-zero-reopen-enabled').checked,
        hour: fieldNumber('#xh-zero-reopen-hour'),
        minute: fieldNumber('#xh-zero-reopen-minute'),
        windowMinutes: fieldNumber('#xh-zero-reopen-window'),
        retryMinutes: fieldNumber('#xh-zero-reopen-retry'),
        minSpend: fieldNumber('#xh-zero-reopen-min-spend'),
        maxSpend: fieldNumber('#xh-zero-reopen-max-spend'),
      },
      policy: {
        protectionRules,
        stages: stageGroups,
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
    renderOverview();
  }

  function setStatus(text, kind) {
    const element = document.querySelector('#xh-status');
    if (!element) return;
    element.textContent = text;
    element.dataset.kind = kind;
    document.querySelectorAll('[data-status-mirror]').forEach((mirror) => {
      mirror.textContent = text;
      mirror.dataset.kind = kind;
    });
    renderOverview();
  }

  function setLoginStatus(text, kind = 'idle') {
    const element = document.querySelector('#xh-login-status');
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
    let text = '';
    if (!running) {
      text = '未启动';
      element.textContent = text;
      document.querySelectorAll('[data-countdown-mirror]').forEach((mirror) => { mirror.textContent = text; });
      return;
    }
    if (executing) {
      text = '本轮执行中';
      element.textContent = text;
      document.querySelectorAll('[data-countdown-mirror]').forEach((mirror) => { mirror.textContent = text; });
      return;
    }
    if (!nextRunAt) {
      text = '等待调度';
      element.textContent = text;
      document.querySelectorAll('[data-countdown-mirror]').forEach((mirror) => { mirror.textContent = text; });
      return;
    }
    const remaining = Math.max(0, nextRunAt - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    text = `${minutes}:${String(seconds).padStart(2, '0')}`;
    element.textContent = text;
    document.querySelectorAll('[data-countdown-mirror]').forEach((mirror) => { mirror.textContent = text; });
  }

  function actionBadgeClass(action) {
    if (['PAUSE', 'ACCOUNT_ERROR', 'ROUND_ERROR', 'LOGIN_EXPIRED'].includes(action)) return 'badge-danger';
    if (['REOPEN', 'REOPEN_ZERO_SPEND', 'REOPEN_SCHEDULED_SPEND', 'LOGIN_RECOVERED'].includes(action)) return 'badge-success';
    if (['WHITELIST_SKIP', 'REVIEW_WHITELIST_SKIP', 'SCHEDULED_REOPEN_WHITELIST_SKIP'].includes(action)) return 'badge-slate';
    if (String(action || '').startsWith('WOULD_')) return 'badge-warning';
    return 'badge-muted';
  }

  function renderActionBadge(action) {
    const value = String(action || '-');
    return `<span class="badge ${actionBadgeClass(value)}">${html(value)}</span>`;
  }

  function renderResultBadge(success, text = '') {
    const label = success ? '成功' : '失败';
    return `<span class="badge ${success ? 'badge-success' : 'badge-danger'}" title="${html(text || label)}">${label}</span>`;
  }

  function renderOverview() {
    const root = document.querySelector('#xh-overview-grid');
    if (!root) return;
    const logs = getLogs();
    const latestRound = logs.find((log) => log.action === 'ROUND_SUMMARY');
    const actionCount = (actions, successOnly = true) => logs.filter((log) => actions.includes(log.action) && (!successOnly || log.success)).length;
    const accountTotal = mergeAdAccountLists(config.accountCandidates).filter(isDetectedAdAccountCandidate).length;
    const selected = `${config.accountIds.length}/${accountTotal}`;
    const failed = logs.filter((log) => log.success === false).length;
    const roundText = latestRound?.message || '';
    const checkedCount = roundText.match(/检查(\d+)条/)?.[1] || '0';
    const accountDone = roundText.match(/账户(\d+)\/(\d+)/);
    const accountDoneText = accountDone ? `${accountDone[1]} / ${accountDone[2]} 个账户完成` : '尚未执行';
    const statusKind = running ? 'ok' : failed ? 'error' : 'idle';
    const cards = [
      { label: '已选择账户', value: selected, hint: accountTotal ? `共 ${accountTotal} 个检测账户` : '尚未检测账户' },
      { label: '本轮检查', value: checkedCount, hint: accountDoneText },
      { label: '自动暂停', value: actionCount(['PAUSE']), hint: '正式模式命中后暂停' },
      { label: '自动恢复', value: actionCount(['REOPEN', 'REOPEN_ZERO_SPEND', 'REOPEN_SCHEDULED_SPEND']), hint: '复核或定时恢复' },
      { label: '失败', value: failed, hint: failed ? '存在失败日志' : '暂无失败', tone: failed ? 'danger' : '' },
      { label: '下次执行', value: document.querySelector('#xh-countdown')?.textContent || '未启动', hint: running ? '循环任务已启动' : '循环任务未启动' },
      { label: '运行模式', value: config.mode === 'live' ? '正式模式' : '观察模式', hint: config.mode === 'live' ? '命中后会执行暂停' : '只记录不暂停' },
      { label: '任务间隔', value: `${config.intervalMinutes}`, hint: '分钟 / 轮' },
    ];
    const systemRows = [
      ['Shop ID', config.shopId || '未填写'],
      ['飞书同步', config.feishu.enabled ? '已启用' : '未启用', config.feishu.enabled ? 'ok' : 'idle'],
      ['登录守护', config.loginGuard.enabled ? '已启用' : '未启用', config.loginGuard.enabled ? 'ok' : 'idle'],
      ['运行状态', running ? '运行中' : '已停止', statusKind],
    ];
    root.innerHTML = `${cards.map(({ label, value, hint, tone }) => `<div class="overview-card ${tone === 'danger' ? 'overview-card-danger' : ''}">
      <div class="overview-label">${html(label)}</div>
      <div class="overview-value" title="${html(value)}">${html(value)}</div>
      <div class="overview-hint" title="${html(hint || '')}">${html(hint || '')}</div>
    </div>`).join('')}
    <div class="overview-card system-card">
      <div class="overview-label">系统状态</div>
      <div class="system-status-list">
        ${systemRows.map(([label, value, kind]) => `<div class="system-status-row"><span>${html(label)}</span><strong class="${kind ? `status-text-${kind}` : ''}">${kind ? '<i></i>' : ''}${html(value)}</strong></div>`).join('')}
      </div>
    </div>`;
  }

  function renderLogs() {
    const body = document.querySelector('#xh-log-body');
    if (!body) return;
    const accountFilter = document.querySelector('#xh-log-filter-account')?.value.trim();
    const adFilter = document.querySelector('#xh-log-filter-ad')?.value.trim();
    const actionFilter = document.querySelector('#xh-log-filter-action')?.value || '';
    const resultFilter = document.querySelector('#xh-log-filter-result')?.value || '';
    const logs = getLogs()
      .filter((log) => !['ACCOUNT_SUMMARY', 'ROUND_SUMMARY', 'REVIEW_KEEP_PAUSED', 'ZERO_REOPEN_ACCOUNT_SUMMARY', 'SCHEDULED_REOPEN_ACCOUNT_SUMMARY'].includes(log.action))
      .filter((log) => {
        const accountId = String(log.account_id || '');
        const adId = String(log.ad_id || '');
        return (!accountFilter || accountId.includes(accountFilter))
          && (!adFilter || adId.includes(adFilter))
          && (!actionFilter || String(log.action || '') === actionFilter)
          && (!resultFilter || (resultFilter === 'success' ? log.success !== false : log.success === false));
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
        <td>${renderActionBadge(log.action)}</td>
        <td>${html(log.matched_rule || '-')}</td>
        <td class="${resultClass}" title="${html(log.reason || log.message || '')}">${renderResultBadge(log.success, log.message || log.reason || '')}</td>
      </tr>`;
    }).join('');
    renderOverview();
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
        <td class="${resultClass}" title="${html(log.message || '')}">${renderResultBadge(log.success, log.message || '')}</td>
      </tr>`;
    }).join('');
    renderOverview();
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
      'time', 'data_date', 'time_zone', 'execution_id', 'source', 'mode', 'action', 'success', 'account_id',
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

  function activateModuleTab(panel, target, persist = true) {
    const legacyMap = {
      'base-config': 'ad-accounts',
      'pause-rules': 'ad-policy',
      'review-rules': 'automation',
      'scheduled-reopen': 'automation',
      'login-guard': 'automation',
      'local-logs': 'run-logs',
    };
    const requested = legacyMap[target] || target;
    const panels = [...panel.querySelectorAll('[data-tab-panel]')];
    const available = new Set(panels.map((item) => item.dataset.tabPanel));
    const active = available.has(requested) ? requested : 'overview';
    panel.querySelectorAll('.module-tab').forEach((tab) => {
      const selected = tab.dataset.tabTarget === active;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((item) => {
      item.hidden = item.dataset.tabPanel !== active;
    });
    if (persist) {
      try { localStorage.setItem(MODULE_TAB_KEY, active); } catch (_) { /* ignore */ }
    }
    requestAnimationFrame(() => clampPanelPosition(panel, true));
  }

  function initModuleTabs(panel) {
    const tabs = [...panel.querySelectorAll('.module-tab')];
    const tabList = panel.querySelector('.module-tabs');
    if (!tabs.length || !tabList) return;
    tabList.addEventListener('click', (event) => {
      const tab = event.target.closest('.module-tab');
      if (!tab) return;
      activateModuleTab(panel, tab.dataset.tabTarget);
    });
    tabList.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = Math.max(0, tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'));
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      activateModuleTab(panel, tabs[nextIndex].dataset.tabTarget);
    });
    let saved = '';
    try { saved = localStorage.getItem(MODULE_TAB_KEY) || ''; } catch (_) { /* ignore */ }
    activateModuleTab(panel, saved, false);
  }

  function activateLogTab(panel, target) {
    const active = target === 'summary' ? 'summary' : 'operation';
    panel.querySelectorAll('.log-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.logTarget === active);
    });
    panel.querySelectorAll('[data-log-panel]').forEach((item) => {
      item.hidden = item.dataset.logPanel !== active;
    });
  }

  function initLogTabs(panel) {
    const tabs = panel.querySelector('.log-subtabs');
    if (!tabs) return;
    tabs.addEventListener('click', (event) => {
      const tab = event.target.closest('.log-tab');
      if (!tab) return;
      activateLogTab(panel, tab.dataset.logTarget);
    });
    activateLogTab(panel, 'operation');
  }

  function syncToggleCards(panel) {
    panel.querySelectorAll('.toggle-card').forEach((card) => {
      const toggle = card.querySelector(`#${card.dataset.toggleSource}`);
      const enabled = Boolean(toggle?.checked);
      card.classList.toggle('is-disabled', !enabled);
      card.querySelectorAll('.toggle-content input, .toggle-content select, .toggle-content textarea').forEach((control) => {
        if (control === toggle) return;
        control.disabled = !enabled;
      });
    });
  }

  function createPanel() {
    const style = document.createElement('style');
    style.textContent = `
      /* 1. Design Tokens */
      #xh-fb-controller{--bg:#F5F7FA;--card:#FFFFFF;--subtle:#F8FAFC;--border:#E2E8F0;--border-hover:#CBD5E1;--text:#0F172A;--muted:#475569;--soft:#64748B;--weak:#94A3B8;--primary:#2563EB;--primary-hover:#1D4ED8;--success:#16A34A;--warning:#D97706;--danger:#DC2626;--shadow:0 1px 2px rgba(15,23,42,.04),0 10px 24px rgba(15,23,42,.06)}

      /* 2. Base */
      #xh-fb-controller{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:min(1180px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:hidden;background:var(--bg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);font:13px/1.5 Inter,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text)}
      #xh-fb-controller *{box-sizing:border-box;letter-spacing:0}

      /* 3. Layout */
      #xh-fb-controller .body{display:flex;flex-direction:column;height:min(780px,calc(100vh - 100px));max-height:calc(100vh - 100px);padding:0;overflow:hidden}
      #xh-fb-controller .content-area{flex:1;min-height:0;overflow:auto;padding:16px}
      #xh-fb-controller .xh-content-inner{width:100%;max-width:1400px;margin:0 auto}
      #xh-fb-controller .content-wide{max-width:1400px}
      #xh-fb-controller .content-medium{max-width:1200px}
      #xh-fb-controller .content-narrow{max-width:1100px}
      #xh-fb-controller .form-grid,#xh-fb-controller .two-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px}
      #xh-fb-controller .toolbar,#xh-fb-controller .page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      #xh-fb-controller .page-head{padding-bottom:20px}
      #xh-fb-controller .page-title{font-size:18px;font-weight:600;color:var(--text);line-height:1.25}
      #xh-fb-controller .page-desc{margin-top:4px;color:var(--soft);font-size:12px;line-height:1.6}
      #xh-fb-controller .page-actions,#xh-fb-controller .toolbar-actions,#xh-fb-controller .bar-actions,#xh-fb-controller .actions{display:flex;gap:8px;flex-wrap:wrap}

      /* 4. Header */
      #xh-fb-controller .app-header{display:flex;align-items:center;justify-content:space-between;height:60px;padding:0 14px 0 16px;background:var(--card);border-bottom:1px solid var(--border);color:var(--text);cursor:move;touch-action:none;user-select:none}
      #xh-fb-controller.dragging .app-header{cursor:grabbing}
      #xh-fb-controller .brand-title{font-size:18px;font-weight:700;line-height:1.2}
      #xh-fb-controller .brand-version{font-size:12px;color:var(--weak);margin-top:2px}
      #xh-fb-controller .header-meta{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px}
      #xh-fb-controller .next-run{display:flex;align-items:center;gap:6px}
      #xh-fb-controller .next-run b{font-weight:600;color:var(--text)}
      #xh-fb-controller .header-meta .status-dot{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      /* 5. Tabs */
      #xh-fb-controller .module-tabs{display:flex;gap:8px;overflow-x:auto;flex:0 0 auto;margin:0;padding:8px 16px;border:0;border-bottom:1px solid var(--border);border-radius:0;background:var(--card)}
      #xh-fb-controller .module-tab,#xh-fb-controller .log-tab{height:36px;min-height:36px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);font-weight:500;transition:background .12s ease,border-color .12s ease,color .12s ease}
      #xh-fb-controller .module-tab.active,#xh-fb-controller .module-tab[aria-selected="true"],#xh-fb-controller .log-tab.active{background:#EFF6FF;border-color:#BFDBFE;color:var(--primary);box-shadow:none}
      #xh-fb-controller .module[data-tab-panel][hidden],#xh-fb-controller [data-log-panel][hidden]{display:none!important}
      #xh-fb-controller .log-subtabs{display:flex;gap:8px;margin-bottom:12px}

      /* 6. Cards */
      #xh-fb-controller .module{background:var(--card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
      #xh-fb-controller .submodule,#xh-fb-controller .log-block{background:var(--subtle);border:1px solid var(--border);border-radius:10px;box-shadow:none}
      #xh-fb-controller .policy{padding:16px}
      #xh-fb-controller .module + .module{margin-top:0}
      #xh-fb-controller .policy-title{font-size:15px;font-weight:650;color:var(--text);margin:0 0 12px;padding:0;border:0}
      #xh-fb-controller .policy-title::before{display:none}
      #xh-fb-controller .submodule{padding:16px;margin-top:12px}
      #xh-fb-controller .submodule-title{font-size:15px;font-weight:650;color:var(--text);margin:0 0 12px}
      #xh-fb-controller .card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      #xh-fb-controller .card-head .submodule-title{margin:0}
      #xh-fb-controller .card-desc,#xh-fb-controller .policy-note,#xh-fb-controller .account-select-rule{font-size:12px;color:var(--soft);line-height:1.6}

      /* 7. Overview */
      #xh-fb-controller .overview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
      #xh-fb-controller .overview-card{min-height:94px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--subtle)}
      #xh-fb-controller .overview-label{font-size:12px;color:var(--soft)}
      #xh-fb-controller .overview-value{margin-top:6px;font-size:26px;font-weight:700;line-height:1.15;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller .overview-hint{margin-top:6px;color:var(--weak);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller .overview-card-danger .overview-value{color:var(--danger)}
      #xh-fb-controller .system-card{grid-column:1/-1;min-height:auto}
      #xh-fb-controller .system-status-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 18px;margin-top:12px}
      #xh-fb-controller .system-status-row{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--soft);font-size:12px}
      #xh-fb-controller .system-status-row strong{display:inline-flex;align-items:center;gap:6px;color:var(--text);font-size:12px;font-weight:600;white-space:nowrap}
      #xh-fb-controller .system-status-row i{width:7px;height:7px;border-radius:999px;background:currentColor}
      #xh-fb-controller .status-text-ok{color:var(--success)!important}
      #xh-fb-controller .status-text-error{color:var(--danger)!important}
      #xh-fb-controller .status-text-idle{color:var(--weak)!important}

      /* 8. Form */
      #xh-fb-controller label{display:block;margin:0 0 6px;color:var(--muted);font-size:12px;font-weight:500}
      #xh-fb-controller .check-row{display:flex;align-items:center;gap:6px;margin:0 0 10px;color:var(--muted)}
      #xh-fb-controller input,#xh-fb-controller select,#xh-fb-controller textarea{width:100%;min-height:36px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-size:13px}
      #xh-fb-controller input,#xh-fb-controller select{padding:0 10px}
      #xh-fb-controller textarea{min-height:92px;padding:8px 10px;resize:vertical}
      #xh-fb-controller input:hover,#xh-fb-controller select:hover,#xh-fb-controller textarea:hover{border-color:var(--border-hover)}
      #xh-fb-controller input:focus,#xh-fb-controller select:focus,#xh-fb-controller textarea:focus{outline:none;border-color:var(--primary);box-shadow:0 0 0 3px rgba(37,99,235,.08)}
      #xh-fb-controller input:disabled,#xh-fb-controller select:disabled,#xh-fb-controller textarea:disabled{background:#F1F5F9;color:var(--weak);cursor:not-allowed}
      #xh-fb-controller .form-field{display:flex;min-width:0;flex-direction:column}
      #xh-fb-controller .form-field small{margin-top:6px;color:var(--weak);font-size:12px;line-height:1.4}
      #xh-fb-controller .span-two{grid-column:1/-1}
      #xh-fb-controller .account-filters{display:grid;grid-template-columns:240px 200px minmax(320px,1fr);gap:12px;margin-top:0}
      #xh-fb-controller .log-filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}
      #xh-fb-controller .field-status{display:block;margin-top:4px;font-size:12px;color:var(--muted)}
      #xh-fb-controller .inline-status{display:inline;margin:0 0 0 8px}
      #xh-fb-controller .input-action{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
      #xh-fb-controller .input-with-unit{display:grid;grid-template-columns:minmax(72px,180px) auto;gap:8px;align-items:center;justify-content:start}
      #xh-fb-controller .input-with-unit span,#xh-fb-controller .time-inputs span,#xh-fb-controller .spend-range span{color:var(--soft);font-size:12px;white-space:nowrap}
      #xh-fb-controller .time-inputs{display:grid;grid-template-columns:72px auto 72px;gap:8px;align-items:center;justify-content:start}
      #xh-fb-controller .spend-range{display:grid;grid-template-columns:90px auto 90px auto;gap:8px;align-items:center;justify-content:start}
      #xh-fb-controller input[type="checkbox"]{width:auto;min-height:auto;margin:0;vertical-align:middle}
      #xh-fb-controller .whitelist-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin-top:12px}
      #xh-fb-controller .whitelist-grid textarea{min-height:92px;font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
      #xh-fb-controller .update-details{white-space:pre-wrap;margin-top:12px;padding:12px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;color:var(--muted);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
      #xh-fb-controller .rule-details{margin-top:12px;border:1px solid var(--border);border-radius:8px;background:var(--card)}
      #xh-fb-controller .rule-details summary{cursor:pointer;padding:10px 12px;color:var(--muted);font-weight:600}
      #xh-fb-controller .rule-details > div{padding:0 12px 12px;color:var(--muted);font-size:12px;line-height:1.7}
      #xh-fb-controller .checkpoint-help{margin:0;padding:0;background:transparent;border:0}
      #xh-fb-controller .info{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--subtle);color:var(--muted);font-size:12px}
      #xh-fb-controller .account-empty{padding:16px;color:var(--muted)}
      #xh-fb-controller .integration-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px}
      #xh-fb-controller .settings-grid{grid-template-columns:1fr 1fr;gap:20px 32px}
      #xh-fb-controller .update-meta{display:flex;gap:16px;flex-wrap:wrap;margin:-4px 0 12px;color:var(--soft);font-size:12px}

      /* 9. Buttons */
      #xh-fb-controller button{height:36px;min-height:36px;padding:0 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--text);font-weight:500;box-shadow:none;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
      #xh-fb-controller button:focus{outline:none}
      #xh-fb-controller button:focus-visible{outline:2px solid rgba(37,99,235,.25);outline-offset:2px}
      #xh-fb-controller button:hover:not(:disabled){background:#F8FAFC;border-color:var(--border-hover);box-shadow:none}
      #xh-fb-controller button:disabled{background:#F1F5F9!important;border-color:var(--border)!important;color:var(--weak)!important;opacity:1;cursor:not-allowed}
      #xh-fb-controller button.primary{background:var(--primary);border-color:var(--primary);color:#fff}
      #xh-fb-controller button.primary:hover:not(:disabled){background:var(--primary-hover);border-color:var(--primary-hover)}
      #xh-fb-controller button.danger{background:var(--danger);border-color:var(--danger);color:#fff}
      #xh-fb-controller .stage-delete,#xh-fb-controller .protection-delete{width:auto;background:transparent!important;border-color:#FECACA!important;color:var(--danger)!important}
      #xh-fb-controller .stage-delete:hover,#xh-fb-controller .protection-delete:hover{background:#FEF2F2!important}

      /* 10. Table */
      #xh-fb-controller .protection-head,#xh-fb-controller .protection-row{display:grid;grid-template-columns:minmax(260px,1fr) 150px 150px 72px;gap:8px;align-items:center}
      #xh-fb-controller .stage-head,#xh-fb-controller .stage-row{display:grid;grid-template-columns:88px minmax(0,1fr) 80px;gap:8px;align-items:center}
      #xh-fb-controller .stage-head.stage-four,#xh-fb-controller .stage-row.stage-four{grid-template-columns:88px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)}
      #xh-fb-controller .stage-head.stage-ten,#xh-fb-controller .stage-row.stage-ten{display:grid;grid-template-columns:96px 118px 108px 108px 96px 118px 108px 118px 96px 74px;column-gap:8px;row-gap:0;align-items:center;min-width:1120px;padding:0 8px}
      #xh-fb-controller .stage-head.zero-reopen-row,#xh-fb-controller .stage-row.zero-reopen-row{grid-template-columns:120px minmax(0,1fr) 80px}
      #xh-fb-controller .stage-head,#xh-fb-controller .protection-head{position:sticky;top:0;z-index:2;color:var(--muted);font-size:12px;font-weight:600;text-align:left;background:var(--subtle)}
      #xh-fb-controller .stage-head.stage-ten span{display:flex;align-items:center;height:42px;padding:0 6px;border-bottom:1px solid var(--border);background:#F8FAFC;white-space:normal;line-height:1.3}
      #xh-fb-controller .stage-row,#xh-fb-controller .protection-row{margin-top:8px}
      #xh-fb-controller .stage-row.stage-ten{min-height:40px;margin-top:0;border-bottom:1px solid var(--border)}
      #xh-fb-controller .stage-row.stage-ten input{height:32px;min-height:32px;margin:4px 0;padding:0 8px;font-size:12px;border-color:var(--border)}
      #xh-fb-controller .stage-row strong{color:var(--muted);font-weight:600}
      #xh-fb-controller .inline-inputs{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0}
      #xh-fb-controller .stage-tools{display:flex;justify-content:flex-end;margin-top:12px}
      #xh-fb-controller .account-options,#xh-fb-controller .logs,#xh-fb-controller .stage-table{border:1px solid var(--border);border-radius:10px;background:var(--card);overflow:auto}
      #xh-fb-controller .account-options,#xh-fb-controller .stage-table,#xh-fb-controller .logs{margin-top:12px}
      #xh-fb-controller .account-options{max-height:360px}
      #xh-fb-controller .logs{max-height:430px}
      #xh-fb-controller table,#xh-fb-controller .data-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
      #xh-fb-controller .account-table{min-width:1080px}
      #xh-fb-controller .logs .data-table{min-width:1580px}
      #xh-fb-controller th,#xh-fb-controller td{height:44px;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text);background:var(--card)}
      #xh-fb-controller th{height:42px;position:sticky;top:0;z-index:2;background:#F8FAFC;color:var(--muted);font-weight:600}
      #xh-fb-controller tbody tr:hover td{background:#F8FAFC}
      #xh-fb-controller .account-table .account-option{display:table-row}
      #xh-fb-controller .account-table th:first-child,#xh-fb-controller .account-table td:first-child{width:54px;text-align:center}
      #xh-fb-controller .account-table td:last-child{color:var(--soft)}
      #xh-fb-controller .account-table td:nth-child(5){white-space:nowrap}
      #xh-fb-controller .id-cell{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace;white-space:nowrap;text-align:left}
      #xh-fb-controller .metric-cell{width:86px;text-align:right;font-variant-numeric:tabular-nums}
      #xh-fb-controller .cell-ellipsis{display:block;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #xh-fb-controller .stage-head.stage-ten span:first-child,#xh-fb-controller .stage-row.stage-ten .stage-spend{position:sticky;left:0;z-index:1;background:var(--card)}
      #xh-fb-controller .stage-head.stage-ten span:first-child{z-index:3;background:#F8FAFC}
      #xh-fb-controller .stage-head.stage-ten span:last-child,#xh-fb-controller .stage-row.stage-ten .stage-delete{position:sticky;right:0;z-index:1}
      #xh-fb-controller .stage-head.stage-ten span:last-child{z-index:3;background:#F8FAFC}
      #xh-fb-controller .stage-row.stage-ten .stage-delete{height:32px;min-height:32px;margin:4px 0;background:var(--card)!important}

      /* 11. Badge */
      #xh-fb-controller .badge,#xh-fb-controller .status-dot{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:24px;padding:2px 8px;border-radius:999px;border:1px solid transparent;font-size:12px;font-weight:500;white-space:nowrap}
      #xh-fb-controller .status-dot::before{content:"";width:7px;height:7px;border-radius:999px;background:currentColor}
      #xh-fb-controller #xh-login-status,#xh-fb-controller #xh-feishu-status,#xh-fb-controller #xh-update-status,#xh-fb-controller #xh-shop-id-status,#xh-fb-controller #xh-account-status{display:inline-flex;align-items:center;min-height:24px;padding:2px 8px;border-radius:999px;background:#F1F5F9;color:var(--muted);font-size:12px}
      #xh-fb-controller .badge-success,#xh-fb-controller #xh-status[data-kind="ok"],#xh-fb-controller [data-status-mirror][data-kind="ok"]{color:var(--success)}
      #xh-fb-controller .badge-warning{color:var(--warning);background:#FFFBEB;border-color:#FDE68A}
      #xh-fb-controller .badge-danger,#xh-fb-controller #xh-status[data-kind="error"],#xh-fb-controller [data-status-mirror][data-kind="error"]{color:var(--danger)}
      #xh-fb-controller .badge-muted,#xh-fb-controller #xh-status[data-kind="idle"],#xh-fb-controller [data-status-mirror][data-kind="idle"]{color:var(--weak)}
      #xh-fb-controller .badge-muted{background:#F1F5F9;border-color:#E2E8F0}
      #xh-fb-controller .badge-slate{color:#475569;background:#F1F5F9;border-color:#CBD5E1}
      #xh-fb-controller .badge-success{background:#F0FDF4;border-color:#BBF7D0}
      #xh-fb-controller .badge-danger{background:#FEF2F2;border-color:#FECACA}
      #xh-fb-controller #xh-status[data-kind="working"],#xh-fb-controller [data-status-mirror][data-kind="working"]{color:var(--success)}
      #xh-fb-controller #xh-login-status[data-kind="ok"],#xh-fb-controller #xh-feishu-status[data-kind="ok"],#xh-fb-controller #xh-update-status[data-kind="ok"],#xh-fb-controller #xh-shop-id-status[data-kind="ok"],#xh-fb-controller #xh-account-status[data-kind="ok"]{color:var(--success);background:#F0FDF4}
      #xh-fb-controller #xh-login-status[data-kind="error"],#xh-fb-controller #xh-feishu-status[data-kind="error"],#xh-fb-controller #xh-update-status[data-kind="error"],#xh-fb-controller #xh-shop-id-status[data-kind="error"],#xh-fb-controller #xh-account-status[data-kind="error"]{color:var(--danger);background:#FEF2F2}
      #xh-fb-controller #xh-login-status[data-kind="working"],#xh-fb-controller #xh-feishu-status[data-kind="working"],#xh-fb-controller #xh-update-status[data-kind="working"],#xh-fb-controller #xh-shop-id-status[data-kind="working"],#xh-fb-controller #xh-account-status[data-kind="working"]{color:var(--primary);background:#EFF6FF}

      /* 12. Toggle */
      #xh-fb-controller .toggle-switch{display:inline-flex;align-items:center;margin:0;cursor:pointer}
      #xh-fb-controller .toggle-switch input{position:absolute;opacity:0;width:1px;height:1px}
      #xh-fb-controller .toggle-switch span{position:relative;width:42px;height:24px;border-radius:999px;background:#CBD5E1;transition:background .16s ease}
      #xh-fb-controller .toggle-switch span::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.18);transition:transform .16s ease}
      #xh-fb-controller .toggle-switch input:checked + span{background:var(--primary)}
      #xh-fb-controller .toggle-switch input:checked + span::after{transform:translateX(18px)}
      #xh-fb-controller .toggle-card.is-disabled .toggle-content{opacity:.48}

      /* 13. Automation and Logs */
      #xh-fb-controller .automation-grid{display:grid;grid-template-columns:1fr;gap:12px}
      #xh-fb-controller .automation-fields{display:grid;gap:16px 24px;margin-top:8px}
      #xh-fb-controller .compact-fields{grid-template-columns:repeat(2,minmax(0,220px))}
      #xh-fb-controller .two-up-fields{grid-template-columns:repeat(2,minmax(0,1fr))}
      #xh-fb-controller .log-block{padding:0;margin-top:0;background:transparent;border:0;border-radius:0}
      #xh-fb-controller .success{color:var(--success)}
      #xh-fb-controller .failure{color:var(--danger)}

      /* 14. Sticky Action Bar */
      #xh-fb-controller .sticky-action-bar{flex:0 0 60px;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:60px;padding:10px 16px;background:var(--card);border-top:1px solid var(--border)}
      #xh-fb-controller .bar-status{display:flex;gap:12px;align-items:center;min-width:0;color:var(--muted);font-size:12px}
      #xh-fb-controller .bar-status #xh-status{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #xh-fb-controller .bar-status b{color:var(--text)}
      #xh-fb-controller #xh-collapse{height:32px;min-height:32px;width:32px;border:1px solid var(--border)!important;background:var(--card)!important;color:var(--muted)!important;font-size:18px}
      #xh-fb-controller.collapsed .body{display:none}

      /* 15. Responsive */
      @media (max-width:1200px){#xh-fb-controller .overview-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media (max-width:1024px){#xh-fb-controller .overview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}#xh-fb-controller .account-filters,#xh-fb-controller .log-filters,#xh-fb-controller .system-status-list{grid-template-columns:1fr 1fr}#xh-fb-controller .sticky-action-bar{align-items:flex-start;flex-direction:column;min-height:auto;flex-basis:auto}}
      @media (max-width:900px){#xh-fb-controller{width:calc(100vw - 24px);right:12px;bottom:12px}#xh-fb-controller .header-meta{gap:8px}#xh-fb-controller .brand-title{font-size:16px}#xh-fb-controller .content-area{padding:12px}#xh-fb-controller .form-grid,#xh-fb-controller .two-cols,#xh-fb-controller .integration-grid,#xh-fb-controller .settings-grid,#xh-fb-controller .automation-fields,#xh-fb-controller .two-up-fields,#xh-fb-controller .compact-fields,#xh-fb-controller .account-filters,#xh-fb-controller .log-filters,#xh-fb-controller .system-status-list,#xh-fb-controller .whitelist-grid{grid-template-columns:1fr}#xh-fb-controller .page-head{flex-direction:column}#xh-fb-controller .span-two{grid-column:auto}}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('section');
    panel.id = 'xh-fb-controller';
    panel.innerHTML = `
      <header class="app-header" title="按住标题栏拖动；双击恢复默认位置">
        <div class="brand-block"><div class="brand-title">Shopcity FB 自动控制器</div><div class="brand-version">v${CURRENT_VERSION}</div></div>
        <div class="header-meta">
          <span class="status-dot" data-status-mirror data-kind="idle">已停止</span>
          <span class="next-run">下次执行 <b data-countdown-mirror>未启动</b></span>
          <button id="xh-collapse" title="折叠面板">−</button>
        </div>
      </header>
      <div class="body">
        <div class="module-tabs" role="tablist" aria-label="功能模块">
          <button type="button" class="module-tab active" role="tab" aria-selected="true" data-tab-target="overview">概览</button>
          <button type="button" class="module-tab" role="tab" aria-selected="false" data-tab-target="ad-accounts">广告账户</button>
          <button type="button" class="module-tab" role="tab" aria-selected="false" data-tab-target="ad-policy">广告策略</button>
          <button type="button" class="module-tab" role="tab" aria-selected="false" data-tab-target="automation">自动化</button>
          <button type="button" class="module-tab" role="tab" aria-selected="false" data-tab-target="feishu-sync">飞书同步</button>
          <button type="button" class="module-tab" role="tab" aria-selected="false" data-tab-target="run-logs">运行日志</button>
          <button type="button" class="module-tab" role="tab" aria-selected="false" data-tab-target="system-settings">系统设置</button>
        </div>
        <main class="content-area">
        <div class="policy module xh-content-inner content-wide" data-module="overview" data-tab-panel="overview">
          <div class="page-head">
            <div><div class="page-title">概览</div><div class="page-desc">查看当前控制器运行状态、账户选择和近期执行结果。</div></div>
          </div>
          <div id="xh-overview-grid" class="overview-grid"></div>
        </div>
        <div class="policy module account-section xh-content-inner content-wide" data-module="ad-accounts" data-tab-panel="ad-accounts">
          <div class="page-head">
            <div><div class="page-title">Facebook 广告账户</div><div class="page-desc">管理当前 ShopCity 店铺绑定的 Facebook 广告账户。<span id="xh-account-status" class="field-status inline-status" data-kind="idle">可自动检测当前店铺绑定账户，并勾选需要执行任务的账户</span></div></div>
            <div class="page-actions">
              <button type="button" id="xh-account-detect">自动检测当前店铺账户</button>
              <button type="button" id="xh-account-select-all">全选</button>
              <button type="button" id="xh-account-select-none">全不选</button>
            </div>
          </div>
          <div class="account-filters">
            <div class="account-filter-field">
              <label>FB账号筛选</label>
              <select id="xh-fb-user-filter">${renderFbUserFilterOptions()}</select>
            </div>
            <div class="account-filter-field">
              <label>显示状态</label>
              <select id="xh-account-show-filter">
                <option value="visible" ${config.accountShowFilter === 'visible' ? 'selected' : ''}>仅ShopCity展示账户</option>
                <option value="all" ${config.accountShowFilter === 'all' ? 'selected' : ''}>全部账户</option>
                <option value="hidden" ${config.accountShowFilter === 'hidden' ? 'selected' : ''}>仅ShopCity隐藏账户</option>
              </select>
            </div>
            <div class="account-filter-field">
              <label>广告账户搜索</label>
              <input id="xh-account-search" placeholder="搜索账号、邮箱、账户名称或 ID">
            </div>
          </div>
          <div class="account-select-rule">支持粘贴多个广告账户 ID，可用换行、逗号、分号、顿号、竖线或空格分隔。默认仅显示 ShopCity 展示账户；全选/全不选只作用于当前显示的广告账户，被筛选隐藏的账户保留原勾选状态，最终只执行已勾选账户。</div>
          <div id="xh-account-options" class="account-options">${renderAdAccountOptions()}</div>
        </div>
        <div class="policy module xh-content-inner content-wide" data-module="ad-policy" data-tab-panel="ad-policy">
          <div class="page-head">
            <div><div class="page-title">广告策略</div><div class="page-desc">编辑广告保护规则和花费检查点，控制广告暂停判定。</div></div>
          </div>
          <div class="submodule whitelist-card">
            <div class="submodule-title">白名单与观测对象</div>
            <div class="card-desc">命中任意白名单层级时，脚本仍读取并同步数据，但不会自动暂停、复核开启或定时开启。</div>
            <div class="whitelist-grid">
              <div class="form-field"><label>白名单广告账户 ID</label><textarea id="xh-whitelist-accounts" placeholder="每行一个 account_id">${html(config.whitelist.accountIds.join('\n'))}</textarea></div>
              <div class="form-field"><label>白名单广告系列 ID</label><textarea id="xh-whitelist-campaigns" placeholder="每行一个 campaign_id">${html(config.whitelist.campaignIds.join('\n'))}</textarea></div>
              <div class="form-field"><label>白名单广告组 ID</label><textarea id="xh-whitelist-adsets" placeholder="每行一个 adset_id">${html(config.whitelist.adsetIds.join('\n'))}</textarea></div>
              <div class="form-field"><label>白名单广告 ID</label><textarea id="xh-whitelist" placeholder="每行一个 ad_id">${html(config.whitelist.adIds.join('\n'))}</textarea></div>
            </div>
          </div>
          <div class="submodule">
          <div class="submodule-title">广告保护规则</div>
          <div class="protection-head"><span>保护指标</span><span>达到数量</span><span>花费上限</span><span>操作</span></div>
          <div id="xh-protection-list">
            ${config.policy.protectionRules.map((rule) => renderProtectionRule(rule)).join('')}
          </div>
          <div class="stage-tools"><button type="button" id="xh-protection-add">＋ 新增保护规则</button></div>
          <details class="rule-details"><summary>ⓘ 广告保护规则说明</summary><div>例如选择 FB成效，达到数量填 1，花费上限填 30，表示广告已有 1 个 FB成效时，在花费不超过 30 前直接保留广告，不执行检测点；超过 30 后继续按检测点判断。</div></details>
          </div>
          <div class="submodule">
          <div class="submodule-title">花费检查点</div>
          <details class="rule-details"><summary>ⓘ 花费检查点说明</summary><div class="checkpoint-help">
            <div><strong>花费检查点怎么生效：</strong>广告累计花费达到某个检查点后，脚本才会检查该行条件。</div>
            <div><strong>只执行最高档：</strong>例如花费为 $1.80，存在 $0.35 和 $1.60 两档时，只执行 $1.60 这一行。</div>
            <div><strong>数字 0 的含义：</strong>填写 0 代表该项不参与检查；填写大于 0 才表示需要达到的最低数量。</div>
            <div><strong>同花费多行：</strong>同一花费检查点可以配置多行；单行内多个启用指标是“并且”，同花费多行之间是“或者”。</div>
            <div><strong>判定规则：</strong>任一广告保护规则命中后会直接保留；未命中保护时，当前最高花费点任意一行全部达标就保留，所有同花费行都未达标才命中关闭规则；观察模式只记录，正式模式才暂停。</div>
          </div></details>
          <div class="stage-table">
            <div class="stage-head stage-ten"><span>花费检查点</span><span>FB最少单次链接点击数</span><span>FB最少加购数</span><span>FB最少成效数</span><span>最少访客数</span><span>最少商详页访客数</span><span>最少加购数</span><span>最少发起结账数</span><span>最少订单数</span><span>操作</span></div>
            <div id="xh-stage-list">
              ${stageRuleEntries(config.policy.stages).map(({ spend, stage }) => `<div class="stage-row stage-ten stage-policy-row">
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
          <div class="policy-note">执行顺序：广告保护规则 → 花费检查点。</div>
          </div>
        </div>
        <div class="policy module xh-content-inner content-medium" data-module="automation" data-tab-panel="automation">
          <div class="page-head">
            <div><div class="page-title">自动化</div><div class="page-desc">配置任务执行、关闭广告复核和账户定时自动开广告。</div></div>
          </div>
          <div class="submodule task-runtime-card">
            <div class="submodule-title">任务执行</div>
            <div class="form-grid runtime-grid">
              <div class="form-field"><label>任务执行间隔</label><div class="input-with-unit"><input type="number" min="1" step="1" id="xh-interval-minutes" value="${html(config.intervalMinutes)}"><span>分钟</span></div></div>
              <div class="form-field"><label>运行模式</label><select id="xh-mode"><option value="observe" ${config.mode === 'observe' ? 'selected' : ''}>观察模式：只记录，不暂停</option><option value="live" ${config.mode === 'live' ? 'selected' : ''}>正式模式：命中后暂停，定时可开启</option></select></div>
              <div class="form-field span-two"><label>主任务数据时区</label><select id="xh-main-data-timezone"><option value="pacific" ${config.mainDataTimeZone === 'pacific' ? 'selected' : ''}>洛杉矶时区：所有账户统一按 America/Los_Angeles 查询</option><option value="account" ${config.mainDataTimeZone === 'account' ? 'selected' : ''}>广告账户时区：每个账户按自身 time_zone 查询</option></select><small>影响主任务关闭检测、关闭广告复核、复核后开启验证和飞书主任务数据时区；账户定时自动开广告仍始终按广告账户时区执行。</small></div>
            </div>
          </div>
          <div class="automation-grid">
            <div class="submodule toggle-card" data-toggle-source="xh-review-enabled">
              <div class="card-head"><div><div class="submodule-title">关闭广告复核</div><div class="card-desc">每轮主任务检查全部关闭广告，达标后恢复。</div></div><label class="toggle-switch"><input type="checkbox" id="xh-review-enabled" ${config.review.enabled ? 'checked' : ''}><span></span></label></div>
              <div class="toggle-content">
                <div class="automation-fields compact-fields">
                  <div class="form-field"><label>最大复核次数</label><div class="input-with-unit"><input type="number" min="1" step="1" id="xh-review-max" value="${html(config.review.maxReviews)}"><span>次 / 广告 / 天</span></div></div>
                </div>
                <details class="rule-details"><summary>ⓘ 关闭广告复核说明</summary><div>每轮任务都会用同一套广告保护和花费检查点规则检测关闭状态广告；不命中关闭规则时，正式模式会自动开启，观察模式只记录；仍命中关闭规则时保持关闭并累计当天复核次数，达到上限后当天跳过。</div></details>
              </div>
            </div>
            <div class="submodule toggle-card" data-toggle-source="xh-zero-reopen-enabled">
              <div class="card-head"><div><div class="submodule-title">账户定时自动开广告</div><div class="card-desc">按广告账户时区，在指定时间打开符合花费区间的暂停广告。</div></div><label class="toggle-switch"><input type="checkbox" id="xh-zero-reopen-enabled" ${config.zeroReopen.enabled ? 'checked' : ''}><span></span></label></div>
              <div class="toggle-content">
                <div class="automation-fields two-up-fields">
                  <div class="form-field"><label>执行时间</label><div class="time-inputs"><input type="number" min="0" max="23" step="1" id="xh-zero-reopen-hour" value="${html(config.zeroReopen.hour)}"><span>:</span><input type="number" min="0" max="59" step="1" id="xh-zero-reopen-minute" value="${html(config.zeroReopen.minute)}"></div></div>
                  <div class="form-field"><label>执行窗口</label><div class="input-with-unit"><input type="number" min="1" step="1" id="xh-zero-reopen-window" value="${html(config.zeroReopen.windowMinutes)}"><span>分钟</span></div></div>
                  <div class="form-field"><label>失败重试</label><div class="input-with-unit"><input type="number" min="1" step="1" id="xh-zero-reopen-retry" value="${html(config.zeroReopen.retryMinutes)}"><span>分钟</span></div></div>
                  <div class="form-field"><label>花费范围</label><div class="spend-range"><input type="number" min="0" step="0.01" id="xh-zero-reopen-min-spend" value="${html(config.zeroReopen.minSpend)}"><span>-</span><input type="number" min="0" step="0.01" id="xh-zero-reopen-max-spend" value="${html(config.zeroReopen.maxSpend)}"><span>USD</span></div></div>
                </div>
                <details class="rule-details"><summary>ⓘ 定时自动开广告说明</summary><div>按每个已勾选广告账户的时区，在设定时间后的执行窗口内执行；会打开所有已暂停且当日花费处于设定区间内的广告，包括人工暂停广告。观察模式只记录，正式模式才开启；每个账户每天每组配置成功检查一次。</div></details>
              </div>
            </div>
          </div>
        </div>
        <div class="policy module xh-content-inner content-narrow" id="xh-feishu-panel" data-module="feishu-sync" data-tab-panel="feishu-sync">
          <div class="page-head">
            <div><div class="page-title">飞书多维表格同步</div><div class="page-desc">配置多维表格连接，用于同步广告明细、账户汇总、操作日志和系统配置。</div></div>
            <label class="toggle-switch"><input type="checkbox" id="xh-feishu-enabled" ${config.feishu.enabled ? 'checked' : ''}><span></span></label>
          </div>
          <div class="form-grid integration-grid">
            <div class="form-field"><label>App ID</label><input id="xh-feishu-app-id" value="${html(config.feishu.appId)}"><small>飞书开放平台应用 ID</small></div>
            <div class="form-field"><label>App Secret</label><input id="xh-feishu-app-secret" type="password" placeholder="${getFeishuSecret() ? '••••••••••••••••••••' : '请填写 App Secret'}" autocomplete="off"><small>${getFeishuSecret() ? '已安全保存，留空表示不修改' : '仅保存在脚本管理器独立存储'}</small></div>
            <div class="form-field span-two"><label>App Token</label><input id="xh-feishu-app-token" value="${html(config.feishu.appToken)}"><small>多维表格应用 Token</small></div>
            <div class="form-field"><label>广告明细 Table ID</label><input id="xh-feishu-ad-table" value="${html(config.feishu.adDetailsTableId)}"><small>写入每日广告明细</small></div>
            <div class="form-field"><label>账户汇总 Table ID</label><input id="xh-feishu-account-table" value="${html(config.feishu.accountSummaryTableId)}"><small>写入账户维度汇总</small></div>
            <div class="form-field"><label>广告操作日志 Table ID</label><input id="xh-feishu-log-table" value="${html(config.feishu.operationLogTableId)}"><small>写入暂停、恢复和异常记录</small></div>
            <div class="form-field"><label>系统配置 Table ID</label><input id="xh-feishu-config-table" value="${html(config.feishu.systemConfigTableId)}"><small>同步当前脚本配置</small></div>
          </div>
          <div class="actions"><button type="button" id="xh-feishu-test">测试飞书连接</button></div>
          <div class="info"><span id="xh-feishu-status" data-kind="idle">尚未测试连接</span><span>Secret仅保存在脚本管理器独立存储</span></div>
        </div>
        <div class="policy module xh-content-inner content-wide" data-module="run-logs" data-tab-panel="run-logs">
          <div class="page-head">
            <div><div class="page-title">运行日志</div><div class="page-desc">查看广告操作记录和账户汇总，支持按账户、广告、动作和结果筛选。</div></div>
            <div class="page-actions">
              <button id="xh-export">导出CSV</button>
              <button id="xh-clear-logs">清空日志</button>
            </div>
          </div>
          <div class="log-subtabs" role="tablist" aria-label="日志类型">
            <button type="button" class="log-tab active" data-log-target="operation">广告操作日志</button>
            <button type="button" class="log-tab" data-log-target="summary">账户汇总</button>
          </div>
          <div class="log-block" data-log-panel="operation">
            <div class="log-filters">
              <div><label>广告账户 ID</label><input id="xh-log-filter-account" placeholder="输入广告账户ID"></div>
              <div><label>广告 ID</label><input id="xh-log-filter-ad" placeholder="输入广告ID"></div>
              <div><label>动作类型</label><select id="xh-log-filter-action"><option value="">全部动作</option><option value="PAUSE">PAUSE</option><option value="REOPEN">REOPEN</option><option value="WHITELIST_SKIP">WHITELIST_SKIP</option><option value="REVIEW_WHITELIST_SKIP">REVIEW_WHITELIST_SKIP</option><option value="SCHEDULED_REOPEN_WHITELIST_SKIP">SCHEDULED_REOPEN_WHITELIST_SKIP</option><option value="ACCOUNT_ERROR">ACCOUNT_ERROR</option><option value="ROUND_ERROR">ROUND_ERROR</option></select></div>
              <div><label>结果状态</label><select id="xh-log-filter-result"><option value="">全部结果</option><option value="success">成功</option><option value="failure">失败</option></select></div>
            </div>
            <div class="logs"><table class="data-table"><thead><tr><th>时间</th><th class="id-cell">广告账户ID</th><th class="id-cell">广告ID</th><th>广告名称</th><th class="metric-cell">花费</th><th class="metric-cell">FB单点</th><th class="metric-cell">CPC</th><th class="metric-cell">FB加购</th><th class="metric-cell">访客</th><th class="metric-cell">商详访客</th><th class="metric-cell">FB成效</th><th class="metric-cell">站内加购</th><th class="metric-cell">发起结账</th><th class="metric-cell">订单</th><th>动作</th><th>规则</th><th>结果</th></tr></thead><tbody id="xh-log-body"></tbody></table></div>
          </div>
          <div class="log-block" data-log-panel="summary" hidden>
            <div class="logs"><table class="data-table"><thead><tr><th>执行时间</th><th class="id-cell">广告账户ID</th><th class="metric-cell">总花费</th><th class="metric-cell">FB单点</th><th class="metric-cell">平均CPC</th><th class="metric-cell">FB加购</th><th class="metric-cell">FB成效</th><th class="metric-cell">访客</th><th class="metric-cell">商详访客</th><th class="metric-cell">站内加购</th><th class="metric-cell">发起结账</th><th class="metric-cell">订单</th><th>本轮处理情况</th></tr></thead><tbody id="xh-summary-body"></tbody></table></div>
          </div>
        </div>
        <div class="policy module xh-content-inner content-medium" data-module="system-settings" data-tab-panel="system-settings">
          <div class="page-head">
            <div><div class="page-title">系统设置</div><div class="page-desc">配置店铺登录状态守护和版本更新。</div></div>
          </div>
          <div class="submodule toggle-card" id="xh-login-guard-panel" data-toggle-source="xh-login-guard-enabled">
            <div class="card-head"><div><div class="submodule-title">店铺登录状态守护</div><div class="card-desc">检测登录状态，过期时可使用店铺账号自动恢复。</div></div><label class="toggle-switch"><input type="checkbox" id="xh-login-guard-enabled" ${config.loginGuard.enabled ? 'checked' : ''}><span></span></label></div>
            <div class="form-field login-shop-field"><label>Shop ID</label><div class="input-action"><input id="xh-shop-id" value="${html(config.shopId)}"><button type="button" id="xh-shop-id-detect">自动获取</button></div><span id="xh-shop-id-status" class="field-status" data-kind="idle">将从当前登录店铺自动识别</span></div>
            <div class="toggle-content login-guard-content">
              <label class="check-row"><input type="checkbox" id="xh-login-auto-enabled" ${config.loginGuard.autoLogin ? 'checked' : ''}>登录过期后使用店铺账号自动登录</label>
              <label class="check-row"><input type="checkbox" id="xh-login-resume" ${config.loginGuard.resumeAfterLogin ? 'checked' : ''}>登录恢复后自动回到广告控制页并继续运行</label>
              <div class="two-cols">
                <div class="form-field"><label>店铺账号</label><input id="xh-login-username" value="${html(config.loginGuard.username)}" autocomplete="username"></div>
                <div class="form-field"><label>店铺密码</label><input id="xh-login-password" type="password" placeholder="${getLoginPassword() ? '已保存；留空表示不修改' : '仅建议填写低权限店铺子账号密码'}" autocomplete="current-password"></div>
              </div>
              <div class="automation-fields compact-fields">
                <div class="form-field"><label>检测间隔</label><div class="input-with-unit"><input type="number" min="1" step="1" id="xh-login-check-minutes" value="${html(config.loginGuard.checkMinutes)}"><span>分钟</span></div></div>
                <div class="form-field"><label>失败判定</label><div class="input-with-unit"><input type="number" min="1" step="1" id="xh-login-fail-limit" value="${html(config.loginGuard.failLimit)}"><span>连续次数</span></div></div>
              </div>
              <details class="rule-details"><summary>ⓘ 登录状态守护说明</summary><div>登录过期后会暂停主任务、复核和定时开广告；自动登录会使用当前店铺域名的 /admin/login，只建议使用低权限店铺子账号。登录恢复或页面刷新后，如果循环此前处于启动状态，会自动回到广告控制页并继续运行；遇到验证码、安全校验或连续失败达到上限时会停止自动登录并提示人工处理。</div></details>
              <div class="actions"><button type="button" id="xh-login-test">测试登录状态</button></div>
              <div class="info"><span id="xh-login-status" data-kind="idle">尚未检测登录状态</span><span>密码只保存在脚本管理器独立存储，不写入日志</span></div>
            </div>
          </div>
          <div class="submodule update-card" id="xh-update-panel">
          <div class="submodule-title">GitHub 版本中心</div>
          <div class="update-meta"><span>当前版本：v${CURRENT_VERSION}</span><span>仓库：harmony-s/sc-fb-auto-controller</span></div>
          <label class="check-row"><input type="checkbox" id="xh-update-auto" ${config.update.autoCheck ? 'checked' : ''}>每12小时自动检查一次（不会自动安装）</label>
          <div class="two-cols update-selects">
            <div class="form-field"><label>版本通道</label><select id="xh-update-channel">
              <option value="stable" ${config.update.channel === 'stable' ? 'selected' : ''}>稳定版</option>
              <option value="beta" ${config.update.channel === 'beta' ? 'selected' : ''}>测试版</option>
              <option value="dev" ${config.update.channel === 'dev' ? 'selected' : ''}>开发版</option>
              <option value="all" ${config.update.channel === 'all' ? 'selected' : ''}>全部历史版本</option>
            </select></div>
            <div class="form-field"><label>选择版本</label><select id="xh-update-version" disabled><option>请先检查更新</option></select></div>
          </div>
          <div id="xh-update-details" class="update-details">点击“检查更新”后载入可用版本。</div>
          <div class="actions">
            <button type="button" id="xh-update-check">检查更新</button>
            <button type="button" class="primary" id="xh-update-install" disabled>安装所选版本</button>
          </div>
          <div class="info"><span id="xh-update-status" data-kind="idle">尚未检查</span><span>校验通过后由Tampermonkey确认更新</span></div>
          <div class="policy-note">更新或回退保持相同脚本标识，现有广告参数、面板位置与飞书 Secret 会保留。</div>
        </div>
        </div>
        </main>
        <div class="sticky-action-bar">
          <div class="bar-status"><span id="xh-status" data-kind="idle">已停止</span><span>下次：<b id="xh-countdown">未启动</b></span></div>
          <div class="bar-actions">
            <button class="primary" id="xh-start">启动循环</button>
            <button class="danger" id="xh-stop" disabled>停止</button>
            <button id="xh-run-once">手动执行一次</button>
            <button id="xh-save">保存配置</button>
          </div>
        </div>
      </div>`;
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
    panel.querySelector('#xh-fb-user-filter').addEventListener('change', applyAdAccountFilter);
    panel.querySelector('#xh-account-show-filter').addEventListener('change', () => {
      applyAdAccountFilter();
      persistAccountSelectionFromPanel();
    });
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
        scheduleLoginGuard(1000);
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
    panel.querySelector('#xh-login-test').addEventListener('click', async () => {
      const button = panel.querySelector('#xh-login-test');
      button.disabled = true;
      setLoginStatus('正在检测登录状态…', 'working');
      try {
        readFormConfig();
        saveConfig();
        const status = await checkShopLoginStatus();
        if (status.loggedIn) {
          handleLoginRecovered(status);
        } else {
          setLoginStatus(`登录状态异常：${status.message}`, 'error');
        }
        scheduleLoginGuard();
      } catch (error) {
        setLoginStatus(`检测失败：${error.message}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
    panel.querySelector('#xh-log-filter-account').addEventListener('input', renderLogs);
    panel.querySelector('#xh-log-filter-ad').addEventListener('input', renderLogs);
    panel.querySelector('#xh-log-filter-action').addEventListener('change', renderLogs);
    panel.querySelector('#xh-log-filter-result').addEventListener('change', renderLogs);
    panel.querySelector('#xh-export').addEventListener('click', exportCsv);
    panel.querySelector('#xh-clear-logs').addEventListener('click', clearLogs);
    ['#xh-review-enabled', '#xh-zero-reopen-enabled', '#xh-login-guard-enabled'].forEach((selector) => {
      panel.querySelector(selector)?.addEventListener('change', () => syncToggleCards(panel));
    });
    panel.querySelector('#xh-collapse').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      panel.querySelector('#xh-collapse').textContent = panel.classList.contains('collapsed') ? '+' : '−';
      requestAnimationFrame(() => clampPanelPosition(panel, true));
    });

    countdownId = window.setInterval(updateCountdown, 1000);
    window.addEventListener('beforeunload', () => {
      if (countdownId) window.clearInterval(countdownId);
      if (timerId) window.clearTimeout(timerId);
      if (zeroReopenTimerId) window.clearTimeout(zeroReopenTimerId);
      if (loginGuardTimerId) window.clearTimeout(loginGuardTimerId);
    });
    renderSummaries();
    renderLogs();
    updateButtons();
    initModuleTabs(panel);
    initLogTabs(panel);
    syncToggleCards(panel);
    renderOverview();
    applyAdAccountFilter();
    scheduleLoginGuard(1200);
    window.setTimeout(() => {
      restoreRunAfterPageLoad().catch((error) => {
        setStatus(`自动恢复运行失败：${error.message}`, 'error');
        setLoginStatus(`自动恢复运行失败：${error.message}`, 'error');
      });
    }, 900);
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

  function bootstrap() {
    if (isLoginPage()) {
      runLoginPageAutomation().catch((error) => showLoginAutomationBanner(`自动登录异常：${error.message}`, 'error'));
      return;
    }
    if (!isConversionPage()) {
      runAdminBridgePage().catch((error) => showLoginAutomationBanner(`登录恢复检查异常：${error.message}`, 'error'));
      return;
    }
    createPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
