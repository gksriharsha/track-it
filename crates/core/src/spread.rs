//! The five figures a period of logged days comes down to.
//!
//! Lifted out of `src/screens/Statistics.tsx`, where the same arithmetic had
//! been living in a local `summarise()`. It moved here because the Android
//! home-screen widget needs the middle day too, and a widget renders strings a
//! long way from any React code: computing a median in Kotlin would put a third
//! implementation of these five numbers in the tree, and the second one was
//! already one too many.
//!
//! What this module deliberately does NOT hold is any notion of a target, a
//! score or a percentage. A spread describes how a person actually ate; the
//! reference figure is printed beside it, named, by whoever is doing the
//! printing.

/// Below this many logged days a spread is not a spread — it is a handful of
/// points, and drawing a band through them would claim a pattern that is not
/// there yet.
///
/// The caller's job when [`summarise`] refuses is to say how many days are
/// missing, not to fall back to a mean over four days. Statistics.tsx has
/// printed that sentence since the redesign and the widget prints the same one.
pub const ENOUGH_FOR_SPREAD: usize = 5;

/// One measure over a period, as a distribution rather than a figure.
///
/// `days` travels with the numbers because every sentence written about them
/// needs it — "half your days fell between" is a claim about a sample size, and
/// a reader who cannot see the size cannot judge the claim.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spread {
    pub min: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub max: f64,
    pub days: usize,
}

/// Quartiles by the median-of-halves method, or `None` below
/// [`ENOUGH_FOR_SPREAD`].
///
/// Median-of-halves rather than a linear-interpolation quantile because the
/// samples here are small — a few weeks of logging — and interpolating between
/// two of nine days invents precision the data has not got. It is also the
/// method the screen has always used, and the two must agree to the last
/// decimal or the widget and the app would print different numbers for the same
/// thirty days.
///
/// `None` is a refusal, not an empty result. There is no variant of this
/// function that returns a median over four days.
///
/// Values that are not finite are dropped before anything is sorted. A NaN
/// makes `partial_cmp` return `None`, which would leave the slice in an
/// arbitrary order and silently move the median; and no measure this app
/// records can be NaN in the first place, so dropping is the honest answer
/// rather than a defensive one.
pub fn summarise(values: &[f64]) -> Option<Spread> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.len() < ENOUGH_FOR_SPREAD {
        return None;
    }
    // `total_cmp` rather than `partial_cmp` and an unwrap. The filter above has
    // already taken every non-finite value out, so the two agree on everything
    // that can still be in the slice — but `partial_cmp` returns an `Option`,
    // and this crate has no `unwrap` outside its tests for the reason a sort
    // comparator shows off perfectly: the panic would fire inside a read, on a
    // phone, in a release build that aborts rather than unwinds.
    v.sort_by(f64::total_cmp);

    let h = v.len() / 2;
    Some(Spread {
        min: v[0],
        max: v[v.len() - 1],
        median: mid(&v),
        q1: mid(&v[..h]),
        // An odd sample leaves the middle day out of BOTH halves. Including it
        // in the upper half would drag the third quartile toward the centre on
        // every odd-length period, which is a bias rather than a rounding.
        q3: mid(if v.len() % 2 == 1 { &v[h + 1..] } else { &v[h..] }),
        days: v.len(),
    })
}

/// The middle of an already-sorted slice, averaging the middle two when there
/// is no single middle. Never called on an empty slice: `summarise` has already
/// refused anything shorter than [`ENOUGH_FOR_SPREAD`], and both halves of a
/// slice that long are at least two elements.
fn mid(xs: &[f64]) -> f64 {
    let h = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[h]
    } else {
        (xs[h - 1] + xs[h]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spread_needs_five_days_before_it_is_one() {
        for n in 0..ENOUGH_FOR_SPREAD {
            let days: Vec<f64> = (0..n).map(|i| 1000.0 + i as f64).collect();
            assert!(
                summarise(&days).is_none(),
                "{n} days must refuse rather than describe a habit"
            );
        }
        assert!(summarise(&[1.0, 2.0, 3.0, 4.0, 5.0]).is_some());
    }

    #[test]
    fn quartiles_come_from_the_median_of_each_half() {
        // Nine days, so the middle day sits in neither half.
        let s = summarise(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]).unwrap();
        assert_eq!(s.median, 5.0);
        assert_eq!(s.q1, 2.5, "the median of 1..4");
        assert_eq!(s.q3, 7.5, "the median of 6..9");
        assert_eq!(s.min, 1.0);
        assert_eq!(s.max, 9.0);
        assert_eq!(s.days, 9);
    }

    #[test]
    fn an_even_sample_averages_the_middle_two() {
        let s = summarise(&[10.0, 20.0, 30.0, 40.0, 50.0, 60.0]).unwrap();
        assert_eq!(s.median, 35.0);
        assert_eq!(s.q1, 20.0, "the median of 10,20,30");
        assert_eq!(s.q3, 50.0, "the median of 40,50,60");
    }

    #[test]
    fn the_order_the_days_arrive_in_does_not_matter() {
        let sorted = summarise(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]).unwrap();
        let jumbled = summarise(&[5.0, 1.0, 7.0, 3.0, 2.0, 6.0, 4.0]).unwrap();
        assert_eq!(sorted, jumbled);
    }

    #[test]
    fn the_same_input_gives_the_same_five_figures_as_the_statistics_screen() {
        // Hard-coded on both sides on purpose. `summarise()` in
        // src/screens/Statistics.tsx still computes these numbers for the web
        // UI, so if either implementation is changed this test is where the two
        // stop agreeing — which is the only place a widget quoting a different
        // median from the screen it transcribes would ever be caught.
        let days = [
            1820.0, 2410.0, 1990.0, 2240.0, 1655.0, 2810.0, 2075.0, 1930.0, 2360.0, 2150.0,
        ];
        let s = summarise(&days).unwrap();
        assert_eq!(s.min, 1655.0);
        assert_eq!(s.q1, 1930.0);
        assert_eq!(s.median, 2112.5);
        assert_eq!(s.q3, 2360.0);
        assert_eq!(s.max, 2810.0);
        assert_eq!(s.days, 10);
    }

    #[test]
    fn a_value_that_is_not_a_number_is_dropped_rather_than_sorted() {
        // Five real days plus a NaN is five days, and the NaN must not become
        // the median by landing wherever an unstable comparison left it.
        let s = summarise(&[3.0, 1.0, f64::NAN, 5.0, 2.0, 4.0]).unwrap();
        assert_eq!(s.days, 5);
        assert_eq!(s.median, 3.0);
        assert!(summarise(&[1.0, 2.0, f64::INFINITY, 3.0, 4.0]).is_none());
    }
}
