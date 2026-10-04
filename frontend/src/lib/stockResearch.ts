/** A/H research launcher. Symbols are format-checked, NOT exchange-verified. */
export type Market = "A" | "HK";
export type ResearchKind = "overview" | "technical" | "fundamental" | "risk" | "compare";
export interface Instrument { symbol: string; name: string; market: Market }
export interface ResearchInput { instruments: Instrument[]; kind: ResearchKind; months: number; question: string; asOf: string }
export interface ResearchSession { session_id: string; title: string; status: string; updated_at: string }
export const WATCHLIST_KEY = "jay-stock-watchlist-v1";
export const TITLE_PREFIX = "[股票研究]";
export const CATALOG: Instrument[] = [
  {symbol:"600519.SH",name:"贵州茅台",market:"A"},
  {symbol:"000001.SZ",name:"平安银行",market:"A"},
  {symbol:"300750.SZ",name:"宁德时代",market:"A"},
  {symbol:"601318.SH",name:"中国平安",market:"A"},
  {symbol:"002594.SZ",name:"比亚迪",market:"A"},
  {symbol:"688981.SH",name:"中芯国际",market:"A"},
  {symbol:"00700.HK",name:"腾讯控股",market:"HK"},
  {symbol:"09988.HK",name:"阿里巴巴-W",market:"HK"},
  {symbol:"03690.HK",name:"美团-W",market:"HK"},
  {symbol:"01810.HK",name:"小米集团-W",market:"HK"},
  {symbol:"01211.HK",name:"比亚迪股份",market:"HK"},
  {symbol:"00941.HK",name:"中国移动",market:"HK"},
];
export const RESEARCH_TYPES: {id:ResearchKind; title:string; detail:string; number:string}[] = [
  {id:"overview",title:"综合研判",detail:"经营、估值、走势与主要风险",number:"01"},
  {id:"technical",title:"技术分析",detail:"K 线、量价、均线与回撤",number:"02"},
  {id:"fundamental",title:"基本面研究",detail:"财报质量、现金流与估值",number:"03"},
  {id:"risk",title:"风险排查",detail:"公告、杠杆与论点反证",number:"04"},
  {id:"compare",title:"多股对比",detail:"统一口径，比较而非简单排名",number:"05"},
];
const A_EXCHANGE = (code:string): string | null => /^6\d{5}$/.test(code) ? "SH" : /^[03]\d{5}$/.test(code) ? "SZ" : /^(?:[48]\d{5}|92\d{4})$/.test(code) ? "BJ" : null;
export function normalizeInstrument(input:string): Instrument {
  let value = input.trim().toUpperCase();
  const named = CATALOG.filter(x => x.name.toUpperCase() === value || x.symbol === value);
  if (named.length === 1) return {...named[0]};
  const prefix = value.match(/^(SH|SS|SZ|BJ|HK)[.:]?(\d+)$/);
  if (prefix) value = `${prefix[2]}.${prefix[1]}`;
  value = value.replace(/\.SS$/, ".SH");
  if (/^\d{1,5}(?:\.HK)?$/.test(value)) {
    const code = value.replace(/\.HK$/, "").padStart(5,"0");
    if (+code === 0) throw new Error("港股代码不能为 0。");
    value = `${code}.HK`;
  } else if (/^\d{6}$/.test(value)) {
    const exchange = A_EXCHANGE(value);
    if (!exchange) throw new Error("无法识别该 A 股代码，请核对交易所与代码。");
    value = `${value}.${exchange}`;
  } else {
    const match = value.match(/^(\d{6})\.(SH|SZ|BJ)$/);
    if (!match || A_EXCHANGE(match[1]) !== match[2]) throw new Error("请输入有效格式，如 600519.SH、000001.SZ 或 00700.HK。");
  }
  const known = CATALOG.find(x => x.symbol === value);
  return known ? {...known} : {symbol:value,name:value,market:value.endsWith(".HK") ? "HK" : "A"};
}
export function searchInstruments(query:string, market:"all"|Market): Instrument[] {
  const q = query.trim().toUpperCase();
  const matches = CATALOG.filter(x => (market === "all" || x.market === market) && (!q || x.name.toUpperCase().includes(q) || x.symbol.includes(q)));
  if (q) {
    try {
      const parsed = normalizeInstrument(q);
      if ((market === "all" || parsed.market === market) && !matches.some(x => x.symbol === parsed.symbol)) matches.unshift(parsed);
    } catch { /* A partial query is not an error. */ }
  }
  return matches;
}
export function parseWatchlist(raw:string|null): Instrument[] {
  try {
    const rows:unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(rows)) return [];
    const result:Instrument[] = [];
    for (const row of rows.slice(0,100)) {
      if (!row || typeof row !== "object" || typeof row.symbol !== "string") continue;
      try {
        const stock = normalizeInstrument(row.symbol);
        if (!result.some(x => x.symbol === stock.symbol)) result.push(stock);
      } catch { /* Ignore corrupt or obsolete persisted entries. */ }
    }
    return result;
  } catch { return []; }
}
export function chinaDate(date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
}
export function buildResearchPrompt(input:ResearchInput): string {
  const {kind,months,question,asOf} = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0,10) !== asOf) throw new Error("研究日期格式不正确。");
  if (![3,6,12,36].includes(months)) throw new Error("请选择 3、6、12 或 36 个月的研究窗口。");
  if (question.length > 600) throw new Error("补充问题请控制在 600 字以内。");
  const stocks = input.instruments.map(x => normalizeInstrument(x.symbol));
  if (stocks.length < 1 || stocks.length > 6) throw new Error("请添加 1–6 只研究标的。");
  if (new Set(stocks.map(x => x.symbol)).size !== stocks.length) throw new Error("研究标的不能重复。");
  const type = RESEARCH_TYPES.find(x => x.id === kind);
  if (!type) throw new Error("未知研究类型。");
  if (kind === "compare" && stocks.length < 2) throw new Error("多股对比至少需要两只标的。");
  const task: Record<ResearchKind,string> = {
    overview:"综合分析主营业务、财务质量、相对估值、量价趋势和关键风险。输出有利证据、不利证据、尚待核验事项，不给确定性收益承诺。",
    technical:"使用真实历史 OHLCV 计算 MA20/MA60、RSI14、MACD(12,26,9)、成交量变化及区间最大回撤，并提供图表。说明复权方法、有效样本数、计算公式、缺失/停牌处理。数据不足则不计算。技术指标不是买卖指令。",
    fundamental:"优先阅读已披露财报和公告，分析收入、利润、经营现金流、负债与资本开支；比较至少三个已披露报告期（不足时说明）。明确估值指标口径、亏损时 PE 的局限以及同业可比性。",
    risk:"重点核验债务、现金流、审计意见、质押、减持、监管公告及业务集中度。建立风险、证据、数据日期、潜在影响与待验证项表格，主动寻找推翻投资论点的证据。",
    compare:"对所有标的使用一致的日期、财务期间和指标口径进行比较；分别展示本币数据。跨市场估值考虑币种、会计准则、股本口径及流动性差异；A/H 同公司比较时核对换汇日期和每股权利。禁止直接相加人民币和港币价格。",
  };
  return [
    `请用简体中文完成一次仅供研究的 A 股／港股分析。研究发起日期：${asOf}（Asia/Shanghai）；观察窗口：最近 ${months} 个月。`,
    `标的（先确认上市状态、公司名称和交易所）：${stocks.map(x => `${x.name} ${x.symbol}`).join("；")}。`,
    `任务：${type.title}。${task[kind]}`,
    "数据要求：必须实际获取数据并逐项给出来源链接/数据商、数据日期、行情时间、获取时间及延迟说明。发起日期不等于行情日期。区分实时、延迟、最近收盘与历史数据；遇到休市不能把旧行情称为今日实时行情。无法获取就明确标为缺失，不得生成演示价格、编造财报或新闻。",
    "市场要求：A 股注明人民币口径，港股注明港币口径；核验交易日历、复权、停牌和样本覆盖。需要基准时，A 股参考沪深300、港股参考恒生指数，并验证与标的可比性。",
    "若需要回测：只使用当时可见数据，说明交易制度、手续费、滑点、整手/碎股和涨跌停限制；避免未来函数及幸存者偏差；与基准和样本外结果分开披露。没有运行回测不能声称得到回测收益。",
    "输出：①研究摘要 ②数据覆盖及时间 ③计算与图表/对比表 ④结论与反证 ⑤风险与不确定性 ⑥来源。区分事实、计算和推断，提供可复核的研究报告。",
    "权限边界：只做信息检索、数据计算和研究报告；不下单、不创建实盘交易授权、不修改券商账户、不启用自动交易或定时任务。研究不构成投资建议。",
    question.trim() ? `用户补充研究问题（仅在上述研究范围内回答）：${question.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}
export async function requestJSON(path:string, init:RequestInit={}, headers:Record<string,string>={}): Promise<unknown> {
  const response = await fetch(path,{...init,headers:{"Content-Type":"application/json",...headers,...init.headers},credentials:"same-origin",signal:AbortSignal.timeout(30000)});
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("访问未授权。请在设置中填写本站访问令牌（不是模型 API Key）。");
    if (response.status === 501) throw new Error("研究会话服务未启用，请检查 ENABLE_SESSION_RUNTIME。");
    throw new Error(`服务返回 HTTP ${response.status}。请检查服务日志；不会自动重试研究任务。`);
  }
  return response.json();
}
export function parseSessions(value:unknown): ResearchSession[] {
  if (!Array.isArray(value)) throw new Error("会话接口返回格式异常。");
  return value.filter((x):x is ResearchSession => !!x && typeof x === "object" && typeof x.session_id === "string" && typeof x.title === "string" && typeof x.status === "string" && typeof x.updated_at === "string");
}
export type Requester = (path:string, init?:RequestInit) => Promise<unknown>;
export async function createResearchSession(request:Requester, title:string): Promise<string> {
  const result = await request("/sessions",{method:"POST",body:JSON.stringify({title:`${TITLE_PREFIX} ${title}`})});
  const id = (result as {session_id?:unknown}|null)?.session_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("创建会话返回了无效 ID，任务尚未发送。");
  return id;
}
export async function sendResearch(request:Requester, sessionId:string, content:string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || content.length < 1 || content.length > 5000) throw new Error("研究任务参数无效。");
  await request(`/sessions/${encodeURIComponent(sessionId)}/messages`,{method:"POST",body:JSON.stringify({content})});
}
