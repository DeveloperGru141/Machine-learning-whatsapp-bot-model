# WhatsApp Voice Calls: Clear Integration Plan

## What the feature will do

A person calls the bot in WhatsApp, speaks naturally, hears the bot answer during that same call, and can interrupt it. This is a live two-way call. It is different from the existing voice-note flow, where WhatsApp first delivers a complete audio file, the bot transcribes it, then sends a separate reply.

## Why Baileys cannot carry this call

The current bot uses Baileys for WhatsApp messages. Baileys can report call-state events and can reject calls, but the installed socket does not provide the supported accept-and-stream-audio interface required for a live call. The bot's current `messages.upsert` handler, `analyzeVoiceNote`, and `tts.ts` can process voice notes; they do not expose the real-time call media path. We should keep that transport for existing chats and add the call feature through the official WhatsApp Business Platform Calling API.

## The call, step by step

```mermaid
sequenceDiagram
    participant P as Person in WhatsApp
    participant M as Meta Calling API
    participant H as Bot call webhook
    participant G as WebRTC voice gateway
    participant A as Existing bot agent
    participant S as Speech services

    P->>M: Start voice call to the Business number
    M->>H: Signed CONNECT webhook with call ID and SDP offer
    H->>G: Create isolated call session and pass SDP offer
    G-->>H: WebRTC SDP answer
    H->>M: Pre-accept / accept call with SDP answer
    M<->>G: Live encrypted audio over WebRTC
    loop Each spoken turn
        G->>S: Caller audio frames
        S->>G: Transcript when caller finishes speaking
        G->>A: handleVoiceTurn(transcript, caller + call context)
        A-->>G: Short text reply
        G->>S: Text reply for speech synthesis
        S-->>G: Audio frames
        G->>M: Bot audio over the active WebRTC call
        M->>P: Caller hears bot reply
    end
    P->>M: Hang up
    M->>H: TERMINATE webhook
    H->>G: Close media and clear call session
```

1. The person calls a WhatsApp Business number that has Calling enabled. For the first release, they call the bot; we do not make bot-initiated calls.
2. Meta sends the bot a signed `calls` webhook containing the call ID and the caller's WebRTC SDP offer. The bot validates the signature and deduplicates the event.
3. A dedicated WebRTC gateway creates an SDP answer. The bot sends that answer back through the Cloud API call action (`pre_accept`, then `accept`) and starts the audio session. The gateway is necessary: an HTTP webhook by itself cannot receive or transmit live audio.
4. The gateway streams the caller's audio to speech recognition. Voice activity detection determines when a turn is complete.
5. The call orchestrator sends the transcript into the existing agent as a new `handleVoiceTurn(transcript, callContext)` entry point. The call context contains only this caller's identity and the conversation allowed for that business number. A reviewed call-specific tool allowlist prevents voice commands from triggering broadcasts or unrelated chat actions.
6. Text-to-speech creates the reply. The gateway streams the audio to the same WebRTC session. If the caller begins speaking, the gateway stops playback and starts the next turn.
7. A terminate event closes the peer connection and stores only call metadata and a redacted result. Raw audio is not retained by default.

Meta's calling API is the **signaling and call-control layer**: it tells the bot a call is arriving and accepts/rejects/ends it. The WebRTC gateway is the **media layer**: it handles SDP, secure audio packets, jitter, silence detection, and audio playback. The existing bot agent and speech services form the **conversation layer**. These three jobs should be separate modules so a media reconnect cannot freeze regular WhatsApp message handling.

## How it fits this codebase

| New component | Responsibility | Existing bot code it connects to |
| --- | --- | --- |
| `WhatsAppCallWebhookController` | Receive and authenticate Meta call events; deduplicate call IDs | Existing HTTP server, if it can accept public webhooks; otherwise a small dedicated service |
| `WhatsAppCallAdapter` | Cloud API accept, reject, and terminate actions | New Cloud API credentials and Business Platform phone-number ID |
| `CallSessionStore` | Track call ID, caller key, timestamps, and state transitions | SQLite, with TTL cleanup and no audio/transcript by default |
| `WebRtcVoiceGateway` | Create SDP answer, receive/send audio, detect turns and interruptions | New dedicated WebRTC service or a documented calling provider |
| `VoiceTurnOrchestrator` | Convert each transcript to a constrained agent turn | `agentHarness.handleMessage`/context manager through a new voice-specific entry point |
| Speech adapters | Streaming speech recognition and speech synthesis | `src/core/transcription.ts` and `src/core/tts.ts` are useful starting points, but currently operate on complete audio files rather than live frames |

The current Baileys socket stays responsible for the existing WhatsApp message session. Do not point Baileys and Cloud API at the same phone number unless Meta confirms that the exact account and coexistence setup supports it. The safer pilot is a dedicated Business Platform number; users can continue messaging the existing bot while voice is piloted on the new number.

## Build sequence

### 1. Confirm the account and number

- Create or select a WhatsApp Business Account and Cloud API app.
- Choose whether the call pilot uses a new Business Platform number. Verify the number's country eligibility, business verification, account messaging limit, calling settings, permissions, and webhook subscription in WhatsApp Manager/Meta developer tools.
- Start with customer-initiated inbound calls. Business-initiated calls require user permission and country eligibility; the bot should not try to call a person proactively until Meta confirms the Nigerian sender number supports it.
- Configure a public HTTPS webhook and subscribe the app to the `calls` field.

### 2. Prove call control without the bot

- Use a test sender and a test deployment.
- Validate webhook signature, duplicate delivery, call timeouts, accept/reject/end transitions, and the Cloud API call endpoint.
- Connect the test number to a real WebRTC stack or a documented calling provider. Confirm bidirectional audio before integrating the agent. Sending an SDP string with curl alone is not a media connection.

### 3. Connect one safe voice turn

- Add a `handleVoiceTurn` method that reuses the current agent and caller-scoped memory without pretending a transcript is an ordinary text message from another chat.
- Initially use one completed utterance → transcription → agent → synthesized reply. Keep the interaction turn-based with a clear timeout. This is easier to debug but may feel slower.
- After that works, switch recognition and synthesis to streaming and add barge-in cancellation.
- Keep calls one-at-a-time in the pilot, cap call duration, set per-caller cooldowns, and provide a kill switch.

### 4. Pilot and measure

Test with a small group that has agreed to participate. Measure call setup failures, transcription accuracy, end-of-turn delay, interruption behavior, dropped calls, and per-minute cost. Store call IDs and redacted error categories for diagnostics; do not log SDP, access tokens, phone numbers, or audio payloads.

## What we can ship first

The first working slice should be **inbound calls on a test Business Platform number, with a real WebRTC media gateway and one short spoken bot turn**. It can reuse the existing agent and current transcription/TTS providers, but those providers will need streaming adapters or a turn-based file bridge. We should not build a fake call by sending voice notes: that would not meet the live-call requirement.

## Current constraints and references

- The current Baileys session is not the call transport; a supported Calling API number and WebRTC/SIP media endpoint are needed.
- Meta's official WhatsApp Business Platform collection describes Cloud API and webhook setup: [Meta WhatsApp Business Platform Postman collection](https://www.postman.com/meta/whatsapp-business-platform/overview).
- Meta's Calling API guide covers user-initiated call setup and call-control actions: [WhatsApp Cloud API Calling](https://developers.facebook.com/docs/whatsapp/cloud-api/calling/).
- The exact phone-number eligibility and account requirements should be confirmed in the live Meta developer console before implementation because these settings and regional rules can change.
