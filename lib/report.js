'use strict';

const fs = require('node:fs');
const path = require('node:path');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const gray = paint(90);

function statusLabel(status) {
  if (status === 'PASS') return green('[PASS]');
  if (status === 'FAIL') return red('[FAIL]');
  if (status === 'BIZFAIL') return yellow('[BIZFAIL]');
  return yellow('[ERROR]');
}

function fmtDiff(d) {
  const p = d.path || '<root>';
  const parts = [`  [${d.type}]`, p];
  if (d.oldType !== undefined || d.newType !== undefined) parts.push(`老: ${d.oldType}  新: ${d.newType}`);
  if (d.origPath && d.origPath !== '<新增>' && d.origPath !== p) parts.push(gray(`(原始: ${d.origPath})`));
  if (d.note) parts.push(gray(`— ${d.note}`));
  return parts.join('  ');
}

/**
 * 控制台逐接口输出：
 *   [PASS] user.GetUserInfo  (GET /api/user/info, 183ms)
 *   [FAIL] user.QueryOrderList  (POST /api/order/query, 240ms) — 3 处差异
 *      [missing-in-new]  data.list[].skuId  老: number  新: <缺失>  (原始: Data.List[].SkuID)
 *   [ERROR] order.CreateOrder  (POST /api/order/create) — HTTP_ERROR 500
 */
function printApiResult(result, { verbose = false, progress = '' } = {}) {
  // 标识 = 来源 json 文件 › 接口名（mock 无 file 时退回 module.name）
  const label = result.file ? `${result.file} › ${result.name}` : `${result.module}.${result.name}`;
  const head = `${progress}${statusLabel(result.status)} ${label}  (${result.method} ${result.path}${result.durationMs != null ? `, ${result.durationMs}ms` : ''})`;

  if (result.status === 'ERROR') {
    console.log(`${head} — ${result.error}${result.httpStatus ? ` ${result.httpStatus}` : ''}${result.message ? `: ${result.message}` : ''}`);
    if (result.bodySnippet) console.log(gray(`    响应快照: ${String(result.bodySnippet).slice(0, 200)}`));
    return;
  }

  if (result.status === 'BIZFAIL') {
    console.log(`${head} — 业务失败（${result.bizField}）${result.bizErrMsg ? `: ${result.bizErrMsg}` : ''}`);
    console.log(gray('    → HTTP 通了但业务报错，不参与字段对比；先解决业务报错再看字段差异。返回片段见 MD 报告折叠块'));
    return;
  }

  const fails = result.diffs.filter((d) => d.level === 'fail');
  const warns = result.diffs.filter((d) => d.level === 'warn');
  if (result.status === 'PASS') {
    const extra = warns.length ? yellow(` — ${warns.length} 处警告`) : '';
    console.log(head + extra);
  } else {
    console.log(`${head} — ${fails.length} 处差异`);
    if (result.newResponseSnippet) {
      console.log(gray('    → 新接口实际返回片段已写入 MD 报告（折叠块），先看它再下结论'));
    }
  }
  for (const d of result.diffs) {
    console.log(d.level === 'fail' ? red(fmtDiff(d)) : yellow(fmtDiff(d)));
  }
  if (verbose || result.status === 'FAIL') {
    for (const info of result.infos) {
      console.log(gray(`  [${info.type}] ${info.path || '<root>'}${info.note ? ` — ${info.note}` : ''}`));
    }
  }
  for (const w of result.warnings || []) {
    console.log(yellow(`  [warning] ${w.type}: ${w.path}${w.from ? ` (来自 ${w.from})` : ''}`));
  }
}

function printSummary(results, meta) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const pass = green(`PASS ${count('PASS')}`);
  const fail = count('FAIL') ? red(`FAIL ${count('FAIL')}`) : 'FAIL 0';
  const bizfail = count('BIZFAIL') ? yellow(`BIZFAIL ${count('BIZFAIL')}`) : 'BIZFAIL 0';
  const error = count('ERROR') ? yellow(`ERROR ${count('ERROR')}`) : 'ERROR 0';
  console.log('─'.repeat(46));
  console.log(`合计 ${results.length} 接口：${pass} / ${fail} / ${bizfail} / ${error}    环境: ${meta.env}    耗时 ${meta.durationMs}ms`);
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** JSON 报告落盘，返回文件路径 */
function writeJsonReport(dir, payload, ts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `report-${ts || timestamp()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return file;
}

// ---- Markdown 报告：字段一一对应表（人看） ----

const STATUS_ICON = { PASS: '✅', FAIL: '❌', BIZFAIL: '🟡', ERROR: '🟥' };
const FIELD_STATUS_LABEL = {
  match: '✅ 一致',
  missing: '❌ 新接口缺失',
  'optional-missing': '➖ 可选字段缺失（提示）',
  added: '➕ 新接口多给',
  'type-mismatch': '⚠️ 类型变化',
  'null-skip': '➖ 老数据为 null，跳过',
  'empty-skip': '➖ 空数组，跳过',
  'empty-diff': '⚠️ 新侧为空数组',
};

const mdText = (v) => String(v).replace(/\|/g, '\\|');
const pathCell = (v) => (v === undefined || v === '' ? '—' : `\`${mdText(v)}\``);
const typeCell = (t) => (t === '<无>' || t === '<缺失>' ? '—' : mdText(t));

