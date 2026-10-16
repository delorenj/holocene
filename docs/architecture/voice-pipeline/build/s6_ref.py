ROWS = [
 ("Holocene Auto app","holocene/apps/auto","Android app on the Honda AAOS head unit (repo v10 0.2.8-internal; the dev emulator has v9). WebView hosts Agent Pad, NativeRecorder records Ogg/Opus, CarHost blocks recording unless parked."),
 ("Agent Pad","holocene/apps/agent-pad","Vite/React SPA served by nginx container agent-pad-web at agent-pad.delo.sh. IndexedDB outbox, polls replies/ every 15 s, beacons played/skipped."),
 ("agent-pad-upload","holocene/services/upload-proxy","PUT /upload/inbox/..., POST /upload/client-event and /upload/played. Writes MinIO via mc and publishes audio.memo.uploaded/played/failed to NATS (raw, fail-open). Health is container-internal only."),
 ("inbox-watcher","holocene/services/inbox-watcher","holocene-inbox-watcher.service. Stage facts received, transcribed, dispatched, replied, failed. Dispatches invoke on the interactive lane, falls back to start only if interactive is unpulled and batch is pulled. mise run memo:trace|list|retry|test."),
 ("transcribe, vox","~/.local/bin/transcribe, vox containers","faster-whisper large-v3 (CPU int8 when the GPU is full; one at a time). vox: vibevoice engine, voice rick, voxcpm and elevenlabs as fallbacks."),
 ("NATS JetStream","bloodbank/compose/nats","BLOODBANK_EVENTS (bloodbank.evt.>) and BLOODBANK_COMMANDS (workqueue). Monitor :8222."),
 ("Hermes gateway plugin","bloodbank/services/hermes-gateway","Inside the single multiplexed hermes-gateway.service. Two durables (interactive filter invoke, 2 slots, max_deliver 8; batch filter start, 4 slots, max_deliver 5), execution journal with lane and failure_code, lifecycle facts with data.lane, per-turn wall clock."),
 ("Hermes agent profile","~/.hermes/profiles/&lt;agent&gt;","state.db sessions with source=bloodbank and chat_id=memo_id; the reply text is read from here. Model path: automaticai provider, api.automaticai.io."),
 ("Holocene API + web","holocene/apps/api, apps/web","holocene-api.service (:4000) with its own JetStream consumer and event store; holocene-web (33god-platform compose) at holocene.delo.sh/voice behind Google OIDC."),
 ("Candystore, ntfy-router, monitoring","candystore, bloodbank, monitoring","Candystore projects events (loopback :8683). ntfy-router pushes only audio.memo.failed for memos. Prometheus (host port 9472) rules BloodbankLaneNotPulled and BloodbankInteractiveLaneBacklog feed Alertmanager to Telegram (config.yml; alertmanager.yml is a stale Discord placeholder)."),
]
def html():
    t = '<h2 id="ref">Container reference</h2><div class="tw"><table><tr><th>Container</th><th>Where</th><th>What it is</th></tr>'
    for a,b,c in ROWS:
        t += f"<tr><td>{a}</td><td><code>{b}</code></td><td>{c}</td></tr>"
    t += "</table></div>"
    t += '<h2>Known gaps and unverified</h2><ul class="gaps"><li>Reply listing/fetch path from Agent Pad (proxy GET vs direct s3.delo.sh) was not verified; the diagram draws it through the ingress.</li><li>Honda head unit install state is unverified: repo says v10, the dev emulator runs v9, Play was not checked.</li><li>No component of this pipeline was found on the Mac.</li><li>51 messages sit in BLOODBANK_COMMANDS with no gateway consumer pending: some other cmd/rpy subject without a consumer, not identified.</li><li>Alerting gap: nothing alerts on turn duration; BloodbankInteractiveLaneBacklog only fires once a command queues behind busy slots. The wall clock bounds the damage, it does not page.</li><li>n8n runs under PM2 (not systemd or docker); its Agent Fleet workflow graph was not read.</li></ul>'
    return t
