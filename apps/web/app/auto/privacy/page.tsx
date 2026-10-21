import type { Metadata } from "next";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Holocene Auto — Privacy policy",
  description: "Privacy policy for the Holocene Auto Android app."
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <article>
        <header>
          <p className={styles.kicker}>AutomaticAI · Android app</p>
          <h1>Holocene Auto privacy policy</h1>
          <p className={styles.meta}>
            Effective date: <time dateTime="2026-10-21">October 21, 2026</time>
          </p>
        </header>

        <section aria-labelledby="scope">
          <h2 id="scope">App and scope</h2>
          <p>
            This policy covers only the Holocene Auto Android app, published by
            AutomaticAI, package <code>io.automaticai.holocene</code>. The current
            internal builds are versions <code>0.2.10-internal</code> and
            <code>0.2.11-internal</code> (version codes 12 and 13); versions
            <code>0.2.7-internal</code> to <code>0.2.9-internal</code> (version codes 9
            to 11) handle data the same way.
            Earlier internal builds (version codes 6 to 8) may appear as
            “Holocene Fixture”; they had no Internet permission and sent no
            data, as described in the “Diagnostics” sections below.
          </p>
          <p>
            The app is a private, internal tool. Its main screen, Agent Pad,
            lets the operator record a voice memo addressed to a chosen
            AutomaticAI agent and hear that agent&apos;s spoken reply. It also
            keeps a Diagnostics screen for microphone and speech pipeline
            verification. While the vehicle is moving, Agent Pad switches to an
            eyes-free driving mode controlled by steering-wheel buttons and spoken
            feedback; Diagnostics is available only while parked. This policy does
            not cover third-party speech providers.
          </p>
        </section>

        <section aria-labelledby="data">
          <h2 id="data">Accounts, permissions and data transmission</h2>
          <p>
            The app has no user accounts or registration, advertisements,
            analytics SDKs, or third-party runtime SDKs. Its only declared Android
            permissions are <code>android.permission.RECORD_AUDIO</code>,{" "}
            <code>android.permission.MODIFY_AUDIO_SETTINGS</code> and{" "}
            <code>android.permission.INTERNET</code>. It has no location or
            account-access permission.
          </p>
          <p>
            Agent Pad loads its interface from <code>agent-pad.delo.sh</code>,
            a server operated by AutomaticAI. When you deliberately press
            Record and then Stop &amp; Send, the recorded audio is uploaded to
            AutomaticAI&apos;s own storage, addressed to the agent you selected,
            so that agent can transcribe and answer it. The app also downloads
            the agents&apos; spoken replies from that storage to play them.
            Audio is recorded only after you press Record; while recording, it
            is held in a temporary file in the app&apos;s private cache, which
            is deleted after the upload. If an upload fails, the recording is kept
            in the app&apos;s private storage on the device and retried until it
            is delivered. The app also reports operational status to the same
            AutomaticAI server (recording started or stopped, upload and
            playback results, spoken-feedback timing, a random per-install
            device identifier used to decide whether the car or the
            operator&apos;s phone plays a reply, and error messages) so failures
            can be diagnosed; these reports contain no audio. AutomaticAI does not sell this data or
            share it with third parties, and the app contains no
            advertising or analytics.
          </p>
          <p>
            However, when you use speech recognition or text-to-speech, the app
            invokes Android&apos;s system speech services. The provider selected
            on your device (such as a Google speech service) may transmit audio
            or text to its own servers for processing. That provider&apos;s
            handling of your data is governed by its own privacy policy, not by
            this one. See the “System speech services” section below for details.
          </p>
        </section>

        <section aria-labelledby="microphone">
          <h2 id="microphone">Diagnostics: microphone probe</h2>
          <p>
            The “Probe microphone for 6 seconds” button explicitly starts a raw
            PCM microphone diagnostic. An explicit diagnostic launch intent can
            also request the same probe. Capture is bounded to approximately six
            seconds, held only in memory, and never saved as an audio file or
            uploaded by the app. The app keeps diagnostic audio statistics in
            Android&apos;s local system log, not the raw audio.
          </p>
          <p>
            The separate speech-recognition diagnostic uses Android&apos;s system
            speech service. The six-second raw PCM probe does not determine how
            that provider processes speech.
          </p>
        </section>

        <section aria-labelledby="speech">
          <h2 id="speech">Diagnostics: system speech services</h2>
          <p>
            Speech recognition uses Android&apos;s <code>SpeechRecognizer</code>
            with the default recognition service selected on the device, such as
            a Google speech service. That provider determines whether recognition
            happens on the device or on its servers. On-device-only processing
            and end-to-end encryption are not guaranteed by this app. The
            provider may process speech under its own privacy policy. The
            diagnostics never send their audio or transcripts to AutomaticAI.
          </p>
          <p>
            The app also uses Android&apos;s <code>TextToSpeech</code> service to
            speak diagnostic acknowledgements. Review your chosen speech
            providers&apos; privacy policies for their handling of speech and
            text. For Google services, see{" "}
            <a href="https://policies.google.com/privacy">Google&apos;s privacy policy</a>.
            This app policy does not cover those providers.
          </p>
        </section>

        <section aria-labelledby="logs">
          <h2 id="logs">Local diagnostic logs and retention</h2>
          <p>
            The app writes diagnostic messages using <code>android.util.Log</code>
            to Logcat on the device. These include audio statistics, returned
            speech-recognition transcript text and text-to-speech acknowledgement
            text. Spoken words and transcripts may contain personal information.
            The one exception is the steering-wheel key inspector in
            Diagnostics, available only while the car is parked: it records
            which keys and rotary or media-session inputs the app receives
            (key codes, names, timing and the input device name; never audio or
            text) in a small log file in the app&apos;s private storage and
            uploads those lines to <code>agent-pad.delo.sh</code>, so the
            steering-wheel buttons can be identified. The app also speaks short
            confirmations (the selected agent&apos;s name, “Recording”, “Sent”)
            with Android&apos;s text-to-speech. It sends no other logs
            anywhere. Agent Pad memos and replies are kept in AutomaticAI&apos;s storage until the
            operator deletes them.
          </p>
          <p>
            Diagnostic microphone audio is transient and is not persisted by the app.
            Logcat retention is controlled by the Android operating system, not
            by Holocene Auto; the app does not set a log-retention period.
          </p>
        </section>

        <section aria-labelledby="control">
          <h2 id="control">Your microphone permission</h2>
          <p>
            You can revoke microphone permission at any time in Android Settings
            under this app&apos;s permissions. Without the RECORD_AUDIO grant,
            the app&apos;s microphone features cannot capture audio. You can also
            use the app&apos;s cancel control to stop diagnostic capture or
            playback. Agent Pad records nothing until you press Record.
          </p>
        </section>

        <footer className={styles.contact}>
          <h2>Contact</h2>
          <p>
            Publisher and developer: AutomaticAI<br />
            Contact person: Jarad DeLorenzo<br />
            Email: <a href="mailto:jarad@automaticai.io">jarad@automaticai.io</a>
          </p>
        </footer>
      </article>
    </main>
  );
}
