import { test, expect, type Page } from "@playwright/test";
import { installDesktopDouble, recorded } from "./desktop-double";

// Packages a document loads are downloaded before it is compiled.
async function open(page: Page, text: string, hold = false) {
  await installDesktopDouble(page, { text });
  if (hold)
    await page.addInitScript(() => {
      (window as any).testIPC.holdFetch = true;
    });
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Auto test" }).click();
  await page.getByRole("button", { name: "Auto compile" }).click();
}

test("a package the document loads is downloaded when the project opens", async ({
  page,
}) => {
  await open(
    page,
    String.raw`\documentclass{article}
\usepackage[ruled]{algorithm2e}
\begin{document}Hi\end{document}`,
  );
  await expect(page.getByRole("status").filter({ hasText: "Downloaded" })).toHaveText(
    "Downloaded algorithm2e for this project.",
  );
  const [fetch] = (await recorded(page)).fetches;
  expect(fetch.engine).toBe("pdflatex");
  expect(fetch.files).toEqual(["algorithm2e.sty", "article.cls"]);
});

test("a compile waits for a download in progress, then runs", async ({ page }) => {
  await open(
    page,
    String.raw`\documentclass{article}
\usepackage{algorithm2e}
\begin{document}Hi\end{document}`,
    true,
  );
  await expect(page.locator(".statusbar")).toContainText("Getting packages");
  await page.getByRole("button", { name: /^Compile/ }).click();
  await page.waitForTimeout(500);
  expect((await recorded(page)).builds.length).toBe(0);
  await page.evaluate(() => (window as any).testIPC.releaseFetch());
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  expect((await recorded(page)).builds[0].install).toBe(true);
  await expect(page.locator(".statusbar")).not.toContainText("Getting packages");
});

test("a newly added package is fetched on save; a misspelled one is reported once", async ({
  page,
}) => {
  await open(page, String.raw`\documentclass{article}
\begin{document}Hi\end{document}`);
  await expect.poll(async () => (await recorded(page)).fetches.length).toBe(1);
  const editor = page.getByRole("textbox", { name: "LaTeX source editor" });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n\\usepackage{nosuchpkg}");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("status").filter({ hasText: "Couldn" })).toContainText(
    "Couldn’t download nosuchpkg",
  );
  // Already checked files are not looked up again.
  expect((await recorded(page)).fetches.at(-1)!.files).toEqual(["nosuchpkg.sty"]);
  await page.keyboard.insertText(" ");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(500);
  expect((await recorded(page)).fetches.length).toBe(2);

  // With the setting off, nothing is downloaded.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: /Download missing packages/ }).uncheck();
  await page.keyboard.press("Escape");
  await editor.click();
  await page.keyboard.insertText("\n\\usepackage{tikzcd}");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(500);
  expect((await recorded(page)).fetches.length).toBe(2);
});
