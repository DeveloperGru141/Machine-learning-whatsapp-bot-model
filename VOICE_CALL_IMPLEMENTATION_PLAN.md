# WhatsApp Voice Call Feature: Implementation Plan

## Goal

Let one person at a time have a real, two-way voice conversation with the bot in WhatsApp. The bot should listen, transcribe, answer using the existing agent and tool system, synthesize speech, and speak the answer during the same call.

This plan assumes a live call. Sending voice notes back and forth is a simpler fallback, but it is not a live-call implementation.

## Feasibility finding

The project currently uses `@whiskeysockets/baileys` `7.0.0-rc14`. The installed public socket surface includes the `call` event, `rejectCall`, and `createCallLink`; it does not expose a supported API to accept an individual call and exchange real-time audio frames. The official Baileys guide describes `call` as call-state updates, and the upstream socket API exposes rejection and link creation. This is enough to detect and decline a call, but not enough for a reliable conversational call.

Do not treat a call link as an audio bridge. Do not enable an experimental reverse-engineered VoIP engine on the production paired account. A separate test account and a time-boxed proof of concept would be required before considering any unofficial transport.

## Recommended delivery path

Use a dedicated WhatsApp Business Platform sender with WhatsApp Calling enabled, through Meta Cloud API directly or a calling-capable provider. Connect its WebRTC/SIP media path to a small voice gateway, and connect that gateway to the existing bot agent over an internal authenticated interface. Keep the current Baileys session for messaging unless the provider and Meta confirm that the selected number and account setup support the required coexistence arrangement. Do not connect both systems to the same number by assumption.

The business calling route has account, number, consent, and country availability requirements. Meta’s calling announcement describes calls through the Business Platform; provider documentation describes inbound and outbound calling setup and call-permission flows. Confirm the Nigerian sender-number eligibility before choosing an outbound-call design. For an initial MVP, prefer user-initiated inbound calls; only add bot-initiated outbound calls after verifying current country eligibility and explicit call-permission requirements.

## Architecture

1. **WhatsApp call adapter**
   - Receives call lifecycle events from the supported Cloud API/provider integration.
   - Validates webhook signatures, event timestamps, call IDs, sender identity, consent, and current account eligibility.
   - Deduplicates events by provider call ID and maps them to an internal call session.

2. **Voice gateway**
   - Terminates the provider’s WebRTC/SIP media session.
   - Converts inbound audio into bounded audio frames and streams it to speech recognition.
   - Sends synthesized speech frames back over the live media session.
   - Handles jitter, packet loss, timeouts, silence, interruption/barge-in, and reconnects without blocking the WhatsApp message loop.

3. **Conversation orchestrator**
   - Reuses the existing context manager and tool registry, with a per-call context keyed to the caller and call ID.
   - Uses voice-appropriate turn-taking and short responses.
   - Applies the same owner checks, chat-scoped memory rules, tool allowlist, rate limits, and outbound safety policy as text chats.
   - Requires explicit user intent and permission for consequential tool actions; speaking during a call must not silently trigger a tool that sends messages or changes group state.

4. **Speech services**
   - Speech-to-text for caller audio and text-to-speech for bot output.
   - Start with a provider-neutral interface so recognition or synthesis services can be swapped without changing call control.
   - Preserve the caller’s preferred language and code-switching, but do not retain raw call audio by default.

5. **Call state and operations**
   - Persist only minimum call metadata: opaque caller key, call ID, start/end time, result, and redacted error category.
   - Do not log phone numbers, raw transcripts, audio, credentials, or media payloads in normal logs.
   - Enforce one active call initially, a short maximum duration, per-caller cooldowns, a global concurrency cap, and immediate stop/reject controls.

## Phases

### Phase 0 — Product and provider gate

