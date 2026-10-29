import { test, expect } from "@playwright/test";
test("welcome, editor layouts, search, command palette and theme", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Big ideas. Your own space." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Explore the browser preview" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "LaTeX source editor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Write", exact: true }).click();
  await expect(page.getByRole("region", { name: "PDF preview" })).toBeHidden();
  await page.keyboard.press("Control+j");
  await expect(page.getByRole("region", { name: "PDF preview" })).toBeVisible();
  await page
    .getByRole("button", { name: "Search project", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Search project text" })
    .fill("curiosity");
  await expect(page.locator(".search-result")).toHaveCount(1);
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder("Find a command or a file…").fill("graphite");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("editing is saved and restored in the explicitly labeled browser preview", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Explore the browser preview" })
    .click();
  const editor = page.getByRole("textbox", { name: "LaTeX source editor" });
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.insertText("% A persistent thought\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".status-saved")).toHaveText("All changes saved");
  await page.reload();
  await page
    .getByRole("button", { name: "Explore the browser preview" })
    .click();
  await expect(editor).toContainText("A persistent thought");
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect(page.getByRole("status")).toContainText("Windows desktop app");
});
test("keyboard focus and settings remain usable at a compact viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
