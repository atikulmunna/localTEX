# localTEX

A local LaTeX writing studio for Windows. Paper and graphite themes, a focused writing layout, and a source/PDF review workspace. Ordinary folders and `.tex` files remain the source of truth.

**Development status:** the frontend production build, browser UI/PDF tests, Rust core tests, and optimized Windows executable build pass locally. PDF.js is pinned to 6.2.108. Native GUI acceptance, real LaTeX compilation, and clean-machine installation still need the checks described in [VALIDATION.md](VALIDATION.md).

The current executable is `src-tauri/target/release/localtex.exe`. Open it directly from Windows Explorer to try the app; Node.js and Rust are not needed to run the compiled executable. WebView2 and a working TeX distribution are still required. The unsigned Windows installer was successfully built at `src-tauri/target/release/bundle/nsis/localTEX_0.1.0_x64-setup.exe` (about 5.23 MiB).

## Run the desktop app

Prerequisites:

- Windows 11 x64, Node.js 24, and Rust with the MSVC toolchain.
- Visual Studio C++ build tools with a Windows SDK.
- Microsoft Edge WebView2 (normally already available on Windows 11).
- For compilation: an initialized MiKTeX or TeX Live installation with `latexmk`, the selected engine, and SyncTeX. MiKTeX's `latexmk` also needs Perl; [Strawberry Perl](https://strawberryperl.com/) is one Windows option.

```powershell
npm ci
cargo fetch --manifest-path src-tauri/Cargo.toml
npm run desktop
```

Open **Settings → LaTeX setup**, choose an executable folder if the distribution is not on PATH, then use **Save & check tools** and **Test compilation**. A distribution being installed is not sufficient: finish MiKTeX Console's first-time setup and install the packages your project needs. Test compilation uses the selected project engine (pdfLaTeX by default).

**Common-package setup is enabled by default for MiKTeX.** Before the first compilation in an app session, localTEX checks installed packages and downloads missing members of its common bundle. Subsequent builds reuse that result. Settings → LaTeX setup → **Install / repair common packages** checks again; **Save & check tools** also prepares the bundle when enabled. Disable **Prepare common packages automatically** to manage packages yourself.

The bundle covers `geometry`, `amsmath`, `amsfonts` (including `amssymb`), `graphics` (including `graphicx`), `hyperref`, `xcolor`, `latex-tools`, `booktabs`, `caption` (including `subcaption`), `float`, `enumitem`, `microtype`, `siunitx`, TikZ (`pgf`), `pgfplots`, `listings`, `fancyhdr`, `titlesec`, `setspace`, `natbib`, `biblatex`, Biber for Windows x64, `fontspec`, `unicode-math`, Latin Modern, and CM-Super. First-time downloads need internet access; already-installed packages are kept. This is a common bundle, not the entire CTAN repository. TeX Live users manage packages with TeX Live Manager.

For a manual installation of just the starter templates' packages:

```powershell
miktex packages install geometry amsmath amsfonts graphics hyperref
```

