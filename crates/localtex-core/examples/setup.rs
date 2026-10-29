//! Runs the first-launch LaTeX setup from a terminal, printing its progress.
//! Usage: cargo run --example setup [-- <LaTeX bin folder>]
use localtex_core::setup::{self, Event};
use std::sync::atomic::AtomicBool;

fn main() {
    let directory = std::env::args().nth(1);
    let started = std::time::Instant::now();
    let result = setup::run(
        &directory,
        &AtomicBool::new(false),
        &mut |event| match event {
            Event::Step { step, state, text } => println!("[{step:?}] {state:?}: {text}"),
            Event::Progress {
                step,
                done,
                total,
                text,
            } => println!("[{step:?}] {done}/{total} {text}"),
            Event::Line { .. } => {}
        },
    );
    let seconds = started.elapsed().as_secs_f32();
    match result {
        Ok(outcome) => println!(
            "Ready in {seconds:.1}s: {} (installed: {:?})",
            outcome.distribution, outcome.installed
        ),
        Err(failure) => {
            println!(
                "Failed after {seconds:.1}s at {:?} ({:?}): {}",
                failure.step, failure.problem, failure.text
            );
            std::process::exit(1);
        }
    }
}
