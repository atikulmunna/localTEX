import { test, expect } from "@playwright/test";
import { installDesktopDouble } from "./desktop-double";

// Overleaf-style formatting toolbar: select, click, and the LaTeX is written.
test("the toolbar formats text without typing LaTeX", async ({ page }) => {
  await installDesktopDouble(page, {
    text: String.raw`\documentclass{article}
\begin{document}
Results
first point
second point
\end{document}`,
  });
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Auto test" }).click();
  await page.getByRole("button", { name: "Auto compile" }).click();
  const editor = page.getByRole("textbox", { name: "LaTeX source editor" });
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  const style = toolbar.getByRole("combobox", { name: "Text style" });
  // Tools that don't fit beside the PDF sit in the More menu.
  const use = async (name: string) => {
    const button = toolbar.getByRole("button", { name, exact: true });
    if (await button.isVisible()) return button.click();
    await toolbar.getByRole("button", { name: "More formatting" }).click();
    await toolbar.getByRole("menuitem", { name }).click();
  };

  await editor.getByText("Results").click();
  await expect(style).toHaveValue("");
  await style.selectOption("section");
  await expect(editor).toContainText("\\section{Results}");
  await expect(style).toHaveValue("section");

  await editor.getByText("first point").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await use("Bulleted list");
  await expect(editor).toContainText("\\begin{itemize}");
  await expect(editor).toContainText("\\item first point");
  await expect(editor).toContainText("\\item second point");

  // The cursor ends after the first item; select its last word and make it bold.
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await toolbar.getByRole("button", { name: "Bold" }).click();
  await expect(editor).toContainText("\\item first \\textbf{point}");
  // Clicking again removes it, and the selection was kept for the second click.
  await use("Bold");
  await expect(editor).toContainText("\\item first point");

  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // Beside the PDF, Figure does not fit and is offered in the More menu.
  await expect(toolbar.getByRole("button", { name: "Figure", exact: true })).toHaveCount(0);
  await use("Figure");
  await expect(editor).toContainText("\\begin{figure}[htbp]");
  await expect(editor).toContainText("\\includegraphics[width=0.8\\linewidth]{file}");
});
