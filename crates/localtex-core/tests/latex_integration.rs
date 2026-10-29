//! Explicitly opt in: these tests require a fully initialized TeX installation.
use localtex_core::{
    paths::tool_path,
    process::{apply_path, command, configure_latexmk, executable, output_timeout},
};
use std::{fs, time::Duration};

fn compile_fixture(engine: &str) {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("Research বাংলা with spaces");
    fs::create_dir_all(root.join(".localtex/build")).unwrap();
    fs::write(
        root.join("figure.tex"),
        r"\documentclass{article}
\pagestyle{empty}
\begin{document}\rule{2cm}{1cm}\end{document}",
    )
    .unwrap();
    fs::write(root.join("main.tex"),r"\documentclass{article}
\usepackage{graphicx}
\begin{document}
\section{Introduction}\label{sec:intro}
This is a multi-file research paper. See Figure~\ref{fig:test}.
\input{chapter}
\begin{figure}\includegraphics[width=2cm]{figure.pdf}\caption{A test image}\label{fig:test}\end{figure}
\bibliographystyle{plain}\bibliography{references}
\end{document}").unwrap();
    fs::write(
        root.join("chapter.tex"),
        r"A reference to Section~\ref{sec:intro} and a citation~\cite{knuth1984}.",
    )
    .unwrap();
    fs::write(root.join("references.bib"),r"@book{knuth1984,author={Donald E. Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}").unwrap();
    let directory = std::env::var("LOCALTEX_TOOL_DIRECTORY").ok();
    let figure = configure_latexmk(&directory, engine, &root, "figure.tex", None, false).unwrap();
    let (success, log) = output_timeout(figure, Duration::from_secs(90)).unwrap();
    assert!(success, "{engine}: {log}");
    let main = configure_latexmk(
        &directory,
        engine,
        &root,
        "main.tex",
        Some(".localtex/build"),
        false,
    )
    .unwrap();
    let (success, log) = output_timeout(main, Duration::from_secs(90)).unwrap();
    assert!(success, "{engine}: {log}");
    let output = root.join(".localtex/build");
    assert!(output.join("main.pdf").exists());
    assert!(output.join("main.synctex.gz").exists());
    let final_log = fs::read_to_string(output.join("main.log")).unwrap();
    assert!(
        !final_log.contains("There were undefined references"),
        "{final_log}"
    );
    assert!(
        !final_log.contains("Citation `knuth1984' on page 1 undefined"),
        "{final_log}"
    );
    let mut sync = command(executable(&directory, "synctex"));
    apply_path(&mut sync, &directory);
    sync.current_dir(tool_path(&root)).args([
        "view",
        "-i",
        &format!("5:0:{}", tool_path(&root.join("main.tex"))),
        "-o",
        &tool_path(&output.join("main.pdf")),
    ]);
    let (ok, result) = output_timeout(sync, Duration::from_secs(10)).unwrap();
    assert!(ok && result.contains("Page:"), "{result}");
    // A failed rebuild must be observable rather than treated as a fresh PDF.
    fs::write(root.join("chapter.tex"), r"\undefinedLocaltexCommand").unwrap();
    let broken = configure_latexmk(
        &directory,
        engine,
        &root,
        "main.tex",
        Some(".localtex/build"),
        false,
    )
    .unwrap();
    let (ok, result) = output_timeout(broken, Duration::from_secs(90)).unwrap();
    assert!(!ok, "The broken document unexpectedly built: {result}");
}
#[test]
#[ignore = "Requires configured pdfLaTeX, latexmk, BibTeX and SyncTeX"]
fn pdflatex_multifile_unicode_project() {
    compile_fixture("pdflatex");
}
#[test]
#[ignore = "Requires configured XeLaTeX, latexmk, BibTeX and SyncTeX"]
fn xelatex_multifile_unicode_project() {
    compile_fixture("xelatex");
}
#[test]
#[ignore = "Requires configured LuaLaTeX, latexmk, BibTeX and SyncTeX"]
fn lualatex_multifile_unicode_project() {
    compile_fixture("lualatex");
}
