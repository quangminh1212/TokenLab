//! TokenLab binary entry point: delegates to `tokenlab::cli::run`.

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match tokenlab::cli::run(args).await {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("{err:?}");
            std::process::exit(1);
        }
    }
}