// 默认报告里省略的字段状态（一致/跳过类）；--detail 时全量显示
const QUIET_FIELD_STATUS = new Set(['match', 'null-skip', 'empty-skip', 'optional-missing']);

function renderMarkdown(payload) {
  const { meta, results } = payload;
  const count = (s) => results.filter((r) => r.status === s).length;
  const lines = [
    '# 新老接口字段对比报告',
    '',
    ...(meta.file ? [`- 文件：${mdText(meta.file)}`] : []),
    `- 环境：${meta.env}（${meta.baseURL}）`,
    `- 时间：${meta.startedAt}`,
    `- 合计：${results.length} 个接口 —— PASS ${count('PASS')} / FAIL ${count('FAIL')} / BIZFAIL ${count('BIZFAIL')} / ERROR ${count('ERROR')}`,
  ];
  if (meta.fixtureErrors && meta.fixtureErrors.length) {
    lines.push(`- ⚠️ fixture 问题 ${meta.fixtureErrors.length} 个：`);
    for (const e of meta.fixtureErrors) lines.push(`  - ${mdText(e)}`);
  }
  lines.push('', '---', '');

  for (const r of results) {
    lines.push(`## ${STATUS_ICON[r.status] || ''} ${r.file ? `${mdText(r.file)} › ` : ''}${r.name}（${r.status}）`, '');
    if (r.oldApi && r.oldApi.path) {
      lines.push(`- 老接口：${r.oldApi.method || ''} \`${r.oldApi.path}\`（仅存档，未实际请求）`);
      lines.push(`- 新接口：${r.method} \`${r.path}\``, '');
    } else {
      lines.push(`- 新接口：${r.method} \`${r.path}\``, '');
    }
    if (r.status === 'BIZFAIL') {
      lines.push(`业务失败（${r.bizField}）${r.bizErrMsg ? `：${mdText(r.bizErrMsg)}` : ''}。HTTP ${r.httpStatus} 已通，未参与字段对比。`, '');
    } else if (r.status === 'ERROR') {
      lines.push(`请求失败：${r.error}${r.httpStatus ? ` ${r.httpStatus}` : ''}${r.message ? ` — ${mdText(r.message)}` : ''}`, '');
    } else {
      // 默认只列异常字段（缺失/类型变化/多给），一致与跳过类省略；--detail 全量
      const all = r.fields || [];
      const rows = meta.detail ? all : all.filter((f) => !QUIET_FIELD_STATUS.has(f.status));
      const hidden = all.length - rows.length;
      if (rows.length === 0) {
        lines.push(`全部 ${all.length} 个字段一致，无异常。${meta.detail ? '' : '（加 `--detail` 查看完整字段对照表）'}`, '');
      } else {
        lines.push('| 老字段 | 新字段 | 老类型 | 新类型 | 状态 |');
        lines.push('|---|---|---|---|---|');
        for (const f of rows) {
          const oldCell = f.status === 'added' ? '—' : pathCell(f.origPath);
          const newCell = (f.status === 'missing' || f.status === 'optional-missing') ? '—' : pathCell(f.path);
          lines.push(`| ${oldCell} | ${newCell} | ${typeCell(f.oldType)} | ${typeCell(f.newType)} | ${FIELD_STATUS_LABEL[f.status] || mdText(f.status)} |`);
        }
        lines.push('');
        if (hidden > 0) lines.push(`> 另有 ${hidden} 个一致/跳过字段已省略（加 \`--detail\` 显示完整对照）`, '');
      }
    }
    const snippet = r.newResponseSnippet || r.bodySnippet;
    if (snippet) {
      lines.push('<details><summary>新接口实际返回片段</summary>', '', '```', snippet, '```', '', '</details>', '');
    }
  }
  return lines.join('\n');
}

/** Markdown 字段对应表落盘，返回文件路径 */
function writeMarkdownReport(dir, payload, ts) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `report-${ts || timestamp()}.md`);
  fs.writeFileSync(file, renderMarkdown(payload), 'utf8');
  return file;
}

module.exports = { printApiResult, printSummary, writeJsonReport, writeMarkdownReport, renderMarkdown, timestamp };
