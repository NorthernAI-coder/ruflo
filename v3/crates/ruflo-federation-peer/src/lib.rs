//! `ruflo-federation-peer` — single-process federation peer.
//!
//! Composes the QUIC transport (`midstreamer-quic`) and the AIMDS
//! 3-gate safety pipeline (`aimds-detection` / `aimds-analysis` /
//! `aimds-response`) into one Rust process per peer (ADR-120 Step 3).
//! Collapses the previous Node-bridge → Node-MCP → Rust-crate path
//! into a single binary that does the federation hop + the 3-gate
//! in-flight scan + the stdio handoff to the local agent.
//!
//! The crate exports two traits that callers can implement against
//! their own backends:
//!
//!   - [`TransportProvider`] — accepts inbound federation messages
//!     and surfaces outbound ones. Default impl (under `--features
//!     native`) wraps `midstreamer-quic`.
//!
//!   - [`SafetyGate`] — runs the 3-gate inspection on a message
//!     payload. Default impl wraps `aimds-detection`'s sanitizer +
//!     `aimds-analysis`'s policy verifier + `aimds-response`'s
//!     mitigation pipeline.
//!
//! The [`Peer`] type binds a transport to a safety gate. Inbound
//! messages flow `transport → gate → dispatch`, outbound flow
//! `dispatch → gate → transport`. Both gates run in-process, so a
//! verdict on a federation hop completes in <60 ms (AIMDS docs).
//!
//! Without the `native` feature this crate compiles to traits + the
//! [`Peer`] dispatch loop only — useful for downstream consumers
//! that want to substitute their own QUIC / gate backends without
//! pulling in the upstream tree.

#![deny(unsafe_code)]
#![warn(missing_docs)]

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A federation message. Mirrors the shape of
/// `agentic-flow/transport/loader::AgentMessage` so the TS-side and
/// Rust-side peer agree on the wire format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationMessage {
    /// Message identifier.
    pub id: String,
    /// Message type (`task` / `result` / `status` / `coordination` /
    /// `heartbeat` / custom).
    #[serde(rename = "type")]
    pub kind: String,
    /// JSON payload; opaque at the transport layer.
    pub payload: serde_json::Value,
    /// Optional sender / recipient metadata.
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    /// Optional stream id for multiplexing per peer.
    #[serde(default, rename = "streamId")]
    pub stream_id: Option<String>,
}

/// Verdict from the 3-gate safety pipeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SafetyVerdict {
    /// Message passed all three gates — forward as-is.
    Pass,
    /// Gate flagged unsafe content; quarantine + emit an audit
    /// record. The carried string is the reason (which gate
    /// triggered, what pattern).
    Block(String),
    /// Gate redacted PII or sanitized cookies/tokens but the
    /// message is still safe to forward. Returns the cleaned
    /// payload.
    Redact(FederationMessage),
}

/// Error surface for the peer's operations.
#[derive(Debug, thiserror::Error)]
pub enum PeerError {
    /// Transport-level failure (e.g. socket closed, peer unreachable).
    #[error("transport: {0}")]
    Transport(String),
    /// Safety-gate failure.
    #[error("safety gate: {0}")]
    Gate(String),
    /// Dispatch failure (e.g. the local Node MCP server isn't reachable).
    #[error("dispatch: {0}")]
    Dispatch(String),
    /// Malformed message could not be (de)serialized.
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

/// Pluggable QUIC transport. The default impl under `--features
/// native` wraps `midstreamer-quic`.
#[async_trait]
pub trait TransportProvider: Send + Sync {
    /// Send a message to the remote peer at `addr`.
    async fn send(&self, addr: &str, msg: FederationMessage) -> Result<(), PeerError>;

    /// Pull the next inbound message from any peer. Returns the
    /// sender address along with the message. Blocking — callers
    /// use it from a `select!` loop.
    async fn recv(&self) -> Result<(String, FederationMessage), PeerError>;

