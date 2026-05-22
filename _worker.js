// ============================================================
// Workers Analytics--Cloudflare 项目监测中心
// ============================================================
// 【配置区】
const 监控密码 = 'admin888';  // 看板访问密码（GET ?pw=admin888）

// 【监控账号配置】
// 支持混填 API Token 或 Global API Key (带 email)，使用Global API Key的话需要填写注册邮箱
const CF_ACCOUNTS = [
  { label: '填写显示名称1', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称2', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称3', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称4', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称5', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称6', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称7', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称8', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' },
  { label: '填写显示名称9', id: 'Account ID', email: '注册邮箱', token: 'Global API Key', worker: '需要监测的脚本名称' }
  // 想要监控多少个脚本就往下加...
];
// ============================================================
// KV 绑定名：NODE_MONITOR
// Cron 触发器：*/5 * * * *
// ============================================================

// ── 工具函数 ─────────────────────────────────────────────────
function 北京时间(date) {
  return new Date(date).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function 格式化流量(bytes) {
  if (bytes === 0 || bytes == null) return '0 B';
  const units = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

// ── CF GraphQL Analytics (日/周/月 全维度满载查询) ───────────
async function 拉取单账号CF统计(account) {
  const { label, id: accountId, token, email, worker } = account;
  if (!accountId || !token || !worker) return { 失败: true };

  const 目标脚本 = [worker];
  const 现在 = new Date();
  
  // 以 UTC 时间（北京时间早8点）为基准的自然日、周、月
  const y = 现在.getUTCFullYear();
  const m = 现在.getUTCMonth();
  const d = 现在.getUTCDate();
  const dayOfWeek = 现在.getUTCDay(); // 0是周日，1-6是周一到周六

  // 今日起点（北京时间早8点清零）
  const d1 = new Date(Date.UTC(y, m, d)).toISOString(); 
  
  // 本周起点（以周一作为一周起点，如果想以周日为起点，把后面的三元表达式改成 d - dayOfWeek 即可）
  const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1; 
  const d7 = new Date(Date.UTC(y, m, d - diff)).toISOString(); 
  
  // 本月起点（每月1号早8点清零）
  const d30 = new Date(Date.UTC(y, m, 1)).toISOString();
  const 结束 = 现在.toISOString();

  const headers = { 'Content-Type': 'application/json' };
  if (email) {
    headers['X-Auth-Email'] = email;
    headers['X-Auth-Key'] = token;
  } else {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        d1: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: "${d1}", datetime_leq: "${结束}", scriptName_in: ${JSON.stringify(目标脚本)} }) {
          sum { requests errors responseBodySize }
          quantiles { cpuTimeP50 }
        }
        d7: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: "${d7}", datetime_leq: "${结束}", scriptName_in: ${JSON.stringify(目标脚本)} }) {
          sum { requests errors responseBodySize }
        }
        d30: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: "${d30}", datetime_leq: "${结束}", scriptName_in: ${JSON.stringify(目标脚本)} }) {
          sum { requests errors responseBodySize }
        }
      }
    }
  }`;

  const 统计 = {};
  const name = `[${label}] ${worker}`;
  统计[name] = { 
    日请求: 0, 日错误: 0, 日流量: 0, 
    周请求: 0, 周错误: 0, 周流量: 0, 
    月请求: 0, 月错误: 0, 月流量: 0, 
    cpuP50: 0 
  };

  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ query }),
    });
    
    // 【关键修复】如果遭遇 CF 接口限流或超时，直接抛出失败标志，不返回 0
    if (!res.ok) return { 失败: true };
    const json = await res.json();
    if (json.errors) return { 失败: true };

    const accountData = json?.data?.viewer?.accounts?.[0];
    
    const getSum = (arr) => {
      if (!arr || arr.length === 0) return { requests: 0, errors: 0, responseBodySize: 0 };
      return arr.reduce((acc, row) => ({
        requests: acc.requests + (row.sum?.requests || 0),
        errors: acc.errors + (row.sum?.errors || 0),
        responseBodySize: acc.responseBodySize + (row.sum?.responseBodySize || 0)
      }), { requests: 0, errors: 0, responseBodySize: 0 });
    };

    const sum1  = getSum(accountData?.d1);
    const sum7  = getSum(accountData?.d7);
    const sum30 = getSum(accountData?.d30);

    统计[name].日请求 = sum1.requests;
    统计[name].日错误 = sum1.errors;
    统计[name].日流量 = sum1.responseBodySize;
    统计[name].cpuP50 = accountData?.d1?.[0]?.quantiles?.cpuTimeP50 || 0;
    
    统计[name].周请求 = sum7.requests;
    统计[name].周错误 = sum7.errors;
    统计[name].周流量 = sum7.responseBodySize;

    统计[name].月请求 = sum30.requests;
    统计[name].月错误 = sum30.errors;
    统计[name].月流量 = sum30.responseBodySize;

    return { 数据: 统计, 查询时间: 现在.toISOString() };
  } catch { 
    // 【关键修复】网络被强杀时，返回失败标志
    return { 失败: true }; 
  }
}

async function 拉取CF统计(上次数据) {
  if (!CF_ACCOUNTS || CF_ACCOUNTS.length === 0) return null;
  const 验证账号 = CF_ACCOUNTS.filter(a => a.id && a.token);
  if (验证账号.length === 0) return null;
  
  // 【关键修复】用上一次的 KV 旧数据打底，拉取失败的账号将直接显示旧数据，绝不填 0
  const 综合统计 = 上次数据 || {};
  let 最晚查询时间 = null;

  // 【关键修复】3 个账号为一组并发拉取，将总耗时缩短 3 倍，彻底告别 Cron 超时强杀
  for (let i = 0; i < 验证账号.length; i += 3) {
    const batch = 验证账号.slice(i, i + 3);
    const results = await Promise.all(batch.map(acc => 拉取单账号CF统计(acc)));
    
    for (const res of results) {
      // 只有明确成功拉取到数据的账号，才更新覆盖进去；失败的账号原样不动
      if (res && res.数据 && !res.失败) {
        Object.assign(综合统计, res.数据);
        最晚查询时间 = res.查询时间;
      }
    }
  }
  
  if (Object.keys(综合统计).length === 0) return null;
  return { 数据: 综合统计, 查询时间: 最晚查询时间 || new Date().toISOString() };
}

// ── 核心定时任务 ──────────────────────────────────────────────
async function 执行巡检(kv) {
  let 上次数据 = {};
  try {
    // 【关键修复】在执行巡检前，先把 KV 里的老底子抽出来
    const rawCF = await kv.get('cf_stats');
    if (rawCF) {
       const parsed = JSON.parse(rawCF);
       上次数据 = parsed.数据 || parsed;
    }
  } catch {}

  // 带着老底子去拉取新数据
  const cf统计 = await 拉取CF统计(上次数据);
  if (cf统计) {
    await kv.put('cf_stats', JSON.stringify(cf统计), { expirationTtl: 3600 });
    await kv.put('last_check', new Date().toISOString(), { expirationTtl: 3600 });
  }
}

// ── 看板渲染 ─────────────────────────────────────────────────
function 生成看板(上次检查时间, cf统计数据 = null) {
  let sumReq = 0, sumTraffic = 0, sumErr = 0;
  let sumReqW = 0, sumTrafficW = 0, sumErrW = 0;
  let sumReqM = 0, sumTrafficM = 0, sumErrM = 0;
  const 脚本总数 = cf统计数据 ? Object.keys(cf统计数据).length : 0;
  
  let cf统计模块 = '';
  if (cf统计数据) {
    let cf行 = '';
    const 排序后数据 = Object.entries(cf统计数据).sort((a, b) => b[1].日请求 - a[1].日请求);
    
    const renderErr = (err, req) => {
      if (req === 0) return '<span style="color:var(--color-success)">0</span>';
      const rate = (err / req * 100).toFixed(2);
      const color = err === 0 ? 'var(--color-success)' : err < 10 ? 'var(--color-warning)' : 'var(--color-error)';
      return '<span style="color:' + color + '">' + err.toLocaleString() + ' <span style="opacity:0.7;font-size:0.9em">(' + rate + '%)</span></span>';
    };

    for (const [name, v] of 排序后数据) {
      sumReq += v.日请求 || 0;
      sumTraffic += v.日流量 || 0;
      sumErr += v.日错误 || 0;
      sumReqW += v.周请求 || 0;
      sumTrafficW += v.周流量 || 0;
      sumErrW += v.周错误 || 0;
      sumReqM += v.月请求 || 0;
      sumTrafficM += v.月流量 || 0;
      sumErrM += v.月错误 || 0;

      cf行 += '<tr>' +
        '<td><code style="background:var(--color-surface-2)">' + name + '</code></td>' +
        '<td style="color:var(--color-primary);font-weight:600">' + v.日请求.toLocaleString() + '</td>' +
        '<td style="color:var(--color-primary)">' + v.周请求.toLocaleString() + '</td>' +
        '<td style="color:var(--color-primary)">' + v.月请求.toLocaleString() + '</td>' +
        '<td style="color:#a78bfa">' + 格式化流量(v.日流量) + '</td>' +
        '<td style="color:#c084fc">' + 格式化流量(v.周流量) + '</td>' +
        '<td style="color:#d8b4fe">' + 格式化流量(v.月流量) + '</td>' +
        '<td>' + renderErr(v.日错误, v.日请求) + '</td>' +
        '<td>' + renderErr(v.周错误, v.周请求) + '</td>' +
        '<td>' + renderErr(v.月错误, v.月请求) + '</td>' +
        '<td style="color:var(--color-text-muted)">' + v.cpuP50.toFixed(2) + 'ms</td>' +
        '</tr>';
    }
    
    cf统计模块 = 
      '<div class="card" style="margin-bottom:var(--space-6); overflow-x: auto;">' +
        '<div class="card-head">' +
           '<div style="display:flex;align-items:center;gap:8px;">' +
             '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>' +
             '<span>Workers 流量报表详情（日/周/月）</span>' +
           '</div>' +
        '</div>' +
        '<table class="data-table">' +
          '<thead><tr>' +
          '<th>账号 & 脚本名</th><th>今日请求</th><th>本周请求</th><th>本月请求</th>' +
          '<th>今日流量</th><th>本周流量</th><th>本月流量</th>' +
          '<th>今日错误(率)</th><th>本周错误(率)</th><th>本月错误(率)</th><th>CPU P50</th>' +
          '</tr></thead>' +
          '<tbody>' + cf行 + '</tbody>' +
        '</table>' +
      '</div>';
  } else {
    cf统计模块 = `<div class="card" style="text-align:center;padding:40px;color:var(--color-text-muted)">暂无流量数据，请检查账号配置或等待定时任务执行。</div>`;
  }

  const 上次 = 上次检查时间 ? 北京时间(上次检查时间) + ' (北京)' : '尚未获取数据';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cloudflare 项目监测中心</title>
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap" rel="stylesheet">
<style>
:root {
  --font-body: 'Satoshi', 'Inter', system-ui, sans-serif;
  --text-xs: clamp(0.75rem, 0.7rem + 0.25vw, 0.875rem);
  --text-sm: clamp(0.875rem, 0.8rem + 0.35vw, 1rem);
  --text-base: clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
  --text-lg: clamp(1.125rem, 1rem + 0.75vw, 1.5rem);
  --text-xl: clamp(1.5rem, 1.2rem + 1.25vw, 2.25rem);
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem;
  --space-4: 1rem; --space-5: 1.25rem; --space-6: 1.5rem;
  --radius-sm: 0.375rem; --radius-md: 0.5rem; --radius-lg: 0.75rem; --radius-xl: 1rem;
  --transition: 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
[data-theme="dark"] {
  --color-bg: #0f1117; --color-surface: #161b27; --color-surface-2: #1c2235;
  --color-border: #2a3148; --color-text: #e2e8f0; --color-text-muted: #94a3b8;
  --color-text-faint: #4a5568; --color-primary: #4f8ef7; --color-success: #34d399;
  --color-warning: #fbbf24; --color-error: #f87171; --shadow-md: 0 4px 16px rgba(0,0,0,0.4);
}
[data-theme="light"] {
  --color-bg: #f0f4f8; --color-surface: #ffffff; --color-surface-2: #f8fafc;
  --color-border: #e2e8f0; --color-text: #1a202c; --color-text-muted: #4a5568;
  --color-text-faint: #a0aec0; --color-primary: #2563eb; --color-success: #059669;
  --color-warning: #d97706; --color-error: #dc2626; --shadow-md: 0 4px 16px rgba(0,0,0,0.08);
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--font-body); background: var(--color-bg); color: var(--color-text); min-height: 100vh; transition: background var(--transition), color var(--transition); }
.header { position: sticky; top: 0; z-index: 100; background: var(--color-surface); border-bottom: 1px solid var(--color-border); padding: var(--space-3) var(--space-6); display: flex; align-items: center; justify-content: space-between; box-shadow: var(--shadow-md); }
.logo { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-base); font-weight: 700; color: var(--color-primary); text-transform: uppercase; }
.status-bar { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--color-text-muted); }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--color-success); animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } }
.header-actions { display: flex; gap: var(--space-3); }
.btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: 500; border: 1px solid var(--color-border); background: var(--color-surface-2); color: var(--color-text); cursor: pointer; transition: all var(--transition); display: flex; align-items: center; gap: 8px; text-decoration: none; }
.btn:hover { background: var(--color-border); }
.btn-primary { background: var(--color-primary); color: #fff; border-color: transparent; }
.btn-primary:hover { opacity: 0.9; background: var(--color-primary); }
.btn-icon { padding: var(--space-2); border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-surface-2); color: var(--color-text); cursor: pointer; }
.btn-icon:hover { background: var(--color-border); }
.main { padding: var(--space-6); max-width: 1400px; margin: 0 auto; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4); margin-bottom: var(--space-6); }
.summary-card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: var(--space-5); box-shadow: var(--shadow-md); }
.summary-label { font-size: var(--text-sm); color: var(--color-text-muted); text-transform: uppercase; margin-bottom: var(--space-2); }
.summary-value { font-size: var(--text-xl); font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; margin-bottom: var(--space-1); }
.summary-sub { font-size: var(--text-xs); color: var(--color-text-faint); }
.card { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-xl); padding: var(--space-5); box-shadow: var(--shadow-md); }
.card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--space-4); font-size: var(--text-lg); font-weight: 700; }
.data-table { width: 100%; border-collapse: collapse; }
.data-table th { padding: 12px 14px; text-align: left; font-size: var(--text-xs); color: var(--color-text-muted); font-weight: 600; border-bottom: 1px solid var(--color-border); background: var(--color-surface-2); white-space: nowrap; }
.data-table td { padding: 14px; font-size: var(--text-sm); border-bottom: 1px solid var(--color-border); white-space: nowrap; }
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: var(--color-surface-2); }
code { padding: 4px 8px; border-radius: 4px; font-family: monospace; font-size: 13px; }
@media (max-width: 600px) { .main { padding: var(--space-3); } .header { padding: var(--space-3); } .summary-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>

<header class="header">
  <div class="logo">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M3 9h18M9 21V9" stroke="currentColor" stroke-width="2"/></svg>
    Cloudflare 项目监测系统
  </div>
  <div class="status-bar">
    <div class="pulse"></div>
    <span>数据时间：${上次}</span>
  </div>
  <div class="header-actions">
    <button class="btn-icon" id="themeBtn" title="切换主题">
      <svg id="themeIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
    <a class="btn btn-primary btn-check" href="#" title="手动触发数据抓取">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      更新数据
    </a>
  </div>
</header>

<main class="main">
  <div class="summary-grid">
    <div class="summary-card">
      <div class="summary-label">监控脚本总数</div>
      <div class="summary-value" style="color:var(--color-text)">${脚本总数} <span style="font-size:14px;color:var(--color-text-faint);font-weight:400">个</span></div>
      <div class="summary-sub">已配置的有效账号</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">总请求数</div>
      <div class="summary-value" style="color:var(--color-primary)">${sumReq.toLocaleString()}</div>
      <div class="summary-sub">今日 &nbsp;|&nbsp; 本周 ${sumReqW.toLocaleString()} &nbsp;|&nbsp; 本月 ${sumReqM.toLocaleString()}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">总消耗流量</div>
      <div class="summary-value" style="color:#a78bfa">${格式化流量(sumTraffic)}</div>
      <div class="summary-sub">今日 &nbsp;|&nbsp; 本周 ${格式化流量(sumTrafficW)} &nbsp;|&nbsp; 本月 ${格式化流量(sumTrafficM)}</div>
    </div>
    <div class="summary-card">
      <div class="summary-label">总异常数</div>
      <div class="summary-value" style="color:${sumErr > 0 ? 'var(--color-error)' : 'var(--color-success)'}">${sumErr.toLocaleString()}</div>
      <div class="summary-sub">今日 &nbsp;|&nbsp; 本周 ${sumErrW.toLocaleString()} &nbsp;|&nbsp; 本月 ${sumErrM.toLocaleString()}</div>
    </div>
  </div>

  ${cf统计模块}

</main>

<script>
  // 主题切换
  document.getElementById('themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const isDark = root.getAttribute('data-theme') === 'dark';
    root.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('themeIcon').innerHTML = isDark
      ? '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  });

  // 绑定刷新按钮并设置自动刷新
  document.querySelector('.btn-check').href = location.search.replace(/&?action=check/g, '') + '&action=check';
  setTimeout(() => location.reload(), 5 * 60 * 1000);
</script>
</body>
</html>`;
}

