'use strict';

/**
 * 追加一个 query 参数。数组按 arrayFormat 序列化：
 *   repeat（默认） cats=4&cats=41 —— 最常见
 *   comma          cats=4,41
 *   brackets       cats[]=4&cats[]=41
 * null / undefined / 空数组不发出（多数后端对"空参数"和"不传"处理不同，不传最安全）。
 */
function appendQuery(url, key, value, arrayFormat) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    if (arrayFormat === 'comma') {
      url.searchParams.append(key, value.map(String).join(','));
      return;
    }
    const k = arrayFormat === 'brackets' ? `${key}[]` : key;
    for (const item of value) url.searchParams.append(k, String(item));
    return;
  }
  url.searchParams.append(key, String(value));
}

/**
 * fetch 封装：URL 拼接、query/body、超时、错误分类。
 *
 * 统一返回结构：
 *   成功 { ok: true,  status, json, durationMs }
 *   失败 { ok: false, error, status?, message?, bodySnippet?, json?, durationMs? }
 * error 取值：
 *   HTTP_ERROR     非 2xx（含 500 / 401 / 403），json 已解析则带上
 *   NON_JSON       响应不是 JSON（网关 HTML 错误页等），bodySnippet 留证据
 *   TIMEOUT        超时
 *   NETWORK_ERROR  DNS / 连接拒绝等网络层失败
 *   CONFIG_ERROR   baseURL / path 拼不出合法 URL
 */
async function callApi(api, convertedRequest, cfg) {
  const started = Date.now();
  let url;
  try {
    url = new URL(api.path, cfg.baseURL);
  } catch {
    return { ok: false, error: 'CONFIG_ERROR', message: `baseURL 或 path 非法: ${cfg.baseURL} + ${api.path}` };
  }

  const method = (api.method || 'GET').toUpperCase();
  const headers = { ...cfg.headers, ...(api.request && api.request.headers ? api.request.headers : {}) };
  const init = { method, headers };

  // query 任何方法都拼到 URL（POST + URL 参数的组合很常见）；body 存在就发 JSON body
  const arrayFormat = (api.queryArrayFormat || cfg.queryArrayFormat || 'repeat');
  const query = (convertedRequest && convertedRequest.query) || {};
  for (const [k, v] of Object.entries(query)) {
    appendQuery(url, k, v, arrayFormat);
  }
  if (method !== 'GET' && method !== 'DELETE' && convertedRequest && convertedRequest.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    init.body = JSON.stringify(convertedRequest.body);
  }

  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs || 10000) });
    const durationMs = Date.now() - started;
    const text = await res.text(); // 先拿原文，JSON.parse 失败也能留证据
    let json = null;
    let parseOk = true;
    try {
      json = JSON.parse(text);
    } catch {
      parseOk = false;
    }
    // 先看状态码再看 JSON：500 + HTML 错误页应归为 HTTP_ERROR（状态码才是主要信息）
    if (!res.ok) {
      return {
        ok: false, error: 'HTTP_ERROR', status: res.status, durationMs,
        ...(parseOk ? { json } : { bodySnippet: text.slice(0, 500) }),
      };
    }
    if (!parseOk) {
      return { ok: false, error: 'NON_JSON', status: res.status, bodySnippet: text.slice(0, 500), durationMs };
    }
    return { ok: true, status: res.status, json, durationMs };
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    return {
      ok: false,
      error: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      message: e.message || String(e),
      durationMs: Date.now() - started,
    };
  }
}

module.exports = { callApi };
