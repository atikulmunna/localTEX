import { test, expect, type Page } from "@playwright/test";
import { installDesktopDouble, recorded } from "./desktop-double";

// Overleaf-style editing comforts, through the desktop IPC double.
async function openProject(page: Page) {
  await installDesktopDouble(page);
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Auto test" }).click();
  await page.getByRole("button", { name: "Auto compile" }).click();
  return page.getByRole("textbox", { name: "LaTeX source editor" });
}

test("Ctrl+B and Ctrl+I format text; Ctrl+Shift+B toggles the sidebar", async ({
  page,
}) => {
  const editor = await openProject(page);
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nworld");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await page.keyboard.press("Control+b");
  await expect(editor).toContainText("\\textbf{world}");
  // Pressing it again on the same selection removes the formatting.
  await page.keyboard.press("Control+b");
  await expect(editor).not.toContainText("\\textbf");
  await page.keyboard.press("Control+i");
  await expect(editor).toContainText("\\textit{world}");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.keyboard.press("Control+Shift+B");
  await expect(page.locator(".sidebar")).toBeHidden();
});

test("spell checking skips LaTeX, and the status bar counts words", async ({
  page,
}) => {
  const editor = await openProject(page);
  await expect(editor).toHaveAttribute("spellcheck", "true");
  // Commands are excluded from checking; the prose word is not.
  const command = editor.getByText("\\documentclass");
  await expect(command.locator("xpath=ancestor-or-self::*[@spellcheck][1]")).toHaveAttribute(
    "spellcheck",
    "false",
  );
  await expect(page.locator(".statusbar")).toContainText("1 word");
  await expect(page.locator(".cm-foldGutter")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: /Check spelling/ }).uncheck();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveAttribute("spellcheck", "false");
});

test("the file tree previews images and manages files and folders", async ({
  page,
}) => {
  await openProject(page);
  const tree = page.locator(".file-tree");
  await expect(
    tree.getByRole("button", { name: "figures", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await tree.getByRole("button", { name: "plot.png", exact: true }).click();
  const image = page.getByRole("img", { name: "figures/plot.png" });
  await expect(image).toBeVisible();
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // New files and folders go into the folder of the open file.
  await page.getByRole("button", { name: "New folder" }).click();
  const name = page.getByRole("textbox", { name: "Folder name" });
  await expect(name).toHaveValue("figures/figures");
  // Only the name is selected, so typing keeps the folder, as in Explorer.
  await page.keyboard.type("plots");
  await expect(name).toHaveValue("figures/plots");
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("button", { name: "Add files" }).click();
  await tree.getByRole("button", { name: "Delete figures/plot.png" }).click();
  await expect
    .poll(async () => (await recorded(page)).fileOps.map((op) => op.command))
    .toEqual(["create_folder", "import_files", "delete_entry"]);
  const [created, imported, removed] = (await recorded(page)).fileOps;
  expect(created.path).toBe("figures/plots");
  expect(imported).toMatchObject({ folder: "figures/plots", sources: ["C:/Pictures/chart.png"] });
  expect(removed.path).toBe("figures/plot.png");
  // The deleted file's preview tab closes with it.
  await expect(image).toBeHidden();
});
