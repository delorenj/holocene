import type { Metadata } from "next";
import styles from "./privacy.module.css";

export const metadata: Metadata = {
  title: "Holocene Auto — Privacy policy",
  description: "Privacy policy for the Holocene Auto Android diagnostic fixture."
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <article>
        <header>
          <p className={styles.kicker}>AutomaticAI · Android app</p>
          <h1>Holocene Auto privacy policy</h1>
          <p className={styles.meta}>
            Effective date: <time dateTime="2026-10-06">October 6, 2026</time>
          </p>
        </header>

        <section aria-labelledby="scope">
          <h2 id="scope">App and scope</h2>
          <p>
            This policy covers only the Holocene Auto Android app, published by
            AutomaticAI, package <code>io.automaticai.holocene</code>. The current
            internal build is version <code>0.2.6-internal</code> (version code 8).
            Because its data handling is unchanged, this policy also covers the
            previous internal builds, version <code>0.2.5-internal</code> (version
            code 7) and <code>0.2.4-internal</code> (version code 6). These builds
            may appear as “Holocene Fixture” in the listing
            or on the device.
          </p>
          <p>
            The app is an emulator diagnostic fixture for microphone and speech
            pipeline verification. It does not connect to external live agents
            and is not approved for use while driving. This policy does not cover
            third-party speech providers or other AutomaticAI services.
          </p>
        </section>

        <section aria-labelledby="data">
          <h2 id="data">Accounts, permissions and data transmission</h2>
          <p>
            The app has no user accounts or registration, advertisements,
            analytics SDKs, or third-party runtime SDKs. Its only declared Android
            permission is <code>android.permission.RECORD_AUDIO</code>. It has no
            Internet, location or account-access permission.
          </p>
          <p>
            The app itself does not collect personal data for AutomaticAI, upload
            user data to a developer backend, sell data, or directly share data
            with third parties. It has no network permission with which to
            publish data from the app.
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
          <h2 id="microphone">Microphone diagnostics</h2>
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
          <h2 id="speech">System speech services</h2>
          <p>
            Speech recognition uses Android&apos;s <code>SpeechRecognizer</code>
            with the default recognition service selected on the device, such as
            a Google speech service. That provider determines whether recognition
            happens on the device or on its servers. On-device-only processing
            and end-to-end encryption are not guaranteed by this app. The
            provider may process speech under its own privacy policy, even though
            Holocene Auto itself has no Internet permission.
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
            The app does not write log files or send logs anywhere.
          </p>
          <p>
            Raw microphone audio is transient and is not persisted by the app.
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
            playback.
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
