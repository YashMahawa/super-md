// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

const { platformAtReaderLoad } = vi.hoisted(() => ({ platformAtReaderLoad: vi.fn() }));

vi.mock("./scrollIndicators", () => ({ installScrollIndicators: vi.fn() }));
vi.mock("./androidReader", () => {
  platformAtReaderLoad(document.documentElement.dataset.platform);
  return {};
});

beforeEach(() => {
  vi.resetModules();
  platformAtReaderLoad.mockClear();
  delete document.documentElement.dataset.host;
  delete document.documentElement.dataset.platform;
  Object.defineProperty(window, "qt", { configurable: true, value: { webChannelTransport: {} } });
  Object.defineProperty(window, "QWebChannel", {
    configurable: true,
    value: class {
      constructor(_transport: unknown, ready: (channel: { objects: { studio: unknown } }) => void) {
        ready({ objects: { studio: { post: vi.fn(), replied: { connect: vi.fn() } } } });
      }
    },
  });
});

it("sets desktop platform metadata before Qt initializes the shared reader", async () => {
  await import("./qtReader");

  expect(document.documentElement.dataset.host).toBe("qt");
  expect(document.documentElement.dataset.platform).toBe("desktop");
  await vi.waitFor(() => expect(platformAtReaderLoad).toHaveBeenCalledWith("desktop"));
});
