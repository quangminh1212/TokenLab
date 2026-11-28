//! Port of `src/util.ts`.
//!
//! Split into sub-modules to keep files small; everything is re-exported here
//! so callers use `crate::util::<name>` exactly like `import { x } from "./util.js"`.

pub mod cache;
pub mod date;
pub mod env;
pub mod fsx;
pub mod js;
pub mod jsonl;
pub mod model;
pub mod pathx;
pub mod scan_index;
pub mod period;
pub mod phase;
pub mod snapshot;
pub mod zstd;

pub use cache::*;
pub use date::*;
pub use env::*;
pub use fsx::*;
pub use js::*;
pub use jsonl::*;
pub use model::*;
pub use pathx::PathFlavor;
pub use period::*;
pub use phase::{phase, phase_init};
pub use zstd::*;
