//! Live integration hook for the production acquire/cancel/recreate path.
//! Compiled only with renderer-fault-injection, activated by a trace-file env
//! var.

use std::fs::File;
use std::io::Write;

#[derive(Clone, Copy)]
enum Phase {
    FirstPrepare,
    AwaitFirstRecreation,
    RecreatedBeforeSubmission,
    AwaitFirstSubmission,
    AwaitWindowResize([u32; 2]),
    ResizedAfterSubmission,
    Done,
}

pub(super) struct AcquireFault {
    trace: File,
    phase: Phase,
    submissions: u64,
    recreations: u64,
    events: usize,
}

impl AcquireFault {
    pub fn from_env() -> Option<Self> {
        let path = std::env::var_os("POMME_TEST_ACQUIRE_TRACE")?;
        Some(Self {
            trace: File::create(path).expect("create acquire integration trace"),
            phase: Phase::FirstPrepare,
            submissions: 0,
            recreations: 0,
            events: 0,
        })
    }

    fn event(&mut self, mut value: serde_json::Value) {
        // The integration driver requests a bounded capture, but even an
        // accidentally unbounded QA launch cannot retain an unbounded trace.
        if self.events == 512 {
            return;
        }
        self.events += 1;
        value["pack_submissions"] = self.submissions.into();
        value["recreations"] = self.recreations.into();
        serde_json::to_writer(&mut self.trace, &value).expect("write acquire integration event");
        writeln!(self.trace).expect("write acquire integration newline");
        self.trace.flush().expect("flush acquire integration trace");
    }

    /// Called after the real frame fence wait and successful Bridge::prepare.
    pub fn prepared(&mut self, pack_active: bool, slot: usize) -> bool {
        if !pack_active {
            return false;
        }
        self.event(serde_json::json!({"event":"prepared", "slot":slot}));
        let scenario = match self.phase {
            Phase::FirstPrepare => {
                self.phase = Phase::AwaitFirstRecreation;
                "before_first_submission"
            }
            Phase::RecreatedBeforeSubmission => {
                self.phase = Phase::AwaitFirstSubmission;
                "after_recreation_before_submission"
            }
            Phase::ResizedAfterSubmission => {
                self.phase = Phase::Done;
                "after_window_resize_and_submission"
            }
            _ => return false,
        };
        self.event(
            serde_json::json!({"event":"injected_out_of_date", "scenario":scenario, "slot":slot}),
        );
        true
    }

    /// Called from the real OutOfDateKHR branch after cancel_prepared/dirty.
    pub fn cancelled(&mut self, slot: usize, injected: bool) {
        self.event(serde_json::json!({"event":"cancelled", "slot":slot, "injected":injected}));
    }

    /// Called only after successful production recreate_swapchain completion.
    pub fn recreated(&mut self, width: u32, height: u32) {
        self.recreations += 1;
        self.event(serde_json::json!({"event":"recreated", "size":[width,height]}));
        self.phase = match self.phase {
            Phase::AwaitFirstRecreation => Phase::RecreatedBeforeSubmission,
            Phase::AwaitWindowResize(old) if old != [width, height] => {
                Phase::ResizedAfterSubmission
            }
            other => other,
        };
    }

    /// Called after successful graphics queue submission; requests one actual
    /// window resize after the first pack submission, through normal winit.
    pub fn submitted(&mut self, slot: usize, width: u32, height: u32) -> bool {
        self.submissions += 1;
        self.event(serde_json::json!({"event":"submitted", "slot":slot}));
        if matches!(self.phase, Phase::AwaitFirstSubmission) {
            self.phase = Phase::AwaitWindowResize([width, height]);
            self.event(serde_json::json!({"event":"resize_requested", "from":[width,height], "to":[width+16,height+16]}));
            true
        } else {
            false
        }
    }
}