- Confirm whether the requirement is live duplex audio or a voice-note conversation.
- Confirm the intended WhatsApp sender type, number country, and whether a new dedicated Business Platform number is acceptable.
- Select direct Cloud API or a provider with documented WhatsApp Calling support.
- Verify inbound/outbound eligibility, required business verification, call permission rules, pricing, data residency, recording defaults, and number coexistence before implementation.
- Define caller consent, a spoken disclosure that the caller is talking to an AI, retention limits, maximum call length, and emergency termination behavior.

**Exit criterion:** a selected provider confirms the exact number/account can receive calls, and the team can obtain a test endpoint and call events.

### Phase 1 — Isolated call-control proof of concept

- Build a separate test deployment and use a dedicated test sender.
- Verify webhook signature validation, event ordering, duplicate handling, answer/reject/end state transitions, and health reporting.
- Establish a media session and confirm full-duplex audio without involving production WhatsApp credentials.
- If testing Baileys separately, limit the spike to call-event observation and supported rejection/link behavior; stop if successful media acceptance requires undocumented crypto or protocol changes.

**Exit criterion:** repeatable inbound test calls complete with bidirectional audio and no production session access.

### Phase 2 — Speech loop and agent integration

- Add a bounded streaming STT → agent → streaming TTS loop.
- Add turn detection, interruption handling, per-turn deadlines, cancellation propagation, and graceful fallback to a WhatsApp message if the media session fails.
- Restrict available tools to a reviewed call-specific allowlist; exclude broadcasts, contact campaigns, group admin actions, and arbitrary external messaging by default.
- Add language selection and caller-scoped context without importing unrelated chat history.

**Exit criterion:** the bot can answer a small set of supported questions conversationally, recover from STT/TTS errors, and terminate cleanly.

### Phase 3 — Security, quality, and pilot

- Test replayed and forged webhooks, duplicate events, unknown callers, consent revocation, media floods, provider disconnects, tool prompt injection, and account restrictions.
- Measure call setup success, audio latency, transcription quality, interruption behavior, dropped-call rate, and per-minute cost.
- Pilot with a small allowlist of consenting testers and conservative concurrency/duration limits.
- Add an operator kill switch and dashboard before expanding access.

**Exit criterion:** security review passes, target latency and reliability are met, and the pilot has no unauthorized tool actions or unbounded audio retention.

## First implementation slices

1. Add provider interfaces and typed call-session state without connecting production credentials.
2. Add a webhook ingress with signature verification, idempotency, and sanitized event logging.
3. Add a mock media transport and state-machine tests.
4. Implement one provider-specific test adapter after Phase 0 selection.
5. Add streaming STT/TTS behind provider interfaces, then integrate the constrained agent loop.
6. Pilot and decide whether to expand or retain voice notes as the supported WhatsApp experience.

## Main risks

- The current Baileys v7 socket does not provide the live media accept/stream primitives required by the goal.
- Unofficial call transport would rely on reverse-engineered behavior and could break on WhatsApp changes or put the paired account at risk.
- Business calling eligibility depends on the sender country and account setup; do not assume outbound calls are available for a Nigerian sender.
- Real-time STT/LLM/TTS adds latency, cost, and sensitive audio handling concerns.
- Agent tools capable of messaging, moderation, or broadcasting need stricter call-specific permissions than ordinary chat turns.

## References

- [Baileys receiving updates](https://baileys.wiki/docs/socket/receiving-updates/) — the `call` event is a lifecycle/update event.
- [Baileys upstream call event types](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Events.ts) — typed call events.
- [Baileys upstream socket API](https://github.com/WhiskeySockets/Baileys/blob/master/src/Socket/index.ts) — public call-related socket methods.
- [Meta announcement of WhatsApp Business Platform calling](https://about.fb.com/news/2025/07/centralized-campaigns-ai-support-businesses-whatsapp/) — calling is being provided through the Business Platform.
- [Twilio WhatsApp Business Calling guide](https://www.twilio.com/docs/voice/whatsapp-business-calling) — provider setup, consent, inbound/outbound flow, and country eligibility; re-check at provider selection because availability can change.
