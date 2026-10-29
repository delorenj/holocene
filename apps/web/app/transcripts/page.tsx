import "../hub/hub.css";
import "./transcripts.css";
import { TranscriptsApp } from "./transcripts-app";

export const metadata = {
  title: "Holocene · Transcripts",
  description: "Recordings by kind and project, with the tickets harvested from them"
};

export default function Page() {
  return <TranscriptsApp />;
}
