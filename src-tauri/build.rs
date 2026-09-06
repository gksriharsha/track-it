fn main() {
    // `tauri dev` runs the bare binary out of target/debug — it never builds the
    // .app bundle that `bundle.macOS.infoPlist` is merged into. macOS grants
    // camera access on the strength of NSCameraUsageDescription in the running
    // process's Info.plist, so without this the camera silently never opens in
    // development, which is the exact failure this feature exists to remove.
    //
    // Linking the plist into the binary's own __TEXT,__info_plist section is how
    // an unbundled Mach-O carries one. The bundled build is unaffected: the
    // bundler still merges the same file, and the two agree because they are the
    // same file.
    #[cfg(target_os = "macos")]
    {
        let plist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Info.plist");
        println!("cargo:rerun-if-changed=Info.plist");
        println!(
            "cargo:rustc-link-arg-bins=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            plist.display()
        );
    }

    tauri_build::build()
}
