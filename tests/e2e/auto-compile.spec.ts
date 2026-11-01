import { test, expect } from "@playwright/test";
import { installDesktopDouble, recorded } from "./desktop-double";

// Exercise the desktop UI's save/build ordering with an IPC double, without claiming native execution.
test.beforeEach(async ({ page }) => {
  await installDesktopDouble(page);
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Auto test" }).click();
  await page.getByRole("textbox", { name: "LaTeX source editor" }).click();
  await page.keyboard.press("Control+Home");
});

test("auto compile debounces edits, saves first, and coalesces edits during a build", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "Auto compile" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.insertText("% First edit\n");
  await page.waitForTimeout(500);
  await page.keyboard.insertText("% Second edit\n");
  await page.waitForTimeout(800);
  expect((await recorded(page)).builds.length).toBe(0);
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  const [first] = (await recorded(page)).builds;
  expect(first.text).toContain("First edit");
  expect(first.text).toContain("Second edit");
  expect(first.force).toBe(false);
  // Downloading missing packages is on by default, so builds may fetch them too.
  expect(first.install).toBe(true);
  await page.keyboard.insertText("% While compiling\n");
  await page.waitForTimeout(1400);
  expect((await recorded(page)).builds.length).toBe(1);
  await page.evaluate(() => (window as any).testIPC.finish());
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(2);
  const second = (await recorded(page)).builds[1];
  expect(second.text).toContain("While compiling");
  expect(second.force).toBe(true);
  // A finished setup is remembered, so opening the app never repeats it.
  const { calls } = await recorded(page);
  expect(calls).toContain("setup_status");
  expect(calls).not.toContain("start_setup");
});

test("turning auto off cancels pending work and keeps manual compilation", async ({
  page,
}) => {
  await page.keyboard.insertText("% Pending edit\n");
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.waitForTimeout(1500);
  expect((await recorded(page)).builds.length).toBe(0);
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  expect((await recorded(page)).builds[0].force).toBe(true);
});

test("a missing package offers one click to install it and compile again", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  await page.evaluate(() => {
    const ipc = (window as any).testIPC;
    ipc.output("! LaTeX Error: File `kvsetkeys.sty' not found.");
    ipc.finish();
  });
  const panel = page.getByRole("region", { name: "Build output" });
  await expect(panel).toContainText("kvsetkeys.sty isn’t installed.");
  await panel.getByRole("button", { name: "Install and compile" }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(2);
  const retry = (await recorded(page)).builds[1];
  expect(retry.install).toBe(true);
  expect(retry.force).toBe(true);
});

test("external save conflicts prevent auto compilation", async ({ page }) => {
  await page.evaluate(() => ((window as any).testIPC.conflict = true));
  await page.keyboard.insertText("% Conflicting edit\n");
  await expect(page.getByRole("status")).toContainText("CONFLICT");
  expect((await recorded(page)).builds.length).toBe(0);
});
