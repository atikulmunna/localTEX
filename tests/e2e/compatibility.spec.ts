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

test("a PDF built despite an error is shown, with that error listed first", async ({
  page,
}) => {
  await installDesktopDouble(page);
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  await page.evaluate(() => {
    const ipc = (window as any).testIPC;
    // The first pass can't resolve citations yet; the second one does.
    ipc.output("Run number 1 of rule 'pdflatex'");
    ipc.output("LaTeX Warning: Citation `joy2024novel' on page 3 undefined on input line 196.");
    ipc.output("Run number 2 of rule 'pdflatex'");
    ipc.output(String.raw`Underfull \hbox (badness 10000) in paragraph at lines 187--188`);
    ipc.output("./.localtex/build/main.bbl:75: LaTeX Error: Unicode character ₂ (U+2082)");
    ipc.output("               not set up for use with LaTeX.");
    ipc.output("");
    ipc.output("l.75 ...biosensor with dual-layer au/tio₂");
    ipc.finish(true);
  });
  await expect(page.locator(".statusbar")).toContainText("PDF updated with 1 error");
  const panel = page.getByRole("region", { name: "Build output" });
  const issues = panel.locator(".issue");
  await expect(issues).toHaveCount(2);
  await expect(issues.first()).toContainText(
    "In the bibliography: LaTeX Error: Unicode character ₂ (U+2082) not set up for use with LaTeX.",
  );
  await expect(panel).not.toContainText("joy2024novel");
});

test("a document in draft mode explains its empty figures and fixes them in one click", async ({
  page,
}) => {
  await installDesktopDouble(page, {
    text: String.raw`\documentclass[journal, draft, twoside,web]{ieeecolor}` +
      "\n\\usepackage{graphicx}\n\\begin{document}\\includegraphics{fig.png}\\end{document}",
  });
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  const notice = page.locator(".pdf-notice");
  await page.locator(".compile-button").click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  // Only once there is a PDF to explain.
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => (window as any).testIPC.finish(true));
  await expect(notice).toContainText(
    "Figures show as empty boxes because this document uses the draft option.",
  );
  await notice.getByRole("button", { name: "Show figures" }).click();
  const editor = page.getByRole("textbox", { name: "LaTeX source editor" });
  await expect(editor).toContainText(String.raw`\documentclass[journal, final, twoside,web]{ieeecolor}`);
  // The fix compiles straight away, with the change saved first.
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(2);
  expect((await recorded(page)).builds[1].text).toContain("[journal, final, twoside,web]");
  // Ctrl+Z brings draft back, as with any edit.
  await editor.focus();
  await page.keyboard.press("Control+z");
  await expect(editor).toContainText("[journal, draft, twoside,web]");
});

test("the draft note can be dismissed for people who want draft mode", async ({ page }) => {
  await installDesktopDouble(page, {
    text: String.raw`\documentclass[draft]{article}` + "\n\\begin{document}Hi\\end{document}",
  });
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.locator(".compile-button").click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  await page.evaluate(() => (window as any).testIPC.finish(true));
  const notice = page.locator(".pdf-notice");
  await notice.getByRole("button", { name: "Keep draft mode" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "LaTeX source editor" })).toContainText(
    String.raw`\documentclass[draft]{article}`,
  );
});

test("previews compile quickly; export compiles once at full quality first", async ({
  page,
}) => {
  await installDesktopDouble(page);
  await openProject(page);
  await page.getByRole("button", { name: "Auto compile" }).click();
  await page.getByRole("button", { name: /^Compile/ }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(1);
  expect((await recorded(page)).builds[0].finalQuality).toBe(false);
  await page.evaluate(() => (window as any).testIPC.finish(true));
  await expect(page.locator(".statusbar")).toContainText("PDF is up to date");
  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect.poll(async () => (await recorded(page)).builds.length).toBe(2);
  expect((await recorded(page)).builds[1].finalQuality).toBe(true);
  // Nothing is written until that build has produced its PDF.
  const exports = async () =>
    (await recorded(page)).fileOps.filter((op) => op.command === "export_pdf");
  expect(await exports()).toHaveLength(0);
  await page.evaluate(() => (window as any).testIPC.finish(true));
  await expect.poll(async () => (await exports())[0]?.destination).toBe(
    "C:/Exports/paper.pdf",
  );
});
