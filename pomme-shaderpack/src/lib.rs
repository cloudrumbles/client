pub mod compute;
pub mod context;
pub mod expression;
pub mod geometry;
pub mod live;
pub mod pack;
pub mod runtime;
pub mod scene;
pub mod stages;
pub mod viewer;
#[cfg(feature = "vulkan")]
pub mod vulkan;

#[allow(unsafe_op_in_unsafe_fn, clippy::all)]
pub mod gl {
    include!(concat!(env!("OUT_DIR"), "/gl.rs"));
}

/// Repository revision captured when the runtime was built.
pub const BUILD_REVISION: &str = env!("POMME_REVISION");
