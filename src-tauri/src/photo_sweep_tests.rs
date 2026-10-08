//! Pack photos are working files: read, checked against while the editor is
//! open, and then gone. The start-up sweep takes whatever an unsaved editor or
//! an earlier build left behind.

use std::time::{Duration, SystemTime};

use crate::family_tests::user_db;
use crate::{store, sweep_photo_dir, PHOTO_GRACE};

const OLD: &str = "0123456789abcdef0123456789abcdef.jpg";
const NEW: &str = "fedcba9876543210fedcba9876543210.jpg";

fn food(label: Option<&str>) -> store::CustomFood {
    store::CustomFood {
        id: String::new(),
        name: "Granola bar".into(),
        brand: None,
        overrides_fdc_id: None,
        serving_g: 40.0,
        serving_ml: None,
        serving_pieces: None,
        piece_noun: None,
        serving_label: None,
        ingredients: None,
        barcode: None,
        photo_label: label.map(String::from),
        photo_ingredients: None,
        nutrients: vec![],
        import_only: false,
        dv_basis: "current".into(),
    }
}

#[test]
fn a_photo_a_day_old_is_deleted_and_its_name_forgotten_but_a_fresh_one_stays() {
    let dir = std::env::temp_dir().join(format!("trackit-sweep-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let now = SystemTime::now();
    for name in [OLD, NEW] {
        std::fs::write(dir.join(name), b"jpeg").unwrap();
    }
    // An earlier build's photo, kept since last week.
    std::fs::File::options()
        .write(true)
        .open(dir.join(OLD))
        .unwrap()
        .set_modified(now - PHOTO_GRACE - Duration::from_secs(60))
        .unwrap();
    // Not one of ours: never touched, however old.
    std::fs::write(dir.join("notes.txt"), b"keep").unwrap();

    let mut c = user_db();
    let kept_by_old_build = store::save_custom_food(&mut c, None, &food(Some(OLD))).unwrap();
    let mid_edit = store::save_custom_food(&mut c, None, &food(Some(NEW))).unwrap();

    sweep_photo_dir(&dir, &c, now).unwrap();

    assert!(!dir.join(OLD).exists(), "a day-old photo is deleted");
    assert!(dir.join(NEW).exists(), "a photo still within its grace stays");
    assert!(dir.join("notes.txt").exists());
    assert_eq!(store::get_custom_food(&c, &kept_by_old_build).unwrap().photo_label, None);
    assert_eq!(
        store::get_custom_food(&c, &mid_edit).unwrap().photo_label.as_deref(),
        Some(NEW)
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
