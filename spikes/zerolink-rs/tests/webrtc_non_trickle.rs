use anyhow::Context;
use bytes::Bytes;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use webrtc::api::APIBuilder;
use webrtc::data_channel::RTCDataChannel;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::peer_connection::configuration::RTCConfiguration;

const SAFE_DATAGRAM_BYTES: usize = 1200;
const WAIT: Duration = Duration::from_secs(20);

#[tokio::test]
async fn non_trickle_two_peer_binary_round_trip() -> anyhow::Result<()> {
    let api = APIBuilder::new().build();
    let offerer = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    let answerer = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);

    let (answer_received_tx, answer_received_rx) = oneshot::channel::<Vec<u8>>();
    let answer_received_tx = Arc::new(tokio::sync::Mutex::new(Some(answer_received_tx)));
    let (answer_channel_tx, mut answer_channel_rx) = mpsc::channel::<Arc<RTCDataChannel>>(1);
    let answer_channel_tx = Arc::new(answer_channel_tx);

    answerer.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
        let answer_received_tx = Arc::clone(&answer_received_tx);
        let answer_channel_tx = Arc::clone(&answer_channel_tx);
        Box::pin(async move {
            let channel_for_reply = Arc::clone(&channel);
            channel.on_message(Box::new(move |message: DataChannelMessage| {
                let answer_received_tx = Arc::clone(&answer_received_tx);
                let channel_for_reply = Arc::clone(&channel_for_reply);
                Box::pin(async move {
                    if let Some(sender) = answer_received_tx.lock().await.take() {
                        let _ = sender.send(message.data.to_vec());
                    }
                    channel_for_reply
                        .send(&Bytes::from_static(b"answer-to-offerer"))
                        .await
                        .expect("answerer sends binary reply");
                })
            }));
            let _ = answer_channel_tx.send(channel).await;
        })
    }));

    let offer_channel = offerer.create_data_channel("zerolink", None).await?;
    let (offer_open_tx, offer_open_rx) = oneshot::channel::<()>();
    let offer_open_tx = Arc::new(tokio::sync::Mutex::new(Some(offer_open_tx)));
    offer_channel.on_open(Box::new(move || {
        let offer_open_tx = Arc::clone(&offer_open_tx);
        Box::pin(async move {
            if let Some(sender) = offer_open_tx.lock().await.take() {
                let _ = sender.send(());
            }
        })
    }));
    let (offer_received_tx, offer_received_rx) = oneshot::channel::<Vec<u8>>();
    let offer_received_tx = Arc::new(tokio::sync::Mutex::new(Some(offer_received_tx)));
    offer_channel.on_message(Box::new(move |message: DataChannelMessage| {
        let offer_received_tx = Arc::clone(&offer_received_tx);
        Box::pin(async move {
            if let Some(sender) = offer_received_tx.lock().await.take() {
                let _ = sender.send(message.data.to_vec());
            }
        })
    }));

    // Non-trickle offer: wait until all host candidates are embedded in local SDP.
    let mut offer_gathering_complete = offerer.gathering_complete_promise().await;
    offerer
        .set_local_description(offerer.create_offer(None).await?)
        .await?;
    timeout(WAIT, offer_gathering_complete.recv())
        .await
        .context("offer ICE gathering timed out")?;
    let offer = offerer
        .local_description()
        .await
        .context("offer local description missing")?;
    let offer_sdp_bytes = offer.sdp.len();
    let offer_bytes = serde_json::to_vec(&serde_json::json!({
        "type": "offer",
        "sdp": &offer.sdp,
        "sdpType": "offer",
    }))?
    .len();
    assert!(
        !offer.sdp.contains(" typ relay"),
        "spike must measure SDP without TURN relay candidates"
    );
    answerer.set_remote_description(offer).await?;

    // Non-trickle answer: likewise send exactly one SDP after gathering completes.
    let mut answer_gathering_complete = answerer.gathering_complete_promise().await;
    answerer
        .set_local_description(answerer.create_answer(None).await?)
        .await?;
    timeout(WAIT, answer_gathering_complete.recv())
        .await
        .context("answer ICE gathering timed out")?;
    let answer = answerer
        .local_description()
        .await
        .context("answer local description missing")?;
    let answer_sdp_bytes = answer.sdp.len();
    let answer_bytes = serde_json::to_vec(&serde_json::json!({
        "type": "answer",
        "sdp": &answer.sdp,
        "sdpType": "answer",
    }))?
    .len();
    assert!(
        !answer.sdp.contains(" typ relay"),
        "spike must measure SDP without TURN relay candidates"
    );
    offerer.set_remote_description(answer).await?;

    let combined_bytes = offer_bytes + answer_bytes;
    println!(
        "non-trickle signaling JSON: offer={offer_bytes} B (SDP {offer_sdp_bytes} B), \
         answer={answer_bytes} B (SDP {answer_sdp_bytes} B), combined={combined_bytes} B"
    );
    assert!(
        offer_bytes < SAFE_DATAGRAM_BYTES,
        "offer SDP exceeds {SAFE_DATAGRAM_BYTES} B safe signaling datagram budget"
    );
    assert!(
        answer_bytes < SAFE_DATAGRAM_BYTES,
        "answer SDP exceeds {SAFE_DATAGRAM_BYTES} B safe signaling datagram budget"
    );

    timeout(WAIT, offer_open_rx)
        .await
        .context("offerer DataChannel did not open")??;
    let _answer_channel = timeout(WAIT, answer_channel_rx.recv())
        .await
        .context("answerer DataChannel did not arrive")?
        .context("answerer DataChannel callback closed")?;

    offer_channel
        .send(&Bytes::from_static(b"offerer-to-answer"))
        .await?;
    let at_answer = timeout(WAIT, answer_received_rx)
        .await
        .context("answerer did not receive binary message")??;
    let at_offerer = timeout(WAIT, offer_received_rx)
        .await
        .context("offerer did not receive binary reply")??;
    assert_eq!(at_answer, b"offerer-to-answer");
    assert_eq!(at_offerer, b"answer-to-offerer");

    offerer.close().await?;
    answerer.close().await?;
    Ok(())
}
