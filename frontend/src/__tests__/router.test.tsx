import { act, cleanup, render, screen } from "@testing-library/react";
import { Outlet, RouterProvider } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("@/components/layout/Layout", () => ({ Layout: () => <Outlet /> }));
vi.mock("@/pages/StockAnalysis", () => ({ StockAnalysis: () => <div>StockAnalysis fixture</div> }));
vi.mock("@/pages/Home", () => ({ Home: () => <div>Home fixture</div> }));
vi.mock("@/pages/Agent", () => ({ Agent: () => <div>Agent fixture</div> }));
vi.mock("@/pages/RunDetail", () => ({ RunDetail: () => <div>RunDetail fixture</div> }));
vi.mock("@/pages/Compare", () => ({ Compare: () => <div>Compare fixture</div> }));
vi.mock("@/pages/Settings", () => ({ Settings: () => <div>Settings fixture</div> }));
vi.mock("@/pages/Runtime", () => ({ Runtime: () => <div>Runtime fixture</div> }));
vi.mock("@/pages/Scheduled", () => ({ Scheduled: () => <div>Scheduled fixture</div> }));
vi.mock("@/pages/Reports", () => ({ Reports: () => <div>Reports fixture</div> }));
vi.mock("@/pages/Portfolio", () => ({ Portfolio: () => <div>Portfolio fixture</div> }));
vi.mock("@/pages/Correlation", () => ({ Correlation: () => <div>Correlation fixture</div> }));
vi.mock("@/pages/AlphaZoo", () => ({ AlphaZoo: () => <div>AlphaZoo fixture</div> }));
vi.mock("@/pages/OptionsLab", () => ({ OptionsLab: () => <div>OptionsLab fixture</div> }));
afterEach(cleanup);
test("homepage, legacy session link and every preserved route resolve", async () => {
  const { router } = await import("../router");
  render(<RouterProvider router={router} />);
  const routes: [string,string][] = [["/","StockAnalysis"],["/?session=old","Agent"],["/about","Home"],["/agent","Agent"],["/runtime","Runtime"],["/scheduled","Scheduled"],["/reports","Reports"],["/portfolio","Portfolio"],["/settings","Settings"],["/runs/fixture","RunDetail"],["/compare","Compare"],["/correlation","Correlation"],["/options","OptionsLab"],["/alpha-zoo","AlphaZoo"],["/alpha-zoo/bench","AlphaZoo"],["/alpha-zoo/compare","AlphaZoo"],["/alpha-zoo/fixture","AlphaZoo"]];
  for (const [path, name] of routes) {
    await act(async () => { await router.navigate(path); });
    expect(await screen.findByText(`${name} fixture`)).toBeInTheDocument();
  }
  router.dispose();
});
