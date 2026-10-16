workspace "Holocene voice memo pipeline" "From a spoken memo on the Honda to an agent answering aloud. As built and verified 2026-10-16, including the per-turn wall clock on the interactive lane." {

    !identifiers hierarchical

    model {
        operator = person "Operator" "Jarad. Records memos from the parked Honda, reads /voice, gets push alerts."

        playStore = softwareSystem "Google Play internal testing" "Distributes io.automaticai.holocene (repo: v10 0.2.8-internal)." "External"
        cloudflare = softwareSystem "Cloudflare" "DNS, edge and Tunnel in front of Traefik for *.delo.sh." "External"
        googleOidc = softwareSystem "Google OIDC" "Identity provider for holocene-web login." "External"
        llmGateway = softwareSystem "AutomaticAI gateway" "api.automaticai.io, chat_completions, model automaticai/auto." "External"
        alerts = softwareSystem "ntfy and Telegram" "Phone push (ntfy.delo.sh) and Alertmanager receiver (DeLoNETBot)." "External"
        plane = softwareSystem "Plane and n8n" "Ticket webhooks -> n8n (PM2) -> invocation.start commands on the batch lane." "External"

        auto = softwareSystem "Holocene Auto" "Android app on the Honda AAOS head unit; hosts Agent Pad and records Ogg/Opus while parked." {
            app = container "Holocene Auto app" "APK, minSdk 32. Activity, WebView host, native recorder, car UX gate." "Kotlin, Android" "Device" {
                mainActivity = component "MainActivity" "Launcher activity; UI, lifecycle, mic/speech/TTS diagnostic probes, switches native panel and pad." "Kotlin"
                carHost = component "CarHost" "Isolates android.car.*; HostGate monotonic release; fail-closed off-automotive; reports unrestricted (parked)." "Kotlin, CarUxRestrictionsManager"
                padHost = component "AgentPadHost" "Owns the WebView, URL allow-policy, mic permission gating (padAllowed = unrestricted), render-process recovery." "Kotlin, WebView"
                nativeBridge = component "NativeBridge (window.HoloceneNative)" "@JavascriptInterface start() / stop() / micClosed() exposed to the pad JS." "Kotlin"
                nativeRecorder = component "NativeRecorder" "MediaRecorder MIC, OGG/OPUS, bounded duration, keeps nothing after stop/cancel." "Kotlin, MediaRecorder"
                diagnostic = component "DiagnosticSession" "State machine IDLE/CAPTURING/ACKNOWLEDGING/DONE/CANCELLED for the diagnostic fixture path." "Kotlin"
            }
            pad = container "Agent Pad" "SPA run inside the WebView (and any browser). IndexedDB outbox, uploads, polls replies/ every 15 s, auto-plays, beacons played/skipped." "Vite, React" "Web"
        }

        ingest = softwareSystem "Voice ingress" "Serves the pad, accepts uploads, stores audio in MinIO, announces uploads." {
            padWeb = container "agent-pad-web" "Serves apps/agent-pad/dist; index.html no-cache, /assets immutable." "nginx:alpine container"
            upload = container "agent-pad-upload" "PUT /upload/inbox/..., POST /upload/client-event, POST /upload/played, GET /health. Publishes memo.uploaded/played/failed to NATS (fail-open)." "Python 3.12, container"
            minio = container "MinIO holocene-auto" "inbox/<agent>/<date>/<ts>.ogg and replies/<date>/<time>-<agent>-<memo_id>.ogg." "MinIO (delodrive), s3.delo.sh" "Database"
            traefik = container "Traefik" "Routes agent-pad.delo.sh; PathPrefix /upload/ goes to the proxy." "Traefik v3.6"
        }

        watcherSys = softwareSystem "Inbox watcher" "One state machine per memo: discover, transcribe, dispatch, await, speak, upload." {
            watcher = container "inbox-watcher" "holocene-inbox-watcher.service. memo_id = uuid5(s3 key) = correlationid. Stage facts + command dispatch + heartbeat." "Python, systemd --user"
            transcribe = container "transcribe" "faster-whisper large-v3, CPU int8 when the GPU is full; invoked --ephemeral." "bash + Python CLI"
            vox = container "vox TTS" "POST /synthesize-url, voice rick, vibevoice engine (voxcpm/elevenlabs fallback)." "Containers, vox.delo.sh"
            watcherState = container "Watcher state" "state.json, heartbeat.json, control/ drop-ins for memo:retry." "Files under ~/.local/state/holocene-auto" "Database"
        }

        bloodbank = softwareSystem "Bloodbank" "Event and command bus; owns distribution." {
            nats = container "NATS JetStream" "Streams BLOODBANK_EVENTS (bloodbank.evt.>) and BLOODBANK_COMMANDS (workqueue). Monitor :8222." "nats:2.10, container"
            bb = container "bb-emit" "Validates against schemas/bloodbank and publishes facts and commands." "CLI"
            ntfyRouter = container "bloodbank-ntfy-router" "Policy classes mute/loud/digest. For memos only audio.memo.failed pushes." "Container"
        }

        hermes = softwareSystem "Hermes" "Single multiplexed gateway for ~37 agent profiles." {
            gateway = container "hermes-gateway" "hermes-gateway.service. Hosts the bloodbank platform plugin; restart = ~2 min reconnect." "Python, systemd --user" {
                consumeLoop = component "Lane consume loop" "Per-lane LaneRuntime: pull fetch(capacity), slots = max_inflight (interactive 2, batch 4), supervised." "Python, nats-py"
                decoder = component "decode_command" "Envelope + lane type check; data.deadline_seconds; poison -> term." "contract.py"
                journal = component "Execution journal" "SQLite executions: pending -> started -> completed, outcome, lane, failure_code." "execution_state.py, SQLite WAL"
                dispatch = component "Dispatch" "Per-conversation lock profile:thread_id; MessageEvent(internal) into Hermes handle_message." "adapter.py"
                awaitTurn = component "Turn wall clock (_await_turn)" "wait_for(shield(completion), min(deadline_seconds, lane limit)); interactive default 300 s, batch none." "adapter.py"
                timeoutPath = component "Timeout path" "Claim outcome, /stop the turn, close journal (turn_timeout), publish invocation.failed, ack." "adapter.py"
                lifecycle = component "Lifecycle publisher" "invocation.started / completed / failed (data.lane) and conversation.turn.* with inherited correlationid." "adapter.py"
                progressAck = component "Progress ack" "In-progress ack every 30 s so JetStream does not redeliver a long turn." "adapter.py"
            }
            agent = container "Hermes agent profile" "holocene-pm etc. Runs the turn against the model with tools; state.db holds sessions/messages." "Python, SQLite" {
                runner = component "Hermes runner" "handle_message, session_turn_leases, /stop = hard interrupt + generation bump + kill spawned shells." "Python"
                stateDb = component "Profile state.db" "sessions source='bloodbank', chat_id = memo_id; the reply text is read from here." "SQLite"
            }
            registry = container "agents-registry.yaml" "Org chart and routing: agents, profiles, bloodbank targets. Read by plugin, watcher, holocene-api." "YAML" "Database"
        }

        readSide = softwareSystem "Read side" "Projections and the operator's views." {
            candystore = container "Candystore" "Dapr JetStream consumer candystore-events -> Postgres. GET :8683/events?correlationid=." "Container + daprd + Postgres"
            holoApi = container "Holocene API" "holocene-api.service :4000. Ephemeral JetStream consumer, own event store, /api/modules/voice/memos, watcher heartbeat, registry." "Node, systemd --user"
            holoWeb = container "Holocene web" "holocene.delo.sh/voice. Joins stage facts into hops; Google OIDC." "Next.js, container"
        }

        monitoring = softwareSystem "Monitoring" "Lane health alerts." {
            natsExporter = container "nats-exporter" "Scrapes NATS :8222 jsz." "prometheus-nats-exporter"
            prometheus = container "Prometheus" "Rules BloodbankLaneNotPulled, BloodbankInteractiveLaneBacklog (host port 9472)." "Prometheus"
            alertmanager = container "Alertmanager" "Receiver telegram (config.yml)." "Alertmanager"
        }

        # Context level
        operator -> auto "Speaks a memo, hears the reply" "Voice, touch (parked)"
        playStore -> auto "Installs and updates the APK" "Play internal track"
        auto -> ingest "Uploads audio, polls replies" "HTTPS"
        ingest -> watcherSys "Inbox objects" "S3 (MinIO)"
        watcherSys -> bloodbank "Stage facts and invoke command" "NATS JetStream"
        bloodbank -> hermes "Delivers invoke / start commands" "NATS pull"
        hermes -> bloodbank "Lifecycle facts" "NATS"
        hermes -> llmGateway "Agent turns" "HTTPS chat_completions"
        watcherSys -> hermes "Reads journal and reply text" "SQLite, read-only"
        bloodbank -> readSide "evt.> projections" "NATS JetStream"
        bloodbank -> alerts "audio.memo.failed pushes" "HTTPS (ntfy)"
        monitoring -> alerts "Lane alerts" "Telegram"
        monitoring -> bloodbank "Scrapes consumer state" "HTTP :8222"
        plane -> bloodbank "invocation.start (batch lane)" "n8n -> NATS"
        operator -> readSide "Reads /voice" "HTTPS, Google OIDC"
        readSide -> googleOidc "Login" "OIDC"
        cloudflare -> ingest "Edge and Tunnel" "HTTPS"

        # Container level: device and ingress
        operator -> auto.app "Taps record" "Touch (parked only)"
        auto.app -> auto.pad "Hosts in WebView" "In-process"
        auto.pad -> auto.app "Recorder calls" "window.HoloceneNative"
        auto.pad -> ingest.traefik "PUT audio, POST beacons, GET pad and replies" "HTTPS via Cloudflare"
        ingest.traefik -> ingest.padWeb "Host(agent-pad.delo.sh)" "HTTP"
        ingest.traefik -> ingest.upload "PathPrefix(/upload/)" "HTTP"
        ingest.upload -> ingest.minio "Stores inbox object" "S3 via mc"
        ingest.upload -> bloodbank.nats "memo.uploaded / played / failed" "Raw NATS, fail-open"

        # Container level: watcher
        watcherSys.watcher -> ingest.minio "Lists inbox/ every 5 s, downloads, uploads replies/" "S3 via mc"
        watcherSys.watcher -> watcherSys.transcribe "ffprobe then transcribe" "Subprocess"
        watcherSys.watcher -> bloodbank.bb "Emit facts and command" "Subprocess"
        bloodbank.bb -> bloodbank.nats "Publish" "NATS"
        watcherSys.watcher -> bloodbank.nats "Lane probe" "HTTP :8222 jsz"
        watcherSys.watcher -> hermes.gateway "Journal row by command_id" "SQLite, read-only"
        watcherSys.watcher -> hermes.agent "Reply text by chat_id = memo_id" "SQLite, read-only"
        watcherSys.watcher -> hermes.registry "Agent exists / enabled" "File read"
        watcherSys.watcher -> watcherSys.vox "Text -> Ogg/Opus" "HTTPS"
        watcherSys.watcher -> readSide.candystore "Fallback completion + trace" "HTTP GET"
        watcherSys.watcher -> watcherSys.watcherState "Heartbeat, state, retry drop-ins" "File I/O"

        # Container level: bus <-> gateway <-> agent
        bloodbank.nats -> hermes.gateway "Pull invoke (interactive) / start (batch)" "JetStream durable consumers"
        hermes.gateway -> bloodbank.nats "invocation.* and conversation.turn.* facts" "NATS"
        hermes.gateway -> hermes.agent "Hands the prompt to the runner" "In-process"
        hermes.agent -> llmGateway "Turns" "HTTPS"
        hermes.gateway -> hermes.registry "Route validity" "File read"

        # Container level: read side and monitoring
        bloodbank.nats -> readSide.candystore "evt.>" "Dapr pubsub.jetstream"
        bloodbank.nats -> readSide.holoApi "evt.> (ephemeral consumer)" "JetStream"
        bloodbank.nats -> bloodbank.ntfyRouter "evt.>" "JetStream"
        bloodbank.ntfyRouter -> alerts "Push audio.memo.failed" "HTTPS"
        readSide.holoApi -> watcherSys.watcherState "Reads heartbeat" "File read"
        readSide.holoWeb -> readSide.holoApi "Voice memo model" "HTTP"
        operator -> readSide.holoWeb "Reads /voice" "HTTPS"
        monitoring.natsExporter -> bloodbank.nats "Scrape jsz" "HTTP :8222"
        monitoring.prometheus -> monitoring.natsExporter "Scrape" "HTTP :7777"
        monitoring.prometheus -> monitoring.alertmanager "Firing rules" "HTTP"
        monitoring.alertmanager -> alerts "Telegram" "HTTPS"
        plane -> bloodbank.nats "invocation.start" "n8n NATS node"

        # Component level: Holocene Auto app
        operator -> auto.app.mainActivity "Launches" "Touch"
        auto.app.mainActivity -> auto.app.padHost "show / teardown, lifecycle" "In-process"
        auto.app.carHost -> auto.app.padHost "Unrestricted (parked) gate" "Callback"
        auto.app.padHost -> auto.app.nativeBridge "Exposes as window.HoloceneNative" "addJavascriptInterface"
        auto.app.nativeBridge -> auto.app.nativeRecorder "start / stop" "In-process"
        auto.app.mainActivity -> auto.app.diagnostic "Runs fixtures" "In-process"
        auto.app.padHost -> auto.pad "Loads https://agent-pad.delo.sh/" "WebView, HTTPS"
        auto.pad -> auto.app.nativeBridge "start() / stop() / micClosed()" "JavascriptInterface"
        auto.app.nativeRecorder -> auto.pad "Ogg/Opus bytes" "evaluateJavascript"

        # Component level: gateway plugin
        bloodbank.nats -> hermes.gateway.consumeLoop "Fetch (2 interactive, 4 batch)" "JetStream pull"
        hermes.gateway.consumeLoop -> hermes.gateway.decoder "Raw message" "In-process"
        hermes.gateway.decoder -> hermes.gateway.journal "Claim row (pending -> started)" "SQLite"
        hermes.gateway.journal -> hermes.gateway.dispatch "Claimed" "In-process"
        hermes.gateway.dispatch -> hermes.agent.runner "MessageEvent(internal)" "handle_message"
        hermes.gateway.dispatch -> hermes.gateway.awaitTurn "Await completion future" "In-process"
        hermes.gateway.awaitTurn -> hermes.gateway.timeoutPath "Budget expired" "In-process"
        hermes.gateway.timeoutPath -> hermes.agent.runner "/stop" "Hermes stop path"
        hermes.gateway.timeoutPath -> hermes.gateway.journal "completed / failure / turn_timeout" "SQLite"
        hermes.gateway.timeoutPath -> hermes.gateway.lifecycle "invocation.failed" "In-process"
        hermes.gateway.awaitTurn -> hermes.gateway.lifecycle "completed / failed" "In-process"
        hermes.gateway.lifecycle -> bloodbank.nats "Publish facts" "NATS"
        hermes.gateway.progressAck -> bloodbank.nats "ack in-progress every 30 s" "JetStream"
        hermes.agent.runner -> hermes.agent.stateDb "Writes session and messages" "SQLite"
    }

    views {
        systemContext auto "SystemContext" "The operator's memo travels through five systems; Hermes agents and the model gateway sit behind the bus." {
            include *
            exclude googleOidc cloudflare plane monitoring
            autolayout lr 300 150
        }

        container auto "Container-Auto" "Holocene Auto and the ingress it talks to." {
            include *
            autolayout lr 300 100
        }

        container watcherSys "Container-Watcher" "The inbox watcher and everything it touches." {
            include *
            autolayout lr 300 100
        }

        container hermes "Container-Hermes" "Gateway, agent profiles and registry with their bus neighbours." {
            include *
            autolayout lr 300 100
        }

        container bloodbank "Container-Bloodbank" "Bus, router and who reads it." {
            include *
            autolayout lr 300 100
        }

        component auto.app "Components-Auto" "Inside the Holocene Auto app: car gate, WebView host, recorder." {
            include *
            autolayout lr 300 100
        }

        component hermes.gateway "Components-Gateway" "Inside the Hermes gateway bloodbank plugin: lanes, journal, wall clock and the timeout path." {
            include *
            autolayout lr 300 100
        }

        dynamic * "MemoJourney" "One voice memo, verified run 657e81ba (33god-pm, interactive lane, 65.0 s)." {
            1: operator -> auto.app "Taps record (parked)"
            2: auto.app -> auto.pad "Native recorder returns Ogg/Opus"
            3: auto.pad -> ingest.upload "PUT /upload/inbox/<agent>/<date>/<ts>.ogg"
            4: ingest.upload -> ingest.minio "mc cp"
            5: ingest.upload -> bloodbank.nats "evt.audio.memo.uploaded"
            6: watcherSys.watcher -> ingest.minio "Discovers object, downloads"
            7: watcherSys.watcher -> watcherSys.transcribe "ffprobe, transcribe (43 s)"
            8: watcherSys.watcher -> bloodbank.bb "memo.received / transcribed / dispatched, cmd.invoke"
            9: bloodbank.nats -> hermes.gateway "Interactive durable pulls the command"
            10: hermes.gateway -> hermes.agent "Runs the turn (10.3 s), wall clock armed"
            11: hermes.gateway -> bloodbank.nats "invocation.started / completed"
            12: watcherSys.watcher -> hermes.gateway "Journal row completed"
            13: watcherSys.watcher -> hermes.agent "Reads reply text"
            14: watcherSys.watcher -> watcherSys.vox "Synthesize (1.9 s)"
            15: watcherSys.watcher -> ingest.minio "Uploads replies/ ogg"
            16: watcherSys.watcher -> bloodbank.bb "evt.audio.memo.replied"
            17: auto.pad -> ingest.traefik "Polls replies/, plays, beacons played"
            autolayout lr 300 100
        }

        styles {
            element "Person" {
                shape Person
                background #7a4a26
                color #ffffff
            }
            element "Software System" {
                background #1f4e79
                color #ffffff
            }
            element "External" {
                background #8a8a8a
                color #ffffff
            }
            element "Container" {
                background #2f6ea5
                color #ffffff
            }
            element "Component" {
                background #6fa3d1
                color #0b1f33
            }
            element "Database" {
                shape Cylinder
            }
            element "Web" {
                shape WebBrowser
            }
            element "Device" {
                shape MobileDeviceLandscape
            }
        }
    }
}
