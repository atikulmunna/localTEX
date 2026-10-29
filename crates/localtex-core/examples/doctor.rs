use localtex_core::process;
fn main() {
    let directory = std::env::args().nth(1);
    let tools = process::check_tools(directory);
    for tool in &tools {
        println!(
            "{:<10} {}",
            tool.name,
            if tool.available {
                "ready"
            } else {
                "needs attention"
            }
        );
        if !tool.available {
            println!(
                "  {}",
                tool.detail
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .take(6)
                    .collect::<Vec<_>>()
                    .join("\n  ")
            );
        }
    }
    if !tools.iter().any(|t| t.name == "latexmk" && t.available) {
        std::process::exit(1);
    }
}