If the Problems panel reports `geometry.sty not found`, run common-package setup and compile again with **Ctrl+Enter**. Package setup uses the [MiKTeX package commands](https://docs.miktex.org/manual/miktex-packages.html); the compiler itself still runs with its automatic installer disabled.

To inspect tool availability without the UI:

```powershell
cargo run --manifest-path crates/localtex-core/Cargo.toml --example doctor
```

An optional first argument specifies the TeX executable directory. Restart your terminal and the app after installing a distribution or Perl so their PATH changes become visible.

## Build a Windows installer

```powershell
npm run package
```

The NSIS installer is produced in `src-tauri/target/release/bundle/nsis/`. It installs per user and checks for WebView2. The first packaging run may download the NSIS tooling and WebView2 bootstrapper. Generated installers are **unsigned** unless a signing certificate is configured. Do not describe an unsigned development build as a verified public release.

To build just the application executable without downloading installer tooling:

```powershell
npm run tauri -- build --no-bundle
```

The app contains no TeX distribution. A fresh installation guides the user to install one separately. Uninstalling localTEX does not remove project folders. User settings and recovery drafts are stored in Tauri's application-data directory for `app.localtex.studio`.

## Work with a project

- Open an existing folder (including an extracted Overleaf project), or create an article/thesis from the welcome screen.
- **Ctrl+S** saves all changed files. Recovery drafts are written after a short idle period; they are not a substitute for saving. External changes reload clean buffers and require a choice for dirty buffers.
- **Ctrl+Enter** saves and compiles locally. **Ctrl+J** switches Write/Review. **Ctrl+K** opens commands. **Ctrl+B** toggles navigation.
- **Auto on**, enabled by default, saves and compiles after a 1.2-second pause in typing. Edits during a build queue one follow-up build using the latest source. Toggle **Auto** in the toolbar or Settings to use manual builds. Setup/save failures pause auto compilation; ordinary LaTeX errors remain visible while you fix the source. Browser preview does not compile.
- Select the root document when a folder has multiple candidates. `% !TeX root` and `% !TeX program` comments are supported; explicit project settings win.
- **Ctrl+Shift+L** jumps from source to PDF. Double-click the PDF to return to source. Synchronization is disabled when the preview is stale.
- Source diagnostics appear inline and in the Problems panel. Raw output is available when a compiler's error format cannot be parsed.
- Export saves a copy of the last successful PDF. A failed build retains that preview and labels it as a previous build.

Configuration lives in `.localtex/project.json`; build artifacts live in `.localtex/build/`. The internal `.gitignore` excludes build artifacts. Project configuration has version `1`, optional `root` and `engine`, and a `shellEscape` flag. Shell escape additionally requires local consent recorded in app data, so copying a project configuration cannot grant it on another machine.

`latexmk` runs with `-norc`: arbitrary `.latexmkrc` scripts are not loaded. Engine commands are restricted to pdfLaTeX, XeLaTeX, and LuaLaTeX. MiKTeX engine invocations disable automatic package installation; install missing packages explicitly through MiKTeX Console. The external TeX distribution remains responsible for its helper programs and configuration. Shell escape explicitly grants external-program execution.

V1 opens UTF-8 source files up to 8 MB, indexes up to 32 MB of project text, and lists up to 20,000 files. Source paths must stay within the project. File creation supports paths in existing directories. Rename does not rewrite `\input`, bibliography, or image references. Projects with custom build scripts or legacy source encodings may require adaptation.

## Tests

```powershell
npm test
cargo test --manifest-path crates/localtex-core/Cargo.toml
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npx playwright install chromium
npm run test:e2e
```

After initializing all three engines, run the opt-in native compiler tests:

```powershell
cargo test --manifest-path crates/localtex-core/Cargo.toml --test latex_integration -- --ignored --test-threads=1
```

Set `LOCALTEX_TOOL_DIRECTORY` if those tests should use a custom TeX binary folder. They compile multi-file papers with bibliography and images under a path containing spaces and Bangla characters, check SyncTeX, then verify a broken build fails. They intentionally fail if required engines or packages are unavailable.

`npm run dev` opens a browser preview with an explicitly labeled, browser-local sample project. It does not compile LaTeX or access project folders. Its UI tests do **not** replace native application and installer tests.

## Implementation map

- `src/`: React interface, CodeMirror editor, PDF.js viewer, typed Tauri bridge, and pure indexing/diagnostic logic.
- `crates/localtex-core/`: independently testable file safety, conflict-checked atomic writes, templates, compiler setup, and Windows process jobs.
- `src-tauri/`: desktop commands, file watching, build events, recovery persistence, and Windows packaging.

The UI and PDF workers/fonts are bundled locally. There are no accounts, analytics, AI requests, or remote compilation. Setup links open only on user action. Automatic updates and collaboration are outside this release.

Architecture references: [Tauri Windows packaging](https://v2.tauri.app/distribute/windows-installer/), [CodeMirror](https://codemirror.net/), [PDF.js](https://mozilla.github.io/pdf.js/), [latexmk](https://ctan.org/pkg/latexmk), [MiKTeX installer control](https://docs.miktex.org/manual/miktex-pdftex.html).
