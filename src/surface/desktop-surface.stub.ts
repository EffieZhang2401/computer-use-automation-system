import type { ActionCall, ActionResult, Observation, Surface } from "./surface.js";

/**
 * Desktop surface stub — proves the Surface interface is not web-specific.
 * A real implementation would use Windows UIA or macOS Accessibility APIs.
 */
export class DesktopSurfaceStub implements Surface {
  observe(): Promise<Observation> {
    throw new Error("DesktopSurfaceStub.observe is not implemented (Windows UIA / macOS AX)");
  }

  act(_call: ActionCall): Promise<ActionResult> {
    throw new Error("DesktopSurfaceStub.act is not implemented (Windows UIA / macOS AX)");
  }

  screenshot(): Promise<Buffer> {
    throw new Error("DesktopSurfaceStub.screenshot is not implemented (Windows UIA / macOS AX)");
  }
}
