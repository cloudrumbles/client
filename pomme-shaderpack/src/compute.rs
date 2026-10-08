// SPDX-License-Identifier: GPL-3.0-or-later
//! Original Rust discovery/parser for the bounded, explicit-dispatch compute
//! ABI.
//!
//! Contracts checked against Iris bff1e69cb6c5519d8745784aa9c8b92984de67e7:
//! `shaderpack/programs/ProgramSet.java`,
//! `parsing/ComputeDirectiveParser.java`, `gl/program/ComputeProgram.java`, and
//! `pipeline/CompositeRenderer.java` in <https://github.com/IrisShaders/Iris>. Frame ordering was also checked against
//! Vitrail f42e5489c6abff655781b40bebc70338bada3039 `ProgramNames.java` and
//! `EngineStages.java` in <https://github.com/avpbynf/vitrail-shaders>.
//! No Java implementation or shader source is copied into this module.
//!
//! Associated computes run BEFORE their fragment program. Setup runs at pack
//! load and after target reallocation; the frame order is begin, shadow and
//! shadowcomp, prepare, opaque world/deferred, translucent world/composite.
//! This module orders compute names; the engine supplies those execution cuts.
//! Omitted local-size axes default to one, per GLSL 4.60 section 4.4.1:
//! <https://registry.khronos.org/OpenGL/specs/gl/GLSLangSpec.4.60.pdf>.

use std::collections::BTreeSet;

use anyhow::{Context, Result, bail, ensure};
use regex::Regex;

use crate::pack::Pack;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dispatch {
    /// Exact group count, independent of render extent. Zero remains zero.
    Fixed([u32; 3]),
}

