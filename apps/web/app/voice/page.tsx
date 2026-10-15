import "../hub/hub.css";
import "./voice.css";
import { VoiceApp } from "./voice-app";

export const metadata = {
  title: "Holocene · Voice memos",
  description: "Every voice memo, hop by hop, from the car to the agent and back"
};

export default function Page() {
  return <VoiceApp />;
}