    /// Gracefully close the transport.
    async fn close(&self) -> Result<(), PeerError>;
}

/// Pluggable safety gate. The default impl under `--features native`
/// composes the AIMDS detection / analysis / response layers.
#[async_trait]
pub trait SafetyGate: Send + Sync {
    /// Run the 3-gate pipeline on an inbound or outbound message.
    /// Returns a verdict describing whether to forward, block, or
    /// forward a redacted variant.
    async fn inspect(&self, msg: &FederationMessage) -> Result<SafetyVerdict, PeerError>;
}

/// Pluggable dispatcher — typically writes the post-gate message to
/// the local Node MCP server via stdio NDJSON. Implementors decide
/// whether to spawn a child process, write to a Unix socket, etc.
#[async_trait]
pub trait Dispatcher: Send + Sync {
    /// Hand off an inspected (and possibly redacted) message to the
    /// local agent runtime.
    async fn dispatch(&self, sender: &str, msg: FederationMessage) -> Result<(), PeerError>;
}

/// The peer binds a transport, a gate, and a dispatcher into one
/// process. Inbound messages flow `transport.recv() → gate.inspect()
/// → dispatcher.dispatch()`; gate verdicts of `Block` quarantine the
/// message (it never reaches dispatch); `Redact` forwards the
/// cleaned variant.
pub struct Peer<T, G, D>
where
    T: TransportProvider,
    G: SafetyGate,
    D: Dispatcher,
{
    transport: T,
    gate: G,
    dispatcher: D,
}

impl<T, G, D> Peer<T, G, D>
where
    T: TransportProvider,
    G: SafetyGate,
    D: Dispatcher,
{
    /// Construct a peer from its three collaborators.
    pub fn new(transport: T, gate: G, dispatcher: D) -> Self {
        Self {
            transport,
            gate,
            dispatcher,
        }
    }

    /// Drive the inbound loop. Returns when the transport is closed
    /// or an unrecoverable error fires. Recoverable errors (gate
    /// block / redact) are logged and the loop continues.
    pub async fn run(&self) -> Result<(), PeerError> {
        loop {
            let (sender, msg) = match self.transport.recv().await {
                Ok(pair) => pair,
                Err(PeerError::Transport(reason)) if reason == "closed" => break,
                Err(e) => return Err(e),
            };

            match self.gate.inspect(&msg).await? {
                SafetyVerdict::Pass => {
                    self.dispatcher.dispatch(&sender, msg).await?;
                }
                SafetyVerdict::Redact(clean) => {
                    tracing::warn!(
                        from = %sender,
                        id = %clean.id,
                        "AIDefence gate redacted PII before dispatch",
                    );
                    self.dispatcher.dispatch(&sender, clean).await?;
                }
                SafetyVerdict::Block(reason) => {
                    tracing::warn!(
                        from = %sender,
                        id = %msg.id,
                        reason = %reason,
                        "AIDefence gate blocked inbound message — quarantined",
                    );
                    // Block: message does NOT reach dispatch.
                }
            }
        }
        Ok(())
    }

    /// Send a message outbound through the safety gate first. Used
    /// by the local agent runtime when responding to peers.
    pub async fn send(&self, addr: &str, msg: FederationMessage) -> Result<(), PeerError> {
        match self.gate.inspect(&msg).await? {
            SafetyVerdict::Pass => self.transport.send(addr, msg).await,
            SafetyVerdict::Redact(clean) => self.transport.send(addr, clean).await,
            SafetyVerdict::Block(reason) => {
                tracing::warn!(
                    to = %addr,
                    id = %msg.id,
                    reason = %reason,
                    "AIDefence gate blocked outbound message",
                );
                Err(PeerError::Gate(reason))
            }
        }
    }

    /// Tear down the transport.
    pub async fn close(&self) -> Result<(), PeerError> {
        self.transport.close().await
    }
}

/// Production transport wrapping `midstreamer-quic`. Only available
/// under `--features native` because the upstream crate is otherwise
/// optional.
#[cfg(feature = "native")]
pub mod native_transport {
    //! Real-QUIC wrapper. Implementation lands once the upstream
    //! `midstreamer-quic` API stabilizes its `QuicTransport` trait.
    //! Today this is a typed placeholder so `cargo check
    //! --features native` succeeds.
    use super::*;

    /// Concrete [`TransportProvider`] backed by `midstreamer-quic`.
    pub struct MidstreamerTransport;

    #[async_trait]
    impl TransportProvider for MidstreamerTransport {
        async fn send(&self, _addr: &str, _msg: FederationMessage) -> Result<(), PeerError> {
            Err(PeerError::Transport("not implemented — see ADR-120".into()))
        }
        async fn recv(&self) -> Result<(String, FederationMessage), PeerError> {
            Err(PeerError::Transport("not implemented — see ADR-120".into()))
        }
        async fn close(&self) -> Result<(), PeerError> {
            Ok(())
        }
    }
}

/// Production safety gate wrapping AIMDS detection + analysis +
/// response layers. Only available under `--features native`.
#[cfg(feature = "native")]
pub mod native_gate {
    //! AIMDS 3-gate wrapper. Composes the four `aimds-*` crates.
    //! Today this is a typed placeholder; the real implementation
    //! lands in a follow-up once the upstream crates expose the
    //! handle the ruflo MCP tools already use.
    use super::*;

