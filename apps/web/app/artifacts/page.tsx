import "../hub/hub.css";
import "./artifacts.css";
import { ArtifactsApp } from "./artifacts-app";

export const metadata = { title: "Holocene · Artifacts", description: "Browse published files and videos" };
export default function Page() { return <ArtifactsApp />; }
