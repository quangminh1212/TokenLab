//! TokenLab binary entry point: delegates to `tokenlab::cli::run`.
//!
//! Uses a deliberately small tokio runtime (2 workers, tiny blocking pool) so
//! heavy scans are serialised instead of fanning out into hundreds of threads.

use std::time::Duration;

fn main() {
    // Bound rayon (backup) to 2 threads instead of one per core.
    let _ = rayon::ThreadPoolBuilder::new().num_threads(2).build_global();

    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .thread_keep_alive(Duration::from_secs(2))
        .thread_stack_size(1024 * 1024)
        .thread_name("tokenlab-rt")
        .on_thread_start(tokenlab::lower_current_thread_priority)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("failed to start runtime: {err}");
            std::process::exit(1);
        }
    };

    let args: Vec<String> = std::env::args().skip(1).collect();
    match rt.block_on(tokenlab::cli::run(args)) {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("{err:?}");
            std::process::exit(1);
        }
    }
}
