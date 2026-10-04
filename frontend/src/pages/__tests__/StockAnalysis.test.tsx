import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { StockAnalysis } from "../StockAnalysis";
import { WATCHLIST_KEY } from "@/lib/stockResearch";

const fetchMock = vi.fn();
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function mount() {
  return render(<MemoryRouter><Routes><Route path="/" element={<StockAnalysis />} /><Route path="/agent" element={<div>研究结果页</div>} /></Routes></MemoryRouter>);
}
async function ready() { const view = mount(); await screen.findByText(/服务已连接/); return view; }
function add(code = "600519") {
  fireEvent.change(screen.getByLabelText("股票名称或代码"), {target:{value:code}});
  fireEvent.click(screen.getByRole("button", {name:/加入研究/}));
}
function preview() { fireEvent.click(screen.getByRole("button", {name:/预览研究任务/})); }
beforeEach(() => { localStorage.clear(); fetchMock.mockReset().mockImplementation(async () => response([])); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("empty desk, search, market filters, selection validation and task controls", async () => {
  await ready();
  expect(screen.getByRole("button", {name:/预览研究任务/})).toBeDisabled();
  fireEvent.click(screen.getByRole("button", {name:/查找第一只股票/}));
  expect(screen.getByLabelText("股票名称或代码")).toHaveFocus();
  add("bad"); expect(screen.getByRole("alert")).toHaveTextContent("请输入有效格式");
  fireEvent.change(screen.getByLabelText("股票名称或代码"), {target:{value:"不存在"}});
  expect(screen.getByText(/未匹配名称示例/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("股票名称或代码"), {target:{value:""}});
  fireEvent.click(screen.getByRole("button", {name:"港股"}));
  fireEvent.click(screen.getByRole("button", {name:"研究 腾讯控股"}));
  fireEvent.click(screen.getByRole("button", {name:"研究 腾讯控股"}));
  expect(screen.getByText("该标的已加入本次研究。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name:/05多股对比/}));
  preview(); expect(screen.getByRole("alert")).toHaveTextContent("至少需要两只");
  add(); fireEvent.change(screen.getByRole("combobox"), {target:{value:"6"}});
  fireEvent.change(screen.getByRole("textbox", {name:/还想重点/}), {target:{value:"现金流"}});
  preview(); expect(screen.getByLabelText("研究任务预览")).toHaveFocus();
  expect(screen.getByLabelText("研究任务预览")).toHaveTextContent("最近 6 个月");
  fireEvent.click(screen.getByLabelText("移除研究标的 00700.HK"));
  expect(screen.queryByLabelText("研究任务预览")).not.toBeInTheDocument();
  for (const code of ["000001","300750","601318","002594","688981","700"]) add(code);
  expect(screen.getByRole("alert")).toHaveTextContent("最多研究 6 只");
});

test("watchlist can be saved, selected, removed and survives remount", async () => {
  const view = await ready();
  fireEvent.click(screen.getByLabelText("添加自选 贵州茅台"));
  expect(JSON.parse(localStorage.getItem(WATCHLIST_KEY)!)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", {name:"贵州茅台600519.SH"}));
  expect(screen.getByLabelText("移除研究标的 600519.SH")).toBeInTheDocument();
  view.unmount(); await ready();
  fireEvent.click(screen.getByLabelText("移除自选 贵州茅台"));
  expect(JSON.parse(localStorage.getItem(WATCHLIST_KEY)!)).toEqual([]);
  fireEvent.click(screen.getByLabelText("添加自选 贵州茅台"));
  fireEvent.click(screen.getByLabelText("删除自选 贵州茅台"));
  expect(JSON.parse(localStorage.getItem(WATCHLIST_KEY)!)).toEqual([]);
});

test("storage denied and full watchlist are explicitly reported", async () => {
  vi.spyOn(Storage.prototype,"getItem").mockImplementation(() => { throw new Error("denied"); });
  const view = await ready();
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(() => { throw new Error("denied"); });
  fireEvent.click(screen.getByLabelText("添加自选 贵州茅台"));
  expect(screen.getByText(/浏览器禁止本地存储/)).toBeInTheDocument();
  view.unmount(); vi.restoreAllMocks();
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(Array.from({length:100},(_,i)=>({symbol:`${600000+i}.SH`}))));
  await ready(); fireEvent.click(screen.getByLabelText("添加自选 贵州茅台"));
  expect(screen.getByRole("alert")).toHaveTextContent("最多保存 100 只");
});

test.each([401,403,501,502])("connection failure %i is visible", async status => {
  fetchMock.mockResolvedValue(response({},status)); mount();
  await waitFor(()=>expect(screen.getByRole("status")).not.toHaveTextContent("正在检查"));
  expect(screen.getByText("连接服务后可读取研究历史。")).toBeInTheDocument();
});

test("history filters research sessions and displays unknown states", async () => {
  fetchMock.mockResolvedValue(response([{session_id:"a",title:"[股票研究] 腾讯",status:"new-status",updated_at:"2026-10-04"},{session_id:"b",title:"other",status:"idle",updated_at:"2026-10-04"}]));
  await ready(); expect(screen.getByRole("link",{name:/腾讯new-status/})).toHaveAttribute("href","/agent?session=a");
  expect(screen.queryByText("other")).not.toBeInTheDocument();
});

test("confirmation creates and sends exactly one request during double click", async () => {
  await ready(); add(); preview();
  let resolve!: (r:Response)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValueOnce(response({status:"started"}));
  const button = screen.getByRole("button",{name:/确认并开始分析/});
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async()=>resolve(response({session_id:"research-1"})));
  expect(await screen.findByText("研究结果页")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls[2][0]).toBe("/sessions/research-1/messages");
});

test.each([true,false])("uncertain send/create failure retains evidence: created=%s", async created => {
  await ready(); add(); preview();
  if (created) fetchMock.mockResolvedValueOnce(response({session_id:"recovery"}));
  fetchMock.mockRejectedValueOnce(new Error("timeout"));
  fireEvent.click(screen.getByRole("button",{name:/确认并开始分析/}));
  expect(await screen.findByRole("alert")).toHaveTextContent(created ? "会话已创建" : "任务创建未获确认");
  expect(fetchMock).toHaveBeenCalledTimes(created ? 3 : 2);
  if (created) {
    expect(screen.getByRole("link",{name:/打开已创建会话/})).toHaveAttribute("href","/agent?session=recovery");
    expect(screen.getByRole("button",{name:"请先检查已创建会话"})).toBeDisabled();
  }
});

test("unmounted requests do not update the desk", async () => {
  let resolve!: (r:Response)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const view = mount(); view.unmount();
  await act(async()=>resolve(response([])));
  expect(screen.queryByText(/服务已连接/)).not.toBeInTheDocument();
});

test("export downloads the preview and releases its object URL", async () => {
  await ready(); add(); preview();
  const create = vi.fn(()=>"blob:fixture"); const revoke=vi.fn();
  vi.stubGlobal("URL",Object.assign(URL,{createObjectURL:create,revokeObjectURL:revoke}));
  const click=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>{});
  vi.useFakeTimers();
  try { fireEvent.click(screen.getByRole("button",{name:/导出任务文本/})); expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); vi.advanceTimersByTime(1000); expect(revoke).toHaveBeenCalledWith("blob:fixture"); }
  finally { vi.useRealTimers(); }
});

test("name row selects its stock", async () => {
  await ready(); fireEvent.click(screen.getByRole("button",{name:/贵州茅台600519.SH · CNY/}));
  expect(screen.getByLabelText("移除研究标的 600519.SH")).toBeInTheDocument();
});
test("unknown transport error is rendered without assuming Error", async () => {
  fetchMock.mockRejectedValueOnce("offline"); mount();
  await screen.findByText("服务未连接");
});
test("rejected pending request after unmount does not render an error", async () => {
  let reject!: (e:unknown)=>void;
  fetchMock.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
  const view=mount(); view.unmount();
  await act(async()=>reject("offline"));
  expect(screen.queryByText("服务未连接")).not.toBeInTheDocument();
});
test("non-Error creation rejection is explained", async () => {
  await ready(); add(); preview(); fetchMock.mockRejectedValueOnce("offline");
  fireEvent.click(screen.getByRole("button",{name:/确认并开始分析/}));
  expect(await screen.findByRole("alert")).toHaveTextContent("服务异常");
});

test("unexpected non-Error validation failures produce safe fallback messages", async () => {
  const research = await import("@/lib/stockResearch");
  await ready();
  vi.spyOn(research,"normalizeInstrument").mockImplementationOnce(()=>{throw "invalid";});
  add(); expect(screen.getByRole("alert")).toHaveTextContent("请输入股票代码");
  add();
  vi.spyOn(research,"buildResearchPrompt").mockImplementationOnce(()=>{throw "invalid";});
  preview(); expect(screen.getByRole("alert")).toHaveTextContent("无法生成研究任务");
});
