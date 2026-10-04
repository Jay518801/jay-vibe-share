import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { authHeaders } from "@/lib/apiAuth";
import { buildResearchPrompt, chinaDate, createResearchSession, normalizeInstrument, parseSessions, parseWatchlist, RESEARCH_TYPES, requestJSON, searchInstruments, sendResearch, TITLE_PREFIX, WATCHLIST_KEY, type Instrument, type Market, type ResearchKind, type ResearchSession } from "@/lib/stockResearch";
import "./StockAnalysis.css";

function loadWatchlist(): Instrument[] {
  try { return parseWatchlist(localStorage.getItem(WATCHLIST_KEY)); } catch { return []; }
}
const request = (path:string, init?:RequestInit) => requestJSON(path,init,authHeaders());
const stateLabel = (status:string) => (({idle:"就绪",running:"运行中",completed:"已完成",failed:"失败",cancelled:"已取消",error:"异常"} as Record<string,string>)[status] || status);

export function StockAnalysis() {
  const navigate = useNavigate();
  const [watchlist,setWatchlist] = useState(loadWatchlist);
  const [selection,setSelection] = useState<Instrument[]>([]);
  const [query,setQuery] = useState("");
  const [market,setMarket] = useState<"all"|Market>("all");
  const [kind,setKind] = useState<ResearchKind>("overview");
  const [months,setMonths] = useState(12);
  const [question,setQuestion] = useState("");
  const [notice,setNotice] = useState("");
  const [error,setError] = useState("");
  const [connection,setConnection] = useState("正在检查服务…");
  const [connected,setConnected] = useState(false);
  const [recent,setRecent] = useState<ResearchSession[]>([]);
  const [preview,setPreview] = useState("");
  const [busy,setBusy] = useState(false);
  const [recoveryId,setRecoveryId] = useState("");
  const launchLock = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const catalog = useMemo(() => searchInstruments(query,market),[query,market]);
  const asOf = chinaDate();

  useEffect(() => {
    let active = true;
    request("/sessions?limit=50").then(value => {
      const sessions = parseSessions(value);
      if (!active) return;
      setRecent(sessions.filter(x=>x.title.startsWith(TITLE_PREFIX)).slice(0,5));
      setConnected(true); setConnection("服务已连接 · 模型状态尚未验证");
    }).catch(err => {
      if (active) { setConnected(false); setConnection(err instanceof Error ? err.message : "服务未连接"); }
    });
    return () => { active = false; };
  },[]);
  useEffect(() => { if (preview) previewRef.current?.focus(); },[preview]);

  function save(next:Instrument[]) {
    setWatchlist(next);
    try { localStorage.setItem(WATCHLIST_KEY,JSON.stringify(next)); setNotice("自选已保存在此浏览器，不代表真实持仓。"); }
    catch { setNotice("浏览器禁止本地存储；自选仅在本次页面内保留。"); }
  }
  function toggleWatch(stock:Instrument) {
    if (watchlist.some(x=>x.symbol===stock.symbol)) save(watchlist.filter(x=>x.symbol!==stock.symbol));
    else if (watchlist.length >= 100) setError("自选最多保存 100 只。");
    else save([...watchlist,stock]);
  }
  function add(stock:Instrument) {
    setError(""); setPreview("");
    if (selection.some(x=>x.symbol===stock.symbol)) { setNotice("该标的已加入本次研究。"); return; }
    if (selection.length >= 6) { setError("一次最多研究 6 只股票。"); return; }
    setSelection([...selection,stock]); setNotice(`已加入 ${stock.symbol}`);
  }
  function addQuery() {
    try { add(normalizeInstrument(query)); setQuery(""); }
    catch(err) { setError(err instanceof Error ? err.message : "请输入股票代码。"); }
  }
  function makePreview() {
    try {
      setPreview(buildResearchPrompt({instruments:selection,kind,months,question,asOf}));
      setError(""); setRecoveryId("");
    } catch(err) { setError(err instanceof Error ? err.message : "无法生成研究任务。"); }
  }
  async function launch() {
    if (launchLock.current || !preview || recoveryId) return;
    launchLock.current=true; setBusy(true); setError("");
    let id="";
    try {
      id=await createResearchSession(request,`${selection.map(x=>x.symbol).join(" / ")} · ${RESEARCH_TYPES.find(x=>x.id===kind)?.title}`);
      setRecoveryId(id);
      await sendResearch(request,id,preview);
      window.dispatchEvent(new Event("vibe:sessions-refresh"));
      navigate(`/agent?session=${encodeURIComponent(id)}`);
    } catch(err) {
      const detail=err instanceof Error ? err.message : "服务异常";
      setError(id ? `会话已创建，但发送结果尚未确认。${detail} 请先打开下方会话检查，不要重复提交。` : `任务创建未获确认：${detail} 如发生网络超时，请先到 AI 研究页核对会话，避免重复创建。`);
    } finally { launchLock.current=false; setBusy(false); }
  }
  function downloadPrompt() {
    const blob = new Blob([preview],{type:"text/plain;charset=utf-8"});
    const url=URL.createObjectURL(blob); const link=document.createElement("a");
    link.href=url; link.download=`股票研究任务-${asOf}.txt`; link.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <div className="stock-workspace" lang="zh-CN">
    <header className="stock-topbar"><div><span className="stock-mark">研</span><strong>研股工作台</strong><span className="stock-muted">A 股 / 港股</span></div><Link to="/settings" className="stock-link">连接与设置 ↗</Link></header>
    <section className="stock-intro"><div><div className="stock-eyebrow">YOUR RESEARCH, GROUNDED IN EVIDENCE</div><h1>先看清，<span>再做决定。</span></h1><p>从一只股票出发，把数据、判断和风险放在一起。<br/>研究由 Vibe-Trading 执行，结论应能追溯到证据。</p></div><div className="stock-date"><span>研究工作日历</span><strong>{asOf}</strong><small>上海 / 香港时区 · 非行情时间</small></div></section>
    <section className="stock-stats" aria-label="工作台概览"><div><span>研究市场</span><strong>A + H<small> 双市场</small></strong></div><div><span>我的自选</span><strong>{watchlist.length}<small> 只 · 本机保存</small></strong></div><div><span>本次研究</span><strong>{String(selection.length).padStart(2,"0")}<small> / 6 只</small></strong></div><div><span>数据原则</span><strong className="stock-stat-word">先核验<small> 再下结论</small></strong></div></section>
    <div className={`stock-connection ${connected?"is-connected":""}`} role="status"><i/>{connection}<Link to="/settings">检查配置 →</Link></div>
    {error && <div className="stock-error" role="alert">{error} {recoveryId && <Link to={`/agent?session=${encodeURIComponent(recoveryId)}`}>打开已创建会话 →</Link>}</div>}
    {notice && <p className="stock-notice" aria-live="polite">{notice}</p>}
    <div className="stock-grid">
      <div className="stock-main">
        <section className="stock-card"><div className="stock-section-heading"><div><span className="stock-step">01</span><h2>选择研究标的</h2></div><span className="stock-caption">名称示例检索 / 自定义代码</span></div>
          <form className="stock-search" onSubmit={e=>{e.preventDefault();addQuery();}}><span aria-hidden="true">⌕</span><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} aria-label="股票名称或代码" placeholder="搜索名称示例，或输入 600519 / 00700.HK" maxLength={40}/><button type="submit">加入研究 ↵</button></form>
          <div className="stock-filters" aria-label="市场筛选">{([['all','全部'],['A','A 股'],['HK','港股']] as const).map(([value,label])=><button key={value} aria-pressed={market===value} onClick={()=>setMarket(value)} className={market===value?'is-active':''}>{label}</button>)}<span>示例名录非全市场搜索，也不是投资推荐</span></div>
          <div className="stock-stocklist">{catalog.length ? catalog.slice(0,6).map(stock=><div className="stock-row" key={stock.symbol}><span className={`stock-exchange ${stock.market==='HK'?'is-hk':''}`}>{stock.market==='HK'?'HK':stock.symbol.slice(-2)}</span><button className="stock-stockname" onClick={()=>add(stock)}><strong>{stock.name}</strong><small>{stock.symbol} · {stock.market==='HK'?'HKD':'CNY'}</small></button><span className="stock-unpriced">研究时获取数据</span><button className="stock-star" aria-label={`${watchlist.some(x=>x.symbol===stock.symbol)?'移除':'添加'}自选 ${stock.name}`} aria-pressed={watchlist.some(x=>x.symbol===stock.symbol)} onClick={()=>toggleWatch(stock)}>{watchlist.some(x=>x.symbol===stock.symbol)?'★':'☆'}</button><button className="stock-add" onClick={()=>add(stock)} aria-label={`研究 ${stock.name}`}>＋</button></div>) : <div className="stock-empty">未匹配名称示例。请用完整证券代码加入，上市状态将在研究时核验。</div>}</div>
          <div className="stock-selected"><span>研究篮子</span>{selection.length ? selection.map(x=><button key={x.symbol} onClick={()=>{setSelection(selection.filter(s=>s.symbol!==x.symbol));setPreview("");}} aria-label={`移除研究标的 ${x.symbol}`}>{x.name}<small>{x.symbol}</small> ×</button>) : <small>点击 ＋ 加入股票；多股对比至少选择两只。</small>}</div>
        </section>
        <section className="stock-card"><div className="stock-section-heading"><div><span className="stock-step">02</span><h2>定义你的研究</h2></div><span className="stock-caption">不是一句“该不该买”</span></div>
          <div className="stock-modes">{RESEARCH_TYPES.map(type=><button key={type.id} className={kind===type.id?'is-active':''} aria-pressed={kind===type.id} onClick={()=>{setKind(type.id);setPreview("");}}><span>{type.number}</span><strong>{type.title}</strong><small>{type.detail}</small></button>)}</div>
          <div className="stock-controls"><label>历史观察窗口<select value={months} onChange={e=>{setMonths(Number(e.target.value));setPreview("");}}><option value={3}>最近 3 个月</option><option value={6}>最近 6 个月</option><option value={12}>最近 1 年</option><option value={36}>最近 3 年</option></select></label><div><span>默认研究约束</span><p>中文报告 · 本币口径 · 标注来源 · 不执行交易</p></div></div>
          <label className="stock-question">还想重点了解什么？<span>选填 · {question.length}/600</span><textarea value={question} onChange={e=>{setQuestion(e.target.value);setPreview("");}} maxLength={600} placeholder="例如：利润增长能否转化为现金流？当前估值与历史区间相比如何？" rows={3}/></label>
          <div className="stock-action"><p>这里只生成研究任务，不会展示虚构行情。<br/><small>开始分析后使用站点已配置模型，可能产生模型费用。</small></p><button className="stock-primary" onClick={makePreview} disabled={!selection.length || busy}>预览研究任务 <span>→</span></button></div>
        </section>
        {preview && <section className="stock-card stock-preview" tabIndex={-1} ref={previewRef} aria-label="研究任务预览"><div className="stock-section-heading"><div><span className="stock-step">03</span><h2>确认后开始分析</h2></div><button className="stock-link" onClick={downloadPrompt}>导出任务文本 ↓</button></div><pre>{preview}</pre><div className="stock-action"><p>结果将在原项目的 AI 研究界面持续显示。<br/><small>这是任务描述，不是已完成的分析报告。</small></p><button className="stock-primary" onClick={launch} disabled={busy || !!recoveryId}>{busy?'正在创建研究…':recoveryId?'请先检查已创建会话':'确认并开始分析 →'}</button></div></section>}
      </div>
      <aside className="stock-side">
        <section className="stock-card"><div className="stock-section-heading"><h2>我的自选</h2><span className="stock-count">{watchlist.length}</span></div><p className="stock-caption">仅保存在此浏览器，不代表实际持仓。</p>{watchlist.length ? <div className="stock-watchlist">{watchlist.map(stock=><div key={stock.symbol}><button onClick={()=>add(stock)}><strong>{stock.name}</strong><small>{stock.symbol}</small></button><button aria-label={`删除自选 ${stock.name}`} className="stock-link" onClick={()=>toggleWatch(stock)}>×</button></div>)}</div> : <div className="stock-empty"><span className="stock-empty-symbol">☆</span><strong>把关注留在这里</strong><p>点击股票旁的星标建立自选。<br/>下次打开，继续你的研究。</p><button className="stock-link" onClick={()=>searchRef.current?.focus()}>查找第一只股票 →</button></div>}</section>
        <section className="stock-card stock-proof"><div className="stock-eyebrow">RESEARCH STANDARD</div><h2>有依据的判断，<br/>才值得继续讨论。</h2><div><span>01</span><p><strong>先确认数据</strong><small>来源、时间、复权及覆盖范围</small></p></div><div><span>02</span><p><strong>再计算指标</strong><small>价格、财报与风险均需可复核</small></p></div><div><span>03</span><p><strong>保留反面证据</strong><small>区分事实、推断与未知</small></p></div><p className="stock-caption">未接通数据前不展示价格；休市、延迟和缺失数据需要明确说明。</p></section>
        <section className="stock-card"><div className="stock-section-heading"><h2>最近研究</h2><Link className="stock-link" to="/agent">全部会话 ↗</Link></div>{recent.length ? recent.map(session=><Link className="stock-recent" to={`/agent?session=${encodeURIComponent(session.session_id)}`} key={session.session_id}><strong>{session.title.replace(TITLE_PREFIX,'').trim()}</strong><small>{stateLabel(session.status)} · {session.updated_at.slice(0,10)}</small></Link>) : <p className="stock-empty">{connected?'最近 50 个会话中暂无股票研究。创建任务后，在这里继续。':'连接服务后可读取研究历史。'}</p>}<Link to="/reports" className="stock-report-link">查看已生成报告 →</Link></section>
      </aside>
    </div>
    <footer className="stock-footer"><span>基于 Jay518801/jay-vibe-share · Vibe-Trading</span><span>研究辅助工具，不构成投资建议。市场有风险，决策需独立核验。</span></footer>
  </div>;
}
