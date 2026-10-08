//! Opt-in, bounded diagnostics whose readiness follows actual GPU submission.
use serde_json::Value;

struct Pending {
    value: Value,
    submitted: bool,
}
pub(super) struct Capture {
    limit: usize,
    submissions: usize,
    pending: Vec<Option<Pending>>,
    pub samples: Vec<Value>,
    pub reloads: Vec<Value>,
    pub saved: bool,
}
impl Capture {
    pub fn new(limit: Option<u32>, slots: usize) -> Self {
        Self {
            limit: limit.unwrap_or(0) as usize,
            submissions: 0,
            pending: (0..slots).map(|_| None).collect(),
            samples: Vec::new(),
            reloads: Vec::new(),
            saved: limit.is_none(),
        }
    }
    pub fn active(&self) -> bool {
        !self.saved && self.submissions < self.limit
    }
    pub fn prepare(&mut self, slot: usize, build: impl FnOnce() -> Value) {
        self.cancel(slot);
        if self.active() {
            self.pending[slot] = Some(Pending {
                value: build(),
                submitted: false,
            });
        }
    }
    pub fn submitted(&mut self, slot: usize) {
        if let Some(pending) = &mut self.pending[slot]
            && !pending.submitted
        {
            pending.submitted = true;
            self.submissions += 1;
        }
    }
    pub fn cancel(&mut self, slot: usize) {
        if self.pending[slot].as_ref().is_some_and(|p| !p.submitted) {
            self.pending[slot] = None;
        }
    }
    /// Called only after this slot's frame fence (or the whole device)
    /// completed. Prepared, unsubmitted samples never cause a query read or
    /// WAIT.
    pub fn completed(&mut self, slot: usize) -> Option<Value> {
        self.pending[slot]
            .take()
            .filter(|p| p.submitted)
            .map(|p| p.value)
    }
    pub fn sample_mut(&mut self, slot: usize) -> Option<&mut Value> {
        self.pending[slot].as_mut().map(|p| &mut p.value)
    }
    pub fn collect(&mut self, sample: Value) {
        if !self.saved && self.samples.len() < self.limit {
            self.samples.push(sample);
        }
    }
    pub fn reload(&mut self, build: impl FnOnce() -> Value) {
        if self.active() && self.reloads.len() < self.limit {
            self.reloads.push(build());
        }
    }
    pub fn ready(&self) -> bool {
        !self.saved && self.limit > 0 && self.samples.len() == self.limit
    }
    /// Called after both capture files were successfully written. Release data.
    pub fn finish(&mut self) {
        self.saved = true;
        self.samples = Vec::new();
        self.reloads = Vec::new();
        for slot in &mut self.pending {
            *slot = None;
        }
    }
    pub fn slots(&self) -> usize {
        self.pending.len()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_gameplay_retains_nothing_for_one_million_frames() {
        let mut capture = Capture::new(None, 2);
        for frame in 0..1_000_000 {
            let slot = frame % 2;
            assert!(capture.completed(slot).is_none());
            capture.prepare(slot, || {
                panic!("default gameplay must not construct JSON samples")
            });
            capture.reload(|| panic!("default gameplay must not retain reload JSON"));
            capture.submitted(slot);
            assert_eq!(capture.samples.len(), 0);
            assert_eq!(capture.samples.capacity(), 0);
            assert_eq!(capture.reloads.capacity(), 0);
            assert!(capture.pending.iter().all(Option::is_none));
        }
    }
    #[test]
    fn opt_in_capture_stops_at_bound_and_releases_data_after_successful_write() {
        let mut capture = Capture::new(Some(120), 2);
        for frame in 0..1000 {
            let slot = frame % 2;
            if let Some(sample) = capture.completed(slot) {
                capture.collect(sample);
            }
            if capture.ready() {
                assert_eq!(capture.samples.len(), 120);
                capture.finish();
            }
            capture.prepare(slot, || serde_json::json!({"frame":frame}));
            capture.submitted(slot);
            assert!(
                capture.samples.len()
                    + capture
                        .pending
                        .iter()
                        .flatten()
                        .filter(|p| p.submitted)
                        .count()
                    <= 120
            );
        }
        assert!(capture.saved);
        assert_eq!(capture.submissions, 120);
        assert_eq!(capture.samples.capacity(), 0);
        assert!(capture.pending.iter().all(Option::is_none));
    }
    #[test]
    fn out_of_date_before_first_submit_never_makes_queries_ready() {
        let mut capture = Capture::new(Some(3), 2);
        capture.prepare(0, || serde_json::json!({"frame":0}));
        capture.cancel(0); // acquire_next_image returned OUT_OF_DATE; no recording/submission.
        assert!(capture.completed(0).is_none());
        assert_eq!(capture.submissions, 0);
        capture.prepare(0, || serde_json::json!({"frame":1}));
        assert!(capture.completed(0).is_none()); // even a forgotten cancellation cannot read queries.
        assert!(!capture.ready());
    }
    #[test]
    fn resize_reload_drains_only_submitted_fence_completed_samples() {
        let mut capture = Capture::new(Some(3), 2);
        capture.prepare(0, || serde_json::json!({"frame":0}));
        capture.submitted(0);
        capture.prepare(1, || serde_json::json!({"frame":1}));
        // A reload waits for device idle, then inspects both slots. The second
        // engine's prepared-but-unsubmitted frame has never written queries.
        for slot in 0..capture.slots() {
            if let Some(sample) = capture.completed(slot) {
                capture.collect(sample);
            }
        }
        assert_eq!(capture.samples.len(), 1);
        assert_eq!(capture.samples[0]["frame"], 0);
        capture.prepare(1, || serde_json::json!({"frame":2}));
        capture.submitted(1);
        capture.submitted(1); // readiness is idempotent.
        let sample = capture.completed(1).unwrap();
        capture.collect(sample);
        assert_eq!(capture.samples.len(), 2);
        assert_eq!(capture.submissions, 2);
    }
}
