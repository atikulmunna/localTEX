import { test, expect, type Page } from "@playwright/test";
import { installDesktopDouble, recorded } from "./desktop-double";

const send = (page: Page, event: object) =>
  page.evaluate((e) => (window as any).testIPC.setup(e), event);

test("first launch sets up LaTeX in a dialog that can keep running in the background", async ({
  page,
}) => {
  await installDesktopDouble(page, { setupComplete: false });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Set up LaTeX" });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await recorded(page)).setups.length).toBe(1);

  await send(page, { kind: "step", step: "tools", state: "done", text: "Found MiKTeX 26.5 and latexmk" });
  await send(page, { kind: "progress", step: "packages", done: 1, total: 4, text: "Installing pgfplots" });
  await expect(dialog).toContainText("Found MiKTeX 26.5 and latexmk");
  await expect(dialog).toContainText("Installing pgfplots");
  await expect(dialog).toContainText("1 of 4");
  await expect(
    dialog.getByRole("progressbar", { name: "Setup progress" }),
  ).toHaveAttribute("aria-valuenow", "25");

  await dialog.getByRole("button", { name: "Continue in background" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Setting up LaTeX 25%" }),
  ).toBeVisible();

  // A compile requested during setup waits for it instead of failing on missing packages.
  await page.getByRole("button").filter({ hasText: "Auto test" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your build starts as soon as it finishes",
  );
  expect((await recorded(page)).builds.length).toBe(0);

  await send(page, {
    kind: "finished",
    success: true,
    outcome: { distribution: "MiKTeX 26.5", miktex: true, installed: ["pgfplots"] },
  });
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  await expect(page.getByRole("status")).toContainText("LaTeX is ready");
  await expect(page.getByRole("button", { name: /Setting up LaTeX/ })).toHaveCount(0);
});

test("a missing LaTeX install explains the fix and checks again", async ({
  page,
}) => {
  await installDesktopDouble(page, { setupComplete: false });
  await page.goto("/");
  await expect.poll(async () => (await recorded(page)).setups.length).toBe(1);
  await send(page, {
    kind: "finished",
    success: false,
    failure: {
      step: "tools",
      problem: "missing-tex",
      text: "LaTeX isn't installed, or localTEX can't find it. Install MiKTeX, then try again.\nprogram not found",
    },
  });
  const dialog = page.getByRole("dialog", { name: "LaTeX setup needs attention" });
  await expect(dialog.getByRole("alert")).toContainText("Install MiKTeX");
  await expect(dialog.getByRole("button", { name: "Download MiKTeX" })).toBeVisible();
  await dialog.getByRole("button", { name: "Check again" }).click();
  await expect.poll(async () => (await recorded(page)).setups.length).toBe(2);
  await expect(page.getByRole("dialog", { name: "Set up LaTeX" })).toBeVisible();
});

test("stopping setup is not treated as an error", async ({ page }) => {
  await installDesktopDouble(page, { setupComplete: false });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Set up LaTeX" });
  await dialog.getByRole("button", { name: "Stop setup" }).click();
  await expect
    .poll(async () => (await recorded(page)).calls)
    .toContain("cancel_setup");
  await send(page, {
    kind: "finished",
    success: false,
    failure: { step: "packages", problem: "cancelled", text: "Setup stopped." },
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Start setup" })).toBeVisible();
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("button", { name: "Set up LaTeX" })).toBeVisible();
});