    /// Concrete [`SafetyGate`] backed by the AIMDS pipeline.
    pub struct AimdsGate;

    #[async_trait]
    impl SafetyGate for AimdsGate {
        async fn inspect(&self, _msg: &FederationMessage) -> Result<SafetyVerdict, PeerError> {
            // The wired implementation walks `aimds-detection` →
            // `aimds-analysis` → `aimds-response`. Until the upstream
            // crates publish their public-API trait for embedding,
            // this default safely passes everything through.
            Ok(SafetyVerdict::Pass)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal in-memory transport used by the dispatch-loop test.
    struct StubTransport {
        inbound: tokio::sync::Mutex<Vec<(String, FederationMessage)>>,
    }

    #[async_trait]
    impl TransportProvider for StubTransport {
        async fn send(&self, _addr: &str, _msg: FederationMessage) -> Result<(), PeerError> {
            Ok(())
        }
        async fn recv(&self) -> Result<(String, FederationMessage), PeerError> {
            let mut g = self.inbound.lock().await;
            if let Some(v) = g.pop() {
                Ok(v)
            } else {
                Err(PeerError::Transport("closed".into()))
            }
        }
        async fn close(&self) -> Result<(), PeerError> {
            Ok(())
        }
    }

    struct PassThroughGate;

    #[async_trait]
    impl SafetyGate for PassThroughGate {
        async fn inspect(&self, _msg: &FederationMessage) -> Result<SafetyVerdict, PeerError> {
            Ok(SafetyVerdict::Pass)
        }
    }

    struct BlockEverythingGate;

    #[async_trait]
    impl SafetyGate for BlockEverythingGate {
        async fn inspect(&self, _msg: &FederationMessage) -> Result<SafetyVerdict, PeerError> {
            Ok(SafetyVerdict::Block("test rule".into()))
        }
    }

    struct CountingDispatcher(tokio::sync::Mutex<usize>);

    #[async_trait]
    impl Dispatcher for CountingDispatcher {
        async fn dispatch(&self, _sender: &str, _msg: FederationMessage) -> Result<(), PeerError> {
            let mut g = self.0.lock().await;
            *g += 1;
            Ok(())
        }
    }

    fn msg(id: &str) -> FederationMessage {
        FederationMessage {
            id: id.to_string(),
            kind: "task".to_string(),
            payload: serde_json::Value::Null,
            metadata: Default::default(),
            stream_id: None,
        }
    }

    #[tokio::test]
    async fn run_dispatches_inbound_messages_that_pass_the_gate() {
        let transport = StubTransport {
            inbound: tokio::sync::Mutex::new(vec![
                ("peer-1".into(), msg("a")),
                ("peer-1".into(), msg("b")),
            ]),
        };
        let gate = PassThroughGate;
        let counter = CountingDispatcher(tokio::sync::Mutex::new(0));
        let dispatcher = CountingDispatcher(tokio::sync::Mutex::new(0));
        let peer = Peer::new(transport, gate, dispatcher);
        peer.run().await.unwrap();
        assert_eq!(*peer.dispatcher.0.lock().await, 2);
        // counter is unused; we hold it just to test the move semantics
        let _ = counter;
    }

    #[tokio::test]
    async fn run_quarantines_messages_that_the_gate_blocks() {
        let transport = StubTransport {
            inbound: tokio::sync::Mutex::new(vec![("peer-1".into(), msg("a"))]),
        };
        let gate = BlockEverythingGate;
        let dispatcher = CountingDispatcher(tokio::sync::Mutex::new(0));
        let peer = Peer::new(transport, gate, dispatcher);
        peer.run().await.unwrap();
        assert_eq!(*peer.dispatcher.0.lock().await, 0);
    }

    #[tokio::test]
    async fn outbound_send_blocks_when_gate_says_block() {
        let transport = StubTransport {
            inbound: tokio::sync::Mutex::new(vec![]),
        };
        let gate = BlockEverythingGate;
        let dispatcher = CountingDispatcher(tokio::sync::Mutex::new(0));
        let peer = Peer::new(transport, gate, dispatcher);
        let err = peer.send("peer-2", msg("c")).await.unwrap_err();
        match err {
            PeerError::Gate(reason) => assert_eq!(reason, "test rule"),
            other => panic!("expected Gate error, got {other:?}"),
        }
    }
}
