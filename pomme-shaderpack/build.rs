use std::env;
use std::fs::File;
use std::path::Path;
use std::process::Command;

fn main() {
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    let revision = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    println!(
        "cargo:rustc-env=POMME_REVISION={revision}{}",
        if dirty { "+dirty" } else { "" }
    );
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=build.rs");
    if let Some(path) = git(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={path}");
    }
    if let Some(branch) = git(&["symbolic-ref", "HEAD"])
        && let Some(path) = git(&["rev-parse", "--git-path", &branch])
    {
        println!("cargo:rerun-if-changed={path}");
    }
    let dest = env::var("OUT_DIR").unwrap();
    let mut file = File::create(Path::new(&dest).join("gl.rs")).unwrap();
    gl_generator::Registry::new(
        gl_generator::Api::Gl,
        (4, 3),
        gl_generator::Profile::Compatibility,
        gl_generator::Fallbacks::All,
        [],
    )
    .write_bindings(gl_generator::StructGenerator, &mut file)
    .unwrap();
}
