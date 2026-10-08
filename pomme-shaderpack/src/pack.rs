//! OptiFine/Iris pack inputs. Source text is compiled by the driver, not
//! replaced by built-in approximations. Unknown settings and unsupported
//! resources fail.
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path};
use std::process::{Command, Stdio};

use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use sha2::{Digest, Sha256};

struct OptionRule {
    name: String,
    value: String,
    define: Regex,
    constant: Regex,
}

pub struct Pack {
    pub files: BTreeMap<String, Vec<u8>>,
    pub digest: String,
    pub options: BTreeMap<String, String>,
    pub properties: BTreeMap<String, String>,
    pub dimension: String,
    pub block_materials: BTreeMap<String, i32>,
    pub ignored_profile_options: Vec<String>,
    option_rules: Vec<OptionRule>,
}

fn normalized(path: &str) -> Result<String> {
    let mut parts = Vec::new();
    ensure!(!path.contains('\\'), "backslash in pack path {path}");
    for c in Path::new(path.trim_start_matches('/')).components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::CurDir => (),
            Component::ParentDir => {
                ensure!(parts.pop().is_some(), "pack path escapes root: {path}");
            }
            _ => bail!("invalid pack path {path}"),
        }
    }
    Ok(parts.join("/"))
}

impl Pack {
    pub fn load(
        path: &Path,
        dimension: &str,
        profile: Option<&str>,
        overrides: &[String],
    ) -> Result<Self> {
        let mut files = BTreeMap::new();
        if path.is_dir() {
            let root = if path.join("shaders").is_dir() {
                path.join("shaders")
            } else {
                path.to_path_buf()
            };
            fn visit(root: &Path, dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
                for entry in fs::read_dir(dir)? {
                    let e = entry?;
                    ensure!(!e.file_type()?.is_symlink(), "symlinks are not pack inputs");
                    if e.file_type()?.is_dir() {
                        visit(root, &e.path(), files)?;
                    } else {
                        ensure!(
                            e.metadata()?.len() <= 64 * 1024 * 1024,
                            "pack file too large"
                        );
                        files.insert(
                            e.path()
                                .strip_prefix(root)?
                                .to_string_lossy()
                                .replace('\\', "/"),
                            fs::read(e.path())?,
                        );
                    }
                }
                Ok(())
            }
            visit(&root, &root, &mut files)?;
        } else {
            let mut zip = zip::ZipArchive::new(fs::File::open(path)?)?;
            ensure!(zip.len() <= 16384, "too many pack entries");
            for i in 0..zip.len() {
                let mut e = zip.by_index(i)?;
                if e.is_dir() {
                    continue;
                }
                ensure!(e.size() <= 64 * 1024 * 1024, "pack entry too large");
                let name = normalized(e.name())?;
                let Some((_, name)) = name.split_once("shaders/") else {
                    continue;
                };
                let mut bytes = Vec::new();
                e.read_to_end(&mut bytes)?;
                ensure!(
                    files.insert(name.to_string(), bytes).is_none(),
                    "duplicate pack entry {name}"
                );
            }
        }
        ensure!(
            files.values().map(Vec::len).sum::<usize>() <= 256 * 1024 * 1024,
            "pack exceeds 256 MiB"
        );
        let mut hash = Sha256::new();
        for (name, bytes) in &files {
            hash.update((name.len() as u64).to_le_bytes());
            hash.update(name.as_bytes());
            hash.update((bytes.len() as u64).to_le_bytes());
            hash.update(bytes);
        }
        let digest = hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut pack = Self {
            files,
            digest,
            options: BTreeMap::new(),
            properties: BTreeMap::new(),
            dimension: dimension.to_owned(),
            block_materials: BTreeMap::new(),
            ignored_profile_options: Vec::new(),
            option_rules: Vec::new(),
        };
        let props = pack.text("shaders.properties").unwrap_or_default();
        let raw = parse_properties(&props);
        fn profile_options(
            name: &str,
            raw: &BTreeMap<String, String>,
            out: &mut BTreeMap<String, String>,
            stack: &mut Vec<String>,
        ) -> Result<()> {
            ensure!(!stack.iter().any(|s| s == name), "profile cycle {name}");
            stack.push(name.to_owned());
            let value = raw
                .get(&format!("profile.{name}"))
                .with_context(|| format!("unknown profile {name}"))?;
            for token in value.split_whitespace() {
                if let Some(parent) = token.strip_prefix("profile.") {
                    profile_options(parent, raw, out, stack)?;
                } else if let Some((key, value)) = token.split_once('=') {
                    out.insert(key.into(), value.into());
                } else if let Some(key) = token.strip_prefix('!') {
                    out.insert(key.into(), "false".into());
                } else {
                    out.insert(token.into(), "true".into());
                }
            }
            stack.pop();
            Ok(())
        }
        if let Some(p) = profile {
            profile_options(p, &raw, &mut pack.options, &mut Vec::new())?;
        }
        for item in overrides {
            let (k, v) = item.split_once('=').context("option must be NAME=VALUE")?;
            ensure!(
                v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)),
                "invalid option value"
            );
            pack.options.insert(k.into(), v.into());
        }
        pack.compile_option_rules()?;
        // Pack-defined option declarations may be in any include, not just
        // settings.glsl.
        let mut booleans = BTreeMap::new();
        let define = Regex::new(r"(?m)^\s*(?://\s*)?#\s*define\s+([A-Za-z_]\w*)([^\n]*)")?;
        let constant = Regex::new(r"(?m)^\s*const\s+(?:int|float|bool)\s+([A-Za-z_]\w*)\s*=")?;
        for (name, bytes) in &pack.files {
            if !name.ends_with(".glsl") {
                continue;
            }
            let s = String::from_utf8_lossy(bytes);
            for c in define.captures_iter(&s) {
                if !c[2].trim_start().starts_with('(') && !c[1].ends_with("INCLUDED") {
                    let line = pack.replace_options(&c[0]);
                    let option = define.captures(&line).unwrap();
                    let value = option[2].split("//").next().unwrap().trim();
                    if value.is_empty() {
                        let enabled = !line.trim_start().starts_with("//");
                        booleans.insert(option[1].to_owned(), enabled);
                    }
                }
            }
        }
        for key in pack.options.keys().cloned().collect::<Vec<_>>() {
            let declared = pack.files.values().any(|v| {
                let s = String::from_utf8_lossy(v);
                define.captures_iter(&s).any(|c| c[1] == key)
                    || constant.captures_iter(&s).any(|c| c[1] == key)
            });
            if !declared {
                ensure!(
                    !overrides
                        .iter()
                        .any(|item| item.split_once('=').is_some_and(|(k, _)| k == key)),
                    "unknown shader option {key}"
                );
                eprintln!("pack profile references undeclared option {key}; ignored");
                pack.ignored_profile_options.push(key.clone());
                pack.options.remove(&key);
            }
        }
        pack.compile_option_rules()?;
        let props = props
            .lines()
            .filter(|line| {
                let l = line.trim();
                !l.starts_with('#')
                    || ["#if", "#else", "#endif", "#define", "#undef"]
                        .iter()
                        .any(|p| l.starts_with(p))
            })
            .map(|line| {
                if line.contains(".enabled")
                    && let Some((key, value)) = line.split_once('=')
                    && let Some(enabled) = booleans.get(value.trim())
                {
                    return format!("{key} = {enabled}");
                }
                line.to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n");
        // Use the selected dimension's real include environment. Collecting
        // macros from unrelated programs would activate disabled features and
        // apply Nether/End aliases to Overworld custom uniforms.
        let prelude = pack
            .expand(
                &pack
                    .program_path("final", "vsh")
                    .context("missing final vertex program")?,
                &mut Vec::new(),
            )?
            .lines()
            .filter(|line| {
                !line.trim().starts_with("#version") && !line.trim().starts_with("#extension")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let property_source = format!(
            "{}\n{prelude}\nPOMME_PROPERTIES_BEGIN\n{props}",
            pack.environment()
        );
        let output = cpp(&property_source)?;
        let (_, output) = output
            .split_once("POMME_PROPERTIES_BEGIN")
            .context("preprocessor property marker missing")?;
        pack.properties = parse_properties(output);
        if let Ok(blocks) = pack.text("block.properties") {
            let blocks = blocks
                .lines()
                .filter(|line| {
                    let l = line.trim();
                    !l.starts_with('#')
                        || ["#if", "#else", "#endif", "#define", "#undef"]
                            .iter()
                            .any(|p| l.starts_with(p))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let source = format!(
                "{}\n{prelude}\nPOMME_BLOCKS_BEGIN\n{blocks}",
                pack.environment()
            );
            let output = cpp(&source)?;
            let (_, output) = output
                .split_once("POMME_BLOCKS_BEGIN")
                .context("block property marker missing")?;
            for (key, names) in parse_properties(output) {
                if let Some(id) = key.strip_prefix("block.") {
                    let id: i32 = id.parse()?;
                    for name in names.split_whitespace() {
                        // Exact names are sufficient for fixture blocks. State predicates,
                        // modded registries and tag expansion belong to the world adapter.
                        pack.block_materials
                            .insert(name.strip_prefix("minecraft:").unwrap_or(name).into(), id);
                    }
                }
            }
        }
        Ok(pack)
    }

    pub fn block_material_id(&self, name: &str) -> i32 {
        self.block_materials
            .get(name.strip_prefix("minecraft:").unwrap_or(name))
            .copied()
            .unwrap_or(0)
    }
    pub fn bytes(&self, name: &str) -> Result<&[u8]> {
        self.files
            .get(&normalized(name)?)
            .map(Vec::as_slice)
            .with_context(|| format!("missing pack input {name}"))
    }
    pub fn text(&self, name: &str) -> Result<String> {
        Ok(String::from_utf8(self.bytes(name)?.to_vec())?)
    }

    fn environment(&self) -> String {
        // Keep IS_IRIS absent until its optional CUSTOM_IMAGES contract is supported.
        "#define MC_VERSION 12111\n#define MC_GL_VERSION 430\n#define MC_GLSL_VERSION 430\n#define MC_HAND_DEPTH 0.125\n#define MC_RENDER_QUALITY 1.0\n#define MC_SHADOW_QUALITY 1.0\n#define MC_NORMAL_MAP\n#define MC_SPECULAR_MAP\n".into()
    }
    fn compile_option_rules(&mut self) -> Result<()> {
        self.option_rules = self
            .options
            .iter()
            .map(|(name, value)| {
                Ok(OptionRule {
                    name: name.clone(),
                    value: value.clone(),
                    define: Regex::new(&format!(
                        r"(?m)^([ \t]*)(?://[ \t]*)?#[ \t]*define[ \t]+{}(?:[ \t]+[^\n]*)?$",
                        regex::escape(name)
                    ))?,
                    constant: Regex::new(&format!(
                        r"(?m)(const\s+(?:int|float|bool)\s+{}\s*=\s*)[^;]+;",
                        regex::escape(name)
                    ))?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(())
    }
    fn replace_options(&self, source: &str) -> String {
        let mut result = source.to_owned();
        for rule in &self.option_rules {
            let name = &rule.name;
            let value = &rule.value;
            result = rule
                .define
                .replace_all(&result, |c: &regex::Captures| match value.as_str() {
                    "true" => format!("{}#define {name}", &c[1]),
                    "false" => format!("{}// #define {name}", &c[1]),
                    _ => format!("{}#define {name} {value}", &c[1]),
                })
                .into_owned();
            result = rule
                .constant
                .replace_all(&result, |c: &regex::Captures| format!("{}{value};", &c[1]))
                .into_owned();
        }
        result
    }
    fn expand(&self, name: &str, stack: &mut Vec<String>) -> Result<String> {
        let name = normalized(name)?;
        ensure!(
            stack.len() < 64 && !stack.contains(&name),
            "include cycle/depth at {name}"
        );
        stack.push(name.clone());
        let source = self.replace_options(&self.text(&name)?);
        let mut out = String::new();
        for line in source.lines() {
            if let Some(include) = line.trim().strip_prefix("#include") {
                let include = include.trim().trim_matches('"');
                let path = if include.starts_with('/') {
                    include.to_owned()
                } else {
                    format!(
                        "{}/{include}",
                        Path::new(&name).parent().unwrap_or(Path::new("")).display()
                    )
                };
                out.push_str(&self.expand(&path, stack)?);
            } else {
                out.push_str(line);
                out.push('\n');
            }
        }
        stack.pop();
        Ok(out)
    }
    pub fn source(&self, name: &str) -> Result<String> {
        let expanded = self.expand(name, &mut Vec::new())?;
        let mut version = None;
        let mut body = String::new();
        for line in expanded.lines() {
            if line.trim().starts_with("#version") {
                ensure!(version.is_none(), "multiple #version directives");
                version = Some(line.to_owned());
            } else {
                body.push_str(&line.replace("#extension", "POMME_EXTENSION"));
                body.push('\n');
            }
        }
        let preprocessed = cpp(&format!("{}\n{body}", self.environment()))?;
        Ok(format!(
            "{}\n{}",
            version.context("shader lacks #version")?,
            preprocessed.replace("POMME_EXTENSION", "#extension")
        ))
    }
    pub fn program_path(&self, name: &str, ext: &str) -> Option<String> {
        [
            format!("{}/{name}.{ext}", self.dimension),
            format!("{name}.{ext}"),
        ]
        .into_iter()
        .find(|n| self.files.contains_key(n))
    }
    pub fn enabled(&self, name: &str) -> Result<bool> {
        match self
            .properties
            .get(&format!("program.{}/{name}.enabled", self.dimension))
            .or_else(|| self.properties.get(&format!("program.{name}.enabled")))
        {
            None => Ok(true),
            Some(value) => match value.trim() {
                "true" | "1" => Ok(true),
                "false" | "0" => Ok(false),
                _ => bail!("unresolved program condition {name}: {value}"),
            },
        }
    }
}

pub fn parse_properties(source: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    let mut continued = String::new();
    for line in source.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with("//") || line.is_empty() {
            continue;
        }
        continued.push_str(line.trim_end_matches('\\'));
        if line.ends_with('\\') {
            continued.push(' ');
            continue;
        }
        if let Some((key, value)) = continued.split_once('=') {
            result.insert(key.trim().into(), value.trim().into());
        }
        continued.clear();
    }
    result
}
fn cpp(source: &str) -> Result<String> {
    let mut child = Command::new(std::env::var("POMME_CPP").unwrap_or_else(|_| "cpp".into()))
        .args(["-P", "-C", "-undef", "-nostdinc", "-x", "c", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("install cpp (C preprocessor) or set POMME_CPP")?;
    child.stdin.take().unwrap().write_all(source.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success(),
        "preprocessing failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boolean_option_preserves_next_line() {
        let mut pack = Pack {
            files: BTreeMap::new(),
            digest: String::new(),
            options: BTreeMap::from([("FOG".into(), "false".into())]),
            properties: BTreeMap::new(),
            dimension: "world0".into(),
            block_materials: BTreeMap::new(),
            ignored_profile_options: Vec::new(),
            option_rules: Vec::new(),
        };
        pack.compile_option_rules().unwrap();
        assert_eq!(
            pack.replace_options("#define FOG\n#define DENSITY 0.3\n"),
            "// #define FOG\n#define DENSITY 0.3\n"
        );
    }
    #[test]
    fn paths_and_continuations() {
        assert!(normalized("../../secret").is_err());
        assert_eq!(
            normalized("/lib/../settings.glsl").unwrap(),
            "settings.glsl"
        );
        assert_eq!(
            parse_properties("x = one \\\n two\n# ignored")["x"],
            "one  two"
        );
    }
}
