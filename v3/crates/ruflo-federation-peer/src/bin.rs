//! `ruflo-federation-peer` binary entry point.
//!
//! Reads configuration from environment variables (the same set the
//! TypeScript federation plugin already understands) and runs the
//! peer until the transport closes.
//!
//! Without `--features native` the binary's runtime backend isn't
//! wired (it would dispatch through the trait surface to an
//! in-process noop). This is intentional: the binary builds and
//! tests in CI without the upstream Rust crate tree, and the
//! `native` feature is flipped on once the Cargo workspace is
//! locked against the published `midstreamer-quic` + `aimds-*`
//! versions per ADR-120 Step 1.

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!(
        "ruflo-federation-peer {} — ADR-120 Step 3.\n\
         Native QUIC + AIMDS backend is gated behind `--features native`.\n\
         Without it, the binary's trait surface is exported as a library only;\n\
         binary boots as a no-op so callers can probe `--version`/`--help` without\n\
         pulling in the optional upstream Rust deps.",
        env!("CARGO_PKG_VERSION"),
    );

    // Print the version + exit so the binary is useful for smoke
    // verification today. Once `--features native` is wired into the
    // ruflo CI workflow, this gets replaced by a real
    // `tokio::runtime::Runtime` driving `Peer::run`.
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("ruflo-federation-peer {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    ExitCode::SUCCESS
}
