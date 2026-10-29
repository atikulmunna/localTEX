import { test, expect } from "@playwright/test";

// Exercise the desktop UI's save/build ordering with an IPC double, without claiming native execution.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.isTauri = true;
    const callbacks = new Map<number, Function>();
    const listeners = new Map<string, number>();
    let next = 1;
    const document = {
      path: "main.tex",
      text: "\\documentclass{article}\n\\begin{document}Hello\\end{document}",
      revision: "1",
    };
    const project = {
      id: "test",
      name: "Auto test",
      directory: "D:/Auto test",
      roots: ["main.tex"],
      files: [{ path: "main.tex", size: 80, editable: true }],
      config: {
        version: 1,
        root: "main.tex",
        engine: "pdflatex",
        shellEscape: false,
      },
    };
    w.testIPC = {
      calls: [],
      builds: [],
      packageFailure: false,
      conflict: false,
      finish() {
        const build = this.builds.at(-1);
        callbacks.get(listeners.get("build-event")!)?.({
          payload: {
            projectId: "test",
            buildId: build.buildId,
            kind: "finished",
            success: false,
            text: "Build failed",
          },
        });
      },
    };
    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback(callback: Function) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: any) {
        w.testIPC.calls.push(command);
        if (command === "load_settings")
          return { recent: ["D:/Auto test"], toolDirectory: null };
        if (command === "plugin:event|listen") {
          listeners.set(args.event, args.handler);
          return next++;
        }
        if (command === "open_project" || command === "refresh_project")
          return project;
        if (command === "index_project") return [{ ...document }];
        if (command === "load_drafts") return [];
        if (command === "read_file") return { ...document };
        if (command === "prepare_packages") {
          if (w.testIPC.packageFailure)
            throw new Error("Package download unavailable. Retry in Settings.");
          return "Common packages are ready.";
        }
        if (command === "save_file") {
          if (w.testIPC.conflict)
            throw new Error("CONFLICT: external file changed");
          Object.assign(document, args.document, {
            revision: String(Number(document.revision) + 1),
          });
          return document.revision;
        }
        if (command === "start_build")
          w.testIPC.builds.push({ ...args, text: document.text });
      },
    };
  });
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
  expect(await page.evaluate(() => (window as any).testIPC.builds.length)).toBe(
    0,
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).testIPC.builds.length))
    .toBe(1);
  const first = await page.evaluate(
    () => (window as any).testIPC.builds[0].text,
  );
  expect(first).toContain("First edit");
  expect(first).toContain("Second edit");
  expect(await page.evaluate(() => (window as any).testIPC.builds[0].force)).toBe(false);
  await page.keyboard.insertText("% While compiling\n");
  await page.waitForTimeout(1400);
  expect(await page.evaluate(() => (window as any).testIPC.builds.length)).toBe(
    1,
  );
  await page.evaluate(() => (window as any).testIPC.finish());
  await expect
    .poll(() => page.evaluate(() => (window as any).testIPC.builds.length))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).testIPC.builds[1].text),
  ).toContain("While compiling");
  expect(await page.evaluate(() => (window as any).testIPC.builds[1].force)).toBe(true);
  expect(
    await page.evaluate(
      () =>
        (window as any).testIPC.calls.filter(
          (c: string) => c === "prepare_packages",
        ).length,
    ),
  ).toBe(1);
});

test("turning auto off cancels pending work and keeps manual compilation", async ({
  page,
}) => {
  await page.keyboard.insertText("% Pending edit\n");
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).testIPC.builds.length)).toBe(
    0,
  );
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testIPC.builds.length))
    .toBe(1);
  expect(await page.evaluate(() => (window as any).testIPC.builds[0].force)).toBe(true);
});

test("package failures pause auto compile without starting an engine", async ({
  page,
}) => {
  await page.evaluate(() => ((window as any).testIPC.packageFailure = true));
  await page.keyboard.insertText("% Needs setup\n");
  await expect(
    page.getByRole("button", { name: "Auto compile" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status")).toContainText(
    "Package download unavailable",
  );
  expect(await page.evaluate(() => (window as any).testIPC.builds.length)).toBe(
    0,
  );
});

test("external save conflicts prevent auto compilation", async ({ page }) => {
  await page.evaluate(() => ((window as any).testIPC.conflict = true));
  await page.keyboard.insertText("% Conflicting edit\n");
  await expect(page.getByRole("status")).toContainText("CONFLICT");
  expect(await page.evaluate(() => (window as any).testIPC.builds.length)).toBe(
    0,
  );
});
