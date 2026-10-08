// SPDX-License-Identifier: LGPL-3.0-only
//! Geometry-stage fallbacks adapted from Iris ProgramId.java (LGPL-3.0-only).
//! Copyright the Iris contributors. Source
//! bff1e69cb6c5519d8745784aa9c8b92984de67e7. See third_party/iris/NOTICE and
//! LICENSE. No Iris parser dependencies are used.
use anyhow::Result;

use crate::pack::Pack;

pub const FALLBACKS: &[(&str, Option<&str>)] = &[
    ("shadow", None),
    ("shadow_solid", Some("shadow")),
    ("shadow_cutout", Some("shadow")),
    ("shadow_water", Some("shadow")),
    ("shadow_entities", Some("shadow")),
    ("shadow_lightning", Some("shadow_entities")),
    ("shadow_block", Some("shadow")),
    ("gbuffers_basic", None),
    ("gbuffers_line", Some("gbuffers_basic")),
    ("gbuffers_textured", Some("gbuffers_basic")),
    ("gbuffers_textured_lit", Some("gbuffers_textured")),
    ("gbuffers_skybasic", Some("gbuffers_basic")),
    ("gbuffers_skytextured", Some("gbuffers_textured")),
    ("gbuffers_clouds", Some("gbuffers_textured")),
    ("gbuffers_terrain", Some("gbuffers_textured_lit")),
    ("gbuffers_terrain_solid", Some("gbuffers_terrain")),
    ("gbuffers_terrain_cutout", Some("gbuffers_terrain")),
    ("gbuffers_damagedblock", Some("gbuffers_terrain")),
    ("gbuffers_block", Some("gbuffers_terrain")),
    ("gbuffers_block_translucent", Some("gbuffers_block")),
    ("gbuffers_beaconbeam", Some("gbuffers_textured")),
    ("gbuffers_item", Some("gbuffers_textured_lit")),
    ("gbuffers_entities", Some("gbuffers_textured_lit")),
    ("gbuffers_entities_translucent", Some("gbuffers_entities")),
    ("gbuffers_lightning", Some("gbuffers_entities")),
    ("gbuffers_particles", Some("gbuffers_textured_lit")),
    ("gbuffers_particles_translucent", Some("gbuffers_particles")),
    ("gbuffers_entities_glowing", Some("gbuffers_entities")),
    ("gbuffers_armor_glint", Some("gbuffers_textured")),
    ("gbuffers_spidereyes", Some("gbuffers_textured")),
    ("gbuffers_hand", Some("gbuffers_textured_lit")),
    ("gbuffers_weather", Some("gbuffers_textured_lit")),
    ("gbuffers_water", Some("gbuffers_terrain")),
    ("gbuffers_hand_water", Some("gbuffers_hand")),
    ("dh_terrain", None),
    ("dh_water", Some("dh_terrain")),
    ("dh_generic", Some("dh_terrain")),
    ("dh_shadow", None),
    ("final", None),
];
pub fn parent(name: &str) -> Option<&'static str> {
    FALLBACKS
        .iter()
        .find(|(n, _)| *n == name)
        .and_then(|(_, p)| *p)
}
pub fn resolve(pack: &Pack, requested: &str) -> Result<Option<String>> {
    let mut current = Some(requested);
    while let Some(name) = current {
        if pack.enabled(name)?
            && pack.program_path(name, "vsh").is_some()
            && pack.program_path(name, "fsh").is_some()
        {
            return Ok(Some(name.into()));
        }
        current = parent(name);
    }
    Ok(None)
}
pub fn is_shadow(name: &str) -> bool {
    name == "shadow" || name.starts_with("shadow_")
}
pub fn is_actor(name: &str) -> bool {
    matches!(
        name,
        "shadow_entities"
            | "shadow_block"
            | "gbuffers_entities"
            | "gbuffers_block"
            | "gbuffers_hand"
            | "gbuffers_entities_translucent"
            | "gbuffers_block_translucent"
            | "gbuffers_hand_water"
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iris_fallback_contract_preserves_distinct_roots_and_actor_chains() {
        assert_eq!(parent("gbuffers_entities"), Some("gbuffers_textured_lit"));
        assert_eq!(parent("gbuffers_block"), Some("gbuffers_terrain"));
        assert_eq!(parent("gbuffers_hand_water"), Some("gbuffers_hand"));
        assert_eq!(parent("shadow_lightning"), Some("shadow_entities"));
        assert_eq!(parent("shadow_block"), Some("shadow"));
        assert_eq!(parent("gbuffers_basic"), None);
        assert_eq!(parent("dh_shadow"), None);
        assert_eq!(parent("composite"), None);
        for (name, _) in FALLBACKS {
            let mut visited = std::collections::HashSet::new();
            let mut next = Some(*name);
            while let Some(n) = next {
                assert!(visited.insert(n));
                next = parent(n);
            }
        }
    }
}
