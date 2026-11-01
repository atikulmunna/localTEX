import { test, expect, type Page } from "@playwright/test";
import { installDesktopDouble, recorded } from "./desktop-double";

// Overleaf-style editing comforts, through the desktop IPC double.
async function openProject(page: Page, text?: string) {
  await installDesktopDouble(page, { text });
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

test("spell checking underlines misspelled prose, offers fixes, and counts words", async ({
  page,
}) => {
  const editor = await openProject(
    page,
    String.raw`\documentclass{article}
\begin{document}
Hello teh world, see \ref{teh}.
\end{document}`,
  );
  // The whole file is checked on opening, not only words as they are typed.
  const marked = editor.locator(".cm-misspelled");
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveText("teh");
  // LaTeX never reaches the checker: commands and labels arrive as spaces.
  const [check] = (await recorded(page)).spellChecks;
  expect(check.language).toBe("en-US");
  expect(check.text).not.toContain("documentclass");
  expect(check.text).not.toContain("{teh}");
  expect(check.text).toContain("Hello teh world");
  await expect(page.locator(".statusbar")).toContainText("4 words");
  await marked.click({ button: "right" });
  await page.getByRole("menuitem", { name: "the", exact: true }).click();
  await expect(editor).toContainText("Hello the world");
  await expect(marked).toHaveCount(0);
  await expect(page.locator(".cm-foldGutter")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Spelling language" }),
  ).toHaveValue("en-US");
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
