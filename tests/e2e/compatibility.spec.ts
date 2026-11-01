import { test, expect, type Page } from "@playwright/test";
import { installDesktopDouble, recorded } from "./desktop-double";

// Projects that come from Overleaf, TeXstudio or older editors, through the IPC double.
async function openProject(page: Page) {
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Auto test" }).click();
  await page.getByRole("textbox", { name: "LaTeX source editor" }).waitFor();
}

test("an Overleaf download that loads fontspec builds with XeLaTeX", async ({
  page,
}) => {
  await installDesktopDouble(page, {
    engine: null,
    text: "\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}Hi\\end{document}",
  });
  await openProject(page);
  await expect(page.locator(".statusbar")).toContainText("XeLaTeX");
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  expect((await recorded(page)).builds[0].engine).toBe("xelatex");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "LaTeX engine" }),
  ).toContainText("Auto (XeLaTeX)");
});

test("a file in an older encoding shows that encoding", async ({ page }) => {
  await installDesktopDouble(page, { encoding: "Windows-1252" });
  await openProject(page);
  await expect(page.locator(".statusbar")).toContainText("Windows-1252");
});

test("a project's latexmkrc is used only after the user trusts it", async ({
  page,
}) => {
  await installDesktopDouble(page, { latexmkrc: true });
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  await page.evaluate(() => (window as any).testIPC.finish());
  const panel = page.getByRole("region", { name: "Build output" });
  await expect(panel).toContainText("build rules localTEX isn’t using yet");
  await panel.getByRole("button", { name: "Review in Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const trust = settings.getByRole("checkbox", {
    name: /Use this project’s latexmkrc/,
  });
  // It turns on only after the trust prompt is accepted.
  await trust.click();
  await expect
    .poll(async () => (await recorded(page)).configs.at(-1)?.latexmkrc)
    .toBe(true);
  await expect(trust).toBeChecked();
  expect((await recorded(page)).calls).toContain("plugin:dialog|message");
});

test("a template with a separate highlights file compiles main.tex", async ({
  page,
}) => {
  await installDesktopDouble(page, { roots: ["highlights.tex", "main.tex"] });
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  expect((await recorded(page)).builds[0].document).toBe("main.tex");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("when the main document is unclear, Compile asks once and remembers", async ({
  page,
}) => {
  await installDesktopDouble(page, { roots: ["paper.tex", "response.tex"] });
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  const chooser = page.getByRole("dialog", { name: "Choose the main document" });
  await expect(chooser).toContainText(
    String.raw`Several files in this project start with \documentclass`,
  );
  // The open file is offered first; choose the other one.
  await expect(chooser.getByRole("radio", { name: "paper.tex" })).toBeChecked();
  await chooser.getByRole("radio", { name: "response.tex" }).check();
  await chooser.getByRole("button", { name: "Compile" }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  const { builds, configs } = await recorded(page);
  expect(builds[0].document).toBe("response.tex");
  expect(configs.at(-1)?.root).toBe("response.tex");
  await expect(chooser).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Root document" }),
  ).toHaveValue("response.tex");
});