#[derive(Debug)]
pub struct ComputeSource {
    pub name: String,
    /// Corresponding fragment-phase name; `deferred4_a` belongs to `deferred4`.
    pub base: String,
    /// Actual pack source after include expansion, options and preprocessing.
    pub source: String,
    pub dispatch: Dispatch,
    pub local_size: [u32; 3],
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ProgramName {
    family: u8,
    slot: u8,
    suffix: u8,
    base: String,
}

const FAMILIES: [&str; 6] = [
    "setup",
    "begin",
    "shadowcomp",
    "prepare",
    "deferred",
    "composite",
];

fn program_name(name: &str) -> Result<ProgramName> {
    let (base, suffix) = match name.split_once('_') {
        Some((base, suffix)) => {
            ensure!(
                suffix.len() == 1 && suffix.as_bytes()[0].is_ascii_lowercase(),
                "unsupported compute suffix: {name}"
            );
            (base, suffix.as_bytes()[0] - b'a' + 1)
        }
        None => (name, 0),
    };
    for (family, prefix) in FAMILIES.iter().enumerate() {
        if let Some(number) = base.strip_prefix(prefix) {
            let slot = if number.is_empty() {
                0
            } else {
                ensure!(
                    number.as_bytes().iter().all(u8::is_ascii_digit) && !number.starts_with('0'),
                    "unsupported compute slot: {name}"
                );
                let slot: u8 = number
                    .parse()
                    .with_context(|| format!("compute slot outside 1..99: {name}"))?;
                ensure!(slot <= 99, "compute slot outside 1..99: {name}");
                slot
            };
            ensure!(
                family != 0 || suffix == 0,
                "setup compute suffixes are unsupported: {name}; Iris setup uses numeric slots"
            );
            return Ok(ProgramName {
                family: family as u8,
                slot,
                suffix,
                base: base.to_owned(),
            });
        }
    }
    bail!(
        "unsupported active compute family: {name}; supported families: {}",
        FAMILIES.join(", ")
    )
}

/// Resolve every active top-level/current-dimension compute entry point.
/// Include-library `.csh` files and other dimensions are not entry points.
/// Unsupported active names/dispatches are errors, never silently omitted.
pub fn discover(pack: &Pack) -> Result<Vec<ComputeSource>> {
    let mut names = BTreeSet::new();
    let dimension_prefix = format!("{}/", pack.dimension);
    for path in pack.files.keys() {
        let relative = path.strip_prefix(&dimension_prefix).unwrap_or(path);
        if !relative.contains('/')
            && let Some(name) = relative.strip_suffix(".csh")
        {
            names.insert(name.to_owned());
        }
    }
    let mut programs = Vec::new();
    for name in names {
        if !pack.enabled(&name)? {
            continue;
        }
        let parsed = program_name(&name)?;
        // Iris reads bare then _a.._z and stops at the first missing/disabled
        // letter. Reject a later active suffix instead of dispatching it at an
        // invented position, or silently losing a pack program.
        for preceding in 1..parsed.suffix {
            let previous = format!("{}_{}", parsed.base, char::from(b'a' + preceding - 1));
            ensure!(
                pack.enabled(&previous)? && pack.program_path(&previous, "csh").is_some(),
                "active compute {name} follows missing/disabled suffix {previous}; Iris stops at that gap"
            );
        }
        ensure!(
            !pack.properties.contains_key(&format!("indirect.{name}"))
                && !pack
                    .properties
                    .contains_key(&format!("indirect.{}/{name}", pack.dimension)),
            "indirect compute dispatch is unsupported: {name}"
        );
        let path = pack
            .program_path(&name, "csh")
            .with_context(|| format!("compute source disappeared: {name}"))?;
        let source = pack
            .source(&path)
            .with_context(|| format!("preprocessing compute {name}"))?;
        let (dispatch, local_size) =
            parse_dispatch(&source).with_context(|| format!("compute {name} ({path})"))?;
        programs.push((
            parsed,
            ComputeSource {
                name,
                base: String::new(),
                source,
                dispatch,
                local_size,
            },
        ));
    }
    programs.sort_by(|(a, _), (b, _)| a.cmp(b));
    Ok(programs
        .into_iter()
        .map(|(name, mut source)| {
            source.base = name.base;
            source
        })
        .collect())
}

fn integer(value: &str, allow_zero: bool, unsigned_suffix: bool) -> Result<u32> {
    let value = value.trim();
    let literal = if unsigned_suffix {
        value.strip_suffix(['u', 'U']).unwrap_or(value)
    } else {
        value
    };
    let digits = literal.strip_prefix(['+', '-']).unwrap_or(literal);
    ensure!(
        !digits.is_empty() && digits.as_bytes().iter().all(u8::is_ascii_digit),
        "unsupported integer expression {value:?}; expected a preprocessed decimal literal"
    );
    ensure!(
        digits.len() == 1 || !digits.starts_with('0'),
        "octal/leading-zero integer literals are unsupported: {value}"
    );
    let number: i64 = literal
        .parse()
        .with_context(|| format!("integer outside supported range: {value}"))?;
    let maximum = if unsigned_suffix {
        u32::MAX as i64
    } else {
        i32::MAX as i64
    };
    ensure!(
        number >= i64::from(!allow_zero) && number <= maximum,
        "integer outside supported range: {value}"
    );
    Ok(number as u32)
}

fn parse_dispatch(source: &str) -> Result<(Dispatch, [u32; 3])> {
    let source = without_comments(source)?;
    ensure!(
        !Regex::new(r"\bworkGroupsRender\b")?.is_match(&source),
        "relative workGroupsRender dispatch is unsupported; explicit workGroups is required"
    );
    let work = Regex::new(r"(?s)\bconst\s+ivec3\s+workGroups\s*=\s*ivec3\s*\(([^;]*?)\)\s*;")?;
    let declarations = work.captures_iter(&source).collect::<Vec<_>>();
    ensure!(
        declarations.len() == 1,
        "expected exactly one explicit const ivec3 workGroups = ivec3(x,y,z); screen-sized/default or other dispatch forms are unsupported"
    );
    let args = declarations[0][1].split(',').collect::<Vec<_>>();
    ensure!(
        args.len() == 3,
        "workGroups requires three decimal components"
    );
    let dispatch = Dispatch::Fixed([
        integer(args[0], true, false)?,
        integer(args[1], true, false)?,
        integer(args[2], true, false)?,
    ]);
    let qualifiers = Regex::new(r"(?s)\blayout\s*\(([^;]*?)\)\s*in\s*;")?;
    let local_identifier = Regex::new(r"\blocal_size_[A-Za-z_]+\b")?;
    let mut local_size = None;
    let mut recognized = 0;
    for layout in qualifiers.captures_iter(&source) {
        if !local_identifier.is_match(&layout[1]) {
            continue;
        }
        let mut sizes = [1; 3];
        let mut axes = [false; 3];
        for field in layout[1].split(',') {
            let (key, value) = field
                .split_once('=')
                .context("unsupported variable/specialized local workgroup size")?;
            let axis = match key.trim() {
                "local_size_x" => 0,
                "local_size_y" => 1,
                "local_size_z" => 2,
                _ => bail!("unsupported compute input qualifier: {}", key.trim()),
            };
            ensure!(!axes[axis], "duplicate local-size axis in a declaration");
            axes[axis] = true;
            recognized += 1;
            sizes[axis] = integer(value, false, true)?;
        }
        ensure!(
            local_size.is_none_or(|previous| previous == sizes),
            "conflicting local workgroup-size declarations"
        );
        local_size = Some(sizes);
    }
    ensure!(
        local_identifier.find_iter(&source).count() == recognized,
        "local size is outside a supported static input layout; specialization/variable sizes are unsupported"
    );
    Ok((
        dispatch,
        local_size.context("compute requires a static local workgroup-size input layout")?,
    ))
}

/// Comments are whitespace in GLSL. Preserve separators/newlines so commented
/// fake directives cannot influence the CPU dispatch while the shader ignores
/// them, and adjacent tokens are never joined by stripping a comment.
fn without_comments(source: &str) -> Result<String> {
    let bytes = source.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && bytes[index] != b'\n' {
                result.push(b' ');
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            result.extend_from_slice(b"  ");
            index += 2;
            while index < bytes.len() && !bytes[index..].starts_with(b"*/") {
                result.push(if bytes[index] == b'\n' { b'\n' } else { b' ' });
                index += 1;
            }
            ensure!(index < bytes.len(), "unterminated compute shader comment");
            result.extend_from_slice(b"  ");
            index += 2;
        } else {
            result.push(bytes[index]);
            index += 1;
        }
    }
    Ok(String::from_utf8(result)?)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    const FIXED: &str = "#version 430\nlayout(local_size_x=256) in;\nconst ivec3 workGroups=ivec3(1,1,1);\nvoid main() {}\n";

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(files: &[(&str, &str)]) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "pomme-compute-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("final.vsh"), "#version 430\nvoid main() {}\n").unwrap();
            for (name, source) in files {
                let path = root.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, source).unwrap();
            }
            Self(root)
        }
        fn load(&self) -> Pack {
            Pack::load(&self.0, "world0", None, &[]).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fixed_groups_and_real_local_axes_are_independent() {
        assert_eq!(
            parse_dispatch(FIXED).unwrap(),
            (Dispatch::Fixed([1, 1, 1]), [256, 1, 1])
        );
        assert_eq!(parse_dispatch("layout(local_size_y=4u,local_size_z=2,local_size_x=8) in; const ivec3 workGroups=ivec3(0,+3,1);").unwrap(), (Dispatch::Fixed([0, 3, 1]), [8, 4, 2]));
        assert_eq!(
            parse_dispatch("layout(local_size_y=2) in; const ivec3 workGroups=ivec3(1,1,1);")
                .unwrap()
                .1,
            [1, 2, 1]
        );
        assert_eq!(
            parse_dispatch(&format!("{FIXED}\nlayout(local_size_x=256) in;"))
                .unwrap()
                .1,
            [256, 1, 1]
        );
    }

    #[test]
    fn comments_cannot_change_dispatch_or_join_tokens() {
        let source = format!(
            "// const ivec3 workGroups=ivec3(99,99,99);\n/* workGroupsRender; layout(local_size_x_id=3) in; */\n{FIXED}"
        );
        assert_eq!(
            parse_dispatch(&source).unwrap(),
            (Dispatch::Fixed([1; 3]), [256, 1, 1])
        );
        assert!(parse_dispatch(&FIXED.replace("const ivec3", "co/* split */nst ivec3")).is_err());
        assert!(parse_dispatch(&format!("{FIXED} /* unfinished")).is_err());
    }

    #[test]
    fn unsupported_dispatch_forms_error_instead_of_changing_group_count() {
        for groups in [
            "ivec3(8*2,1,1)",
            "ivec3(COUNT,1,1)",
            "ivec3(1)",
            "ivec3(-1,1,1)",
            "ivec3(2147483648,1,1)",
            "ivec3(1u,1,1)",
            "ivec3(0x10,1,1)",
            "ivec3(010,1,1)",
        ] {
            assert!(
                parse_dispatch(&FIXED.replace("ivec3(1,1,1)", groups)).is_err(),
                "{groups}"
            );
        }
        assert!(parse_dispatch("layout(local_size_x=8) in; void main() {}").is_err());
        assert!(
            parse_dispatch(&format!(
                "{FIXED} const vec2 workGroupsRender=vec2(1.0,1.0);"
            ))
            .is_err()
        );
        assert!(parse_dispatch(&format!("{FIXED} const ivec3 workGroups=ivec3(2,2,2);")).is_err());
    }

    #[test]
    fn unsupported_or_conflicting_local_sizes_error() {
        for local in [
            "local_size_x=0",
            "local_size_x=8*2",
            "local_size_x=COUNT",
            "local_size_x_id=2",
            "local_size_variable",
            "local_size_x=8,local_size_x=8",
            "local_size_x=4294967296",
            "local_size_x=010",
        ] {
            assert!(
                parse_dispatch(&FIXED.replace("local_size_x=256", local)).is_err(),
                "{local}"
            );
        }
        assert!(parse_dispatch(&FIXED.replace("layout(local_size_x=256) in;", "")).is_err());
        assert!(parse_dispatch(&format!("{FIXED} layout(local_size_x=128) in;")).is_err());
    }

    #[test]
    fn stage_numeric_and_full_letter_order_match_execution_contract() {
        let mut names = [
            "composite10",
            "deferred4_b",
            "prepare2",
            "begin",
            "setup99",
            "shadowcomp",
            "composite2",
            "deferred4",
            "setup",
            "deferred4_a",
            "deferred4_z",
        ]
        .map(|name| (program_name(name).unwrap(), name));
        names.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            names.map(|(_, name)| name),
            [
                "setup",
                "setup99",
                "begin",
                "shadowcomp",
                "prepare2",
                "deferred4",
                "deferred4_a",
                "deferred4_b",
                "deferred4_z",
                "composite2",
                "composite10"
            ]
        );
        assert_eq!(program_name("deferred4_a").unwrap().base, "deferred4");
        for name in [
            "setup_a",
            "deferred0",
            "deferred01",
            "begin100",
            "composite_a_b",
            "shadow",
            "final",
            "gbuffers_terrain",
            "composite_A",
        ] {
            assert!(program_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn selected_dimension_overrides_root_without_duplicate_or_library_dispatch() {
        let selected = FIXED.replace("ivec3(1,1,1)", "ivec3(3,2,1)");
        let fixture = Fixture::new(&[
            ("deferred4_a.csh", FIXED),
            ("world0/deferred4_a.csh", &selected),
            ("world1/begin.csh", "invalid"),
            ("program/library.csh", "invalid"),
        ]);
        let sources = discover(&fixture.load()).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "deferred4_a");
        assert_eq!(sources[0].base, "deferred4");
        assert_eq!(sources[0].dispatch, Dispatch::Fixed([3, 2, 1]));
        assert!(sources[0].source.contains("ivec3(3,2,1)"));
    }

    #[test]
    fn active_suffix_gap_and_unsupported_entrypoints_are_reported() {
        let gap = Fixture::new(&[("deferred4_c.csh", FIXED)]);
        assert!(
            discover(&gap.load())
                .unwrap_err()
                .to_string()
                .contains("deferred4_a")
        );
        let unsupported = Fixture::new(&[("final.csh", FIXED)]);
        assert!(
            discover(&unsupported.load())
                .unwrap_err()
                .to_string()
                .contains("unsupported active compute family")
        );
        let disabled = Fixture::new(&[
            ("final.csh", "invalid"),
            ("setup.csh", "invalid"),
            (
                "shaders.properties",
                "program.final.enabled=false\nprogram.setup.enabled=false\n",
            ),
        ]);
        assert!(discover(&disabled.load()).unwrap().is_empty());
    }

    #[test]
    fn active_indirect_property_is_never_replaced_with_fixed_dispatch() {
        let fixture = Fixture::new(&[
            ("begin.csh", FIXED),
            ("shaders.properties", "indirect.begin=0 16\n"),
        ]);
        assert!(
            discover(&fixture.load())
                .unwrap_err()
                .to_string()
                .contains("indirect")
        );
    }

    #[test]
    fn dispatch_is_read_after_real_include_and_branch_preprocessing() {
        let fixture = Fixture::new(&[
            (
                "begin.csh",
                "#version 430\n#include \"/include/sizing.glsl\"\nlayout(local_size_x=LOCAL) in;\n#if ENABLED\nconst ivec3 workGroups=ivec3(GROUPS,1,1);\n#else\nconst ivec3 workGroups=ivec3(9,9,9);\n#endif\nvoid main() {}\n",
            ),
            (
                "include/sizing.glsl",
                "#define LOCAL 32\n#define GROUPS 7\n#define ENABLED 1\n",
            ),
        ]);
        let sources = discover(&fixture.load()).unwrap();
        assert_eq!(sources[0].dispatch, Dispatch::Fixed([7, 1, 1]));
        assert_eq!(sources[0].local_size, [32, 1, 1]);
    }

    #[test]
    #[ignore = "requires an original pack directory; set POMME_COMPUTE_PACK"]
    fn original_pack_profile_discovers_preprocessed_dispatches() {
        let path =
            PathBuf::from(std::env::var("POMME_COMPUTE_PACK").expect("set POMME_COMPUTE_PACK"));
        let profile = std::env::var("POMME_COMPUTE_PROFILE").ok();
        let pack = Pack::load(&path, "world0", profile.as_deref(), &[]).unwrap();
        let sources = discover(&pack).unwrap();
        assert!(
            !sources.is_empty(),
            "selected test profile must enable at least one compute"
        );
        for source in sources {
            eprintln!(
                "{} base={} groups={:?} local={:?}",
                source.name, source.base, source.dispatch, source.local_size
            );
            assert!(source.local_size.into_iter().all(|n| n > 0));
        }
    }
}
