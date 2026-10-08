use std::io::Write;
use std::path::{Path, PathBuf};

use pomme_shaderpack::pack::Pack;
use pomme_shaderpack::scene::Scene;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("pomme-pack-test-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(path.join("shaders/lib")).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, source: &str) {
        std::fs::write(self.0.join("shaders").join(name), source).unwrap();
    }
    fn populate(&self) {
        self.write(
            "lib/settings.glsl",
            "#define TONE 0.2 // [0.2 0.8]\n#define FOG\n",
        );
        self.write("final.vsh", "#version 330 compatibility\n#include \"/lib/settings.glsl\"\nvoid main(){gl_Position=vec4(gl_Vertex.xy*2.0-1.0,0.0,1.0);gl_TexCoord[0]=gl_MultiTexCoord0;}\n");
        self.write("final.fsh", "#version 330 compatibility\n#include \"/lib/settings.glsl\"\nuniform sampler2D colortex0;\nuniform int worldTime;\nvoid main(){gl_FragColor=vec4(texture2D(colortex0,gl_TexCoord[0].xy).rgb*0.1+vec3(TONE,0.0,float(worldTime)/24000.0),1.0);}\n");
        self.write(
            "gbuffers_terrain.vsh",
            "#version 330 compatibility\nvoid main(){gl_Position=ftransform();}\n",
        );
        self.write("gbuffers_terrain.fsh", "#version 330 compatibility\n/* RENDERTARGETS: 0 */\nvoid main(){gl_FragColor=vec4(0.0,1.0,0.0,1.0);}\n");
        self.write("shaders.properties", "profile.base = TONE=0.2 FOG\nprofile.changed = profile.base TONE=0.8 !FOG\n#if defined FOG\nprogram.deferred.enabled = true\n#else\nprogram.deferred.enabled = false\n#endif\n");
        self.write(
            "block.properties",
            "block.41 = water\nblock.72 = oak_leaves\nblock.73 = oak_leaves:persistent=true\n",
        );
    }
    fn zip(&self, output: &Path) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(output).unwrap());
        for name in [
            "lib/settings.glsl",
            "final.vsh",
            "final.fsh",
            "gbuffers_terrain.vsh",
            "gbuffers_terrain.fsh",
            "shaders.properties",
            "block.properties",
        ] {
            zip.start_file(
                format!("pack/shaders/{name}"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(&std::fs::read(self.0.join("shaders").join(name)).unwrap())
                .unwrap();
        }
        zip.finish().unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn directories_zips_profiles_and_materials_agree() {
    let f = Fixture::new();
    f.populate();
    let pack = Pack::load(&f.0, "world0", Some("changed"), &[]).unwrap();
    assert!(!pack.enabled("deferred").unwrap());
    assert!(pack.source("final.fsh").unwrap().contains("vec3(0.8"));
    assert_eq!(pack.block_material_id("minecraft:water"), 41);
    assert_eq!(
        pack.block_material_id("minecraft:oak_leaves[persistent=true,distance=7]"),
        73
    );
    assert_eq!(
        pack.block_material_id("minecraft:oak_leaves[persistent=false,distance=7]"),
        72
    );
    assert_eq!(
        pomme_shaderpack::pack::minecraft_version_code("26.2").unwrap(),
        260200
    );
    assert_eq!(
        pomme_shaderpack::pack::minecraft_version_code("1.21.11").unwrap(),
        12111
    );
    let scene = Scene::fixture("water");
    assert!(
        scene
            .mapped_vertices(&pack, true)
            .iter()
            .all(|v| v.material[0] == 41.0)
    );
    let path = f.0.join("pack.zip");
    f.zip(&path);
    let zipped = Pack::load(&path, "world0", Some("changed"), &[]).unwrap();
    assert_eq!(pack.digest, zipped.digest);
    assert_eq!(
        pack.source("final.fsh").unwrap(),
        zipped.source("final.fsh").unwrap()
    );
    assert!(Pack::load(&path, "world0", None, &["UNKNOWN=1".into()]).is_err());
    f.write("lib/settings.glsl", "#include \"/lib/settings.glsl\"\n");
    assert!(Pack::load(&f.0, "world0", None, &[]).is_err());
}
#[test]
#[ignore = "requires EGL desktop OpenGL 4.3 compatibility; run with --ignored on Mesa or hardware"]
fn driver_execution_changes_with_pack_settings_and_rejects_failed_reload() {
    use pomme_shaderpack::context::HeadlessContext;
    use pomme_shaderpack::runtime::{FrameInput, Runtime};
    let f = Fixture::new();
    f.populate();
    let context = HeadlessContext::new(32, 32).unwrap();
    let scene = Scene::fixture("terrain");
    let input = FrameInput::fixture(&scene, 0, 6000, 0.0);
    let pack = Pack::load(&f.0, "world0", Some("base"), &[]).unwrap();
    let mut first = Runtime::new(context.gl.clone(), pack, 32, 32, &scene, None).unwrap();
    first.render(&input).unwrap();
    first.screenshot(&f.0.join("first.png")).unwrap();
    let pack = Pack::load(&f.0, "world0", Some("changed"), &[]).unwrap();
    let mut second = Runtime::new(context.gl.clone(), pack, 32, 32, &scene, None).unwrap();
    second.render(&input).unwrap();
    second.screenshot(&f.0.join("second.png")).unwrap();
    let a = image::open(f.0.join("first.png")).unwrap().to_rgba8();
    let b = image::open(f.0.join("second.png")).unwrap().to_rgba8();
    assert!(b.get_pixel(0, 0)[0] > a.get_pixel(0, 0)[0] + 100);
    f.write(
        "final.fsh",
        "#version 330 compatibility\nthis is invalid GLSL\n",
    );
    let broken = Pack::load(&f.0, "world0", None, &[]).unwrap();
    assert!(Runtime::new(context.gl.clone(), broken, 32, 32, &scene, None).is_err());
    first.render(&input).unwrap();
    first.replace_geometry(&Scene::fixture("cave")).unwrap();
    first.render(&input).unwrap();
    assert!(first.invalidations >= 3);
}