export default {
  async scheduled(event, env, ctx) {
    await 执行巡检(env.NODE_MONITOR);
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const pw  = url.searchParams.get('pw');

    if (pw !== 监控密码) {
      return new Response(
        `<!DOCTYPE html><html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><title>流量监控登录</title>
        <link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700&display=swap" rel="stylesheet">
        <style>
          body{background:#0f1117;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:'Satoshi',sans-serif;margin:0;}
          .box{background:#161b27;padding:32px;border-radius:16px;text-align:center;width:100%;max-width:320px;box-shadow:0 12px 40px rgba(0,0,0,0.5);border:1px solid #2a3148;}
          input{background:#1c2235;border:1px solid #2a3148;color:#e2e8f0;padding:12px 16px;border-radius:8px;font-size:14px;width:100%;outline:none;margin-bottom:16px;box-sizing:border-box;}
          input:focus{border-color:#4f8ef7;}
          button{background:#4f8ef7;color:#fff;border:none;padding:12px 0;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;width:100%;transition:opacity 0.2s;}
          button:hover{opacity:0.9;}
        </style></head>
        <body><form method="get"><div class="box">
          <div style="font-size:22px;font-weight:700;margin-bottom:8px">📊 Workers Analytics</div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:24px">Cloudflare 项目监测中心</div>
          <input name="pw" type="password" placeholder="请输入安全访问密码">
          <button type="submit">进入看板</button>
        </div></form></body></html>`,
        { headers: { 'Content-Type': 'text/html;charset=utf-8' } }
      );
    }
    
    if (url.searchParams.get('action') === 'check') {
      await 执行巡检(env.NODE_MONITOR);
      return Response.redirect(`${url.origin}?pw=${pw}`, 302);
    }

    let 上次检查时间 = null;
    let cf统计数据 = null;
    try {
      const [rawTime, rawCF] = await Promise.all([
        env.NODE_MONITOR.get('last_check'),
        env.NODE_MONITOR.get('cf_stats'),
      ]);
      上次检查时间 = rawTime;
      if (rawCF) { const parsed = JSON.parse(rawCF); cf统计数据 = parsed.数据 || parsed; }
    } catch {}

    const html = 生成看板(上次检查时间, cf统计数据);
    return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  }
};
