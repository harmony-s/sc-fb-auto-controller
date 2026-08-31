// ==UserScript==
// @name         Shopcity Facebook 广告自动控制器
// @namespace    xh-shopcity
// @version      1.7.1
// @description  优先执行Shopcity广告检测与控制，后台批量同步飞书，并提供花费检查点的直观规则说明。
// @match        https://*.shopcity.vip/admin/conversion*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      open.feishu.cn
// ==/UserScript==

(function () {
  'use strict';

  const API_BASE = 'https://api.shopcity.vip/plugins/ads/api.php?r=facebook-ads/';
  const STORAGE_KEY = 'xh_shopcity_fb_controller_v1';
  const LOG_KEY = 'xh_shopcity_fb_controller_logs_v1';
  const MANAGED_KEY = 'xh_shopcity_fb_controller_managed_v1';
  const FEISHU_SECRET_KEY = 'xh_shopcity_fb_controller_feishu_secret_v1';
  const FEISHU_RECORD_CACHE_KEY = 'xh_shopcity_fb_controller_feishu_records_v1';
  const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
  const MAX_LOGS = 3000;

  const DEFAULT_CONFIG = {
    accountIds: [],
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
    review: {
      enabled: true,
      delayMinutes: 40,
      maxReopensPerDay: 1,
      protectionMinutes: 60,
    },
    policy: {
      effectProtectionSpend: 6,
      effectProtectionCount: 1,
      cartProtectionSpend: 3,
      cartProtectionCount: 1,
      stages: {
        1: { minFbClicks: 1, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
        2: { minFbClicks: 2, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
        3: { minFbClicks: 3, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
        5: { minFbClicks: 4, minFbAddToCart: 0, minFbPurchases: 0, minVisitors: 0, minAddToCart: 0, minInitiateCheckout: 0, minOrders: 0 },
      },
    },
  };

  let config = normalizeConfig(loadJson(STORAGE_KEY, DEFAULT_CONFIG));
  let running = false;
  let executing = false;
  let timerId = null;
  let nextRunAt = null;
  let countdownId = null;
  let feishuTokenCache = null;
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

  function normalizeConfig(value) {
    const policy = value?.policy || {};
    const stages = policy.stages || {};
    const review = value?.review || {};
    const feishu = value?.feishu || {};
    return {
      ...DEFAULT_CONFIG,
      ...value,
      accountIds: [...new Set(
        (Array.isArray(value?.accountIds)
          ? value.accountIds
          : value?.accountId
            ? [value.accountId]
            : DEFAULT_CONFIG.accountIds)
          .map(String)
          .map((item) => item.trim())
          .filter(Boolean)
      )],
      whitelist: Array.isArray(value?.whitelist) ? value.whitelist.map(String) : [],
      feishu: { ...DEFAULT_CONFIG.feishu, ...feishu },
      review: { ...DEFAULT_CONFIG.review, ...review },
      policy: {
        ...DEFAULT_CONFIG.policy,
        ...policy,
        stages: Object.fromEntries(
          Object.entries(Object.keys(stages).length ? stages : DEFAULT_CONFIG.policy.stages)
            .map(([spend, stage]) => [String(numberValue(spend)), {
              minFbClicks: numberValue(stage?.minFbClicks ?? stage?.minClicks),
              minFbAddToCart: numberValue(stage?.minFbAddToCart ?? stage?.minAddToCart),
              minFbPurchases: numberValue(stage?.minFbPurchases),
              minVisitors: numberValue(stage?.minVisitors),
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
    const response = await fetch(`${API_BASE}${route}`, {
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
      'SC商详页访客数': numberFrom(ad, ['product_detail_uv_num', 'detail_uv_num']),
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
      'SC商详页访客总数': metrics.product_detail_uv_num,
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
    })[action] || '执行失败';
  }

  function isAdOperation(action) {
    return !['ACCOUNT_SUMMARY', 'ACCOUNT_ERROR', 'ROUND_SUMMARY', 'ROUND_ERROR'].includes(action);
  }

  async function syncFeishuOperationLog(log) {
    if (!config.feishu.enabled || !isAdOperation(log.action)) return;
    const metrics = log.metrics || {};
    const managed = getManagedAds()[managedKey(log.account_id, log.ad_id)] || {};
    const actual = ['PAUSE', 'REOPEN'].includes(log.action);
    const beforeStatus = ['REOPEN', 'WOULD_REOPEN', 'REVIEW_KEEP_PAUSED', 'REVIEW_REOPEN_LIMIT'].includes(log.action) ? 'PAUSED' : 'ACTIVE';
    const plannedStatus = ['PAUSE', 'WOULD_PAUSE'].includes(log.action) ? 'PAUSED'
      : ['REOPEN', 'WOULD_REOPEN'].includes(log.action) ? 'ACTIVE' : '不变';
    const afterStatus = actual && log.success ? plannedStatus : beforeStatus;
    const logId = `${Date.parse(log.time) || Date.now()}_${log.execution_id || 'noexec'}_${log.account_id || 'noaccount'}_${log.ad_id || 'noad'}_${log.action}_${Math.random().toString(36).slice(2, 6)}`;
    const checkpoint = Number(String(log.matched_rule || '').match(/^STAGE_([\d.]+)/)?.[1] || 0);
    await createFeishuRecord(config.feishu.operationLogTableId, {
      '日志ID': logId,
      '操作时间': Date.parse(log.time) || Date.now(),
      '数据日期': dateTimestamp(pacificDate(new Date(log.time))),
      '执行批次ID': String(log.execution_id || ''),
      '执行来源': ({ auto: '自动执行', start: '启动执行', manual: '手动执行' })[log.source] || String(log.source || ''),
      '运行模式': log.mode === 'live' ? '正式模式' : '观察模式',
      '数据时区': 'America/Los_Angeles',
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
      '操作时SC加购人数': numberValue(metrics.add_to_cart_uv_num),
      '操作时SC发起结账人数': numberValue(metrics.initiate_checkout_uv_num),
      '操作时SC订单数': numberValue(metrics.total_order_num),
      '首次暂停时间': managed.closed_at || undefined,
      '计划复核时间': managed.review_due_at || undefined,
      '实际复核时间': log.action?.startsWith('REVIEW_') ? Date.parse(log.time) : undefined,
      '当日恢复次数': numberValue(managed.reopen_count),
      '恢复保护截止时间': managed.protection_until || undefined,
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

  async function fetchAllAds(accountId, status = 'ACTIVE', date = pacificDate()) {
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
        time_zone: 'America/Los_Angeles',
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
    const purchases = numberValue(ad.fb_purchase_num);
    const addToCart = numberValue(ad.add_to_cart_uv_num);
    const initiateCheckout = numberValue(ad.initiate_checkout_uv_num);
    const orders = numberValue(ad.total_order_num);
    const policy = config.policy;

    if (
      spend <= numberValue(policy.effectProtectionSpend) &&
      purchases >= numberValue(policy.effectProtectionCount)
    ) {
      return null;
    }

    if (
      spend <= numberValue(policy.cartProtectionSpend) &&
      fbAddToCart >= numberValue(policy.cartProtectionCount)
    ) {
      return null;
    }

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
      'total_uv_num', 'add_to_cart_uv_num', 'initiate_checkout_uv_num', 'total_order_num',
      'impressions', 'reach', 'product_detail_uv_num', 'page_view_num', 'sales_amount',
    ];
    const totals = Object.fromEntries(keys.map((key) => [key, 0]));
    for (const ad of ads) {
      for (const key of keys) {
        if (key === 'product_detail_uv_num') totals[key] += numberFrom(ad, ['product_detail_uv_num', 'detail_uv_num']);
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
      review_done: false,
      close_rule: rule.id,
      protection_until: 0,
    };
    saveManagedAds(managed);
  }

  function isInReopenProtection(accountId, adId) {
    const record = getManagedAds()[managedKey(accountId, adId)];
    return Boolean(record && record.state === 'reopened' && numberValue(record.protection_until) > Date.now());
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

        if (latestRule) {
          current.review_done = true;
          current.state = 'review_kept_paused';
          current.review_rule = latestRule.id;
          result.kept += 1;
          addLog({
            ...baseLog,
            action: 'REVIEW_KEEP_PAUSED',
            matched_rule: latestRule.id,
            category: latestRule.category,
            reason: latestRule.reason,
            success: true,
            message: '复核后仍命中关闭规则，保持暂停',
          });
          saveManagedAds(managed);
          continue;
        }

        const today = pacificDate();
        const reopenCount = current.reopen_count_date === today ? numberValue(current.reopen_count) : 0;
        if (reopenCount >= numberValue(config.review.maxReopensPerDay)) {
          current.review_done = true;
          current.state = 'review_reopen_limit';
          result.kept += 1;
          addLog({
            ...baseLog, action: 'REVIEW_REOPEN_LIMIT', success: true,
            message: `最新数据已达标，但今日自动恢复次数已达上限 ${config.review.maxReopensPerDay}`,
          });
          saveManagedAds(managed);
          continue;
        }

        if (config.mode === 'observe') {
          addLog({
            ...baseLog, action: 'WOULD_REOPEN', success: true,
            message: '复核后已不再命中关闭规则；观察模式未执行恢复',
          });
          continue;
        }

        try {
          const activation = await activateAd(record.ad_id, accountId);
          current.review_done = true;
          current.state = 'reopened';
          current.reopened_at = Date.now();
          current.reopen_count_date = today;
          current.reopen_count = reopenCount + 1;
          current.protection_until = Date.now() + numberValue(config.review.protectionMinutes) * 60000;
          result.reopened += 1;
          addLog({
            ...baseLog, action: 'REOPEN', success: true,
            message: `${activation.msg || 'success'}；保护${config.review.protectionMinutes}分钟`,
          });
          saveManagedAds(managed);
        } catch (error) {
          result.failed += 1;
          addLog({ ...baseLog, action: 'REOPEN', success: false, message: error.message });
        }
      }
    }

    saveManagedAds(managed);
    return result;
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
    let protectedCount = 0;
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
          let accountProtected = 0;

          for (const ad of ads) {
            checked += 1;
            accountChecked += 1;
            const adId = String(ad.ad_id || '');
            if (isInReopenProtection(accountId, adId)) {
              protectedCount += 1;
              accountProtected += 1;
              continue;
            }
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
            message: `当日全部广告${allAds.length}条，活动${ads.length}条，检查${accountChecked}条，保护${accountProtected}条，命中${accountMatched}条，暂停${accountPaused}条，复核${reviewResult.reviewed}条，恢复${reviewResult.reopened}条，保持暂停${reviewResult.kept}条，失败${reviewResult.failed}条`,
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
        message: `账户${accountsCompleted}/${config.accountIds.length}，检查${checked}条，保护${protectedCount}条，命中${matched}条，暂停${paused}条，复核${reviewed}条，恢复${reopened}条，保持暂停${keptPaused}条，失败${failed}条`,
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
      if (running) scheduleNextRun();
      updateButtons();
    }
  }

  function validateConfig() {
    if (!Array.isArray(config.accountIds) || config.accountIds.length === 0) {
      throw new Error('请至少填写一个Facebook广告账户ID');
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
      ['成效保护花费', config.policy.effectProtectionSpend],
      ['成效保护数量', config.policy.effectProtectionCount],
      ['加购保护花费', config.policy.cartProtectionSpend],
      ['加购保护数量', config.policy.cartProtectionCount],
      ['关闭后复核等待分钟', config.review.delayMinutes],
      ['每天最多恢复次数', config.review.maxReopensPerDay],
      ['恢复保护分钟', config.review.protectionMinutes],
      ['任务执行间隔', config.intervalMinutes],
      ...Object.keys(config.policy.stages).flatMap((spend) => [
        [`$${spend}阶段FB最少单次链接点击`, config.policy.stages[spend].minFbClicks],
        [`$${spend}阶段FB最少加购`, config.policy.stages[spend].minFbAddToCart],
        [`$${spend}阶段FB最少成效`, config.policy.stages[spend].minFbPurchases],
        [`$${spend}阶段最少访客`, config.policy.stages[spend].minVisitors],
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
      if (!Number.isInteger(Number(config.policy.stages[spend].minInitiateCheckout))) throw new Error(`$${spend}阶段最少发起结账必须是整数`);
      if (!Number.isInteger(Number(config.policy.stages[spend].minOrders))) throw new Error(`$${spend}阶段最少订单必须是整数`);
    }
    if (!Number.isInteger(Number(config.policy.cartProtectionCount))) {
      throw new Error('加购保护数量必须是整数');
    }
    if (!Number.isInteger(Number(config.policy.effectProtectionCount)) || Number(config.policy.effectProtectionCount) < 1) {
      throw new Error('成效保护最低数量必须是大于等于1的整数');
    }
    if (!Number.isInteger(Number(config.review.maxReopensPerDay))) {
      throw new Error('每天最多恢复次数必须是整数');
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
    executeRound('start');
  }

  function stop() {
    running = false;
    clearScheduledRun();
    updateButtons();
    setStatus(executing ? '已停止后续循环；本轮仍在执行' : '已停止', 'idle');
  }

  function readFormConfig() {
    const accountIds = document.querySelector('#xh-account-ids').value
      .split(/[\s,，;；]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const shopId = document.querySelector('#xh-shop-id').value.trim();
    const intervalMinutes = Number(document.querySelector('#xh-interval-minutes').value);
    const mode = document.querySelector('#xh-mode').value;
    const whitelist = document.querySelector('#xh-whitelist').value
      .split(/[\s,，;；]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const fieldNumber = (selector, root = document) => Number(root.querySelector(selector).value);
    const stageRows = [...document.querySelectorAll('#xh-stage-list .stage-policy-row')];
    if (!stageRows.length) throw new Error('至少保留一个检测点');
    const stageEntries = stageRows.map((row) => {
      const spend = fieldNumber('.stage-spend', row);
      return [String(spend), {
        minFbClicks: fieldNumber('.stage-fb-clicks', row),
        minFbAddToCart: fieldNumber('.stage-fb-cart', row),
        minFbPurchases: fieldNumber('.stage-fb-purchases', row),
        minVisitors: fieldNumber('.stage-visitors', row),
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
      review: {
        enabled: document.querySelector('#xh-review-enabled').checked,
        delayMinutes: fieldNumber('#xh-review-delay'),
        maxReopensPerDay: fieldNumber('#xh-review-max'),
        protectionMinutes: fieldNumber('#xh-review-protection'),
      },
      policy: {
        effectProtectionSpend: fieldNumber('#xh-effect-protection-spend'),
        effectProtectionCount: fieldNumber('#xh-effect-protection-count'),
        cartProtectionSpend: fieldNumber('#xh-cart-protection-spend'),
        cartProtectionCount: fieldNumber('#xh-cart-protection-count'),
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
    const logs = getLogs()
      .filter((log) => !['ACCOUNT_SUMMARY', 'ROUND_SUMMARY', 'REVIEW_KEEP_PAUSED'].includes(log.action))
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
      'category', 'fb_purchase_num', 'fb_add_to_cart', 'total_uv_num', 'add_to_cart_uv_num',
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
      #xh-fb-controller header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#334269;color:#fff;font-weight:700;cursor:move}
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
      #xh-status[data-kind="error"],#xh-feishu-status[data-kind="error"]{color:#c42d2d} #xh-status[data-kind="ok"],#xh-feishu-status[data-kind="ok"]{color:#118146} #xh-status[data-kind="working"],#xh-feishu-status[data-kind="working"]{color:#245bd7}
      #xh-fb-controller .rules{margin:8px 0;padding:8px 8px 8px 26px;background:#fff8df;border-radius:6px;color:#554b2c}
      #xh-fb-controller .rules li{margin:2px 0}
      #xh-fb-controller .policy{margin-top:10px;padding:10px;background:#f7f8fc;border:1px solid #e2e6f1;border-radius:8px}
      #xh-fb-controller .policy-title{font-weight:700;color:#334269;margin:0 0 5px}
      #xh-fb-controller .policy-note{font-size:11px;color:#737b91;margin-bottom:6px}
      #xh-fb-controller .checkpoint-help{margin:10px 0 8px;padding:9px 11px;background:#eef5ff;border:1px solid #cfe0ff;border-radius:7px;color:#405172;font-size:12px;line-height:1.65}
      #xh-fb-controller .checkpoint-help strong{color:#245bd7}
      #xh-fb-controller .two-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #xh-fb-controller .stage-head,#xh-fb-controller .stage-row{display:grid;grid-template-columns:65px 1fr 1fr;gap:6px;align-items:center}
      #xh-fb-controller .stage-head.stage-four,#xh-fb-controller .stage-row.stage-four{grid-template-columns:65px 1fr 1fr 1fr}
      #xh-fb-controller .stage-table{overflow-x:auto;padding-bottom:3px}
      #xh-fb-controller .stage-head.stage-nine,#xh-fb-controller .stage-row.stage-nine{grid-template-columns:90px repeat(7,135px) 44px;min-width:1120px}
      #xh-fb-controller .stage-head{font-size:11px;color:#737b91;margin-top:8px;text-align:center}
      #xh-fb-controller .stage-row{margin-top:5px}
      #xh-fb-controller .stage-row strong{text-align:center;color:#334269}
      #xh-fb-controller .stage-delete{padding:7px 5px;background:#ffe9e9;color:#b72f2f}
      #xh-fb-controller .stage-tools{display:flex;justify-content:flex-end;margin-top:7px}
      #xh-fb-controller .logs{margin-top:9px;max-height:210px;overflow:auto;border:1px solid #e1e5f0}
      #xh-fb-controller .log-title{margin-top:12px;font-weight:700;color:#334269}
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
      <header><span>Shopcity FB 自动控制器 v1.7.1</span><button id="xh-collapse">−</button></header>
      <div class="body">
        <label>Facebook广告账户ID（换行、逗号或空格分隔）</label>
        <textarea class="account-list" id="xh-account-ids" placeholder="每行一个广告账户ID">${html(config.accountIds.join('\n'))}</textarea>
        <div class="two-cols">
          <div><label>Shop ID</label><input id="xh-shop-id" value="${html(config.shopId)}"></div>
          <div><label>任务执行间隔（分钟）</label><input type="number" min="1" step="1" id="xh-interval-minutes" value="${html(config.intervalMinutes)}"></div>
        </div>
        <label>运行模式</label>
        <select id="xh-mode">
          <option value="observe" ${config.mode === 'observe' ? 'selected' : ''}>观察模式：只记录，不暂停</option>
          <option value="live" ${config.mode === 'live' ? 'selected' : ''}>正式模式：命中后暂停</option>
        </select>
        <label>白名单广告ID（逗号、空格或换行分隔）</label>
        <textarea id="xh-whitelist" placeholder="每行一个ad_id">${html(config.whitelist.join('\n'))}</textarea>
        <div class="policy">
          <div class="policy-title">广告保护与检测点</div>
          <div class="two-cols">
            <div><label>成效保护花费上限</label><input type="number" min="0" step="0.01" id="xh-effect-protection-spend" value="${html(config.policy.effectProtectionSpend)}"></div>
            <div><label>成效保护最低数量</label><input type="number" min="1" step="1" id="xh-effect-protection-count" value="${html(config.policy.effectProtectionCount)}"></div>
          </div>
          <div class="policy-note">花费不超过保护上限且Facebook成效达到最低数量时，直接保留广告。</div>
          <div class="two-cols">
            <div><label>加购保护花费上限</label><input type="number" min="0" step="0.01" id="xh-cart-protection-spend" value="${html(config.policy.cartProtectionSpend)}"></div>
            <div><label>加购保护最低数量</label><input type="number" min="0" step="1" id="xh-cart-protection-count" value="${html(config.policy.cartProtectionCount)}"></div>
          </div>
          <div class="policy-note">花费不超过保护上限且Facebook加购达到最低数量时，直接保留广告。</div>
          <div class="checkpoint-help">
            <div><strong>花费检查点怎么生效：</strong>广告累计花费达到某个检查点后，脚本才会检查该行条件。</div>
            <div><strong>只执行最高档：</strong>例如花费为 $1.80，存在 $0.35 和 $1.60 两档时，只执行 $1.60 这一行。</div>
            <div><strong>数字 0 的含义：</strong>填写 0 代表该项不参与检查；填写大于 0 才表示需要达到的最低数量。</div>
            <div><strong>判定规则：</strong>当前行所有启用条件中，任意一项低于最低数量，就判定命中关闭规则；观察模式只记录，正式模式才暂停。</div>
          </div>
          <div class="stage-table">
            <div class="stage-head stage-nine"><span>花费检查点</span><span>FB最少单次链接点击数</span><span>FB最少加购数</span><span>FB最少成效数</span><span>最少访客数</span><span>最少加购数</span><span>最少发起结账数</span><span>最少订单数</span><span>操作</span></div>
            <div id="xh-stage-list">
              ${Object.entries(config.policy.stages).sort(([a], [b]) => Number(a) - Number(b)).map(([spend, stage]) => `<div class="stage-row stage-nine stage-policy-row">
                <input class="stage-spend" type="number" min="0.01" step="0.01" value="${html(spend)}" title="花费检查点（USD）">
                <input class="stage-fb-clicks" type="number" min="0" step="1" value="${html(stage.minFbClicks)}">
                <input class="stage-fb-cart" type="number" min="0" step="1" value="${html(stage.minFbAddToCart)}">
                <input class="stage-fb-purchases" type="number" min="0" step="1" value="${html(stage.minFbPurchases)}">
                <input class="stage-visitors" type="number" min="0" step="1" value="${html(stage.minVisitors)}">
                <input class="stage-cart" type="number" min="0" step="1" value="${html(stage.minAddToCart)}">
                <input class="stage-checkout" type="number" min="0" step="1" value="${html(stage.minInitiateCheckout)}">
                <input class="stage-orders" type="number" min="0" step="1" value="${html(stage.minOrders)}">
                <button type="button" class="stage-delete" title="删除检测点">删除</button>
              </div>`).join('')}
            </div>
          </div>
          <div class="stage-tools"><button type="button" id="xh-stage-add">＋ 新增检测点</button></div>
          <div class="policy-note">执行顺序：成效保护 → 加购保护 → 花费检查点。任一保护命中后，不再执行检查点判断。</div>
        </div>
        <div class="policy">
          <div class="policy-title">关闭后复核</div>
          <label><input type="checkbox" id="xh-review-enabled" ${config.review.enabled ? 'checked' : ''}>启用脚本关闭广告复核</label>
          <div class="stage-head"><span></span><span>数值</span><span>单位</span></div>
          <div class="stage-row"><strong>等待</strong><input type="number" min="0" step="1" id="xh-review-delay" value="${html(config.review.delayMinutes)}"><span>分钟后复核</span></div>
          <div class="stage-row"><strong>恢复</strong><input type="number" min="0" step="1" id="xh-review-max" value="${html(config.review.maxReopensPerDay)}"><span>次/广告/天</span></div>
          <div class="stage-row"><strong>保护</strong><input type="number" min="0" step="1" id="xh-review-protection" value="${html(config.review.protectionMinutes)}"><span>分钟免关</span></div>
          <div class="policy-note">只复核本脚本正式模式关闭的广告；人工暂停广告永不自动开启。</div>
        </div>
        <div class="policy">
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
        <div class="log-title">广告账户汇总统计</div>
        <div class="logs"><table><thead><tr><th>执行时间</th><th class="id-cell">广告账户ID</th><th class="metric-cell">总花费</th><th class="metric-cell">FB单点</th><th class="metric-cell">平均CPC</th><th class="metric-cell">FB加购</th><th class="metric-cell">FB成效</th><th class="metric-cell">访客</th><th class="metric-cell">站内加购</th><th class="metric-cell">发起结账</th><th class="metric-cell">订单</th><th>本轮处理情况</th></tr></thead><tbody id="xh-summary-body"></tbody></table></div>
        <div class="log-title">广告操作日志</div>
        <div class="logs"><table><thead><tr><th>时间</th><th class="id-cell">广告账户ID</th><th class="id-cell">广告ID</th><th>广告名称</th><th class="metric-cell">花费</th><th class="metric-cell">FB单点</th><th class="metric-cell">CPC</th><th class="metric-cell">FB加购</th><th class="metric-cell">访客</th><th class="metric-cell">FB成效</th><th class="metric-cell">站内加购</th><th class="metric-cell">发起结账</th><th class="metric-cell">订单</th><th>动作</th><th>规则</th><th>结果</th></tr></thead><tbody id="xh-log-body"></tbody></table></div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('#xh-stage-add').addEventListener('click', () => {
      const rows = [...panel.querySelectorAll('#xh-stage-list .stage-policy-row')];
      const highest = Math.max(0, ...rows.map((row) => numberValue(row.querySelector('.stage-spend').value)));
      panel.querySelector('#xh-stage-list').insertAdjacentHTML('beforeend', `<div class="stage-row stage-nine stage-policy-row">
        <input class="stage-spend" type="number" min="0.01" step="0.01" value="${highest + 1}" title="花费检查点（USD）">
        <input class="stage-fb-clicks" type="number" min="0" step="1" value="0">
        <input class="stage-fb-cart" type="number" min="0" step="1" value="0">
        <input class="stage-fb-purchases" type="number" min="0" step="1" value="0">
        <input class="stage-visitors" type="number" min="0" step="1" value="0">
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
    panel.querySelector('#xh-export').addEventListener('click', exportCsv);
    panel.querySelector('#xh-clear-logs').addEventListener('click', clearLogs);
    panel.querySelector('#xh-collapse').addEventListener('click', () => {
      panel.classList.toggle('collapsed');
      panel.querySelector('#xh-collapse').textContent = panel.classList.contains('collapsed') ? '+' : '−';
    });

    countdownId = window.setInterval(updateCountdown, 1000);
    window.addEventListener('beforeunload', () => {
      if (countdownId) window.clearInterval(countdownId);
      if (timerId) window.clearTimeout(timerId);
    });
    renderSummaries();
    renderLogs();
    updateButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel, { once: true });
  } else {
    createPanel();
  }
})();
